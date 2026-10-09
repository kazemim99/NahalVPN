const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { exec } = require("child_process");
const os = require("os");

// Passwords, tokens and server addresses live only on the server, in secrets.json (template: secrets.example.json),
// never in the code. Tests require this file without it, so a missing file only stops the real server.
const SECRETS_FILE = process.env.PANEL_SECRETS || "/opt/client-panel/secrets.json";
const SECRETS = (() => {
  try { return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")); }
  catch (e) {
    if (require.main === module) { console.error(`[client-panel] cannot read ${SECRETS_FILE}: ${e.message}`); process.exit(1); }
    return {};
  }
})();

// Auto-detect this server's public IP from network interfaces (works on any VPS)
function getServerIP() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

const SERVER_IP = getServerIP();
const XUI_URL = fs.existsSync('/etc/x-ui/cert/fullchain.crt')
  ? `https://127.0.0.1:2053`
  : `http://127.0.0.1:2053`;
const XUI_HOST = "nahalkmi.ir";
const XUI_BASE = SECRETS.xuiBase || "";
const XUI_DOMAIN = XUI_HOST.split(":")[0];
const SUB_DOMAIN = "subn.nahalkmi.ir";
const XUI_USER = SECRETS.xuiUser;
const XUI_PASS = SECRETS.xuiPass;
const PORT = 2095;
const PUBLIC_DIR = "/opt/client-panel/public";

console.log(`[client-panel] x-ui endpoint: ${XUI_URL}`);
let sessionCookie = "";

// ── Subdomain mapping (per admin, multiple subdomains) ───────────────────
const SUBDOMAINS_FILE = "/opt/client-panel/subdomains.json";
// Format: { "mostafa": ["c", "s"], "amin": ["n"], ... } → admin → array of subdomain prefixes
const CLIENT_SUBDOMAINS_FILE = "/opt/client-panel/client-subdomains.json";
// Format: { "C1": "c", "S5": "s", ... } → client email → chosen subdomain prefix

function loadSubdomains() {
  try {
    const raw = JSON.parse(fs.readFileSync(SUBDOMAINS_FILE, "utf8"));
    // Migrate old format (string) to new format (array)
    const result = {};
    for (const [k, v] of Object.entries(raw)) {
      result[k] = Array.isArray(v) ? v : (v ? [v] : []);
    }
    return result;
  } catch { return {}; }
}
function saveSubdomains(data) {
  fs.writeFileSync(SUBDOMAINS_FILE, JSON.stringify(data, null, 2));
}
function loadClientSubdomains() {
  try { return JSON.parse(fs.readFileSync(CLIENT_SUBDOMAINS_FILE, "utf8")); } catch { return {}; }
}
function saveClientSubdomains(data) {
  fs.writeFileSync(CLIENT_SUBDOMAINS_FILE, JSON.stringify(data, null, 2));
}
function getSubdomainForEmail(email) {
  // 1) Check per-client subdomain mapping first
  const clientSubs = loadClientSubdomains();
  if (clientSubs[email]) {
    if (clientSubs[email] === "@") return XUI_DOMAIN; // @ = default domain
    return `${clientSubs[email]}.${XUI_DOMAIN}`;
  }

  // 2) Derive from admin prefix: M→m, H→h, etc. using subdomains.json
  const firstChar = (email[0] || "").toUpperCase();
  const adminSubs = loadSubdomains(); // { "mostafa": ["m","c"], "hamed": ["h"], ... }
  const allRoles = { ...BUILTIN_ADMINS, ...loadAdminRoles() };
  for (const [username, cfg] of Object.entries(allRoles)) {
    if (cfg.prefixes && cfg.prefixes.includes(firstChar)) {
      const subs = adminSubs[username];
      if (subs && subs.length > 0) {
        // Find matching subdomain: prefer one that matches the first char lowercase
        const match = subs.find(s => s.toLowerCase() === firstChar.toLowerCase()) || subs[0];
        if (match === "@") return XUI_DOMAIN;
        return `${match}.${XUI_DOMAIN}`;
      }
    }
  }

  // 3) Fallback — use base domain
  return XUI_DOMAIN;
}

// ── Admin auth system ──────────────────────────────────────────────────────
const ADMINS_FILE = "/opt/client-panel/admins.json";
const ADMIN_ROLES_FILE = "/opt/client-panel/admin-roles.json";

// Only super admin is built-in — all other admins are dynamic (admin-roles.json)
const BUILTIN_ADMINS = {
  admin:      { prefixes: null,       readonly: true  },
};
const ADMIN_FIXED_PASSWORDS = SECRETS.adminPassword ? { admin: SECRETS.adminPassword } : {};

function loadAdminRoles() {
  try { return JSON.parse(fs.readFileSync(ADMIN_ROLES_FILE, "utf8")); } catch { return {}; }
}
function saveAdminRoles(data) {
  fs.writeFileSync(ADMIN_ROLES_FILE, JSON.stringify(data, null, 2));
}

// ── Sales log (one entry per sale: admin, timestamp, plan length, kind) ──────
// Historically this only recorded account *creations*, one row each, which
// under-counted admins two ways: a renewal (تمدید) is a real sale but was never
// logged at all, and a 3-month plan is three months of sales but counted as one.
// Entries now carry `months` and `type`; rows written before that still count as
// a single order so past totals stay stable.
const CREATION_LOG_FILE = "/opt/client-panel/creation-log.json";
function loadCreationLog() {
  try { return JSON.parse(fs.readFileSync(CREATION_LOG_FILE, "utf8")); } catch { return []; }
}
function appendCreationLog(entry) {
  const log = loadCreationLog();
  log.push(entry);
  try { fs.writeFileSync(CREATION_LOG_FILE, JSON.stringify(log)); } catch (e) { console.error("[creation-log] write error:", e.message); }
}

// One order per month of plan: a 2-month plan is two orders, 3-month is three.
// Legacy rows (no `months`) and anything unparseable count as a single order.
const MAX_ORDERS_PER_SALE = 12;
function entryOrders(entry) {
  const months = Math.round(Number(entry && entry.months));
  if (!Number.isFinite(months) || months < 1) return 1;
  return Math.min(months, MAX_ORDERS_PER_SALE);
}

// Orders per admin over a time window. `since = 0` means all time.
function aggregateSoldStats(log, { since = 0, admins = [] } = {}) {
  const counts = {};
  const detail = {};
  const blank = () => ({ orders: 0, transactions: 0, created: 0, renewed: 0 });
  for (const u of admins) { counts[u] = 0; detail[u] = blank(); }
  let total = 0, transactions = 0;
  for (const entry of Array.isArray(log) ? log : []) {
    if (!entry || typeof entry.ts !== "number" || !entry.admin) continue;
    if (entry.ts < since) continue;
    const orders = entryOrders(entry);
    const d = detail[entry.admin] || (detail[entry.admin] = blank());
    counts[entry.admin] = (counts[entry.admin] || 0) + orders;
    d.orders += orders;
    d.transactions += 1;
    if (entry.type === "renew") d.renewed += 1; else d.created += 1;
    total += orders;
    transactions += 1;
  }
  return { counts, detail, total, transactions };
}

// ?days= for the sales report. 0 (or anything that is not a positive number) means
// all time. The old `daysParam ? Math.max(1, ...)` turned "0" into 1, so the
// dashboard's "all dates" option silently showed only the last 24 hours.
function parseDaysParam(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// email -> creation timestamp. Renewals are sales, not creations, so they must
// not push a client's "created at" forward; a genuine re-creation still wins.
function buildCreatedMap(log) {
  const createdMap = new Map();
  for (const entry of Array.isArray(log) ? log : []) {
    if (!entry || !entry.email || entry.type === "renew") continue;
    createdMap.set(String(entry.email).toLowerCase(), entry.ts); // last create wins
  }
  return createdMap;
}

// Build filter function from prefixes array
// prefixes: null = all clients, [] = catch-all (not matched by any other), ["A","B"] = starts with A or B
function buildFilter(prefixes, username, allRoles) {
  if (prefixes === null) return () => true;
  if (prefixes.length === 0) {
    // catch-all: email not claimed by any other non-catchall admin
    return (email) => {
      const ch = (email[0] || "").toUpperCase();
      for (const [u, cfg] of Object.entries(allRoles)) {
        if (u === username) continue;
        if (cfg.prefixes && cfg.prefixes.length > 0 && cfg.prefixes.includes(ch)) return false;
      }
      return true;
    };
  }
  return (email) => prefixes.includes((email[0] || "").toUpperCase());
}

function buildAdminRoles() {
  const dynamic = loadAdminRoles();
  const allRoles = { ...BUILTIN_ADMINS };
  for (const [u, cfg] of Object.entries(dynamic)) allRoles[u] = cfg;
  const roles = {};
  for (const [u, cfg] of Object.entries(allRoles)) {
    roles[u] = buildFilter(cfg.prefixes, u, allRoles);
    roles[u]._cfg = cfg; // attach config metadata
  }
  return roles;
}

let ADMIN_ROLES = buildAdminRoles();

function getUserPrefixes(username) {
  if (BUILTIN_ADMINS[username]) return BUILTIN_ADMINS[username].prefixes;
  const dynamic = loadAdminRoles();
  return dynamic[username] ? dynamic[username].prefixes : null;
}
const SESSIONS_FILE = "/opt/client-panel/sessions.json";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;     // 30 days in seconds (for cookie)

// Load sessions from disk, drop expired ones
const adminSessions = (() => {
  const m = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    const now = Date.now();
    for (const [token, session] of Object.entries(data)) {
      if (session.expires > now) m.set(token, session);
    }
  } catch {}
  return m;
})();

function saveSessions() {
  const obj = {};
  for (const [token, session] of adminSessions) obj[token] = session;
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj)); } catch {}
}

function loadAdmins() {
  try { return JSON.parse(fs.readFileSync(ADMINS_FILE, "utf8")); } catch { return {}; }
}
function saveAdmins(data) {
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(data, null, 2));
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const h = crypto.pbkdf2Sync(pw, salt, 100000, 32, "sha256").toString("hex");
  return h === hash;
}
function getAdminSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/admin_session=([a-f0-9]+)/);
  if (!match) return null;
  const session = adminSessions.get(match[1]);
  if (!session || session.expires < Date.now()) { adminSessions.delete(match[1]); saveSessions(); return null; }
  return session;
}
// Purge expired sessions from disk once per hour
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, s] of adminSessions) { if (s.expires < now) { adminSessions.delete(token); changed = true; } }
  if (changed) saveSessions();
}, 3600000);
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

// ── Server liveness checks (every 60s) ───────────────────────────────────
// Checks: 1) x-ui service active  2) ESTAB outbound connections to foreign server  3) inbound port accepting
const FOREIGN_SERVER = SECRETS.foreignServer || "";
let serverOnline = false;
let offlineSince = null;
const OFFLINE_GRACE_MS = 5 * 60 * 1000; // 5 minutes

function checkServerStatus() {
  let checks = 0, passed = 0, total = 3;
  const details = {};

  // Check 1: x-ui service is active (xray runs inside x-ui)
  exec("systemctl is-active x-ui", { timeout: 5000 }, (err, stdout) => {
    const ok = !err && (stdout || "").trim() === "active";
    if (ok) passed++;
    details.xui = ok ? "active" : "down";
    if (++checks === total) finishCheck(passed, total, details);
  });

  // Check 2: ESTAB outbound connections to foreign server (most important)
  exec(`ss -tn | grep '${FOREIGN_SERVER}' | awk '{print $1}' | sort | uniq -c | sort -rn`, { timeout: 5000 }, (err, stdout) => {
    const lines = (stdout || "").trim().split("\n").filter(Boolean);
    let estab = 0, stale = 0;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const count = parseInt(parts[0]) || 0;
      const state = parts[1] || "";
      if (state === "ESTAB") estab += count;
      else stale += count;
    }
    // Pass if: no connections at all (idle) OR ESTAB >= stale (healthy)
    // Fail only if stale > ESTAB (outbound is dying)
    const total_conns = estab + stale;
    const ok = total_conns === 0 || estab >= stale;
    if (ok) passed++;
    details.outbound = `${estab} ESTAB, ${stale} stale`;
    if (++checks === total) finishCheck(passed, total, details);
  });

  // Check 3: Inbound port 443 accepting TCP connections
  exec("timeout 3 bash -c 'echo > /dev/tcp/127.0.0.1/443' 2>/dev/null", { timeout: 5000 }, (err) => {
    if (!err) passed++;
    details.inbound = !err ? "open" : "closed";
    if (++checks === total) finishCheck(passed, total, details);
  });
}

function finishCheck(passed, total, details) {
  serverOnline = passed >= 2; // at least 2 of 3 checks pass
  console.log(`[status] ${passed}/${total} ok → ${serverOnline ? "online" : "offline"} | xui=${details.xui} outbound=${details.outbound} inbound=${details.inbound}`);

  if (serverOnline) {
    offlineSince = null;
  } else if (!offlineSince) {
    offlineSince = Date.now();
    console.log("[status] Server down — starting 5min grace period");
  }
}

function isConfirmedOffline() {
  if (serverOnline) return false;
  if (!offlineSince) return false;
  return (Date.now() - offlineSince) >= OFFLINE_GRACE_MS;
}

checkServerStatus();
setInterval(checkServerStatus, 60000);

let csrfToken = "";

async function fetchCsrfToken() {
  return new Promise((resolve) => {
    const url = new URL(XUI_BASE + "/csrf-token", XUI_URL);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: "GET",
      headers: { "X-Requested-With": "XMLHttpRequest", Cookie: sessionCookie, Host: XUI_HOST },
      rejectUnauthorized: false,
    };
    const req = (XUI_URL.startsWith("http://") ? http : https).request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.headers["set-cookie"])
          sessionCookie = res.headers["set-cookie"][0].split(";")[0];
        try {
          const j = JSON.parse(data);
          if (j.success && j.obj) { csrfToken = j.obj; }
        } catch {}
        resolve(csrfToken);
      });
    });
    req.on("error", () => resolve(csrfToken));
    req.end();
  });
}

