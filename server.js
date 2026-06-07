import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const COOKIES_PATH = path.join(__dirname, "cookies.json");
const CONFIG_PATH = path.join(__dirname, "config.json");

// 5 hours + 3 minutes, in milliseconds.
const INTERVAL_MS = (5 * 60 + 3) * 60 * 1000;

const BASE = "https://claude.ai";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Tiny persistent config
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { nextTriggerAt: null, message: "hi", running: false };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// In-memory log (most recent first).
const logs = [];
function log(msg) {
  const entry = { time: new Date().toISOString(), msg };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  console.log(`[${entry.time}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Cookie handling
// ---------------------------------------------------------------------------
function readCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    throw new Error(
      "cookies.json not found. Copy cookies.example.json to cookies.json and paste your exported claude.ai cookies."
    );
  }
  const arr = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
  if (!Array.isArray(arr)) throw new Error("cookies.json must be a JSON array.");
  const header = arr
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const orgCookie = arr.find((c) => c.name === "lastActiveOrg");
  return { header, orgId: orgCookie ? orgCookie.value : null };
}

function baseHeaders(cookieHeader) {
  return {
    "User-Agent": UA,
    "Content-Type": "application/json",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: BASE,
    Referer: `${BASE}/`,
    Cookie: cookieHeader,
  };
}

// ---------------------------------------------------------------------------
// Claude internal API: create conversation + send first message
// ---------------------------------------------------------------------------
async function getOrgId(cookieHeader, fallback) {
  if (fallback) return fallback;
  const res = await fetch(`${BASE}/api/organizations`, {
    headers: baseHeaders(cookieHeader),
  });
  if (!res.ok) throw new Error(`GET /organizations failed: ${res.status}`);
  const orgs = await res.json();
  if (!Array.isArray(orgs) || !orgs.length) throw new Error("No organizations found.");
  return orgs[0].uuid;
}

async function createConversation(cookieHeader, orgId) {
  const convUuid = crypto.randomUUID();
  const res = await fetch(
    `${BASE}/api/organizations/${orgId}/chat_conversations`,
    {
      method: "POST",
      headers: baseHeaders(cookieHeader),
      body: JSON.stringify({ uuid: convUuid, name: "" }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Create conversation failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.uuid || convUuid;
}

async function sendMessage(cookieHeader, orgId, convId, message) {
  const res = await fetch(
    `${BASE}/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
    {
      method: "POST",
      headers: { ...baseHeaders(cookieHeader), Accept: "text/event-stream" },
      body: JSON.stringify({
        prompt: message,
        parent_message_uuid: "00000000-0000-4000-8000-000000000000",
        timezone: "Asia/Kolkata",
        attachments: [],
        files: [],
        sync_sources: [],
        rendering_mode: "messages",
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Send message failed: ${res.status} ${body.slice(0, 200)}`);
  }
  // Drain the SSE stream so the message is fully registered.
  await res.text();
}

async function triggerOnce() {
  const { header, orgId: orgFromCookie } = readCookies();
  const orgId = await getOrgId(header, orgFromCookie);
  log(`Using organization ${orgId}`);
  const convId = await createConversation(header, orgId);
  log(`Created conversation ${convId}`);
  await sendMessage(header, orgId, convId, config.message || "hi");
  log(`Sent message. Conversation: ${BASE}/chat/${convId}`);
  return convId;
}

// ---------------------------------------------------------------------------
// Scheduler — checks every 15s whether it's time to fire.
// ---------------------------------------------------------------------------
let firing = false;
async function tick() {
  if (!config.running || !config.nextTriggerAt) return;
  if (Date.now() < config.nextTriggerAt) return;
  if (firing) return;
  firing = true;
  try {
    log("Trigger time reached — starting a new Claude conversation...");
    await triggerOnce();
  } catch (err) {
    log(`ERROR: ${err.message}`);
  } finally {
    // Schedule next run, skipping any missed slots while we were down.
    let next = config.nextTriggerAt + INTERVAL_MS;
    while (next <= Date.now()) next += INTERVAL_MS;
    config.nextTriggerAt = next;
    saveConfig(config);
    log(`Next trigger scheduled for ${new Date(next).toISOString()}`);
    firing = false;
  }
}
setInterval(tick, 15 * 1000);

// ---------------------------------------------------------------------------
// HTTP API + static frontend
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  let cookiesOk = false;
  try {
    cookiesOk = !!readCookies().header;
  } catch {}
  res.json({
    running: config.running,
    nextTriggerAt: config.nextTriggerAt,
    message: config.message || "hi",
    intervalMs: INTERVAL_MS,
    cookiesOk,
    serverNow: Date.now(),
    logs,
  });
});

// Body: { istDateTime: "2026-06-07T15:30" } (interpreted as Asia/Kolkata)
app.post("/api/schedule", (req, res) => {
  const { istDateTime, message } = req.body || {};
  if (!istDateTime) return res.status(400).json({ error: "istDateTime required" });
  // IST is UTC+5:30 (no DST). Append the offset so it parses as IST.
  const ms = Date.parse(`${istDateTime}:00+05:30`);
  if (Number.isNaN(ms)) return res.status(400).json({ error: "Invalid date/time" });
  config.nextTriggerAt = ms;
  config.running = true;
  if (typeof message === "string" && message.trim()) config.message = message.trim();
  saveConfig(config);
  log(`Scheduled first trigger for ${new Date(ms).toISOString()} (IST input ${istDateTime})`);
  res.json({ ok: true, nextTriggerAt: ms });
});

// Body: { cookies: "<json array string>" } or { cookies: [ ... ] }
app.post("/api/cookies", (req, res) => {
  try {
    let { cookies } = req.body || {};
    if (typeof cookies === "string") cookies = JSON.parse(cookies);
    if (!Array.isArray(cookies)) throw new Error("Expected a JSON array of cookies.");
    const hasSession = cookies.some((c) => c && c.name === "sessionKey" && c.value);
    if (!hasSession) throw new Error("No 'sessionKey' cookie found in the imported JSON.");
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    log(`Imported ${cookies.length} cookies via frontend.`);
    res.json({ ok: true, count: cookies.length });
  } catch (err) {
    res.status(400).json({ error: `Invalid cookies JSON: ${err.message}` });
  }
});

app.post("/api/stop", (req, res) => {
  config.running = false;
  saveConfig(config);
  log("Scheduler stopped.");
  res.json({ ok: true });
});

app.post("/api/trigger-now", async (req, res) => {
  try {
    const convId = await triggerOnce();
    res.json({ ok: true, convId });
  } catch (err) {
    log(`ERROR (manual trigger): ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  log(`Server running on http://localhost:${PORT}`);
  if (config.running && config.nextTriggerAt) {
    log(`Resumed. Next trigger at ${new Date(config.nextTriggerAt).toISOString()}`);
  }
});
