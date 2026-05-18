// WhatsApp Worker for Lovable Scraper Platform
// Deploy on Railway.app — needs persistent volume for ./session
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const API_BASE = process.env.LOVABLE_API_BASE;          // e.g. https://harshscrapping.lovable.app
const TOKEN    = process.env.WHATSAPP_WORKER_TOKEN;     // same as Lovable Cloud secret
const POLL_MS  = 30_000;
const SEND_GAP_MS = 45_000;
const FAIL_GAP_MS = 60_000;

if (!API_BASE || !TOKEN) { console.error("Missing LOVABLE_API_BASE or WHATSAPP_WORKER_TOKEN"); process.exit(1); }

// FIXED: Standard Puppeteer configuration to prevent 'Target closed' and timeouts on Railway
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: {
    headless: true,
    protocolTimeout: 120000, // 2 minutes timeout to prevent freezing
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium", // Points to Dockerfile Chromium
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu" // Prevents memory crashes on low-RAM servers
    ],
  },
});

client.on("qr", (qr) => { console.log("Scan this QR with WhatsApp:"); qrcode.generate(qr, { small: true }); });
client.on("ready", () => { console.log("✅ WhatsApp ready"); pollLoop(); heartbeatLoop(); });
client.on("auth_failure", (m) => console.error("Auth failure", m));
client.on("disconnected", (r) => { console.error("Disconnected", r); process.exit(1); });
client.initialize();

async function fetchPending() {
  const r = await fetch(`${API_BASE}/api/public/wa/pending?limit=1`, {
    headers: { "x-worker-token": TOKEN },
  });
  if (!r.ok) throw new Error("pending " + r.status);
  return (await r.json()).items;
}

async function ack(id, status, error) {
  await fetch(`${API_BASE}/api/public/wa/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-token": TOKEN },
    body: JSON.stringify({ id, status, error }),
  });
}

async function sendOne(item) {
  try {
    if (item.media_url) {
      const media = await MessageMedia.fromUrl(item.media_url);
      await client.sendMessage(item.channel_id, media, { caption: item.message_text });
    } else {
      await client.sendMessage(item.channel_id, item.message_text);
    }
    await ack(item.id, "delivered");
    console.log("✓ sent", item.id);
    await sleep(SEND_GAP_MS);
  } catch (e) {
    console.error("✗ send failed", item.id, e.message);
    await ack(item.id, "failed", String(e.message || e));
    await sleep(FAIL_GAP_MS);
  }
}

async function pollLoop() {
  while (true) {
    try {
      const items = await fetchPending();
      if (items.length === 0) { await sleep(POLL_MS); continue; }
      for (const it of items) await sendOne(it);
    } catch (e) {
      console.error("poll error", e.message);
      await sleep(POLL_MS);
    }
  }
}

async function heartbeatLoop() {
  while (true) {
    try {
      await fetch(`${API_BASE}/api/public/wa/health`, {
        method: "POST", headers: { "x-worker-token": TOKEN },
      });
    } catch {}
    await sleep(60_000);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }