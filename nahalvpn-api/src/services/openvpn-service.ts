import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sha256 } from "../auth/crypto.js";
import { audit, type Db } from "../db.js";
import { AppError } from "../errors.js";
import type { Instance, OpenVpnManagement } from "../gateway/openvpn.js";
import type { Location } from "./location-service.js";

export interface OpenVpnSettings {
  /** Who may use OpenVPN: "*" = everyone, otherwise these usernames only (testing phase). */
  allowedUsers: "*" | string[];
  host: string;
  port: number;
  /** PEM of the CA and the tls-crypt key embedded in every profile (shared; per-device secrets are the passwords). */
  caPem: () => string;
  tlsCryptKey: () => string;
  serverName: string;
}

export interface OpenVpnConfig {
  protocol: "openvpn";
  location: string;
  username: string;
  password: string;
  /** Inline .ovpn profile: UDP 2083 first, then TCP 2083. For generic OpenVPN apps. */
  profile: string;
  /** The same connection in structured form, for the NahalVPN app's built-in engine (no profile parsing needed). */
  server: { host: string; port: number; serverName: string; ca: string; tlsCrypt: string };
}

const POOLS: Record<Instance, string> = { udp: "10.80", tcp: "10.81" };
/** An auth that never reaches client-connect (client gave up) is forgotten after this long. */
const PENDING_TTL_MS = 2 * 60_000;

/**
 * openvpn-gateway spec: backend-checked credentials (`<user>@<loc>` + per-device password), per-location address
 * pools, accounting from the management interface, and forced disconnect on revoke.
 */
export class OpenVpnService {
  constructor(
    private readonly db: Db,
    private readonly mgmt: OpenVpnManagement,
    private readonly settings: OpenVpnSettings,
    private readonly now: () => number = Date.now,
  ) {}

  allowed(username: string): boolean {
    const a = this.settings.allowedUsers;
    return a === "*" || a.some((u) => u.toLowerCase() === username.toLowerCase());
  }

  /**
   * connection-provisioning "OpenVPN configuration": a fresh per-device password on every call (only its hash is
   * stored); the device's previous OpenVPN credential and its live sessions are revoked.
   */
  async issue(userId: number, username: string, deviceId: string, loc: Location): Promise<OpenVpnConfig> {
    if (!this.allowed(username)) throw new AppError("protocol_not_ready", 501, "OpenVPN is in testing");
    if (loc.poolIndex < 1) throw new AppError("protocol_not_ready", 501, "location has no OpenVPN pool");
    await this.revokeDevice(deviceId);
    const now = this.now();
    const password = randomBytes(24).toString("base64url");
    const id = randomUUID();
    this.db.prepare("INSERT INTO credentials (id, device_id, protocol, secret_hash, created_at) VALUES (?, ?, 'openvpn', ?, ?)")
      .run(id, deviceId, sha256(password), now);
    audit(this.db, now, `user:${userId}`, "credential.issued", { deviceId, protocol: "openvpn", location: loc.id });
    const login = `${username}@${loc.id}`;
    const s = this.settings;
    return {
      protocol: "openvpn", location: loc.id, username: login, password, profile: this.profile(loc.id),
      server: { host: s.host, port: s.port, serverName: s.serverName, ca: s.caPem().trim(), tlsCrypt: s.tlsCryptKey().trim() },
    };
  }

