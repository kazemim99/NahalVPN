import { randomUUID } from "node:crypto";
import { audit, type Db } from "../db.js";
import { AppError, Errors } from "../errors.js";
import type { XrayGateway } from "../gateway/xray.js";
import type { LocationService, Protocol } from "./location-service.js";
import type { CredentialRevoker } from "./revocation.js";
import type { OpenVpnConfig, OpenVpnService } from "./openvpn-service.js";

export interface GatewayPublic {
  /** Public host the app connects to (never a foreign server). */
  host: string;
  port: number;
  sni: string;
}

export interface VlessConfig {
  protocol: "vless";
  location: string;
  host: string;
  port: number;
  uuid: string;
  security: "tls";
  sni: string;
  fingerprint: "chrome";
  network: "ws";
  path: string;
  /** Standard share link, for engines that import links. */
  uri: string;
}

/**
 * connection-provisioning spec: per-device credentials, activated live on the location's gateway inbound,
 * rotated on login and revoked live. Never touches x-ui.
 */
export class ProvisioningService implements CredentialRevoker {
  /** Removals the gateway did not confirm (xray briefly down); retried on every tick until they succeed. */
  private readonly pendingRemovals = new Map<string, string>(); // email -> inbound tag

  constructor(
    private readonly db: Db,
    private readonly xray: XrayGateway,
    private readonly locations: LocationService,
    private readonly gateway: GatewayPublic,
    private readonly now: () => number = Date.now,
    private readonly ovpn?: OpenVpnService,
  ) {}

  async connect(userId: number, deviceId: string, locationId: string, protocol: Protocol): Promise<VlessConfig | OpenVpnConfig> {
    const now = this.now();
    const sub = this.db.prepare(
      "SELECT s.expires_at, u.disabled, u.username FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.user_id = ?",
    ).get(userId) as { expires_at: number; disabled: number; username: string } | undefined;
    if (!sub || sub.disabled) throw Errors.accountDisabled();
    if (sub.expires_at <= now) throw Errors.subscriptionExpired();

    const loc = this.locations.get(locationId);
    if (!loc.enabled) throw Errors.notFound("location");
    if (!loc.protocols.includes(protocol)) throw new AppError("protocol_not_offered", 409);
    if (!loc.healthy) throw new AppError("location_unavailable", 503);
    if (protocol === "openvpn") {
      if (!this.ovpn) throw new AppError("protocol_not_ready", 501);
      return this.ovpn.issue(userId, sub.username, deviceId, loc);
    }

    const credId = this.activeCredential(deviceId, "vless") ?? this.newCredential(deviceId, "vless", now);
    const tag = `in-${loc.id}`;
    const active = this.db.prepare(
      "SELECT email FROM credential_activations WHERE credential_id = ? AND location_id = ? AND deactivated_at IS NULL",
    ).get(credId, loc.id) as { email: string } | undefined;
    if (!active) {
      const email = `u${userId}-${credId.slice(0, 8)}.${loc.id}`;
      await this.xray.addUser({ tag, port: loc.inboundPort, wsPath: loc.wsPath }, email, credId);
      this.db.prepare(
        `INSERT INTO credential_activations (credential_id, location_id, email, activated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(credential_id, location_id) DO UPDATE SET email = excluded.email, activated_at = excluded.activated_at, deactivated_at = NULL`,
      ).run(credId, loc.id, email, now);
      audit(this.db, now, `user:${userId}`, "credential.activated", { deviceId, location: loc.id, email });
    }

    const g = this.gateway;
    const uri = `vless://${credId}@${g.host}:${g.port}?encryption=none&security=tls&sni=${encodeURIComponent(g.sni)}` +
      `&fp=chrome&type=ws&host=${encodeURIComponent(g.sni)}&path=${encodeURIComponent(loc.wsPath)}#NahalVPN-${loc.id}`;
    return {
      protocol: "vless", location: loc.id, host: g.host, port: g.port, uuid: credId, security: "tls", sni: g.sni,
      fingerprint: "chrome", network: "ws", path: loc.wsPath, uri,
    };
  }

