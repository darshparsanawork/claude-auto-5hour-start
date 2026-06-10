import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Fire this long after an account's usage window resets.
const RESET_DELAY_MS = 5 * 60 * 1000;
// Re-attempt reading a reset time at most this often per account.
const BOOTSTRAP_THROTTLE_MS = 5 * 60 * 1000;

// Model used to send the message. "Sonic" is claude.ai's fast model; this is
// the API id it maps to. Editable from Settings in case the id changes.
const DEFAULT_MODEL = "claude-sonnet-4-5";

const BASE = "https://claude.ai";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Storage — prefer a mounted /data volume; otherwise keep everything in memory.
// ---------------------------------------------------------------------------
function resolveDataDir() {
  const candidates = [process.env.DATA_DIR, "/data"].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  return null; // in-memory only
}

const DATA_DIR = resolveDataDir();
const memoryStore = {};

function load(name, fallback) {
  if (DATA_DIR) {
    try {
      return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), "utf8"));
    } catch {
      return fallback;
    }
  }
  return name in memoryStore ? memoryStore[name] : fallback;
}

function save(name, data) {
  if (DATA_DIR) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2));
  } else {
    memoryStore[name] = data;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let config = load("config", { message: "hi", model: DEFAULT_MODEL, enabled: true });
let accounts = load("accounts", []); // [{ id, name, cookies: [...] }]
const accountStatus = new Map(); // id -> runtime status (not persisted)

const logs = [];
function log(msg) {
  const entry = { time: new Date().toISOString(), msg };
  logs.unshift(entry);
  if (logs.length > 150) logs.pop();
  console.log(`[${entry.time}] ${msg}`);
}

log(
  DATA_DIR
    ? `Persisting data to ${DATA_DIR}`
    : "No writable data volume found — storing everything in memory (not persisted)."
);

// ---------------------------------------------------------------------------
// Cookie / HTTP helpers
// ---------------------------------------------------------------------------
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
    "anthropic-client-platform": "web_claude_ai",
    Origin: BASE,
    Referer: `${BASE}/`,
    Cookie: cookieHeader,
  };
}

// ---------------------------------------------------------------------------
// Account verification (email + active)
// ---------------------------------------------------------------------------
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
    const res = await fetch(`${BASE}/api/organizations`, { headers: baseHeaders(header) });
    if (res.ok) {
      active = true;
      const orgs = await res.json().catch(() => null);
      email = findEmail(orgs) || email;
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
  const next = { ...accountStatus.get(account.id), active, email, checkedAt: Date.now(), checking: false };
  accountStatus.set(account.id, next);
  return next;
}