  /** `auth-user-pass-verify`: accept only a live credential of an active, unexpired subscription, on a usable location. */
  authenticate(instance: Instance, login: string, password: string, realAddr: string): boolean {
    const now = this.now();
    const m = /^(.+)@([a-z]{2,8})$/.exec(login);
    const deny = (why: string) => { audit(this.db, now, login.slice(0, 80), "openvpn.auth.denied", { instance, why }); return false; };
    if (!m) return deny("bad_username");
    const [, username, locId] = m as unknown as [string, string, string];
    if (!this.allowed(username)) return deny("not_allowed");
    const loc = this.db.prepare("SELECT enabled, healthy, protocols, pool_index FROM locations WHERE id = ?").get(locId) as
      | { enabled: number; healthy: number; protocols: string; pool_index: number } | undefined;
    if (!loc || !loc.enabled || !JSON.parse(loc.protocols).includes("openvpn") || loc.pool_index < 1) return deny("unknown_location");
    if (!loc.healthy) return deny("location_down");
    const user = this.db.prepare(
      `SELECT u.id, u.disabled, s.expires_at FROM users u JOIN subscriptions s ON s.user_id = u.id WHERE u.username = ?`,
    ).get(username) as { id: number; disabled: number; expires_at: number } | undefined;
    if (!user || user.disabled) return deny("no_user");
    if (user.expires_at <= now) return deny("expired");
    const hash = Buffer.from(sha256(password));
    const creds = this.db.prepare(
      `SELECT c.id, c.secret_hash FROM credentials c JOIN devices d ON d.id = c.device_id
        WHERE d.user_id = ? AND d.revoked_at IS NULL AND c.protocol = 'openvpn' AND c.revoked_at IS NULL`,
    ).all(user.id) as { id: string; secret_hash: string }[];
    const cred = creds.find((c) => c.secret_hash.length === hash.length && timingSafeEqual(Buffer.from(c.secret_hash), hash));
    if (!cred) return deny("bad_password");
    // A reconnect from the same address replaces whatever was left of an earlier session there.
    this.db.prepare("UPDATE openvpn_sessions SET ended_at = ? WHERE instance = ? AND real_addr = ? AND ended_at IS NULL")
      .run(now, instance, realAddr);
    this.db.prepare(
      "INSERT INTO openvpn_sessions (instance, real_addr, credential_id, user_id, location_id, authed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(instance, realAddr, cred.id, user.id, locId, now);
    return true;
  }

  /** `client-connect`: the address in the location's pool, as an `ifconfig-push` line; null = refuse. */
  clientConnect(instance: Instance, realAddr: string): string | null {
    const now = this.now();
    const s = this.db.prepare(
      `SELECT o.id, l.pool_index FROM openvpn_sessions o JOIN locations l ON l.id = o.location_id
        WHERE o.instance = ? AND o.real_addr = ? AND o.ended_at IS NULL AND o.connected_at IS NULL AND o.authed_at > ?`,
    ).get(instance, realAddr, now - PENDING_TTL_MS) as { id: number; pool_index: number } | undefined;
    if (!s) return null;
    const prefix = `${POOLS[instance]}.${s.pool_index}.`;
    const used = new Set((this.db.prepare(
      "SELECT address FROM openvpn_sessions WHERE instance = ? AND ended_at IS NULL AND address LIKE ?",
    ).all(instance, `${prefix}%`) as { address: string }[]).map((r) => r.address));
    let host = 2;
    while (host <= 254 && used.has(prefix + host)) host++;
    if (host > 254) return null;
    const address = prefix + host;
    this.db.prepare("UPDATE openvpn_sessions SET address = ?, connected_at = ? WHERE id = ?").run(address, now, s.id);
    return `ifconfig-push ${address} 255.255.0.0`;
  }

  /** `client-disconnect`: books whatever the collector has not booked yet and closes the session. */
  clientDisconnect(instance: Instance, realAddr: string, bytesIn: number, bytesOut: number): void {
    const s = this.liveSession(instance, realAddr);
    if (!s) return;
    this.db.transaction(() => {
      this.book(s, bytesIn, bytesOut);
      this.db.prepare("UPDATE openvpn_sessions SET ended_at = ? WHERE id = ?").run(this.now(), s.id);
    })();
  }

  /** Usage collector: books per-session deltas from `status 3`; closes sessions OpenVPN no longer has. */
  async collect(): Promise<number> {
    let booked = 0;
    for (const instance of ["udp", "tcp"] as const) {
      let clients;
      try {
        clients = await this.mgmt.status(instance);
      } catch (err) {
        console.warn(`[openvpn] status ${instance} failed: ${String(err)}`);
        continue;
      }
      const seen = new Map(clients.map((c) => [c.realAddr, c]));
      const live = this.db.prepare("SELECT * FROM openvpn_sessions WHERE instance = ? AND ended_at IS NULL AND connected_at IS NOT NULL")
        .all(instance) as SessionRow[];
      this.db.transaction(() => {
        for (const s of live) {
          const c = seen.get(s.real_addr);
          if (!c) { this.db.prepare("UPDATE openvpn_sessions SET ended_at = ? WHERE id = ?").run(this.now(), s.id); continue; }
          if (this.book(s, c.bytesIn, c.bytesOut)) booked++;
        }
      })();
    }
    return booked;
  }

  /** Revocation: credentials off, then live sessions killed (spec "Forced disconnect"). */
  async revokeDevice(deviceId: string): Promise<void> {
    const now = this.now();
    this.db.prepare("UPDATE credentials SET revoked_at = ? WHERE device_id = ? AND protocol = 'openvpn' AND revoked_at IS NULL").run(now, deviceId);
    const sessions = this.db.prepare(
      `SELECT o.id, o.instance, o.real_addr FROM openvpn_sessions o JOIN credentials c ON c.id = o.credential_id
        WHERE c.device_id = ? AND o.ended_at IS NULL`,
    ).all(deviceId) as { id: number; instance: Instance; real_addr: string }[];
    for (const s of sessions) {
      try {
        await this.mgmt.kill(s.instance, s.real_addr);
        this.db.prepare("UPDATE openvpn_sessions SET ended_at = ? WHERE id = ?").run(now, s.id);
        audit(this.db, now, "system", "openvpn.killed", { deviceId, instance: s.instance });
      } catch (err) {
        // The credential is already revoked (no reconnect possible); the collector retries via usersWithLiveSessions.
        console.warn(`[openvpn] kill ${s.instance} ${s.real_addr} failed: ${String(err)}`);
      }
    }
  }

  usersWithLiveSessions(): number[] {
    return (this.db.prepare("SELECT DISTINCT user_id FROM openvpn_sessions WHERE ended_at IS NULL").all() as { user_id: number }[])
      .map((r) => r.user_id);
  }

  profile(locId: string): string {
    const s = this.settings;
    return [
      "# NahalVPN - OpenVPN profile", `# location: ${locId}`,
      "client", "dev tun", "nobind", "persist-key", "persist-tun",
      // Per-connection timeouts: a <connection> only inherits options set before it, so set them inside each block.
      // Without this an unreachable UDP waits the 60 s TLS hand-window before trying TCP.
      "<connection>", `remote ${s.host} ${s.port} udp`, "connect-timeout 8", "explicit-exit-notify 1", "</connection>",
      "<connection>", `remote ${s.host} ${s.port} tcp-client`, "connect-timeout 10", "</connection>",
      "connect-retry 1", "resolv-retry 30",
      "remote-cert-tls server", `verify-x509-name ${s.serverName} name`,
      "data-ciphers AES-128-GCM:AES-256-GCM:CHACHA20-POLY1305", "auth-user-pass", "auth-nocache", "verb 3",
      "<ca>", s.caPem().trim(), "</ca>",
      "<tls-crypt>", s.tlsCryptKey().trim(), "</tls-crypt>", "",
    ].join("\n");
  }

  private liveSession(instance: Instance, realAddr: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM openvpn_sessions WHERE instance = ? AND real_addr = ? AND ended_at IS NULL")
      .get(instance, realAddr) as SessionRow | undefined;
  }

  /** Books counter growth since the last booking. Counters only grow within a session. */
  private book(s: SessionRow, bytesIn: number, bytesOut: number): boolean {
    const up = Math.max(0, bytesIn - s.rx_booked);
    const down = Math.max(0, bytesOut - s.tx_booked);
    if (up === 0 && down === 0) return false;
    this.db.prepare("INSERT INTO usage_samples (user_id, location_id, protocol, up_bytes, down_bytes, at) VALUES (?, ?, 'openvpn', ?, ?, ?)")
      .run(s.user_id, s.location_id, up, down, this.now());
    this.db.prepare("UPDATE openvpn_sessions SET rx_booked = ?, tx_booked = ? WHERE id = ?")
      .run(Math.max(bytesIn, s.rx_booked), Math.max(bytesOut, s.tx_booked), s.id);
    return true;
  }
}

interface SessionRow {
  id: number; instance: Instance; real_addr: string; credential_id: string; user_id: number; location_id: string;
  address: string | null; rx_booked: number; tx_booked: number;
}