  /** CredentialRevoker: called on logout, device removal, re-login (rotation), disable and expiry. */
  async revokeDevices(deviceIds: string[]): Promise<void> {
    const now = this.now();
    for (const deviceId of deviceIds) {
      const rows = this.db.prepare(
        `SELECT a.credential_id, a.location_id, a.email FROM credential_activations a
           JOIN credentials c ON c.id = a.credential_id
          WHERE c.device_id = ? AND a.deactivated_at IS NULL`,
      ).all(deviceId) as { credential_id: string; location_id: string; email: string }[];
      for (const r of rows) {
        // Deactivate in the DB first: the access decision is made here, the gateway follows (and is retried).
        this.db.prepare("UPDATE credential_activations SET deactivated_at = ? WHERE credential_id = ? AND location_id = ?")
          .run(now, r.credential_id, r.location_id);
        await this.removeFromGateway(`in-${r.location_id}`, r.email);
      }
      this.db.prepare("UPDATE credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?").run(now, deviceId);
      await this.ovpn?.revokeDevice(deviceId);
      if (rows.length) audit(this.db, now, "system", "credential.revoked", { deviceId, removed: rows.map((r) => r.email) });
    }
  }

  private async removeFromGateway(tag: string, email: string): Promise<void> {
    try {
      await this.xray.removeUser(tag, email);
      this.pendingRemovals.delete(email);
    } catch (err) {
      this.pendingRemovals.set(email, tag);
      console.warn(`[provisioning] gateway removal of ${email} failed, will retry: ${String(err)}`);
    }
  }

  async retryPendingRemovals(): Promise<number> {
    for (const [email, tag] of [...this.pendingRemovals]) await this.removeFromGateway(tag, email);
    return this.pendingRemovals.size;
  }

  /**
   * Runtime-added users live only in xray's memory. On start (nahalvpn-api is PartOf nahalvpn-xray, so it restarts
   * with it) re-add every credential that is still active.
   */
  async resync(): Promise<{ added: number; failed: number }> {
    const rows = this.db.prepare(
      `SELECT a.credential_id, a.email, l.id AS loc, l.inbound_port, l.ws_path FROM credential_activations a
         JOIN locations l ON l.id = a.location_id WHERE a.deactivated_at IS NULL`,
    ).all() as { credential_id: string; email: string; loc: string; inbound_port: number; ws_path: string }[];
    let added = 0, failed = 0;
    for (const r of rows) {
      try {
        await this.xray.addUser({ tag: `in-${r.loc}`, port: r.inbound_port, wsPath: r.ws_path }, r.email, r.credential_id);
        added++;
      } catch (err) {
        failed++;
        console.warn(`[provisioning] resync of ${r.email} failed: ${String(err)}`);
      }
    }
    return { added, failed };
  }

  async revokeUser(userId: number): Promise<void> {
    const devices = (this.db.prepare("SELECT id FROM devices WHERE user_id = ?").all(userId) as { id: string }[]).map((d) => d.id);
    await this.revokeDevices(devices);
  }

  /** Users that currently have at least one live credential (for enforcement). */
  usersWithLiveCredentials(): number[] {
    const vless = (this.db.prepare(
      `SELECT DISTINCT d.user_id FROM credential_activations a JOIN credentials c ON c.id = a.credential_id
         JOIN devices d ON d.id = c.device_id WHERE a.deactivated_at IS NULL`,
    ).all() as { user_id: number }[]).map((r) => r.user_id);
    return [...new Set([...vless, ...(this.ovpn?.usersWithLiveSessions() ?? [])])];
  }

  private activeCredential(deviceId: string, protocol: Protocol): string | undefined {
    return (this.db.prepare(
      "SELECT id FROM credentials WHERE device_id = ? AND protocol = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ).get(deviceId, protocol) as { id: string } | undefined)?.id;
  }

  private newCredential(deviceId: string, protocol: Protocol, now: number): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO credentials (id, device_id, protocol, created_at) VALUES (?, ?, ?, ?)").run(id, deviceId, protocol, now);
    return id;
  }
}