// ---------------------------------------------------------------------------
// Usage / reset-time extraction
// ---------------------------------------------------------------------------
function normalizeTs(v) {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

function deepUsage(obj) {
  const out = { resetsAt: null, remaining: null, limit: null };
  (function walk(o, d) {
    if (!o || d > 6 || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      const lk = k.toLowerCase();
      if (out.resetsAt == null && lk.includes("reset")) {
        const ts = normalizeTs(v);
        if (ts) out.resetsAt = ts;
      }
      if (out.remaining == null && lk.includes("remaining") && typeof v === "number") out.remaining = v;
      if (out.limit == null && lk.includes("limit") && !lk.includes("reset") && typeof v === "number") out.limit = v;
      walk(v, d + 1);
    }
  })(obj, 0);
  return out;
}

function extractUsage(res, bodyText) {
  const usage = { resetsAt: null, remaining: null, limit: null };
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!k.includes("ratelimit") && !k.includes("rate-limit")) return;
    if (k.includes("reset")) usage.resetsAt = normalizeTs(value);
    else if (k.includes("remaining")) usage.remaining = Number(value);
    else if (k.includes("limit")) usage.limit = Number(value);
  });
  if (bodyText && (usage.resetsAt == null || usage.remaining == null)) {
    try {
      const fromBody = deepUsage(JSON.parse(bodyText));
      for (const key of ["resetsAt", "remaining", "limit"]) {
        if (usage[key] == null && fromBody[key] != null) usage[key] = fromBody[key];
      }
    } catch {
      const m = bodyText.match(/"resets?_?at"\s*:\s*"?([\dT:\-.Z+]+)"?/i);
      if (m) usage.resetsAt = normalizeTs(m[1]);
    }
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Claude internal API: create conversation + send a message
// ---------------------------------------------------------------------------
async function getOrgId(cookieHeader, fallback) {
  if (fallback) return fallback;
  const res = await fetch(`${BASE}/api/organizations`, { headers: baseHeaders(cookieHeader) });
  if (!res.ok) throw new Error(`GET /organizations failed: ${res.status}`);
  const orgs = await res.json();
  if (!Array.isArray(orgs) || !orgs.length) throw new Error("No organizations found.");
  return orgs[0].uuid;
}

async function createConversation(cookieHeader, orgId, model) {
  const convUuid = crypto.randomUUID();
  const res = await fetch(`${BASE}/api/organizations/${orgId}/chat_conversations`, {
    method: "POST",
    headers: baseHeaders(cookieHeader),
    body: JSON.stringify({
      uuid: convUuid,
      name: "",
      include_conversation_preferences: true,
      ...(model ? { model } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Create conversation failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}));
  return data.uuid || convUuid;
}

async function sendMessage(cookieHeader, orgId, convId, message, model) {
  const url = `${BASE}/api/organizations/${orgId}/chat_conversations/${convId}/completion`;
  const buildBody = (withModel) =>
    JSON.stringify({
      prompt: message,
      parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      timezone: "Asia/Kolkata",
      personalized_styles: [],
      tools: [],
      attachments: [],
      files: [],
      sync_sources: [],
      rendering_mode: "messages",
      ...(withModel && model ? { model } : {}),
    });

  let res = await fetch(url, {
    method: "POST",
    headers: { ...baseHeaders(cookieHeader), Accept: "text/event-stream" },
    body: buildBody(true),
  });
  // If the chosen model id is rejected, retry once with the account default.
  if (!res.ok && model && (res.status === 400 || res.status === 404)) {
    log(`Model "${model}" rejected (${res.status}); retrying with account default.`);
    res = await fetch(url, {
      method: "POST",
      headers: { ...baseHeaders(cookieHeader), Accept: "text/event-stream" },
      body: buildBody(false),
    });
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`Send failed: ${res.status} ${body.slice(0, 300)}`);
  return extractUsage(res, body);
}

// ---------------------------------------------------------------------------
// Triggering + scheduling
// ---------------------------------------------------------------------------
function applyUsage(account, usage) {
  const prev = accountStatus.get(account.id) || {};
  const next = { ...prev, active: true, checkedAt: Date.now(), bootstrapAt: Date.now() };
  if (usage && usage.resetsAt) {
    next.usage = usage;
    next.autoNextAt = usage.resetsAt + RESET_DELAY_MS;
    log(`[${account.name}] Next reset ${new Date(usage.resetsAt).toISOString()} → auto-send at ${new Date(next.autoNextAt).toISOString()}`);
  }
  accountStatus.set(account.id, next);
  return next;
}

async function triggerOnce(account) {
  const { header, orgId: orgFromCookie } = cookieInfo(account.cookies);
  if (!header) throw new Error("account has no usable cookies");
  const model = config.model || DEFAULT_MODEL;
  const orgId = await getOrgId(header, orgFromCookie);
  const convId = await createConversation(header, orgId, model);
  const usage = await sendMessage(header, orgId, convId, config.message || "hi", model);
  log(`[${account.name}] Sent "${config.message || "hi"}" (model ${model}). ${BASE}/chat/${convId}`);
  applyUsage(account, usage);
  return convId;
}

// Read usage / reset time WITHOUT sending a message.
async function fetchUsage(account) {
  const { header, orgId: orgFromCookie } = cookieInfo(account.cookies);
  if (!header) throw new Error("account has no usable cookies");
  const orgId = await getOrgId(header, orgFromCookie);
  const endpoints = [
    `/api/organizations/${orgId}/usage`,
    `/api/organizations/${orgId}/rate_limit`,
    `/api/organizations/${orgId}`,
    `/api/account`,
  ];
  let usage = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${BASE}${ep}`, { headers: baseHeaders(header) });
      if (!res.ok) continue;
      const u = extractUsage(res, await res.text());
      if (u.resetsAt || u.remaining != null) {
        usage = u;
        break;
      }
    } catch {}
  }
  const prev = accountStatus.get(account.id) || {};
  accountStatus.set(account.id, { ...prev, bootstrapAt: Date.now() });
  if (!usage || !usage.resetsAt) {
    log(`[${account.name}] No reset time available from usage endpoints yet.`);
    return accountStatus.get(account.id);
  }
  return applyUsage(account, usage);
}

// When an account connects: verify, then learn its reset time. If a reset time
// can't be read without sending, send one message now to start the cycle.
async function bootstrapAccount(account) {
  await verifyAccount(account);
  const st = accountStatus.get(account.id) || {};
  if (st.active === false) {
    log(`[${account.name}] Inactive session — skipping bootstrap.`);
    return;
  }
  await fetchUsage(account);
  const after = accountStatus.get(account.id) || {};
  if (!after.autoNextAt && config.enabled) {
    log(`[${account.name}] No reset time yet — sending one message to start the cycle.`);
    try {
      await triggerOnce(account);
    } catch (err) {
      log(`[${account.name}] Bootstrap send ERROR: ${err.message}`);
    }
  }
}

// Scheduler — every 15s, fire any account whose reset+5min has arrived, and
// keep trying to learn a reset time for accounts that don't have one yet.
const firingAccounts = new Set();
async function tick() {
  if (!config.enabled) return;
  const now = Date.now();
  for (const account of accounts) {
    const st = accountStatus.get(account.id) || {};
    if (st.active === false || firingAccounts.has(account.id)) continue;

    if (st.autoNextAt && now >= st.autoNextAt && st.firedAutoAt !== st.autoNextAt) {
      firingAccounts.add(account.id);
      st.firedAutoAt = st.autoNextAt;
      accountStatus.set(account.id, st);
      log(`[${account.name}] Reset +5m reached — auto-sending.`);
      triggerOnce(account)
        .catch((err) => log(`[${account.name}] auto-send ERROR: ${err.message}`))
        .finally(() => firingAccounts.delete(account.id));
      continue;
    }

    // No schedule yet — keep trying to learn the reset time (throttled).
    if (!st.autoNextAt && (!st.bootstrapAt || now - st.bootstrapAt > BOOTSTRAP_THROTTLE_MS)) {
      firingAccounts.add(account.id);
      bootstrapAccount(account).finally(() => firingAccounts.delete(account.id));
    }
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
  const accountList = accounts.map((a) => {
    const st = accountStatus.get(a.id) || {};
    if (!st.checking && (!st.checkedAt || Date.now() - st.checkedAt > VERIFY_TTL_MS)) {
      verifyAccount(a).catch(() => {});
    }
    return {
      id: a.id,
      name: a.name,
      cookieCount: a.cookies.length,
      active: st.active ?? null,
      email: st.email ?? null,
      usage: st.usage ?? null,
      nextResetAt: st.usage ? st.usage.resetsAt : null,
      autoNextAt: st.autoNextAt ?? null,
    };
  });
  res.json({
    enabled: config.enabled,
    message: config.message || "hi",
    model: config.model || DEFAULT_MODEL,
    resetDelayMs: RESET_DELAY_MS,
    storage: DATA_DIR ? `volume (${DATA_DIR})` : "in-memory (not persisted)",
    accounts: accountList,
    serverNow: Date.now(),
    logs,
  });
});

// Update settings: message, model, enabled.
app.post("/api/settings", (req, res) => {
  const { message, model, enabled } = req.body || {};
  if (typeof message === "string" && message.trim()) config.message = message.trim();
  if (typeof model === "string" && model.trim()) config.model = model.trim();
  if (typeof enabled === "boolean") config.enabled = enabled;
  save("config", config);
  log(`Settings updated: enabled=${config.enabled}, model=${config.model}, message="${config.message}"`);
  res.json({ ok: true, message: config.message, model: config.model, enabled: config.enabled });
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
    save("accounts", accounts);
    log(`Added account "${name}" (${cookies.length} cookies). Connecting...`);
    bootstrapAccount(account).catch((err) => log(`[${name}] bootstrap ERROR: ${err.message}`));
    res.json({ ok: true, id: account.id, name, count: cookies.length });
  } catch (err) {
    res.status(400).json({ error: `Invalid cookies JSON: ${err.message}` });
  }
});

app.post("/api/accounts/:id/verify", async (req, res) => {
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const st = await verifyAccount(account);
  res.json({ ok: true, active: st.active, email: st.email });
});

app.post("/api/accounts/:id/refresh-usage", async (req, res) => {
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  try {
    const st = await fetchUsage(account);
    res.json({ ok: true, usage: st.usage ?? null, autoNextAt: st.autoNextAt ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/refresh-usage", async (req, res) => {
  await Promise.all(accounts.map((a) => fetchUsage(a).catch(() => {})));
  res.json({ ok: true });
});

// Manually send now for one account (also (re)learns the reset time).
app.post("/api/accounts/:id/send-now", async (req, res) => {
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  try {
    const convId = await triggerOnce(account);
    res.json({ ok: true, convId });
  } catch (err) {
    log(`[${account.name}] manual send ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/accounts/:id", (req, res) => {
  const before = accounts.length;
  const removed = accounts.find((a) => a.id === req.params.id);
  accounts = accounts.filter((a) => a.id !== req.params.id);
  if (accounts.length === before) return res.status(404).json({ error: "Not found" });
  accountStatus.delete(req.params.id);
  save("accounts", accounts);
  log(`Removed account "${removed ? removed.name : req.params.id}".`);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  log(`Server running on http://localhost:${PORT}`);
  // Kick off connection/bootstrap for any persisted accounts.
  accounts.forEach((a) =>
    bootstrapAccount(a).catch((err) => log(`[${a.name}] startup bootstrap ERROR: ${err.message}`))
  );
});
