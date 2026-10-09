import Database from "better-sqlite3";

export type Db = Database.Database;

/**
 * Ordered, append-only migrations. Never edit an applied migration; add a new one.
 * Timestamps are epoch milliseconds. Byte counters are integers.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    owner         TEXT NOT NULL,              -- admin/reseller name that created the user
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE subscriptions (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    expires_at   INTEGER NOT NULL,
    quota_bytes  INTEGER,                     -- NULL = unlimited
    device_limit INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE sales (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner      TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('create','renew')),
    months     INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE devices (
    id           TEXT PRIMARY KEY,            -- server-generated UUID
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_key   TEXT NOT NULL,               -- stable ID reported by the app
    name         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at   INTEGER
  );
  CREATE INDEX devices_user ON devices(user_id);
  CREATE TABLE refresh_tokens (
    id         INTEGER PRIMARY KEY,
    device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    family_id  TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX refresh_tokens_device ON refresh_tokens(device_id);
  CREATE TABLE login_failures (
    username TEXT NOT NULL COLLATE NOCASE,
    at       INTEGER NOT NULL
  );
  CREATE INDEX login_failures_user ON login_failures(username, at);
  CREATE TABLE locations (
    id          TEXT PRIMARY KEY,             -- e.g. 'de'
    country     TEXT NOT NULL,                -- ISO 3166-1 alpha-2
    name_en     TEXT NOT NULL,
    name_fa     TEXT NOT NULL,
    protocols   TEXT NOT NULL,                -- JSON array: ["vless","openvpn"]
    tunnel_port INTEGER NOT NULL,             -- gateway-local port of the location's reverse tunnel
    enabled     INTEGER NOT NULL DEFAULT 1,
    healthy     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE credentials (
    id          TEXT PRIMARY KEY,             -- VLESS UUID or OpenVPN credential id
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    protocol    TEXT NOT NULL CHECK (protocol IN ('vless','openvpn')),
    secret_hash TEXT,                         -- OpenVPN password hash; NULL for VLESS
    created_at  INTEGER NOT NULL,
    revoked_at  INTEGER
  );
  CREATE INDEX credentials_device ON credentials(device_id);
  CREATE TABLE usage_samples (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL,
    protocol    TEXT NOT NULL,
    up_bytes    INTEGER NOT NULL,
    down_bytes  INTEGER NOT NULL,
    at          INTEGER NOT NULL
  );
  CREATE INDEX usage_samples_user ON usage_samples(user_id, at);
  CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY,
    at     INTEGER NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
  `,
  // 2: per-location gateway inbound details + which credential is live on which location inbound.
  `
  ALTER TABLE locations ADD COLUMN inbound_port INTEGER NOT NULL DEFAULT 0;  -- gateway xray inbound (127.0.0.1)
  ALTER TABLE locations ADD COLUMN ws_path TEXT NOT NULL DEFAULT '';         -- public WS path behind nginx
  ALTER TABLE locations ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;    -- consecutive failed health probes
  ALTER TABLE subscriptions ADD COLUMN usage_since INTEGER NOT NULL DEFAULT 0; -- quota counts usage from here (reset on renew)
  CREATE TABLE credential_activations (
    credential_id   TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    location_id     TEXT NOT NULL REFERENCES locations(id),
    email           TEXT NOT NULL UNIQUE,      -- xray stats key: u<userId>-<cred8>.<loc>
    activated_at    INTEGER NOT NULL,
    deactivated_at  INTEGER,
    PRIMARY KEY (credential_id, location_id)
  );
  `,
  // 3: OpenVPN (task group 6). A location's pool index selects its address pools: 10.80.<i>.0/24 on the UDP
  // instance, 10.81.<i>.0/24 on the TCP instance. One row per OpenVPN session, from auth to disconnect.
  `
  ALTER TABLE locations ADD COLUMN pool_index INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE openvpn_sessions (
    id              INTEGER PRIMARY KEY,
    instance        TEXT NOT NULL CHECK (instance IN ('udp','tcp')),
    real_addr       TEXT NOT NULL,             -- client ip:port as seen by OpenVPN
    credential_id   TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id     TEXT NOT NULL REFERENCES locations(id),
    address         TEXT,                      -- tunnel address assigned at client-connect
    authed_at       INTEGER NOT NULL,
    connected_at    INTEGER,
    ended_at        INTEGER,
    rx_booked       INTEGER NOT NULL DEFAULT 0, -- management "bytes received" already booked as usage (client upload)
    tx_booked       INTEGER NOT NULL DEFAULT 0  -- management "bytes sent" already booked as usage (client download)
  );
  CREATE INDEX openvpn_sessions_live ON openvpn_sessions(instance, real_addr) WHERE ended_at IS NULL;
  `,
  // outage notice shown by every app while active (single row, id = 1).
  `
  CREATE TABLE app_notice (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    active     INTEGER NOT NULL,
    message    TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  );
  `,
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let current = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  for (; current < MIGRATIONS.length; current++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[current]!);
      db.prepare("UPDATE schema_version SET version = ?").run(current + 1);
    })();
  }
}

export function audit(db: Db, now: number, actor: string, action: string, detail?: unknown): void {
  db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)").run(
    now, actor, action, detail === undefined ? null : JSON.stringify(detail),
  );
}