// ── Old x-ui API compatibility layer ────────────────────────────────────────
// Translates new-style /panel/api/clients/* to old-style /panel/api/inbounds/*
// Auto-detect: if 'clients' table exists → 3x-ui (new API), else old x-ui 2.8.11
let OLD_XUI_API = true; // default to old, overridden at startup
try {
  const { execSync } = require("child_process");
  const tables = execSync("sqlite3 /etc/x-ui/x-ui.db \".tables\" 2>/dev/null", { timeout: 3000 }).toString();
  if (tables.includes("client_inbounds")) {
    OLD_XUI_API = false;
    console.log("[xui] Detected 3x-ui (new API) — using /panel/api/clients/*");
  } else {
    console.log("[xui] Detected x-ui 2.8.11 (old API) — using /panel/api/inbounds/*");
  }
} catch { console.log("[xui] Could not detect x-ui version, using old API"); }
function adaptApiPath(urlPath, method, body) {
  if (!OLD_XUI_API) return { urlPath, body };
  // /panel/api/clients/add → /panel/api/inbounds/addClient
  if (urlPath === "/panel/api/clients/add" && method === "POST" && body) {
    const newBody = { id: (body.inboundIds || [])[0], settings: JSON.stringify({ clients: [body.client] }) };
    return { urlPath: "/panel/api/inbounds/addClient", body: newBody };
  }
  // /panel/api/clients/update/{email} → /panel/api/inbounds/updateClient/{uuid}
  const updateMatch = urlPath.match(/^\/panel\/api\/clients\/update\/(.+)$/);
  if (updateMatch && method === "POST" && body) {
    // Body can be { client: {...}, inboundIds: [...] } or flat { id, email, ..., inboundIds }
    const client = body.client || body;
    const clientUuid = client.id || "";
    const inboundIds = body.inboundIds || client.inboundIds || [];
    const inboundId = inboundIds[0] || "";
    const cleanClient = { ...client }; delete cleanClient.inboundIds;
    const newBody = { id: inboundId, settings: JSON.stringify({ clients: [cleanClient] }) };
    return { urlPath: `/panel/api/inbounds/updateClient/${encodeURIComponent(clientUuid)}`, body: newBody };
  }
  // /panel/api/clients/traffic/{email} → /panel/api/inbounds/getClientTraffics/{email}
  const trafficMatch = urlPath.match(/^\/panel\/api\/clients\/traffic\/(.+)$/);
  if (trafficMatch) {
    return { urlPath: `/panel/api/inbounds/getClientTraffics/${trafficMatch[1]}`, body };
  }
  // /panel/api/clients/onlines → /panel/api/inbounds/onlines
  if (urlPath === "/panel/api/clients/onlines") {
    return { urlPath: "/panel/api/inbounds/onlines", body };
  }
  return { urlPath, body };
}
// Delete client (old API needs inboundId + client UUID, not email)
async function deleteClientByEmail(email) {
  const inboundsRes = await getInbounds();
  if (!inboundsRes.success) return { success: false, msg: "cannot fetch inbounds" };
  for (const inb of (inboundsRes.obj || [])) {
    const settings = typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {});
    const client = (settings.clients || []).find(c => c.email === email);
    if (client) {
      if (OLD_XUI_API) {
        return await withAuth(() => xuiRequest(`/panel/api/inbounds/${inb.id}/delClient/${encodeURIComponent(client.id)}`, "POST", {}));
      } else {
        return await withAuth(() => xuiRequest(`/panel/api/clients/del/${encodeURIComponent(email)}`, "POST", {}));
      }
    }
  }
  return { success: false, msg: "client not found" };
}
// Get client by email (old API: search inbound list; new API: /panel/api/clients/get/{email})
async function getClientByEmail(email) {
  if (!OLD_XUI_API) return await withAuth(() => xuiRequest(`/panel/api/clients/get/${encodeURIComponent(email)}`));
  invalidateInboundsCache();
  const inboundsRes = await getInbounds();
  if (!inboundsRes.success) return { success: false };
  for (const inb of (inboundsRes.obj || [])) {
    const settings = typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {});
    const client = (settings.clients || []).find(c => c.email === email);
    if (client) return { success: true, obj: { client: { ...client, uuid: client.id } } };
  }
  return { success: false };
}

