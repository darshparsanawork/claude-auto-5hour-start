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

// 5 hours + 3 minutes, in milliseconds (fallback cadence).
const INTERVAL_MS = (5 * 60 + 3) * 60 * 1000;
// Fire this long after an account's usage window resets.
const RESET_DELAY_MS = 5 * 60 * 1000;
// Model used to send the message. "Sonic" is claude.ai's fast model; this is
// the API id it maps to. Editable from the UI in case the id changes.
const DEFAULT_MODEL = "claude-sonnet-4-5";

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
    return { nextTriggerAt: null, message: "hi", running: false, model: DEFAULT_MODEL };
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

// ---------------------------------------------------------------------------
// Account verification — is the session live, and what's the email?
// Results are cached so the frequent status poll doesn't hammer claude.ai.
// ---------------------------------------------------------------------------
const accountStatus = new Map(); // id -> { active, email, checkedAt, checking }
const VERIFY_TTL_MS = 60 * 1000;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
function findEmail(obj, depth = 0) {
  if (!obj || depth > 6) return null;
  if (typeof obj === "string") return EMAIL_RE.test(obj) ? obj.match(EMAIL_RE)[0] : null;
  if (typeof obj !== "object") return null;
  for (const v of Object.values(obj)) {
    const found = findEmail(v, depth + 1);
    if (found) return found;
  }
  return null;
}

async function verifyAccount(account) {
  const { header } = cookieInfo(account.cookies);
  const prev = accountStatus.get(account.id) || {};
  accountStatus.set(account.id, { ...prev, checking: true });
  let active = false;
  let email = prev.email || null;
  try {
    // /organizations 200 => the sessionKey is still valid.
    const res = await fetch(`${BASE}/api/organizations`, { headers: baseHeaders(header) });
    if (res.ok) {
      active = true;
      const orgs = await res.json().catch(() => null);
      email = findEmail(orgs) || email;
      // Org list rarely carries the email; try the account profile too.
      if (!email) {
        for (const ep of ["/api/account", "/api/bootstrap"]) {
          try {
            const r = await fetch(`${BASE}${ep}`, { headers: baseHeaders(header) });
            if (r.ok) {
              email = findEmail(await r.json());
              if (email) break;
            }
          } catch {}
        }
      }
    }
  } catch {
    active = false;
  }
  const status = { active, email, checkedAt: Date.now(), checking: false };
  accountStatus.set(account.id, status);
  return status;
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

// Pull usage / reset info out of the rate-limit response headers and SSE body.
function extractUsage(res, bodyText) {
  const usage = { resetsAt: null, remaining: null, limit: null };
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!k.includes("ratelimit") && !k.includes("rate-limit")) return;
    if (k.includes("reset")) {
      const n = Number(value);
      if (!Number.isNaN(n)) usage.resetsAt = n < 1e12 ? n * 1000 : n;
      else if (!Number.isNaN(Date.parse(value))) usage.resetsAt = Date.parse(value);
    } else if (k.includes("remaining")) {
      usage.remaining = Number(value);
    } else if (k.includes("limit")) {
      usage.limit = Number(value);
    }
  });
  // Fallback: claude.ai also embeds reset info in the stream on limit events.
  if (!usage.resetsAt && bodyText) {
    const m = bodyText.match(/"resets?_?at"\s*:\s*"?([\dT:\-.Z+]+)"?/i);
    if (m) {
      const n = Number(m[1]);
      usage.resetsAt = Number.isNaN(n)
        ? Date.parse(m[1]) || null
        : n < 1e12 ? n * 1000 : n;
    }
  }
  return usage;
}

async function sendMessage(cookieHeader, orgId, convId, message, model) {
  const buildBody = (withModel) =>
    JSON.stringify({
      prompt: message,
      parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      timezone: "Asia/Kolkata",
      attachments: [],
      files: [],
      sync_sources: [],
      rendering_mode: "messages",
      ...(withModel && model ? { model } : {}),
    });

  let res = await fetch(
    `${BASE}/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
    {
      method: "POST",
      headers: { ...baseHeaders(cookieHeader), Accept: "text/event-stream" },
      body: buildBody(true),
    }
  );
  // If the chosen model id is rejected, retry once with the account default.
  if (!res.ok && model && (res.status === 400 || res.status === 404)) {
    log(`Model "${model}" rejected (${res.status}); retrying with default model.`);
    res = await fetch(
      `${BASE}/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
      {
        method: "POST",
        headers: { ...baseHeaders(cookieHeader), Accept: "text/event-stream" },
        body: buildBody(false),
      }
    );
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Send message failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return extractUsage(res, body);
}

