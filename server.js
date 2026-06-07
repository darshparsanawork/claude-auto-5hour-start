import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const COOKIES_PATH = path.join(__dirname, "cookies.json"); // legacy single-account
const ACCOUNTS_PATH = path.join(__dirname, "accounts.json");
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
// Accounts — each is { id, name, cookies: [ {name, value}, ... ] }
// ---------------------------------------------------------------------------
function loadAccounts() {
  try {
    const arr = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
    if (Array.isArray(arr)) return arr;
  } catch {}
  // One-time migration from the old single-account cookies.json.
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
      if (Array.isArray(cookies) && cookies.length) {
        const migrated = [{ id: crypto.randomUUID(), name: "Account 1", cookies }];
        saveAccounts(migrated);
        return migrated;
      }
    } catch {}
  }
  return [];
}

function saveAccounts(list) {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(list, null, 2));
}

let accounts = loadAccounts();

// Turn a cookie array into a request Cookie header + the org id (if present).
function cookieInfo(cookies) {
  const header = cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const orgCookie = cookies.find((c) => c.name === "lastActiveOrg");
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

async function triggerOnce(account) {
  const { header, orgId: orgFromCookie } = cookieInfo(account.cookies);
  if (!header) throw new Error("account has no usable cookies");
  const orgId = await getOrgId(header, orgFromCookie);
  const convId = await createConversation(header, orgId);
  await sendMessage(header, orgId, convId, config.message || "hi");
  log(`[${account.name}] Sent message. Conversation: ${BASE}/chat/${convId}`);
  return convId;
}

// Fire for every configured account; failures in one don't stop the others.
async function triggerAll() {
  if (!accounts.length) {
    log("No accounts configured — nothing to trigger.");
    return { sent: 0, failed: 0 };
  }
  let sent = 0;
  let failed = 0;
  for (const account of accounts) {
    try {
      await triggerOnce(account);
      sent++;
    } catch (err) {
      failed++;
      log(`[${account.name}] ERROR: ${err.message}`);
    }
  }
  log(`Trigger complete: ${sent} sent, ${failed} failed.`);
  return { sent, failed };
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
    log(`Trigger time reached — starting new conversations for ${accounts.length} account(s)...`);
    await triggerAll();
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
  // Never expose cookie values — just names and counts.
  const accountList = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    cookieCount: a.cookies.length,
  }));
  res.json({
    running: config.running,
    nextTriggerAt: config.nextTriggerAt,
    message: config.message || "hi",
    intervalMs: INTERVAL_MS,
    accounts: accountList,
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

// Add an account. Body: { name?, cookies: "<json string>" | [ ... ] }
app.post("/api/accounts", (req, res) => {
  try {
    let { name, cookies } = req.body || {};
    if (typeof cookies === "string") cookies = JSON.parse(cookies);
    if (!Array.isArray(cookies)) throw new Error("Expected a JSON array of cookies.");
    const hasSession = cookies.some((c) => c && c.name === "sessionKey" && c.value);
    if (!hasSession) throw new Error("No 'sessionKey' cookie found in the imported JSON.");
    name = (typeof name === "string" && name.trim()) || `Account ${accounts.length + 1}`;
    const account = { id: crypto.randomUUID(), name, cookies };
    accounts.push(account);
    saveAccounts(accounts);
    log(`Added account "${name}" (${cookies.length} cookies).`);
    res.json({ ok: true, id: account.id, name, count: cookies.length });
  } catch (err) {
    res.status(400).json({ error: `Invalid cookies JSON: ${err.message}` });
  }
});

// Remove an account.
app.delete("/api/accounts/:id", (req, res) => {
  const before = accounts.length;
  const removed = accounts.find((a) => a.id === req.params.id);
  accounts = accounts.filter((a) => a.id !== req.params.id);
  if (accounts.length === before) return res.status(404).json({ error: "Not found" });
  saveAccounts(accounts);
  log(`Removed account "${removed ? removed.name : req.params.id}".`);
  res.json({ ok: true });
});

app.post("/api/stop", (req, res) => {
  config.running = false;
  saveConfig(config);
  log("Scheduler stopped.");
  res.json({ ok: true });
});

// Fire immediately. Body (optional): { id } to trigger one account only.
app.post("/api/trigger-now", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (id) {
      const account = accounts.find((a) => a.id === id);
      if (!account) return res.status(404).json({ error: "Account not found" });
      const convId = await triggerOnce(account);
      return res.json({ ok: true, convId });
    }
    const result = await triggerAll();
    res.json({ ok: true, ...result });
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