async function xuiRequest(urlPath, method = "GET", body = null, _redirects = 0) {
  // Apply old API compatibility
  const adapted = adaptApiPath(urlPath, method, body);
  urlPath = adapted.urlPath;
  body = adapted.body;
  // Fetch CSRF token for non-GET requests
  if (method !== "GET" && !csrfToken) await fetchCsrfToken();
  return new Promise((resolve, reject) => {
    const url = new URL(XUI_BASE + urlPath, XUI_URL);
    const isFormEncoded = urlPath === "/login";
    let bodyStr = null;
    if (body) {
      if (isFormEncoded) {
        bodyStr = Object.entries(body).map(([k,v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
      } else {
        bodyStr = JSON.stringify(body);
      }
    }
    const headers = {
      "Content-Type": isFormEncoded ? "application/x-www-form-urlencoded; charset=UTF-8" : "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: sessionCookie,
      Host: XUI_HOST,
    };
    if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers,
      rejectUnauthorized: false,
    };
    const req = (XUI_URL.startsWith("http://") ? http : https).request(opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && _redirects < 5) {
        const next = new URL(res.headers.location, XUI_URL);
        res.resume();
        resolve(xuiRequest(next.pathname + next.search, method, body, _redirects + 1));
        return;
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.headers["set-cookie"])
          sessionCookie = res.headers["set-cookie"][0].split(";")[0];
        // If 403, refresh CSRF token and retry once
        if (res.statusCode === 403 && _redirects < 1) {
          csrfToken = "";
          resolve(xuiRequest(urlPath, method, body, _redirects + 1));
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function login() {
  // Clear both before retrying -- a stale sessionCookie surviving into a fresh
  // login attempt can otherwise wedge x-ui auth in a permanently-failing state
  // until the process is restarted (seen in production: worked fine right after
  // deploy, then "cannot fetch inbounds" for every request hours later).
  csrfToken = "";
  sessionCookie = "";
  await fetchCsrfToken();
  const res = await xuiRequest("/login", "POST", { username: XUI_USER, password: XUI_PASS });
  if (res.success) console.log("[xui] Logged in successfully");
  return res.success === true;
}

async function withAuth(fn) {
  let res = await fn();
  if (!res || !res.success) {
    const ok = await login();
    if (ok) res = await fn();
  }
  return res;
}

// ── Inbounds cache (30s TTL) ─────────────────────────────────────────────────
let _inboundsCache = null;
let _inboundsCacheTime = 0;
const INBOUNDS_TTL = 30000; // 30 seconds

const ACTIVE_INBOUND_REMARK = "N"; // Main inbound (port 443)
const CDN_INBOUND_REMARK = "Arvan-CDN"; // CDN inbound (port 8080)
const MANAGED_INBOUND_REMARKS = [ACTIVE_INBOUND_REMARK, CDN_INBOUND_REMARK, "WS-TLS"]; // Both local + WS-TLS
const OLD_INBOUND_REMARK = "T"; // Old port-80 inbound
const WS_TLS_INBOUND_REMARK = "WS-TLS"; // VLESS + WS + TLS inbound (port 53726)

// Where new and renewed accounts go. x-ui refuses the same email on two inbounds
// ("Duplicate email"), so a client lives on exactly one: renewing MIGRATES it off the
// old CDN inbound onto WS-TLS. Servers without a WS-TLS inbound keep the old behaviour.
function pickCreateInbound(inbounds) {
  if (!Array.isArray(inbounds) || inbounds.length === 0) return null;
  const usable = (remark) => inbounds.find((i) => i && i.remark === remark && i.enable !== false);
  return usable(WS_TLS_INBOUND_REMARK) || usable(CDN_INBOUND_REMARK) || inbounds[0] || null;
}
const XUI_SUB_PORT = 2096; // x-ui subscription port

// Fixed monthly plans: 30GB per month (1/2/3/6 month options)
const GB_BYTES = 1073741824;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MONTHLY_GB = 30;
const ALLOWED_PLAN_MONTHS = [1, 2, 3, 6];
const planTotalGB = (months) => Math.round(months * MONTHLY_GB * GB_BYTES);
const planExpiry = (months) => Date.now() + months * MONTH_MS;

const EMAIL_SUFFIX = ""; // Napstar uses "-443", Nahalkmi uses "" (no suffix)
const toInternal = (email) => email + EMAIL_SUFFIX;
const toDisplay = (email) => EMAIL_SUFFIX ? email.replace(new RegExp(EMAIL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), "") : email;

// ── SoftEther L2TP/IPsec + OpenVPN (hosted on the foreign box, not locally) ─────
// One SoftEther account works for BOTH L2TP/IPsec and OpenVPN (same username/password,
// client just picks which protocol to dial with) -- there is no separate "OpenVPN account".
// This panel talks to l2tp-portal's internal admin API over HTTPS rather than shelling
// out to a local vpncmd binary (that only ever existed on a different, older box).
const L2TP_API_HOST = "l.nahalkmi.ir";
const L2TP_API_PORT = 8443;
const L2TP_INTERNAL_TOKEN = SECRETS.l2tpInternalToken || "";
const L2TP_SERVER_DOMAIN = "l.nahalkmi.ir";
const L2TP_OPENVPN_PORT = 1194;
const L2TP_PSK = SECRETS.l2tpPsk || "";

function l2tpApiRequest(urlPath, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      // Connect directly to the foreign box's real IP -- L2TP_API_HOST now resolves to this
      // very server, so going through the hostname would hairpin against our
      // own DNAT (which doesn't apply to locally-originated traffic) and always fail.
      // servername keeps SNI + cert verification pinned to the real l.nahalkmi.ir cert.
      hostname: FOREIGN_SERVER, port: L2TP_API_PORT, path: urlPath, method,
      servername: L2TP_API_HOST,
      headers: { "X-Internal-Token": L2TP_INTERNAL_TOKEN, "Content-Type": "application/json" },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout connecting to L2TP server")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Mirror L2TP/OpenVPN accounts onto this box's own local SoftEther instance ──
// Clients now dial l.nahalkmi.ir (this Iran box) for L2TP/OpenVPN; the actual
// SecureNAT/egress still lives on the foreign hub, bridged in via a Cascade
// Connection, but each hub keeps its own separate user database -- so every
// account change made against the foreign box (via l2tpApiRequest above) must
// also be replayed here, best-effort, via the local vpncmd binary.
// NOTE: /HUB:<name> combined with /PASSWORD: on the connection line makes vpncmd
// prompt for a second (hub-level) password that was never set, hanging forever
// non-interactively -- select the hub as a piped-in command instead.
const IRAN_VPNCMD_DIR = "/usr/local/libexec/softether/vpncmd";
const IRAN_SE_ADMIN_PASSWORD = SECRETS.iranSeAdminPassword || "";
function syncIranL2tpUser(commands) {
  try {
    const { execSync } = require("child_process");
    const script = "Hub DEFAULT\n" + commands.join("\n") + "\n";
    execSync(
      `cd ${IRAN_VPNCMD_DIR} && timeout 8 ./vpncmd localhost:992 /SERVER /PASSWORD:${IRAN_SE_ADMIN_PASSWORD}`,
      { input: script, timeout: 10000 }
    );
  } catch (e) {
    console.error("[l2tp-iran-sync] failed:", e.message);
  }
}

// ── NahalVPN app accounts (task 9.1) ───────────────────────────────────────
// The app's accounts live in nahalvpn-api on this same box. The panel calls it with its own service token and names
// the signed-in panel admin in X-Act-As; nahalvpn-api resolves that name from admin-roles.json, so a reseller only
// ever sees and changes their own app users and the built-in `admin` is read-only. No token file = feature off.
const NAHALVPN_API = { host: "127.0.0.1", port: 8790 };
const NAHALVPN_TOKEN_FILE = "/opt/client-panel/nahalvpn-panel.token";
const NAHALVPN_DOWNLOAD_URL = "https://app.nahalkmi.ir/";
function nahalvpnToken() {
  try { return fs.readFileSync(NAHALVPN_TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}
function nahalvpnRequest(actAs, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const token = nahalvpnToken();
    if (!token) { reject(new Error("not configured")); return; }
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      ...NAHALVPN_API, method, path: urlPath, timeout: 15000,
      headers: { "Authorization": `Bearer ${token}`, "X-Act-As": actAs, ...(bodyStr ? { "Content-Type": "application/json" } : {}) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
// A 4-digit code, as the owner asked: easy to read out and type on a phone. nahalvpn-api locks a username for
// 15 minutes after 10 wrong passwords, which is what limits guessing.
function randomAppPassword() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}
// Default app usernames: the reseller's prefix in lower case plus a number (m1001, m1002, ...), so they are told apart
// from x-ui client names (M101) at a glance.
function nextAppUsername(prefixChar, users) {
  const re = new RegExp(`^${prefixChar.toLowerCase()}(\\d+)$`, "i");
  let max = 1000;
  for (const u of users) { const m = u.username.match(re); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `${prefixChar.toLowerCase()}${max + 1}`;
}
const APP_ERRORS = {
  conflict: "این نام کاربری قبلاً گرفته شده است",
  not_found: "کاربر پیدا نشد",
  forbidden: "دسترسی فقط خواندنی است",
  invalid_request: "اطلاعات واردشده معتبر نیست",
};
function sendApp(res, status, obj) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function appFailure(res, r, fallback) {
  const code = r.body && r.body.error;
  sendApp(res, r.status >= 400 && r.status < 500 ? r.status : 502, { error: APP_ERRORS[code] || fallback });
}

function randomL2tpPassword() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

async function nextL2tpUsername(prefixChar) {
  const existingList = await l2tpApiRequest("/internal/l2tp/list", "GET");
  const existingUsers = (existingList.body && existingList.body.users) || [];
  const numRe = new RegExp(`^${prefixChar}(\\d+)$`);
  let maxNum = 999;
  for (const u of existingUsers) {
    const m = u.username && u.username.match(numRe);
    if (m) { const n = parseInt(m[1], 10); if (n > maxNum) maxNum = n; }
  }
  return `${prefixChar}${maxNum + 1}`;
}

async function getInbounds() {
  const now = Date.now();
  if (_inboundsCache && (now - _inboundsCacheTime) < INBOUNDS_TTL) {
    return _inboundsCache;
  }
  const res = await withAuth(() => xuiRequest("/panel/api/inbounds/list"));
  if (res.success) {
    // Filter to managed inbounds only
    res.obj = (res.obj || []).filter(inb => MANAGED_INBOUND_REMARKS.includes(inb.remark));
    _inboundsCache = res;
    _inboundsCacheTime = now;
  }
  return res;
}

function invalidateInboundsCache() {
  _inboundsCache = null;
  _inboundsCacheTime = 0;
}

// Migrate client from old inbound to active inbound
// Adds old traffic usage to new inbound, removes from old
async function migrateFromOldInbound(displayEmail) {
  try {
    const oldEmail = displayEmail;
    const newEmail = toInternal(displayEmail);

    // Fetch ALL inbounds (unfiltered) to find old one
    const allRes = await withAuth(() => xuiRequest("/panel/api/inbounds/list"));
    if (!allRes.success) return;

    const oldInbound = allRes.obj.find(inb => inb.remark === OLD_INBOUND_REMARK);
    if (!oldInbound) return;

    const oldSettings = (typeof oldInbound.settings === "string" ? JSON.parse(oldInbound.settings || "{}") : (oldInbound.settings || {}));
    const oldClient = (oldSettings.clients || []).find(c => c.email === oldEmail);
    if (!oldClient) return; // client not in old inbound, nothing to migrate

    // Get old traffic stats
    const oldStat = (oldInbound.clientStats || []).find(s => s.email === oldEmail);
    const oldUp = oldStat?.up || 0;
    const oldDown = oldStat?.down || 0;

    // Find new inbound and compare traffic
    const newInbound = allRes.obj.find(inb => inb.remark === ACTIVE_INBOUND_REMARK);
    if (!newInbound) return;

    const newSettings = (typeof newInbound.settings === "string" ? JSON.parse(newInbound.settings || "{}") : (newInbound.settings || {}));
    const newClient = (newSettings.clients || []).find(c => c.email === newEmail);
    if (!newClient) return;

    const newStat = (newInbound.clientStats || []).find(s => s.email === newEmail);
    const newUp = newStat?.up || 0;
    const newDown = newStat?.down || 0;
    const oldTotal = oldUp + oldDown;
    const newTotal = newUp + newDown;

    // Only add the DIFFERENCE if old usage > new usage
    const diff = oldTotal - newTotal;
    if (diff > 0) {
      const { execSync } = require("child_process");
      const pyScript = `import sqlite3\nconn = sqlite3.connect("/etc/x-ui/x-ui.db")\nc = conn.cursor()\nc.execute("UPDATE client_traffics SET down = down + ${diff} WHERE email = '${newEmail}' AND inbound_id = ${newInbound.id}")\nconn.commit()\nconn.close()`;
      execSync("python3 -c '" + pyScript.replace(/'/g, "'\\''") + "'");
      console.log(`[migrate] ${oldEmail}: added ${(diff/1073741824).toFixed(2)}GB diff to ${newEmail}`);
    } else {
      console.log(`[migrate] ${oldEmail}: new already >= old, no traffic to add`);
    }

    // Delete client from old inbound
    await deleteClientByEmail(oldEmail);
    console.log(`[migrate] ${oldEmail}: removed from old inbound`);

    invalidateInboundsCache();
  } catch (e) {
    console.error(`[migrate] Error for ${displayEmail}:`, e.message);
  }
}

function buildClientLink(inbound, clientId, email, client) {
  try {
    const stream = (typeof inbound.streamSettings === "string" ? JSON.parse(inbound.streamSettings || "{}") : (inbound.streamSettings || {}));
    const net = stream.network || "tcp";

    // Build remark with traffic and expiry info
    let remarkStr = `${inbound.remark}-${email}`;
    if (client) {
      const totalGB = client.totalGB || 0;
      const totalGBDisplay = totalGB > 0 ? (totalGB / 1073741824).toFixed(2) + "GB" : "Unlimited";
      remarkStr += `-${totalGBDisplay}\u{1F4CA}`;
      if (client.expiryTime && client.expiryTime > 0) {
        const remaining = client.expiryTime - Date.now();
        if (remaining > 0) {
          const days = Math.floor(remaining / 86400000);
          const hours = Math.floor((remaining % 86400000) / 3600000);
          remarkStr += `-${days}D,${hours}H\u{23F3}`;
        }
      }
    }
    const remark = encodeURIComponent(remarkStr);

    // Use externalProxy settings if available (CDN destination)
    const extProxy = (stream.externalProxy || [])[0];
    let destHost = extProxy ? extProxy.dest : getSubdomainForEmail(email);
    let destPort = extProxy ? extProxy.port : inbound.port;
    const destTls = extProxy ? (extProxy.forceTls === "tls" || extProxy.forceTls === "same" ? (stream.security || "tls") : "none") : (stream.security || "none");

    if (inbound.protocol === "vless") {
      const p = new URLSearchParams();
      p.set("type", net);
      p.set("encryption", "none");
      if (net === "ws") {
        const ws = stream.wsSettings || {};
        p.set("path", ws.path || "");
        p.set("host", ws.host || ws.headers?.Host || XUI_DOMAIN);
      } else if (net === "xhttp" || net === "splithttp") {
        const xh = stream.xhttpSettings || stream.splithttpSettings || {};
        p.set("path", xh.path || "/");
        p.set("host", xh.host || "");
        p.set("mode", xh.mode || "auto");
      } else if (net === "grpc") {
        const grpc = stream.grpcSettings || {};
        if (grpc.serviceName) p.set("serviceName", grpc.serviceName);
        p.set("mode", "gun");
      } else if (net === "tcp") {
        const hdr = (stream.tcpSettings?.header) || {};
        if (hdr.type && hdr.type !== "none") p.set("headerType", hdr.type);
      }
      if (destTls === "tls") {
        p.set("security", "tls");
        const t = stream.tlsSettings || {};
        p.set("sni", t.serverName || destHost || XUI_DOMAIN);
        p.set("fp", t.fingerprint || "chrome");
        if (Array.isArray(t.alpn) && t.alpn.length) p.set("alpn", t.alpn.join(","));
      } else if (stream.security === "reality") {
        p.set("security", "reality");
        const r = stream.realitySettings || {};
        p.set("sni", r.serverName || XUI_DOMAIN);
        p.set("fp", r.fingerprint || "chrome");
        if (r.publicKey) p.set("pbk", r.publicKey);
        if (r.shortIds?.[0]) p.set("sid", r.shortIds[0]);
        if (r.spiderX) p.set("spx", r.spiderX);
      } else {
        p.set("security", "none");
      }
      return `vless://${clientId}@${destHost}:${destPort}?${p.toString()}#${remark}`;
    }
    if (inbound.protocol === "shadowsocks") {
      return null;
    }
  } catch (e) {
    console.error("[migrate] buildClientLink error:", e.message);
  }
  return null;
}

// ── Admin traffic cache (refreshes every 10 minutes) ────────────────────────
const ADMIN_REFRESH_MS = 10 * 60 * 1000; // 10 minutes
const adminCache = { data: null, lastUpdate: 0 };

async function refreshAdminData() {
  try {
    const inboundsRes = await getInbounds();
    if (!inboundsRes.success) { console.error("[admin] Failed to fetch inbounds"); return; }

    // Build prefix→admin lookup from all roles (builtin + dynamic)
    const allRoles = { ...BUILTIN_ADMINS, ...loadAdminRoles() };
    const prefixMap = {};
    const adminNames = [];
    for (const [username, cfg] of Object.entries(allRoles)) {
      if (cfg.readonly) continue;
      adminNames.push(username);
      if (cfg.prefixes && cfg.prefixes.length > 0) {
        for (const p of cfg.prefixes) prefixMap[p.toUpperCase()] = username;
      }
    }

    const catchAllAdmin = Object.entries(allRoles).find(([, cfg]) => !cfg.readonly && cfg.prefixes && cfg.prefixes.length === 0);
    const catchAllName = catchAllAdmin ? catchAllAdmin[0] : null;

    // Per admin: count clients, sum totalGB sold, sum traffic used, price
    const groups = {};
    for (const name of adminNames) {
      const pricePerGB = allRoles[name].pricePerGB || 0;
      groups[name] = { clients: 0, soldGB: 0, usedGB: 0, pricePerGB, totalPrice: 0 };
    }

    // Helper to process inbounds from any server
    const processInbounds = (inbounds) => {
      for (const inb of inbounds) {
        const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        const clients = settings.clients || [];
        const stats = inb.clientStats || [];
        for (const cl of clients) {
          const displayEmail = (cl.email || "").replace(new RegExp(EMAIL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), "");
          const first = displayEmail.charAt(0).toUpperCase();
          const owner = prefixMap[first] || catchAllName;
          if (!owner || !groups[owner]) continue;
          groups[owner].clients++;
          groups[owner].soldGB += (cl.totalGB || 0) / 1073741824;
          const stat = stats.find(s => s.email === cl.email);
          if (stat) {
            groups[owner].usedGB += ((stat.up || 0) + (stat.down || 0)) / 1073741824;
          }
        }
      }
    };

    // Process all local inbounds (N + Arvan-CDN)
    processInbounds(inboundsRes.obj);

    // Calculate total price per admin: usedGB * pricePerGB (pricePerGB is Toman per GB)
    for (const name of adminNames) {
      groups[name].totalPrice = Math.round(groups[name].usedGB * groups[name].pricePerGB);
    }

    adminCache.data = { groups, lastUpdate: new Date().toISOString() };
    adminCache.lastUpdate = Date.now();
    const summary = adminNames.map(n => `${n}: ${groups[n].clients}cl/${Math.round(groups[n].soldGB)}GB sold/${Math.round(groups[n].usedGB)}GB used`).join(", ");
    console.log(`[admin] Refreshed — ${summary}`);
  } catch (e) {
    console.error("[admin] Refresh error:", e.message);
  }
}

// Refresh on startup (after login) and every hour
setTimeout(() => { refreshAdminData(); setInterval(refreshAdminData, ADMIN_REFRESH_MS); }, 5000);

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // ── Admin: POST /api/admin/login ────────────────────────────────────────────
  if (url.pathname === "/api/admin/login" && req.method === "POST") {
    try {
      const { username, password } = await readBody(req);
      if (!ADMIN_ROLES[username]) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "کاربر یافت نشد" }));
        return;
      }
      // Fixed-password admins (e.g. admin) — skip PBKDF2 / setup flow
      if (ADMIN_FIXED_PASSWORDS[username] !== undefined) {
        if (password !== ADMIN_FIXED_PASSWORDS[username]) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "رمز عبور اشتباه است" }));
          return;
        }
      } else {
        const admins = loadAdmins();
        if (!admins[username]) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "setup" }));
          return;
        }
        if (!password || !verifyPassword(password, admins[username])) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "رمز عبور اشتباه است" }));
          return;
        }
      }
      const token = crypto.randomBytes(32).toString("hex");
      adminSessions.set(token, { username, role: username, expires: Date.now() + SESSION_TTL });
      saveSessions();
      const loginRoleData = loadAdminRoles()[username] || BUILTIN_ADMINS[username] || {};
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `admin_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}` });
      res.end(JSON.stringify({ ok: true, username, role: username, prefixes: getUserPrefixes(username), subdomains: (loadSubdomains()[username] || []), domain: XUI_DOMAIN, pricePerGB: loginRoleData.pricePerGB || 0 }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/setup (first-time password) ─────────────────────
  if (url.pathname === "/api/admin/setup" && req.method === "POST") {
    try {
      const { username, newPassword } = await readBody(req);
      if (!ADMIN_ROLES[username]) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "کاربر یافت نشد" }));
        return;
      }
      if (!newPassword || newPassword.length < 6) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "رمز عبور باید حداقل ۶ کاراکتر باشد" }));
        return;
      }
      const admins = loadAdmins();
      if (admins[username]) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "رمز عبور قبلاً تنظیم شده است" }));
        return;
      }
      admins[username] = hashPassword(newPassword);
      saveAdmins(admins);
      const token = crypto.randomBytes(32).toString("hex");
      adminSessions.set(token, { username, role: username, expires: Date.now() + SESSION_TTL });
      saveSessions();
      const setupRoleData = loadAdminRoles()[username] || BUILTIN_ADMINS[username] || {};
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `admin_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}` });
      res.end(JSON.stringify({ ok: true, username, role: username, prefixes: getUserPrefixes(username), subdomains: (loadSubdomains()[username] || []), domain: XUI_DOMAIN, pricePerGB: setupRoleData.pricePerGB || 0 }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/logout ───────────────────────────────────────────
  if (url.pathname === "/api/admin/logout" && req.method === "POST") {
    const cookieMatch = (req.headers.cookie || "").match(/admin_session=([a-f0-9]+)/);
    if (cookieMatch) adminSessions.delete(cookieMatch[1]);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "admin_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Admin: GET /api/admin/admin-users ───────────────────────────────────────
  if (url.pathname === "/api/admin/admin-users" && req.method === "GET") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    const dynamic = loadAdminRoles();
    const result = [];
    for (const [u, cfg] of Object.entries(BUILTIN_ADMINS)) {
      result.push({ username: u, prefixes: cfg.prefixes, readonly: cfg.readonly, builtin: true, pricePerGB: cfg.pricePerGB || 0 });
    }
    for (const [u, cfg] of Object.entries(dynamic)) {
      if (!BUILTIN_ADMINS[u]) result.push({ username: u, prefixes: cfg.prefixes, readonly: false, builtin: false, pricePerGB: cfg.pricePerGB || 0 });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, admins: result }));
    return;
  }

  // ── Admin: POST /api/admin/admin-users (add) ────────────────────────────────
  if (url.pathname === "/api/admin/admin-users" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    const { username, prefixes, pricePerGB } = await readBody(req);
    if (!username || !/^[a-z0-9_]{2,20}$/.test(username)) {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "نام کاربری باید ۲-۲۰ حرف لاتین کوچک باشد" })); return;
    }
    if (BUILTIN_ADMINS[username]) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "این نام رزرو شده است" })); return; }
    // prefixes: array of uppercase letters, or null for all
    const pfx = Array.isArray(prefixes) ? prefixes.map(p => p.toUpperCase()).filter(p => /^[A-Z]$/.test(p)) : null;
    const dynamic = loadAdminRoles();
    const existing = dynamic[username] || {};
    dynamic[username] = { prefixes: pfx, pricePerGB: pricePerGB !== undefined ? Number(pricePerGB) || 0 : (existing.pricePerGB || 0) };
    saveAdminRoles(dynamic);
    ADMIN_ROLES = buildAdminRoles();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Admin: DELETE /api/admin/admin-users (remove) ───────────────────────────
  if (url.pathname === "/api/admin/admin-users" && req.method === "DELETE") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    const { username } = await readBody(req);
    if (!username) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "نام کاربری الزامی است" })); return; }
    if (BUILTIN_ADMINS[username] && BUILTIN_ADMINS[username].readonly) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "این ادمین قابل حذف نیست" })); return; }
    // Delete all clients of this admin from both inbounds
    try {
      const allRole = (BUILTIN_ADMINS[username] || loadAdminRoles()[username]);
      const prefixes = allRole ? (allRole.prefixes || []) : [];
      if (prefixes.length > 0) {
        const allInbRes = await withAuth(() => xuiRequest("/panel/api/inbounds/list"));
        if (allInbRes.success) {
          for (const inb of (allInbRes.obj || [])) {
            const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
            const toDelete = (settings.clients || []).filter(cl => {
              const displayEmail = cl.email.replace(new RegExp(EMAIL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), "");
              return prefixes.map(p => p.toUpperCase()).includes((displayEmail[0] || "").toUpperCase());
            });
            for (const cl of toDelete) {
              await deleteClientByEmail(cl.email);
            }
          }
          invalidateInboundsCache();
        }
      }
    } catch (e) { console.error("[admin-delete] client cleanup error:", e.message); }
    const dynamic = loadAdminRoles();
    delete dynamic[username];
    saveAdminRoles(dynamic);
    // Remove password and sessions
    const admins = loadAdmins();
    delete admins[username];
    saveAdmins(admins);
    for (const [token, s] of adminSessions) { if (s.username === username) adminSessions.delete(token); }
    saveSessions();
    ADMIN_ROLES = buildAdminRoles();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Admin: PATCH /api/admin/admin-users (update price) ──────────────────────
  if (url.pathname === "/api/admin/admin-users" && req.method === "PATCH") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    const { username, pricePerGB } = await readBody(req);
    if (!username) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "نام کاربری الزامی است" })); return; }
    const dynamic = loadAdminRoles();
    if (dynamic[username]) {
      dynamic[username].pricePerGB = Number(pricePerGB) || 0;
      saveAdminRoles(dynamic);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ادمین یافت نشد" }));
    }
    return;
  }

  // ── Admin: POST /api/admin/reset-password ───────────────────────────────────
  if (url.pathname === "/api/admin/reset-password" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "فقط مدیر اصلی می‌تواند رمز را بازنشانی کند" }));
      return;
    }
    const { username } = await readBody(req);
    if (!username || !ADMIN_ROLES[username]) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "نام کاربری نامعتبر است" }));
      return;
    }
    if (ADMIN_FIXED_PASSWORDS[username] !== undefined) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "رمز این کاربر ثابت است و قابل تغییر نیست" }));
      return;
    }
    const admins = loadAdmins();
    delete admins[username];
    saveAdmins(admins);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Admin: GET /api/admin/clients ───────────────────────────────────────────
  if (url.pathname === "/api/admin/clients" && req.method === "GET") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      const filter = ADMIN_ROLES[session.role];
      const clients = [];
      const seenEmails = new Set();
      const createdMap = buildCreatedMap(loadCreationLog());

      // Fetch all local inbounds (N + Arvan-CDN)
      const inboundsRes = await getInbounds();
      if (!inboundsRes.success) throw new Error("cannot fetch inbounds");

      // Auto-sync traffic from N to Arvan-CDN (background, non-blocking)
      try {
        const nInb = inboundsRes.obj.find(i => i.remark === "N");
        const cdnInb = inboundsRes.obj.find(i => i.remark === "Arvan-CDN");
        if (nInb && cdnInb) {
          const { execSync } = require("child_process");
          const nId = nInb.id, cdnId = cdnInb.id;
          execSync(`sqlite3 /etc/x-ui/x-ui.db "UPDATE client_traffics SET up = (SELECT t2.up FROM client_traffics t2 WHERE t2.email = client_traffics.email AND t2.inbound_id = ${nId}), down = (SELECT t2.down FROM client_traffics t2 WHERE t2.email = client_traffics.email AND t2.inbound_id = ${nId}) WHERE inbound_id = ${cdnId} AND email IN (SELECT email FROM client_traffics WHERE inbound_id = ${nId} AND (up > 0 OR down > 0));"`, { timeout: 5000 });
        }
      } catch (e) { console.error("[auto-sync] N→CDN traffic sync error:", e.message); }

      for (const inb of inboundsRes.obj) {
        const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        for (const cl of settings.clients || []) {
          const displayEmail = toDisplay(cl.email);
          if (!filter(displayEmail)) continue;
          if (seenEmails.has(displayEmail.toLowerCase())) continue;
          seenEmails.add(displayEmail.toLowerCase());
          const stat = (inb.clientStats || []).find((s) => s.email === cl.email);
          clients.push({
            email: displayEmail, uuid: cl.id, subId: cl.subId || "", comment: cl.comment || "",
            up: stat?.up || 0, down: stat?.down || 0, total: stat?.total || 0,
            expiryTime: cl.expiryTime || 0, enable: stat?.enable !== false,
            inboundId: inb.id, port: inb.port, remark: inb.remark, protocol: inb.protocol,
            server: "local", createdAt: createdMap.get(displayEmail.toLowerCase()) || null,
          });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      const roleData = loadAdminRoles()[session.username] || BUILTIN_ADMINS[session.username] || {};
      res.end(JSON.stringify({ ok: true, role: session.role, username: session.username, prefixes: getUserPrefixes(session.username), subdomains: (loadSubdomains()[session.username] || []), domain: XUI_DOMAIN, pricePerGB: roleData.pricePerGB || 0, clients }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: GET /api/admin/sold-stats — accounts created per admin over a day range (super admin only) ──
  if (url.pathname === "/api/admin/sold-stats" && req.method === "GET") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    if (session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    try {
      const daysParam = url.searchParams.get("days");
      const days = parseDaysParam(daysParam);
      const since = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
      const log = loadCreationLog();
      const allRoles = { ...BUILTIN_ADMINS, ...loadAdminRoles() };
      const admins = Object.keys(allRoles).filter(u => u !== "admin");
      // counts = orders (plan months), so a 3-month sale or renewal counts as three
      const { counts, detail, total, transactions } = aggregateSoldStats(log, { since, admins });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, days, counts, detail, total, transactions, trackingStartedAt: log.length ? log[0].ts : null }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/clients (create) ─────────────────────────────────
  if (url.pathname === "/api/admin/clients" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    if (session.role === "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی فقط خواندنی است" })); return; }
    try {
      const { email, months, subdomain, server } = await readBody(req);
      if (!email) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "ایمیل الزامی است" })); return; }
      if (!ALLOWED_PLAN_MONTHS.includes(Number(months))) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "پلن نامعتبر است" })); return;
      }
      const filter = ADMIN_ROLES[session.role];
      if (!filter(email)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "این ایمیل در محدوده دسترسی شما نیست" }));
        return;
      }

      // Create client on local x-ui
      {
        const inboundsRes = await getInbounds();
        if (!inboundsRes.success || !inboundsRes.obj?.length) throw new Error("cannot fetch inbounds");
        const inbound = pickCreateInbound(inboundsRes.obj);
        if (!inbound) throw new Error("no usable inbound");
        const internalEmail = email + EMAIL_SUFFIX;
        // Check for duplicate
        for (const inb of inboundsRes.obj) {
          const s = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
          if ((s.clients || []).find((c) => c.email === internalEmail)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "این ایمیل قبلاً استفاده شده است" }));
            return;
          }
        }
        const subId = crypto.randomBytes(8).toString("hex");
        const totalGB = planTotalGB(Number(months));
        const clientUuid = crypto.randomUUID();
        const newClient = { id: clientUuid, flow: "", email: internalEmail, limitIp: 2, totalGB, expiryTime: planExpiry(Number(months)), enable: true, tgId: 0, subId, reset: 0, comment: "" };
        const addRes = await withAuth(() => xuiRequest("/panel/api/clients/add", "POST", { client: newClient, inboundIds: [inbound.id] }));
        if (addRes.success) { invalidateInboundsCache(); appendCreationLog({ email, admin: session.username, ts: Date.now(), months: Number(months), type: "create" }); }
        if (!addRes.success) throw new Error(addRes.msg || "add failed");
        if (subdomain && subdomain.trim()) {
          const cs = loadClientSubdomains();
          cs[email] = subdomain.trim().toLowerCase();
          saveClientSubdomains(cs);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, email, uuid: clientUuid, subId, server: "local" }));
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/clients/bulk ────────────────────────────────────
  if (url.pathname === "/api/admin/clients/bulk" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    if (session.role === "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی فقط خواندنی است" })); return; }
    try {
      const { prefix, start, end, months, subdomain } = await readBody(req);
      if (!prefix || start === undefined || end === undefined || !ALLOWED_PLAN_MONTHS.includes(Number(months))) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "پارامترها ناقص است" })); return;
      }
      const s = Number(start), e = Number(end);
      if (isNaN(s) || isNaN(e) || s > e) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "بازه عددی نامعتبر است" })); return;
      }
      if (e - s > 99) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "حداکثر ۱۰۰ کاربر در هر بار" })); return;
      }
      const filter = ADMIN_ROLES[session.role];
      if (!filter(prefix + s)) {
        res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "این پیشوند در محدوده دسترسی شما نیست" })); return;
      }
      // Create clients on local x-ui
      const inboundsRes = await getInbounds();
      if (!inboundsRes.success || !inboundsRes.obj?.length) throw new Error("cannot fetch inbounds");
      const inbound = pickCreateInbound(inboundsRes.obj);
      if (!inbound) throw new Error("no usable inbound");
      // Collect existing emails from ALL managed inbounds
      const existingEmails = new Set();
      for (const inb of inboundsRes.obj) {
        const s2 = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        for (const c of (s2.clients || [])) existingEmails.add(c.email);
      }
      const totalGB = planTotalGB(Number(months));
      const expiryTime = planExpiry(Number(months));
      const created = [], skipped = [];
      for (let i = s; i <= e; i++) {
        const email = prefix + i;
        const internalEmail = email + EMAIL_SUFFIX;
        if (existingEmails.has(internalEmail)) { skipped.push(email); continue; }
        const subId = crypto.randomBytes(8).toString("hex");
        const newClient = { id: crypto.randomUUID(), flow: "", email: internalEmail, limitIp: 2, totalGB, expiryTime, enable: true, tgId: 0, subId, reset: 0, comment: "" };
        const addRes = await withAuth(() => xuiRequest("/panel/api/clients/add", "POST", { client: newClient, inboundIds: [inbound.id] }));
        if (addRes.success) { created.push(email); existingEmails.add(internalEmail); invalidateInboundsCache(); appendCreationLog({ email, admin: session.username, ts: Date.now(), months: Number(months), type: "create" }); }
        else { skipped.push(email); }
      }
      // Store per-client subdomain for all created clients
      if (subdomain && subdomain.trim() && created.length > 0) {
        const cs = loadClientSubdomains();
        for (const email of created) cs[email] = subdomain.trim().toLowerCase();
        saveClientSubdomains(cs);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, created, skipped }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: DELETE /api/admin/client ─────────────────────────────────────────
  if (url.pathname === "/api/admin/client" && req.method === "DELETE") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      const { email } = await readBody(req);
      if (!email) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "ایمیل الزامی است" })); return; }
      const filter = ADMIN_ROLES[session.role];
      if (!filter(email)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی غیرمجاز" })); return; }
      // Delete from ALL inbounds (Iran-1)
      const allInbRes = await withAuth(() => xuiRequest("/panel/api/inbounds/list"));
      if (!allInbRes.success) throw new Error("cannot fetch inbounds");
      let deleted = 0;
      for (const inb of (allInbRes.obj || [])) {
        const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        for (const tryEmail of [email + EMAIL_SUFFIX, email]) {
          const cl = (settings.clients || []).find(c => c.email === tryEmail);
          if (cl) {
            const delRes = await deleteClientByEmail(cl.email);
            if (delRes.success) deleted++;
            break;
          }
        }
      }
      invalidateInboundsCache();
      if (deleted === 0) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "کاربر یافت نشد" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deleted }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/group-toggle (enable/disable all clients of a prefix) ──
  if (url.pathname === "/api/admin/group-toggle" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    try {
      const { prefixes, enable } = await readBody(req);
      if (!prefixes || !Array.isArray(prefixes) || enable === undefined) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "پارامترها ناقص است" })); return;
      }
      const inboundsRes = await withAuth(() => xuiRequest("/panel/api/inbounds/list"));
      if (!inboundsRes.success) throw new Error("cannot fetch inbounds");
      let updated = 0;
      // Toggle in ALL inbounds
      for (const inb of (inboundsRes.obj || [])) {
        const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        const targets = (settings.clients || []).filter(cl => {
          const displayEmail = cl.email.replace(new RegExp(EMAIL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), "");
          return prefixes.map(p => p.toUpperCase()).includes((displayEmail[0] || "").toUpperCase());
        });
        for (const cl of targets) {
          const upRes = await withAuth(() => xuiRequest(`/panel/api/clients/update/${encodeURIComponent(cl.email)}`, "POST", {
            id: cl.id, email: cl.email, enable: !!enable, limitIp: cl.limitIp, totalGB: cl.totalGB,
            expiryTime: cl.expiryTime, tgId: cl.tgId || 0, subId: cl.subId || "", inboundIds: [inb.id],
          }));
          if (upRes.success) updated++;
        }
      }
      invalidateInboundsCache();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, updated, enable: !!enable }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/client-toggle (enable/disable) ──────────────────
  if (url.pathname === "/api/admin/client-toggle" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    if (session.role === "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی فقط خواندنی است" })); return; }
    try {
      const { email, enable } = await readBody(req);
      if (!email || enable === undefined) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "پارامترها ناقص است" })); return; }
      const filter = ADMIN_ROLES[session.role];
      if (!filter(email)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "این کاربر در محدوده دسترسی شما نیست" })); return; }
      const inboundsRes = await getInbounds();
      if (!inboundsRes.success) throw new Error("cannot fetch inbounds");
      const internalEmail = email + EMAIL_SUFFIX;
      let targetInbound = null, targetClient = null;
      for (const inb of inboundsRes.obj) {
        const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        const cl = (settings.clients || []).find(c => c.email === internalEmail);
        if (cl) { targetInbound = inb; targetClient = cl; break; }
      }
      if (!targetInbound || !targetClient) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "کاربر یافت نشد" })); return; }
      const updateRes = await withAuth(() => xuiRequest(`/panel/api/clients/update/${encodeURIComponent(targetClient.email)}`, "POST", {
        id: targetClient.id, email: targetClient.email, enable: !!enable, limitIp: targetClient.limitIp,
        totalGB: targetClient.totalGB, expiryTime: targetClient.expiryTime, tgId: targetClient.tgId || 0,
        subId: targetClient.subId || "", inboundIds: [targetInbound.id],
      }));
      if (!updateRes.success) throw new Error(updateRes.msg || "failed to update client");
      // Also update in old inbound if exists
      const allInbRes = await withAuth(() => xuiRequest("/panel/api/inbounds/list"));
      if (allInbRes.success) {
        for (const inb of (allInbRes.obj || [])) {
          if (inb.remark !== OLD_INBOUND_REMARK) continue;
          const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
          const oldCl = (settings.clients || []).find(c => c.email === email);
          if (oldCl) {
            await withAuth(() => xuiRequest(`/panel/api/clients/update/${encodeURIComponent(oldCl.email)}`, "POST", {
              id: oldCl.id, email: oldCl.email, enable: !!enable, limitIp: oldCl.limitIp,
              totalGB: oldCl.totalGB, expiryTime: oldCl.expiryTime, tgId: oldCl.tgId || 0,
              subId: oldCl.subId || "", inboundIds: [inb.id],
            }));
            break;
          }
        }
      }
      invalidateInboundsCache();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, enable: !!enable }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // (migrate-iran2 endpoint removed — single server now)

  // ── Admin: POST /api/admin/client-switch-inbound (move client between inbounds) ──
  if (url.pathname === "/api/admin/client-switch-inbound" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      const { email, targetInbound } = await readBody(req);
      if (!email || !targetInbound) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "پارامترها ناقص است" })); return; }
      if (!MANAGED_INBOUND_REMARKS.includes(targetInbound)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "اینباند نامعتبر است" })); return; }
      const filter = ADMIN_ROLES[session.role];
      if (!filter(email)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی غیرمجاز" })); return; }

      const inboundsRes = await getInbounds();
      if (!inboundsRes.success) throw new Error("cannot fetch inbounds");
      const internalEmail = email + EMAIL_SUFFIX;

      // Find client in current inbound
      let sourceInbound = null, sourceClient = null;
      for (const inb of inboundsRes.obj) {
        const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        const cl = (settings.clients || []).find(c => c.email === internalEmail);
        if (cl) { sourceInbound = inb; sourceClient = cl; break; }
      }
      if (!sourceInbound || !sourceClient) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "کاربر یافت نشد" })); return; }
      if (sourceInbound.remark === targetInbound) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, msg: "already on target inbound" })); return; }

      // Find target inbound
      const destInbound = inboundsRes.obj.find(inb => inb.remark === targetInbound);
      if (!destInbound) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "اینباند مقصد یافت نشد" })); return; }

      // Get traffic usage before delete (x-ui API)
      const trafficRes = await withAuth(() => xuiRequest(`/panel/api/clients/traffic/${encodeURIComponent(sourceClient.email)}`));
      const usedUp = trafficRes?.obj?.up || 0;
      const usedDown = trafficRes?.obj?.down || 0;
      console.log(`[switch-inbound] ${email}: traffic before switch: up=${usedUp} down=${usedDown}`);

      // Delete client from source inbound, then re-add to target
      const delRes = await deleteClientByEmail(sourceClient.email);
      if (!delRes.success) throw new Error(delRes.msg || "failed to delete client");
      invalidateInboundsCache();

      // Add client to target inbound (preserve settings, new UUID)
      const newClient = { id: crypto.randomUUID(), flow: sourceClient.flow || "", email: sourceClient.email, limitIp: sourceClient.limitIp, totalGB: sourceClient.totalGB, expiryTime: sourceClient.expiryTime, enable: sourceClient.enable !== false, tgId: sourceClient.tgId || 0, subId: sourceClient.subId || "", reset: sourceClient.reset || 0, comment: sourceClient.comment || "" };
      const addRes = await withAuth(() => xuiRequest("/panel/api/clients/add", "POST", { client: newClient, inboundIds: [destInbound.id] }));
      if (!addRes.success) throw new Error(addRes.msg || "failed to add to target inbound");
      invalidateInboundsCache();

      // Inject traffic usage into the new client_traffics record via sqlite3
      if (usedUp > 0 || usedDown > 0) {
        const { execSync } = require("child_process");
        try {
          execSync(`sqlite3 /etc/x-ui/x-ui.db "UPDATE client_traffics SET up = up + ${usedUp}, down = down + ${usedDown} WHERE email = '${sourceClient.email.replace(/'/g, "''")}' AND inbound_id = ${destInbound.id};"`, { timeout: 5000 });
          console.log(`[switch-inbound] ${email}: traffic migrated: up=${usedUp} down=${usedDown}`);
        } catch (e) {
          console.error(`[switch-inbound] ${email}: traffic migration failed:`, e.message);
        }
      }

      console.log(`[switch-inbound] ${email}: ${sourceInbound.remark}(${sourceInbound.port}) → ${targetInbound}(${destInbound.port})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, from: sourceInbound.remark, to: targetInbound }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/client-renew (renew: reset traffic + fresh expiry) ──
  if (url.pathname === "/api/admin/client-renew" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      const { email, months } = await readBody(req);
      if (!email) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "ایمیل الزامی است" })); return; }
      if (!ALLOWED_PLAN_MONTHS.includes(Number(months))) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "پلن نامعتبر است" })); return;
      }
      // Verify admin has access to this email
      const filter = ADMIN_ROLES[session.role];
      if (!filter(email)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "این کاربر در محدوده دسترسی شما نیست" })); return; }
      // Find the client in x-ui
      const inboundsRes = await getInbounds();
      if (!inboundsRes.success) throw new Error("cannot fetch inbounds");
      const internalEmail = email + EMAIL_SUFFIX;
      let targetInbound = null, targetClient = null;
      for (const inb of inboundsRes.obj) {
        const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        const cl = (settings.clients || []).find(c => c.email === internalEmail);
        if (cl) { targetInbound = inb; targetClient = cl; break; }
      }
      if (!targetInbound || !targetClient) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "کاربر یافت نشد" })); return; }
      const newTotalBytes = planTotalGB(Number(months));
      const newExpiry = planExpiry(Number(months));
      console.log(`[renew] email=${internalEmail} months=${months} newTotalGB=${newTotalBytes} newExpiry=${newExpiry} clientId=${targetClient.id} inboundId=${targetInbound.id}`);

      // Use delete+re-add pattern (x-ui update API is broken). No traffic restore — renewal resets usage to 0.
      const delRes = await deleteClientByEmail(targetClient.email);
      if (!delRes.success) throw new Error(delRes.msg || "failed to delete client");
      invalidateInboundsCache();

      // Renewal doubles as the migration onto WS-TLS: the client was just deleted from
      // its old inbound, so re-add it wherever new accounts now live.
      const destInbound = pickCreateInbound(inboundsRes.obj) || targetInbound;
      const newClient = { id: crypto.randomUUID(), flow: targetClient.flow || "", email: targetClient.email, limitIp: targetClient.limitIp, totalGB: newTotalBytes, expiryTime: newExpiry, enable: true, tgId: targetClient.tgId || 0, subId: targetClient.subId || "", reset: targetClient.reset || 0, comment: targetClient.comment || "" };
      const addRes = await withAuth(() => xuiRequest("/panel/api/clients/add", "POST", { client: newClient, inboundIds: [destInbound.id] }));
      if (destInbound.id !== targetInbound.id) console.log(`[renew] migrated ${email}: ${targetInbound.remark}(${targetInbound.port}) -> ${destInbound.remark}(${destInbound.port})`);
      if (!addRes.success) throw new Error(addRes.msg || "failed to re-add client");
      invalidateInboundsCache();

      // A renewal is a sale: credit it to the renewing admin, weighted by plan length.
      appendCreationLog({ email, admin: session.username, ts: Date.now(), months: Number(months), type: "renew" });

      console.log(`[renew] done: ${email} -> ${months} month(s), ${newTotalBytes / GB_BYTES}GB, traffic reset`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, newTotalGB: newTotalBytes, expiryTime: newExpiry }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: GET /api/admin/l2tp/users (list SoftEther L2TP/OpenVPN accounts) ─
  if (url.pathname === "/api/admin/l2tp/users" && req.method === "GET") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      const r = await l2tpApiRequest("/internal/l2tp/list", "GET");
      if (!r.body || !r.body.ok) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, enabled: false, users: [] })); return; }
      const filter = ADMIN_ROLES[session.role];
      const users = (r.body.users || [])
        .filter((u) => u.username && filter(u.username))
        .map((u) => ({
          username: u.username,
          expiry: u.expiresAt ? new Date(u.expiresAt).toLocaleString("en-US") : "",
          createdAt: u.createdAt || "",
          bytesIn: u.bytesIn || 0,
          bytesOut: u.bytesOut || 0,
          logins: u.logins || 0,
        }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, enabled: true, users, server: L2TP_SERVER_DOMAIN, psk: L2TP_PSK, openvpnPort: L2TP_OPENVPN_PORT }));
    } catch (e) {
      // Foreign box unreachable -- degrade gracefully instead of a 500, matches the
      // frontend's "L2TP is not enabled here" messaging.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, enabled: false, users: [], error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/l2tp/users (create SoftEther L2TP/OpenVPN account) ─
  if (url.pathname === "/api/admin/l2tp/users" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    if (session.role === "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی فقط خواندنی است" })); return; }
    try {
      const { months } = await readBody(req);
      if (!ALLOWED_PLAN_MONTHS.includes(Number(months))) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "پلن نامعتبر است" })); return;
      }
      const prefixes = getUserPrefixes(session.username);
      const prefixChar = (Array.isArray(prefixes) && prefixes.length > 0) ? prefixes[0] : "L";
      const username = await nextL2tpUsername(prefixChar);
      const password = randomL2tpPassword();
      const r = await l2tpApiRequest("/internal/l2tp/create", "POST", { username, password, months: Number(months), createdBy: session.username });
      if (!r.body || !r.body.ok) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "خطا در ایجاد حساب L2TP/OpenVPN", detail: r.body && (r.body.detail || r.body.error) })); return; }
      syncIranL2tpUser([`UserCreate ${username} /GROUP:none /REALNAME:none /NOTE:none`, `UserPasswordSet ${username} /PASSWORD:${password}`]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, username, password, expires: r.body.expiresAt, server: L2TP_SERVER_DOMAIN, psk: L2TP_PSK, openvpnPort: L2TP_OPENVPN_PORT }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "اتصال به سرور L2TP/OpenVPN برقرار نشد: " + e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/l2tp/user-password (admin resets password) ──────
  if (url.pathname === "/api/admin/l2tp/user-password" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    if (session.role === "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی فقط خواندنی است" })); return; }
    try {
      const { username } = await readBody(req);
      if (!username) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "نام کاربری الزامی است" })); return; }
      const filter = ADMIN_ROLES[session.role];
      if (!filter(username)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی غیرمجاز" })); return; }
      const password = randomL2tpPassword();
      const r = await l2tpApiRequest("/internal/l2tp/resetpassword", "POST", { username, password });
      if (!r.body || !r.body.ok) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "خطا در تغییر رمز" })); return; }
      syncIranL2tpUser([`UserPasswordSet ${username} /PASSWORD:${password}`]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, username, password }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: DELETE /api/admin/l2tp/user ──────────────────────────────────────
  if (url.pathname === "/api/admin/l2tp/user" && req.method === "DELETE") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    if (session.role === "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی فقط خواندنی است" })); return; }
    try {
      const { username } = await readBody(req);
      if (!username) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "نام کاربری الزامی است" })); return; }
      const filter = ADMIN_ROLES[session.role];
      if (!filter(username)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی غیرمجاز" })); return; }
      const r = await l2tpApiRequest(`/internal/l2tp/user/${encodeURIComponent(username)}`, "DELETE");
      if (!r.body || !r.body.ok) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "خطا در حذف" })); return; }
      syncIranL2tpUser([`UserDelete ${username}`]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── NahalVPN app accounts: /api/admin/app/* (task 9.1) ─────────────────────
  if (url.pathname.startsWith("/api/admin/app/")) {
    const session = getAdminSession(req);
    if (!session) { sendApp(res, 401, { error: "unauthorized" }); return; }
    const actAs = session.username;
    const op = url.pathname.slice("/api/admin/app/".length);
    const write = req.method !== "GET";
    if (write && session.role === "admin") { sendApp(res, 403, { error: APP_ERRORS.forbidden }); return; }
    const userId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
    try {
      if (op === "users" && req.method === "GET") {
        if (!nahalvpnToken()) { sendApp(res, 200, { ok: true, enabled: false, users: [] }); return; }
        const r = await nahalvpnRequest(actAs, "GET", "/v1/admin/users");
        if (r.status !== 200) { appFailure(res, r, "خطا در دریافت لیست"); return; }
        sendApp(res, 200, { ok: true, enabled: true, users: r.body.users || [], download: NAHALVPN_DOWNLOAD_URL, readonly: session.role === "admin" });
        return;
      }
      if (op === "user" && req.method === "GET") {
        const id = userId(url.searchParams.get("id"));
        if (!id) { sendApp(res, 400, { error: APP_ERRORS.invalid_request }); return; }
        const r = await nahalvpnRequest(actAs, "GET", `/v1/admin/users/${id}`);
        if (r.status !== 200) { appFailure(res, r, "خطا در دریافت اطلاعات"); return; }
        sendApp(res, 200, { ok: true, user: r.body });
        return;
      }
      if (op === "users" && req.method === "POST") {
        const { months, username: wanted } = await readBody(req);
        if (!ALLOWED_PLAN_MONTHS.includes(Number(months))) { sendApp(res, 400, { error: "پلن نامعتبر است" }); return; }
        let username = typeof wanted === "string" ? wanted.trim() : "";
        if (username && !/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
          sendApp(res, 400, { error: "نام کاربری باید ۳ تا ۳۲ حرف انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد" }); return;
        }
        if (!username) {
          const list = await nahalvpnRequest(actAs, "GET", "/v1/admin/users");
          if (list.status !== 200) { appFailure(res, list, "خطا در ساخت حساب"); return; }
          const prefixes = getUserPrefixes(session.username);
          username = nextAppUsername((Array.isArray(prefixes) && prefixes[0]) || "n", list.body.users || []);
        }
        const password = randomAppPassword();
        const r = await nahalvpnRequest(actAs, "POST", "/v1/admin/users",
          { username, password, plan: { days: 30 * Number(months), months: Number(months) } });
        if (r.status !== 201) { appFailure(res, r, "خطا در ساخت حساب"); return; }
        sendApp(res, 200, { ok: true, user: r.body, password, download: NAHALVPN_DOWNLOAD_URL });
        return;
      }
      if (op === "renew" && req.method === "POST") {
        const { id, months } = await readBody(req);
        if (!userId(id) || !ALLOWED_PLAN_MONTHS.includes(Number(months))) { sendApp(res, 400, { error: "پلن نامعتبر است" }); return; }
        const r = await nahalvpnRequest(actAs, "POST", `/v1/admin/users/${userId(id)}/renew`, { days: 30 * Number(months), months: Number(months) });
        if (r.status !== 200) { appFailure(res, r, "خطا در تمدید"); return; }
        sendApp(res, 200, { ok: true, user: r.body });
        return;
      }
      if ((op === "disable" || op === "enable") && req.method === "POST") {
        const { id } = await readBody(req);
        if (!userId(id)) { sendApp(res, 400, { error: APP_ERRORS.invalid_request }); return; }
        const r = await nahalvpnRequest(actAs, "POST", `/v1/admin/users/${userId(id)}/${op}`);
        if (r.status !== 204) { appFailure(res, r, "خطا در تغییر وضعیت"); return; }
        sendApp(res, 200, { ok: true });
        return;
      }
      if (op === "password" && req.method === "POST") {
        const { id } = await readBody(req);
        if (!userId(id)) { sendApp(res, 400, { error: APP_ERRORS.invalid_request }); return; }
        const password = randomAppPassword();
        const r = await nahalvpnRequest(actAs, "POST", `/v1/admin/users/${userId(id)}/password`, { password });
        if (r.status !== 204) { appFailure(res, r, "خطا در تغییر رمز"); return; }
        sendApp(res, 200, { ok: true, password });
        return;
      }
      // Outage notice shown as a modal in every app; nahalvpn-api decides who may change it (the owner).
      if (op === "notice" && req.method === "GET") {
        const r = await nahalvpnRequest(actAs, "GET", "/v1/admin/notice");
        if (r.status !== 200) { appFailure(res, r, "خطا در دریافت وضعیت اطلاعیه"); return; }
        sendApp(res, 200, { ok: true, notice: r.body });
        return;
      }
      if (op === "notice" && req.method === "POST") {
        const { active, message } = await readBody(req);
        if (typeof active !== "boolean" || (message !== undefined && (typeof message !== "string" || message.length > 500))) {
          sendApp(res, 400, { error: APP_ERRORS.invalid_request }); return;
        }
        const r = await nahalvpnRequest(actAs, "PUT", "/v1/admin/notice", { active, ...(message ? { message } : {}) });
        if (r.status !== 200) { appFailure(res, r, "خطا در تغییر اطلاعیه"); return; }
        sendApp(res, 200, { ok: true, notice: r.body });
        return;
      }
      // Backups of the app's users (owner only; nahalvpn-api says who the owner is). Restoring stays a server-side
      // script on purpose: one wrong click in a panel would roll every user back.
      if (op === "backups" || op === "backup-now" || op === "backup-download") {
        const me = await nahalvpnRequest(actAs, "GET", "/v1/admin/me");
        if (me.status !== 200 || me.body.owner !== true) { sendApp(res, 403, { error: "فقط مدیر اصلی به پشتیبان‌ها دسترسی دارد" }); return; }
        const BACKUP_DIR = "/var/backups/nahalvpn";
        const NAME_RE = /^nahalvpn-\d{8}-\d{6}-[a-z0-9-]{1,20}\.tgz$/;
        if (op === "backups" && req.method === "GET") {
          let files = [];
          try {
            files = fs.readdirSync(BACKUP_DIR).filter((f) => NAME_RE.test(f)).map((f) => {
              const st = fs.statSync(path.join(BACKUP_DIR, f));
              return { name: f, size: st.size, time: st.mtimeMs, kind: f.replace(/^nahalvpn-\d{8}-\d{6}-/, "").replace(/\.tgz$/, "") };
            }).sort((a, b) => b.time - a.time);
          } catch {}
          sendApp(res, 200, { ok: true, backups: files });
          return;
        }
        if (op === "backup-now" && req.method === "POST") {
          require("child_process").execFile("/opt/nahalvpn/backup.sh", ["manual"], { timeout: 120000 }, (err, stdout, stderr) => {
            if (err) { sendApp(res, 500, { error: "پشتیبان‌گیری انجام نشد", detail: String(stderr || err.message).slice(0, 300) }); return; }
            sendApp(res, 200, { ok: true, result: String(stdout).trim() });
          });
          return;
        }
        if (op === "backup-download" && req.method === "GET") {
          const file = url.searchParams.get("file") || "";
          if (!NAME_RE.test(file) || !fs.existsSync(path.join(BACKUP_DIR, file))) { sendApp(res, 404, { error: "فایل پیدا نشد" }); return; }
          const full = path.join(BACKUP_DIR, file);
          res.writeHead(200, {
            "Content-Type": "application/gzip", "Content-Length": fs.statSync(full).size,
            "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store",
          });
          fs.createReadStream(full).pipe(res);
          return;
        }
      }
      if (op === "device" && req.method === "DELETE") {
        const { id, deviceId } = await readBody(req);
        if (!userId(id) || typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(deviceId)) { sendApp(res, 400, { error: APP_ERRORS.invalid_request }); return; }
        const r = await nahalvpnRequest(actAs, "DELETE", `/v1/admin/users/${userId(id)}/devices/${deviceId}`);
        if (r.status !== 204) { appFailure(res, r, "خطا در حذف دستگاه"); return; }
        sendApp(res, 200, { ok: true });
        return;
      }
      sendApp(res, 404, { error: "not found" });
    } catch (e) {
      sendApp(res, 502, { error: e.message === "not configured" ? "اپلیکیشن نهال روی این سرور فعال نیست" : "سرویس اپلیکیشن نهال در دسترس نیست" });
    }
    return;
  }

  // ── Admin: GET /api/admin/client-links ─────────────────────────────────────
  if (url.pathname === "/api/admin/client-links" && req.method === "GET") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      const email = url.searchParams.get("email");
      if (!email) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "email required" })); return; }
      const filter = ADMIN_ROLES[session.role];
      if (!filter(email)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "دسترسی غیرمجاز" })); return; }
      // Migrate from old inbound if exists
      await migrateFromOldInbound(email);

      const internalEmail = email + EMAIL_SUFFIX;
      let links = [], subUrl = "";

      const inboundsRes = await getInbounds();
      if (!inboundsRes.success) throw new Error("cannot fetch inbounds");
      for (const inb of inboundsRes.obj) {
        const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
        const cl = (settings.clients || []).find((c) => c.email === internalEmail);
        if (cl) {
          const link = buildClientLink(inb, cl.uuid || cl.id, email, cl);
          if (link) links.push(link);
          if (cl.subId) {
            subUrl = `https://sub.${XUI_DOMAIN}:${XUI_SUB_PORT}/sub/${cl.subId}`;
          }
          break;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, links, subUrl }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: GET /api/admin/traffic-history ────────────────────────────────────
  if (url.pathname === "/api/admin/traffic-history" && req.method === "GET") {
    const session = getAdminSession(req);
    if (!session) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      const { execSync } = require("child_process");
      const py = `
import sqlite3, json, time

SNAP_DB = "/opt/client-panel/traffic_snapshots.db"
XUI_DB = "/etc/x-ui/x-ui.db"

now = int(time.time())
periods = {"1h": 3600, "5h": 18000, "12h": 43200, "24h": 86400, "7d": 604800}

snap_conn = sqlite3.connect(SNAP_DB)
sc = snap_conn.cursor()

# Get current traffic (latest snapshot or live)
xui_conn = sqlite3.connect(XUI_DB)
xc = xui_conn.cursor()
xc.execute("SELECT id FROM inbounds WHERE remark='${ACTIVE_INBOUND_REMARK}'")
inb_row = xc.fetchone()
active_inbound_id = inb_row[0] if inb_row else 30
xc.execute("SELECT email, up, down FROM client_traffics WHERE inbound_id=?", (active_inbound_id,))
current = {r[0]: r[1]+r[2] for r in xc.fetchall()}
xui_conn.close()

result = {}
for label, secs in periods.items():
    target_ts = now - secs
    # Find closest snapshot to target time
    sc.execute("SELECT id, timestamp FROM snapshots WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1", (target_ts,))
    row = sc.fetchone()
    if not row:
        result[label] = None
        continue
    snap_id, snap_ts = row
    sc.execute("SELECT email, up+down FROM snapshot_data WHERE snapshot_id=?", (snap_id,))
    old = {r[0]: r[1] for r in sc.fetchall()}
    # Calc per-email delta
    deltas = {}
    for email, cur_total in current.items():
        old_total = old.get(email, cur_total)
        diff = cur_total - old_total
        if diff < 0: diff = 0
        deltas[email] = diff
    result[label] = {"deltas": deltas, "snap_age": now - snap_ts}

snap_conn.close()
print(json.dumps(result))
`.trim();
      const raw = execSync("python3 -c '" + py.replace(/'/g, "'\\''") + "'", { timeout: 15000 }).toString().trim();
      const periodData = JSON.parse(raw);

      // Build admin roles and calculate per-admin totals
      const allRoles = { ...BUILTIN_ADMINS, ...loadAdminRoles() };
      const adminTotals = {};
      for (const [admin, cfg] of Object.entries(allRoles)) {
        if (admin === "admin") continue; // skip readonly admin
        adminTotals[admin] = { prefixes: cfg.prefixes };
        for (const [period, data] of Object.entries(periodData)) {
          if (!data) { adminTotals[admin][period] = null; continue; }
          const filter = buildFilter(cfg.prefixes, admin, allRoles);
          let total = 0, clientCount = 0;
          for (const [email, delta] of Object.entries(data.deltas)) {
            const displayEmail = email.replace(new RegExp(EMAIL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), "");
            if (filter(displayEmail)) { total += delta; clientCount++; }
          }
          adminTotals[admin][period] = { bytes: total, gb: +(total / 1073741824).toFixed(2), clients: clientCount, snap_age: data.snap_age };
        }
      }

      // Also calculate grand total
      const grandTotal = {};
      for (const [period, data] of Object.entries(periodData)) {
        if (!data) { grandTotal[period] = null; continue; }
        let total = 0;
        for (const delta of Object.values(data.deltas)) total += delta;
        grandTotal[period] = { bytes: total, gb: +(total / 1073741824).toFixed(2), snap_age: data.snap_age };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, admins: adminTotals, total: grandTotal }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: GET/POST/DELETE /api/admin/subdomains ──────────────────────────
  if (url.pathname === "/api/admin/subdomains" && (req.method === "GET" || req.method === "POST" || req.method === "DELETE")) {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    if (req.method === "GET") {
      const subs = loadSubdomains();
      const allRoles = { ...BUILTIN_ADMINS, ...loadAdminRoles() };
      const admins = Object.entries(allRoles)
        .filter(([u, cfg]) => u !== "admin")
        .map(([u, cfg]) => ({ username: u, prefixes: cfg.prefixes, subdomains: subs[u] || [] }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, admins, domain: XUI_DOMAIN }));
      return;
    }
    // POST: add a subdomain for an admin
    const body = await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(JSON.parse(d))); });
    const { username, subdomain } = body;
    if (!username) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "username required" })); return; }
    if (!subdomain || subdomain.trim() === "") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "subdomain required" })); return; }
    const current = loadSubdomains();
    if (!current[username]) current[username] = [];
    const sub = subdomain.trim().toLowerCase();
    if (!current[username].includes(sub)) current[username].push(sub);
    saveSubdomains(current);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Admin: DELETE /api/admin/subdomain-remove ───────────────────────────────
  if (url.pathname === "/api/admin/subdomain-remove" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    const body = await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(JSON.parse(d))); });
    const { username, subdomain } = body;
    if (!username) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "username required" })); return; }
    const current = loadSubdomains();
    if (current[username]) {
      current[username] = current[username].filter(s => s !== subdomain);
      if (current[username].length === 0) delete current[username];
    }
    saveSubdomains(current);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Admin: GET /api/admin/backups ───────────────────────────────────────────
  if (url.pathname === "/api/admin/backups" && req.method === "GET") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    try {
      const backupDir = "/opt/client-panel/backups";
      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith("xui-") && f.endsWith(".db"))
        .map(f => {
          const stat = fs.statSync(path.join(backupDir, f));
          return { name: f, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, backups: files }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: POST /api/admin/sync-traffic-to-cdn ──────────────────
  // Copies traffic (up/down) from N inbound to Arvan-CDN inbound for all matching clients
  if (url.pathname === "/api/admin/sync-traffic-to-cdn" && req.method === "POST") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    try {
      const { execSync } = require("child_process");
      // Get inbound IDs
      const inboundsOut = execSync('sqlite3 /etc/x-ui/x-ui.db "SELECT id, remark FROM inbounds;"', { timeout: 5000 }).toString().trim();
      let nId = null, cdnId = null;
      for (const line of inboundsOut.split("\n")) {
        const [id, remark] = line.split("|");
        if (remark === "N") nId = id;
        else if (remark === "Arvan-CDN") cdnId = id;
      }
      if (!nId || !cdnId) throw new Error("Could not find both N and Arvan-CDN inbounds");

      // Get N traffic
      const nTrafficOut = execSync(`sqlite3 /etc/x-ui/x-ui.db "SELECT email, up, down FROM client_traffics WHERE inbound_id=${nId};"`, { timeout: 5000 }).toString().trim();
      // Get CDN emails
      const cdnEmailsOut = execSync(`sqlite3 /etc/x-ui/x-ui.db "SELECT email FROM client_traffics WHERE inbound_id=${cdnId};"`, { timeout: 5000 }).toString().trim();
      const cdnEmails = new Set(cdnEmailsOut.split("\n").map(e => e.trim()).filter(Boolean));

      const results = [];
      for (const line of nTrafficOut.split("\n")) {
        if (!line.trim()) continue;
        const [email, upStr, downStr] = line.split("|");
        const up = parseInt(upStr) || 0;
        const down = parseInt(downStr) || 0;
        if (cdnEmails.has(email) && (up > 0 || down > 0)) {
          const safe = email.replace(/'/g, "''");
          execSync(`sqlite3 /etc/x-ui/x-ui.db "UPDATE client_traffics SET up = ${up}, down = ${down} WHERE email = '${safe}' AND inbound_id = ${cdnId};"`, { timeout: 5000 });
          results.push({ email, gb: ((up + down) / 1073741824).toFixed(2) });
        }
      }
      console.log(`[sync-traffic] Synced ${results.length} clients from N to Arvan-CDN`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, synced: results.length, details: results }));
    } catch (e) {
      console.error("[sync-traffic] Error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Admin: GET /api/admin/backup-download?file=xui-xxx.db ──────────────────
  if (url.pathname === "/api/admin/backup-download" && req.method === "GET") {
    const session = getAdminSession(req);
    if (!session || session.role !== "admin") { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "فقط مدیر اصلی" })); return; }
    const file = url.searchParams.get("file");
    if (!file || !/^xui-\d{8}-\d{6}\.db$/.test(file)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid filename" }));
      return;
    }
    const filePath = path.join("/opt/client-panel/backups", file);
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Content-Length": stat.size,
      });
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "file not found" }));
    }
    return;
  }

  // ── /api/client?email=xxx ──────────────────────────────────────────────────
  if (url.pathname === "/api/client" && url.searchParams.get("email")) {
    try {
      const email = url.searchParams.get("email");
      // Migrate from old inbound if exists
      await migrateFromOldInbound(email);
      const internalEmail = email + EMAIL_SUFFIX;
      const [trafficRes, inboundsRes, onlineRes] = await Promise.all([
        withAuth(() => xuiRequest("/panel/api/clients/traffic/" + encodeURIComponent(internalEmail))),
        getInbounds(),
        withAuth(() => xuiRequest("/panel/api/clients/onlines", "POST")),
      ]);

      // trafficRes (getClientTraffics) is the authoritative source for up/down bytes
      const traffic = trafficRes.success && trafficRes.obj ? trafficRes.obj : null;

      let clientInfo = null;
      if (inboundsRes.success && inboundsRes.obj) {
        for (const inb of inboundsRes.obj) {
          const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
          for (const cl of settings.clients || []) {
            if (cl.email === internalEmail) {
              const stats = (inb.clientStats || []).find((s) => s.email === internalEmail);
              clientInfo = {
                email, uuid: cl.id,
                // Prefer dedicated traffic endpoint for up/down — clientStats can be stale/zero
                up:   traffic?.up   ?? stats?.up   ?? 0,
                down: traffic?.down ?? stats?.down ?? 0,
                // totalGB in 3x-ui is stored in bytes (misleading name) — use traffic.total which is always bytes
                total: traffic?.total ?? stats?.total ?? 0,
                expiryTime: cl.expiryTime || 0,
                enable: stats?.enable !== false,
                port: inb.port, remark: inb.remark, protocol: inb.protocol,
                online: onlineRes.success && onlineRes.obj ? onlineRes.obj.includes(internalEmail) : false,
              };
              break;
            }
          }
          if (clientInfo) break;
        }
      }
      if (!clientInfo && traffic) {
        clientInfo = { email: traffic.email, up: traffic.up || 0, down: traffic.down || 0,
          total: traffic.total || 0, expiryTime: traffic.expiryTime || 0, enable: traffic.enable !== false, online: false };
      }
      res.writeHead(clientInfo ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(clientInfo || { error: "not_found" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /api/client-by-uuid?uuid=xxx ──────────────────────────────────────────
  if (url.pathname === "/api/client-by-uuid" && url.searchParams.get("uuid")) {
    try {
      const uuid = url.searchParams.get("uuid");
      const [inboundsRes, onlineRes] = await Promise.all([
        getInbounds(),
        withAuth(() => xuiRequest("/panel/api/clients/onlines", "POST")),
      ]);

      let clientInfo = null;
      if (inboundsRes.success && inboundsRes.obj) {
        for (const inb of inboundsRes.obj) {
          // Search clientStats first (uuid field is always populated and faster)
          const statByUuid = (inb.clientStats || []).find((s) => s.uuid === uuid);
          if (statByUuid) {
            // Also get email-level settings for expiryTime
            let expiryTime = 0;
            try {
              const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
              const cl = (settings.clients || []).find((c) => c.id === uuid);
              expiryTime = cl?.expiryTime || 0;
            } catch {}
            // Fetch fresh traffic via dedicated endpoint
            const trafficRes = await withAuth(() =>
              xuiRequest("/panel/api/clients/traffic/" + encodeURIComponent(statByUuid.email))
            );
            const traffic = trafficRes.success && trafficRes.obj ? trafficRes.obj : null;
            clientInfo = {
              email: statByUuid.email.replace(new RegExp(EMAIL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), ""), uuid,
              up:    traffic?.up    ?? statByUuid.up    ?? 0,
              down:  traffic?.down  ?? statByUuid.down  ?? 0,
              total: traffic?.total ?? statByUuid.total ?? 0,
              expiryTime, enable: statByUuid.enable !== false,
              port: inb.port, remark: inb.remark, protocol: inb.protocol,
              online: onlineRes.success && onlineRes.obj ? onlineRes.obj.includes(statByUuid.email) : false,
            };
            break;
          }
        }
        // Fallback: search settings.clients if not found in clientStats
        if (!clientInfo) {
          for (const inb of inboundsRes.obj) {
            try {
              const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
              const cl = (settings.clients || []).find((c) => c.id === uuid);
              if (cl) {
                const stats = (inb.clientStats || []).find((s) => s.email === cl.email);
                clientInfo = {
                  email: cl.email, uuid: cl.id,
                  up: stats?.up || 0, down: stats?.down || 0,
                  total: stats?.total || 0,
                  expiryTime: cl.expiryTime || 0, enable: stats?.enable !== false,
                  port: inb.port, remark: inb.remark, protocol: inb.protocol,
                  online: onlineRes.success && onlineRes.obj ? onlineRes.obj.includes(cl.email) : false,
                };
                break;
              }
            } catch {}
          }
        }
      }
      res.writeHead(clientInfo ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(clientInfo || { error: "not_found" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /api/client-by-ss?password=xxx ────────────────────────────────────────
  if (url.pathname === "/api/client-by-ss" && url.searchParams.get("password")) {
    try {
      const ssPassword = url.searchParams.get("password");
      const [inboundsRes, onlineRes] = await Promise.all([
        getInbounds(),
        withAuth(() => xuiRequest("/panel/api/clients/onlines", "POST")),
      ]);

      let clientInfo = null;
      if (inboundsRes.success && inboundsRes.obj) {
        for (const inb of inboundsRes.obj) {
          if (inb.protocol !== "shadowsocks") continue;
          try {
            const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));

            for (const cl of settings.clients || []) {
              if (cl.password === ssPassword) {
                const stats = (inb.clientStats || []).find((s) => s.email === cl.email);
                // Fetch fresh traffic
                const trafficRes = await withAuth(() =>
                  xuiRequest("/panel/api/clients/traffic/" + encodeURIComponent(cl.email))
                );
                const traffic = trafficRes.success && trafficRes.obj ? trafficRes.obj : null;
                clientInfo = {
                  email: cl.email,
                  up:    traffic?.up    ?? stats?.up    ?? 0,
                  down:  traffic?.down  ?? stats?.down  ?? 0,
                  total: traffic?.total ?? stats?.total ?? 0,
                  expiryTime: cl.expiryTime || 0,
                  enable: stats?.enable !== false,
                  port: inb.port, remark: inb.remark, protocol: inb.protocol,
                  online: onlineRes.success && onlineRes.obj ? onlineRes.obj.includes(cl.email) : false,
                };
                break;
              }
            }
          } catch {}
          if (clientInfo) break;
        }
      }
      res.writeHead(clientInfo ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(clientInfo || { error: "not_found" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /api/migrate (POST) ──────────────────────────────────────────────────
  if (url.pathname === "/api/migrate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { email } = JSON.parse(body);
        if (!email) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "email required" })); return; }

        const TARGET_NAME = "Star";
        const TARGET_PORT = 80;

        const inboundsRes = await getInbounds();
        if (!inboundsRes.success) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "cannot fetch inbounds" })); return; }

        // Find client's current inbound
        let srcInbound = null, srcClient = null;
        for (const inb of inboundsRes.obj) {
          const settings = (typeof inb.settings === "string" ? JSON.parse(inb.settings || "{}") : (inb.settings || {}));
          for (const cl of settings.clients || []) {
            if (cl.email === email) { srcInbound = inb; srcClient = cl; break; }
          }
          if (srcClient) break;
        }
        if (!srcClient) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "client_not_found" })); return; }

        // Already on target inbound — no migration needed
        if (srcInbound.remark === TARGET_NAME && srcInbound.port === TARGET_PORT) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "already_on_target" }));
          return;
        }

        // Find target inbound by name "Star" on port 80
        const targetInbound = inboundsRes.obj.find((inb) => inb.remark === TARGET_NAME && inb.port === TARGET_PORT);
        if (!targetInbound) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "target_inbound_not_found", targetName: TARGET_NAME, targetPort: TARGET_PORT })); return; }

        // Get fresh traffic data
        const trafficRes = await withAuth(() => xuiRequest("/panel/api/clients/traffic/" + encodeURIComponent(email)));
        const traffic = trafficRes.success && trafficRes.obj ? trafficRes.obj : null;
        const stats = (srcInbound.clientStats || []).find((s) => s.email === email);
        const up = traffic?.up ?? stats?.up ?? 0;
        const down = traffic?.down ?? stats?.down ?? 0;
        const total = traffic?.total ?? stats?.total ?? 0;
        // Use minimum 1 byte — totalGB:0 means unlimited in x-ui
        const remaining = Math.max(1, total - (up + down));

        // Check if client already exists in target inbound (check both original and R-suffixed email)
        const newEmail = email + "R";
        const targetSettings = (typeof targetInbound.settings === "string" ? JSON.parse(targetInbound.settings || "{}") : (targetInbound.settings || {}));
        const existingClient = (targetSettings.clients || []).find((c) => c.email === email || c.email === newEmail);
        if (existingClient) {
          const link = buildClientLink(targetInbound, existingClient.uuid || existingClient.id, existingClient.email, existingClient);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "already_migrated", target: targetInbound.remark, link }));
          return;
        }

        // Create new client in target inbound
        const newClient = {
          id: crypto.randomUUID(),
          flow: "",
          email: newEmail,
          limitIp: srcClient.limitIp || 0,
          totalGB: remaining,
          expiryTime: srcClient.expiryTime || 0,
          enable: true,
          tgId: 0,
          subId: "",
          reset: 0,
          comment: "",
        };

        const addPayload = { client: newClient, inboundIds: [targetInbound.id] };
        console.log("[migrate] addClient payload:", JSON.stringify(addPayload));
        const addRes = await withAuth(() => xuiRequest("/panel/api/clients/add", "POST", addPayload));
        console.log("[migrate] addClient response:", JSON.stringify(addRes));

        if (addRes.success) {
          const link = buildClientLink(targetInbound, newClient.uuid || newClient.id, newEmail, newClient);
          console.log("[migrate] link:", link ? link.substring(0, 100) : "null (buildClientLink failed)");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, target: targetInbound.remark, targetPort, remaining, link }));
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "add_failed", msg: addRes.msg || JSON.stringify(addRes) }));
        }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── /api/admin ─────────────────────────────────────────────────────────────
  if (url.pathname === "/api/admin") {
    if (!adminCache.data) await refreshAdminData();
    if (adminCache.data) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(adminCache.data));
    } else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "خطا در دریافت اطلاعات از x-ui" }));
    }
    return;
  }

  // ── /api/sub ───────────────────────────────────────────────────────────────
  if (url.pathname === "/api/sub") {
    const token = url.searchParams.get("token");
    if (!token) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "missing token" })); return; }
    try {
      // Fetch subscription via x-ui API (sub server on 2096 has CSRF issues in v3+)
      const apiRes = await withAuth(() => xuiRequest(`/panel/api/clients/subLinks/${encodeURIComponent(token)}`));
      if (!apiRes.success || !Array.isArray(apiRes.obj)) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no configs found" })); return; }
      const links = apiRes.obj.map(l => l.trim()).filter(l => l.startsWith("vless://") || l.startsWith("ss://") || l.startsWith("vmess://") || l.startsWith("trojan://"));

      if (!links.length) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no configs found" })); return; }

      // Extract email from first link remark (format: INBOUND_REMARK-EMAIL-443)
      const firstRemark = decodeURIComponent((links[0].split("#")[1] || "")).trim();
      // Remove inbound remark prefix and -443 suffix to get display email
      const remarkParts = firstRemark.replace(new RegExp("^" + ACTIVE_INBOUND_REMARK + "-"), "");
      const internalEmail = remarkParts; // e.g. "C1-443"
      const email = internalEmail.replace(new RegExp(EMAIL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), ""); // display: "C1"

      // Migrate from old inbound if exists
      await migrateFromOldInbound(email);

      // Fetch traffic from x-ui using internal email
      const [trafficRes, inboundsRes] = await Promise.all([
        withAuth(() => xuiRequest("/panel/api/clients/traffic/" + encodeURIComponent(internalEmail))),
        getInbounds(),
      ]);

      let clientInfo = null;
      if (trafficRes?.obj) {
        const t = trafficRes.obj;
        clientInfo = { email: t.email, up: t.up, down: t.down, total: t.total, expiryTime: t.expiryTime, enable: t.enable };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ links, email, client: clientInfo }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /api/status ────────────────────────────────────────────────────────────
  if (url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      online: serverOnline,
      offline: isConfirmedOffline(),
    }));
    return;
  }

  // ── /sub/:token or /secretsub/:token — subscription endpoint ────────────────
  const subShortcut = url.pathname.match(/^\/(sub|secretsub)\/([a-zA-Z0-9]+)$/);
  if (subShortcut) {
    const token = subShortcut[2];
    try {
      const apiRes = await withAuth(() => xuiRequest(`/panel/api/clients/subLinks/${encodeURIComponent(token)}`));
      if (!apiRes.success || !Array.isArray(apiRes.obj) || apiRes.obj.length === 0) {
        res.writeHead(404); res.end(""); return;
      }
      const links = apiRes.obj.join("\n");
      // Rewrite domains in subscription links based on client email prefix
      const rewritten = links.split("\n").map(line => {
        if (!line.startsWith("vless://")) return line;
        const remarkPart = decodeURIComponent((line.split("#")[1] || "")).replace(new RegExp("^(" + MANAGED_INBOUND_REMARKS.join("|") + ")-"), "").replace(/-[\d.]+GB.*$/, "").replace(new RegExp(EMAIL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), "");
        const clientDomain = getSubdomainForEmail(remarkPart);
        if (clientDomain !== XUI_DOMAIN) {
          return line.replace(/@[^:]+:/, `@${clientDomain}:`).replace(/host=[^&]*/, `host=${clientDomain}`);
        }
        return line;
      }).join("\n");

      const ua = (req.headers["user-agent"] || "").toLowerCase();
      const isBrowser = ua.includes("mozilla") || ua.includes("chrome") || ua.includes("safari") || ua.includes("edge");

      if (isBrowser) {
        // Browser → render x-ui style subscription page (no redirect)
        const linksList = rewritten.split("\n").filter(l => l.trim());
        const subUrl = `https://${req.headers.host || XUI_DOMAIN}${url.pathname}`;
        // Get client info for display
        let clientName = "", trafficInfo = "";
        if (linksList.length > 0) {
          const remark = decodeURIComponent((linksList[0].split("#")[1] || ""));
          clientName = remark.replace(new RegExp("^(" + MANAGED_INBOUND_REMARKS.join("|") + ")-"), "").replace(/-[\d.]+GB.*$/, "");
          trafficInfo = (remark.match(/([\d.]+GB)/)?.[1]) || "";
        }
        const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>اشتراک ${clientName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a2e;color:#e0e0e0;font-family:Tahoma,sans-serif;padding:20px}
.container{max-width:600px;margin:0 auto}
h1{color:#6c63ff;font-size:1.4em;margin-bottom:8px;text-align:center}
.info{text-align:center;color:#888;margin-bottom:20px;font-size:.9em}
.sub-box{background:#16213e;border:1px solid #6c63ff33;border-radius:12px;padding:16px;margin-bottom:16px}
.sub-label{color:#6c63ff;font-size:.85em;margin-bottom:8px}
.sub-url{background:#0f3460;border-radius:8px;padding:10px;word-break:break-all;font-size:.8em;color:#a0d2db;margin-bottom:10px;direction:ltr;text-align:left}
.link-box{background:#0f3460;border-radius:8px;padding:10px;margin-bottom:8px;word-break:break-all;font-size:.75em;color:#ccc;direction:ltr;text-align:left}
.link-name{color:#6c63ff;font-size:.85em;margin-bottom:4px;direction:rtl}
.btn{display:inline-block;background:#6c63ff;color:#fff;border:none;padding:8px 20px;border-radius:8px;cursor:pointer;font-size:.85em;margin:4px}
.btn:hover{background:#5a52d5}
.btn-copy{background:#2d4a7a;font-size:.8em;padding:6px 14px}
.btn-copy:hover{background:#3d5a8a}
.copied{background:#27ae60!important}
</style>
</head>
<body>
<div class="container">
<h1>🔐 ${clientName}</h1>
<div class="info">${trafficInfo ? "ترافیک: " + trafficInfo : ""}</div>
<div class="sub-box">
<div class="sub-label">📋 لینک اشتراک (Subscription URL)</div>
<div class="sub-url" id="subUrl">${subUrl}</div>
<button class="btn" onclick="copyText('subUrl',this)">کپی لینک اشتراک</button>
</div>
${linksList.map((link, i) => {
  const name = decodeURIComponent((link.split("#")[1] || "config " + (i+1)));
  return `<div class="sub-box">
<div class="link-name">${name}</div>
<div class="link-box" id="link${i}">${link}</div>
<button class="btn btn-copy" onclick="copyText('link${i}',this)">کپی</button>
</div>`;
}).join("\n")}
</div>
<script>
function copyText(id,btn){
  const t=document.getElementById(id).innerText;
  navigator.clipboard.writeText(t).then(()=>{btn.classList.add('copied');btn.textContent='✓ کپی شد';setTimeout(()=>{btn.classList.remove('copied');btn.textContent='کپی';},2000)}).catch(()=>{
    const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);btn.textContent='✓';setTimeout(()=>btn.textContent='کپی',2000);
  });
}
</script>
</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } else {
        // V2Ray/Clash app → base64 encoded links
        const encoded = Buffer.from(rewritten).toString("base64");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(encoded);
      }
    } catch {
      res.writeHead(502); res.end("subscription unavailable");
    }
    return;
  }

  // ── Tutorial page ──────────────────────────────────────────────────────────
  if (url.pathname === "/tutorial" || url.pathname === "/tutorial/") {
    const tutorialPath = path.join(PUBLIC_DIR, "../tutorial.html");
    try {
      const html = fs.readFileSync(tutorialPath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }
  if (url.pathname === "/tutorial/video.mp4") {
    const videoPath = "/opt/client-panel/public/tutorial/video.mp4";
    let stat;
    try { stat = fs.statSync(videoPath); } catch { res.writeHead(404); res.end("Not found"); return; }
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Type": "video/mp4" });
      fs.createReadStream(videoPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" });
      fs.createReadStream(videoPath).pipe(res);
    }
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────────
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  const ext = path.extname(filePath);
  const serveFile = (fp, ct) => {
    let content;
    try { content = fs.readFileSync(fp); } catch { return false; }
    const acceptsGzip = (req.headers["accept-encoding"] || "").includes("gzip");
    // Cache static assets for 1 day; index.html no-cache so updates are instant
    const isHtml = ct === "text/html";
    const cacheControl = isHtml ? "no-cache" : "public, max-age=86400, immutable";
    if (acceptsGzip) {
      zlib.gzip(content, (err, compressed) => {
        if (err) {
          res.writeHead(200, { "Content-Type": ct, "Cache-Control": cacheControl });
          res.end(content);
        } else {
          res.writeHead(200, { "Content-Type": ct, "Content-Encoding": "gzip", "Cache-Control": cacheControl, "Vary": "Accept-Encoding" });
          res.end(compressed);
        }
      });
    } else {
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": cacheControl });
      res.end(content);
    }
    return true;
  };

  if (!serveFile(filePath, MIME[ext] || "application/octet-stream")) {
    // SPA fallback
    if (!serveFile(path.join(PUBLIC_DIR, "index.html"), "text/html")) {
      res.writeHead(404); res.end("Not Found");
    }
  }
});

// Sub server on port 2096 — only start if port is not already in use (x-ui sub may occupy it)
const SUB_CERT_PATH = "/etc/x-ui/cert/fullchain.crt";
const SUB_KEY_PATH = "/etc/x-ui/cert/private.key";
let subServer;
try {
  const subOpts = { cert: fs.readFileSync(SUB_CERT_PATH), key: fs.readFileSync(SUB_KEY_PATH) };
  subServer = https.createServer(subOpts, server.listeners("request")[0]);
  console.log("[client-panel] Sub server using HTTPS with x-ui cert");
} catch (e) {
  console.warn("[warn] Cannot load TLS cert for sub server, falling back to HTTP:", e.message);
  subServer = require("http").createServer(server.listeners("request")[0]);
}

// Handle port conflict gracefully (x-ui sub may already use 2096)
subServer.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.log(`[client-panel] Port ${XUI_SUB_PORT} already in use (x-ui sub), skipping sub server`);
  else console.error("[error] Sub server error:", e.message);
});

const _mainHandler = server.listeners("request")[0];
let mainServer;
try {
  mainServer = https.createServer({ cert: fs.readFileSync(SUB_CERT_PATH), key: fs.readFileSync(SUB_KEY_PATH) }, _mainHandler);
  console.log("[client-panel] Main panel using HTTPS");
} catch (e) {
  console.warn("[warn] Main panel HTTPS cert load failed, using HTTP:", e.message);
  mainServer = server;
}
// The `client_inbounds` table heuristic above is not a reliable predictor of which
// HTTP route surface a given x-ui build exposes -- confirmed in production: a x-ui
// 2.9.3 box has that table (schema looks "new") but /panel/api/clients/add still 404s;
// only the old-style /panel/api/inbounds/addClient works there. A live probe right
// after login, before the server starts accepting real traffic, self-corrects this
// regardless of which x-ui fork/version ends up on any given box.
function probeNewApiExists() {
  return new Promise((resolve) => {
    const url = new URL(XUI_BASE + "/panel/api/clients/add", XUI_URL);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Cookie: sessionCookie, Host: XUI_HOST },
      rejectUnauthorized: false,
    };
    const req = (XUI_URL.startsWith("http://") ? http : https).request(opts, (res) => {
      res.resume(); // only the status code matters, discard the body
      resolve(res.statusCode !== 404);
    });
    req.on("error", () => resolve(!OLD_XUI_API)); // on probe failure, keep the existing guess
    req.write("{}");
    req.end();
  });
}

// Pure sales-accounting helpers, exported for panel/tests/sold-stats.test.js.
module.exports = { entryOrders, aggregateSoldStats, buildCreatedMap, pickCreateInbound, parseDaysParam, nextAppUsername, randomAppPassword };

// Only boot the servers when run directly (systemd: `node /opt/client-panel/server.js`).
// Requiring this file from a test must not log into x-ui or bind 2095/2096.
if (require.main === module) {
login()
  .then(async (ok) => {
    if (!ok) console.warn("[warn] Initial x-ui login failed — will retry on first request");
    else {
      const newApiWorks = await probeNewApiExists();
      const shouldBeOld = !newApiWorks;
      if (shouldBeOld !== OLD_XUI_API) {
        console.log(`[xui] API probe corrected detection: OLD_XUI_API ${OLD_XUI_API} -> ${shouldBeOld}`);
        OLD_XUI_API = shouldBeOld;
      }
    }
    mainServer.listen(PORT, "0.0.0.0", () =>
      console.log(`[client-panel] Listening on port ${PORT}`)
    );
    subServer.listen(XUI_SUB_PORT, "0.0.0.0", () =>
      console.log(`[client-panel] Sub server listening on port ${XUI_SUB_PORT}`)
    );
  })
  .catch((err) => {
    console.error("[error] Cannot reach x-ui:", err.message);
    mainServer.listen(PORT, "0.0.0.0", () =>
      console.log(`[client-panel] Listening on port ${PORT} (x-ui unreachable)`)
    );
    subServer.listen(XUI_SUB_PORT, "0.0.0.0", () =>
      console.log(`[client-panel] Sub server listening on port ${XUI_SUB_PORT}`)
    );
  });
}