async function triggerOnce(account) {
  const { header, orgId: orgFromCookie } = cookieInfo(account.cookies);
  if (!header) throw new Error("account has no usable cookies");
  const orgId = await getOrgId(header, orgFromCookie);
  const convId = await createConversation(header, orgId);
  const usage = await sendMessage(
    header, orgId, convId, config.message || "hi", config.model || DEFAULT_MODEL
  );
  log(`[${account.name}] Sent (model ${config.model || DEFAULT_MODEL}). ${BASE}/chat/${convId}`);

  // Update this account's status with the freshly observed usage, and if the
  // reset time is known, schedule an auto-fire 5 min after it resets.
  const prev = accountStatus.get(account.id) || {};
  const next = { ...prev, active: true, checkedAt: Date.now() };
  if (usage && usage.resetsAt) {
    next.usage = usage;
    next.autoNextAt = usage.resetsAt + RESET_DELAY_MS;
    log(`[${account.name}] Usage window resets ${new Date(usage.resetsAt).toISOString()}; auto-fire at ${new Date(next.autoNextAt).toISOString()}`);
  }
  accountStatus.set(account.id, next);
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
//   1. Global: the IST start time, then every 5h3m (fallback / kickoff).
//   2. Per-account: 5 min after each account's detected usage-window reset.
// ---------------------------------------------------------------------------
let firing = false;
const firingAccounts = new Set();

async function globalTick() {
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
    log(`Next global trigger scheduled for ${new Date(next).toISOString()}`);
    firing = false;
  }
}

async function resetTick() {
  if (!config.running) return;
  const now = Date.now();
  for (const account of accounts) {
    const st = accountStatus.get(account.id);
    if (!st || !st.autoNextAt) continue;
    if (now < st.autoNextAt) continue;
    if (st.firedAutoAt === st.autoNextAt) continue; // already fired this window
    if (firingAccounts.has(account.id)) continue;
    firingAccounts.add(account.id);
    // Mark before firing so we don't double-fire if the send is slow.
    st.firedAutoAt = st.autoNextAt;
    accountStatus.set(account.id, st);
    log(`[${account.name}] Usage reset +5m reached — auto-firing.`);
    triggerOnce(account)
      .catch((err) => log(`[${account.name}] auto-fire ERROR: ${err.message}`))
      .finally(() => firingAccounts.delete(account.id));
  }
}

async function tick() {
  await globalTick();
  await resetTick();
}
setInterval(tick, 15 * 1000);

// ---------------------------------------------------------------------------
// HTTP API + static frontend
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  // Never expose cookie values — just names, counts, and live status.
  const accountList = accounts.map((a) => {
    const st = accountStatus.get(a.id) || {};
    // Refresh stale/unknown entries in the background (don't block the poll).
    if (!st.checking && (!st.checkedAt || Date.now() - st.checkedAt > VERIFY_TTL_MS)) {
      verifyAccount(a).catch(() => {});
    }
    return {
      id: a.id,
      name: a.name,
      cookieCount: a.cookies.length,
      active: st.active ?? null,
      email: st.email ?? null,
      checkedAt: st.checkedAt ?? null,
      usage: st.usage ?? null,
      autoNextAt: st.autoNextAt ?? null,
    };
  });
  res.json({
    running: config.running,
    nextTriggerAt: config.nextTriggerAt,
    message: config.message || "hi",
    model: config.model || DEFAULT_MODEL,
    intervalMs: INTERVAL_MS,
    resetDelayMs: RESET_DELAY_MS,
    accounts: accountList,
    serverNow: Date.now(),
    logs,
  });
});

// Body: { istDateTime: "2026-06-07T15:30" } (interpreted as Asia/Kolkata)
app.post("/api/schedule", (req, res) => {
  const { istDateTime, message, model } = req.body || {};
  if (!istDateTime) return res.status(400).json({ error: "istDateTime required" });
  // IST is UTC+5:30 (no DST). Append the offset so it parses as IST.
  const ms = Date.parse(`${istDateTime}:00+05:30`);
  if (Number.isNaN(ms)) return res.status(400).json({ error: "Invalid date/time" });
  config.nextTriggerAt = ms;
  config.running = true;
  if (typeof message === "string" && message.trim()) config.message = message.trim();
  if (typeof model === "string" && model.trim()) config.model = model.trim();
  saveConfig(config);
  log(`Scheduled first trigger for ${new Date(ms).toISOString()} (IST input ${istDateTime})`);
  res.json({ ok: true, nextTriggerAt: ms });
});

// Add an account. Body: { name?, cookies: "<json string>" | [ ... ] }
app.post("/api/accounts", async (req, res) => {
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
    log(`Added account "${name}" (${cookies.length} cookies). Verifying...`);
    const st = await verifyAccount(account);
    log(`[${name}] ${st.active ? "active" : "inactive"}${st.email ? " — " + st.email : ""}`);
    res.json({ ok: true, id: account.id, name, count: cookies.length, ...st });
  } catch (err) {
    res.status(400).json({ error: `Invalid cookies JSON: ${err.message}` });
  }
});

// Re-check an account's live status now.
app.post("/api/accounts/:id/verify", async (req, res) => {
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const st = await verifyAccount(account);
  res.json({ ok: true, ...st });
});

// Remove an account.
app.delete("/api/accounts/:id", (req, res) => {
  const before = accounts.length;
  const removed = accounts.find((a) => a.id === req.params.id);
  accounts = accounts.filter((a) => a.id !== req.params.id);
  if (accounts.length === before) return res.status(404).json({ error: "Not found" });
  accountStatus.delete(req.params.id);
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
