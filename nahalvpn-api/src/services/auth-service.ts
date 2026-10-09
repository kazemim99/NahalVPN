import { randomUUID } from "node:crypto";
import { AUTH } from "../config.js";
import { audit, type Db } from "../db.js";
import { Errors } from "../errors.js";
import type { AccessTokens } from "../auth/access-token.js";
import { newOpaqueToken, sha256, type PasswordHasher } from "../auth/crypto.js";
import type { CredentialRevoker } from "./revocation.js";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  deviceId: string;
}

export interface DeviceView {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  disabled: number;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly hasher: PasswordHasher & { dummyHash: Promise<string> },
    private readonly access: AccessTokens,
    private readonly revoker: CredentialRevoker,
    private readonly now: () => number = Date.now,
  ) {}

  /** app-auth: "Username and password login", "Brute-force protection", "Device limit". */
  /**
   * [replaceDeviceId]: when the device limit is reached, the user (who just proved the password) may sign out one of
   * their own devices to sign in here (vpn-client-app "Remove one to sign in here").
   */
  async login(username: string, password: string, deviceKey: string, deviceName: string, replaceDeviceId?: string): Promise<TokenPair> {
    const now = this.now();
    if (this.recentFailures(username, now) >= AUTH.lockoutMaxFailures) {
      audit(this.db, now, username, "login.locked");
      throw Errors.lockedOut();
    }

    const user = this.db
      .prepare("SELECT id, username, password_hash, disabled FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;
    // Verify against a dummy hash for unknown users so timing does not reveal whether the username exists.
    const ok = await this.hasher.verify(user?.password_hash ?? (await this.hasher.dummyHash), password);
    if (!user || !ok) {
      this.db.prepare("INSERT INTO login_failures (username, at) VALUES (?, ?)").run(username, now);
      audit(this.db, now, username, "login.failed");
      throw Errors.invalidCredentials();
    }
    this.assertUserUsable(user.id, user.disabled, now);

    let rotated = false;
    let evicted: string | null = null;
    const deviceId = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM devices WHERE user_id = ? AND device_key = ? AND revoked_at IS NULL")
        .get(user.id, deviceKey) as { id: string } | undefined;
      if (existing) {
        this.db.prepare("UPDATE devices SET name = ?, last_seen_at = ? WHERE id = ?").run(deviceName, now, existing.id);
        rotated = true;
        return existing.id;
      }
      const limit = (this.db.prepare("SELECT device_limit FROM subscriptions WHERE user_id = ?").get(user.id) as
        | { device_limit: number }
        | undefined)?.device_limit ?? AUTH.defaultDeviceLimit;
      const active = this.listDevices(user.id);
      if (active.length >= limit) {
        if (!replaceDeviceId || !active.some((d) => d.id === replaceDeviceId)) throw Errors.deviceLimit(active);
        this.revokeDeviceRows(replaceDeviceId, now);
        evicted = replaceDeviceId;
      }
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO devices (id, user_id, device_key, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, user.id, deviceKey, deviceName, now, now);
      return id;
    })();

    // connection-provisioning "Rotation": a re-login invalidates the device's previous connection credentials.
    if (rotated) await this.revoker.revokeDevices([deviceId]);
    if (evicted) {
      audit(this.db, now, user.username, "device.replaced", { removed: evicted, by: deviceId });
      await this.revoker.revokeDevices([evicted]);
    }
    this.db.prepare("DELETE FROM login_failures WHERE username = ?").run(username);
    audit(this.db, now, user.username, "login.ok", { deviceId, rotated });
    return this.issuePair(user.id, deviceId, randomUUID(), now);
  }

  /** app-auth: "Token refresh and rotation", including reuse detection. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const now = this.now();
    const row = this.db
      .prepare(
        `SELECT rt.id, rt.device_id, rt.family_id, rt.expires_at, rt.used_at, rt.revoked_at, d.user_id, d.revoked_at AS device_revoked
           FROM refresh_tokens rt JOIN devices d ON d.id = rt.device_id WHERE rt.token_hash = ?`,
      )
      .get(sha256(refreshToken)) as
      | { id: number; device_id: string; family_id: string; expires_at: number; used_at: number | null;
          revoked_at: number | null; user_id: number; device_revoked: number | null }
      | undefined;
    if (!row) throw Errors.invalidToken();
    if (row.used_at !== null || row.revoked_at !== null) {
      // A rotated token came back: assume theft and kill every session of that device.
      await this.revokeDevice(row.device_id, "refresh.reuse");
      throw Errors.invalidToken();
    }
    if (row.device_revoked !== null || row.expires_at <= now) throw Errors.invalidToken();
    const user = this.db.prepare("SELECT disabled FROM users WHERE id = ?").get(row.user_id) as { disabled: number };
    this.assertUserUsable(row.user_id, user.disabled, now);

    this.db.prepare("UPDATE refresh_tokens SET used_at = ? WHERE id = ?").run(now, row.id);
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, row.device_id);
    return this.issuePair(row.user_id, row.device_id, row.family_id, now);
  }

  /** Resolves a bearer access token and re-checks the device so revocation takes effect immediately. */
  async authenticate(accessToken: string): Promise<{ userId: number; deviceId: string }> {
    const claims = await this.access.verify(accessToken, this.now());
    const device = this.db.prepare("SELECT revoked_at FROM devices WHERE id = ? AND user_id = ?").get(
      claims.deviceId, claims.userId,
    ) as { revoked_at: number | null } | undefined;
    if (!device || device.revoked_at !== null) throw Errors.invalidToken();
    return claims;
  }

  /** app-auth: "User logs out". */
  async logout(deviceId: string): Promise<void> {
    await this.revokeDevice(deviceId, "logout");
  }

  /** app-auth: "Removing a device frees a slot". A user may only remove their own devices. */
  async removeDevice(userId: number, deviceId: string): Promise<void> {
    const owned = this.db.prepare("SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL").get(
      deviceId, userId,
    );
    if (!owned) throw Errors.notFound("device");
    await this.revokeDevice(deviceId, "device.removed");
  }

  /** app-auth: "Admin disables a user". */
  async disableUser(userId: number, actor: string): Promise<void> {
    const now = this.now();
    this.db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);
    const devices = (this.db.prepare("SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL").all(userId) as {
      id: string;
    }[]).map((d) => d.id);
    for (const id of devices) this.revokeDeviceRows(id, now);
    audit(this.db, now, actor, "user.disabled", { userId, devices });
    await this.revoker.revokeDevices(devices);
  }

  /**
   * app-auth "User changes their password": needs the current password (a wrong one counts toward the same lockout
   * as a failed login). The new password applies to the next login; devices already signed in stay signed in.
   */
  async changePassword(userId: number, current: string, next: string): Promise<void> {
    const now = this.now();
    const row = this.db.prepare("SELECT username, password_hash FROM users WHERE id = ?").get(userId) as
      | { username: string; password_hash: string }
      | undefined;
    if (!row) throw Errors.notFound("user");
    if (this.recentFailures(row.username, now) >= AUTH.lockoutMaxFailures) throw Errors.lockedOut();
    if (!(await this.hasher.verify(row.password_hash, current))) {
      this.db.prepare("INSERT INTO login_failures (username, at) VALUES (?, ?)").run(row.username, now);
      audit(this.db, now, row.username, "password.change_failed");
      throw Errors.invalidCredentials();
    }
    const hash = await this.hasher.hash(next);
    this.db.transaction(() => {
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
      this.db.prepare("DELETE FROM login_failures WHERE username = ?").run(row.username);
      audit(this.db, now, row.username, "user.password_changed", { userId });
    })();
  }

  /** app-auth "Admin re-enables a user": the user may log in again (the subscription must still be valid). */
  enableUser(userId: number, actor: string): void {
    const now = this.now();
    this.db.prepare("UPDATE users SET disabled = 0 WHERE id = ?").run(userId);
    audit(this.db, now, actor, "user.enabled", { userId });
  }

  /**
   * app-auth "Admin resets a password": the old password stops working at once and a lockout from failed attempts is
   * cleared. Devices already signed in stay signed in; the admin can remove them separately.
   */
  async resetPassword(userId: number, password: string, actor: string): Promise<void> {
    const now = this.now();
    const hash = await this.hasher.hash(password);
    const row = this.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined;
    if (!row) throw Errors.notFound("user");
    this.db.transaction(() => {
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
      this.db.prepare("DELETE FROM login_failures WHERE username = ?").run(row.username);
      audit(this.db, now, actor, "user.password_reset", { userId });
    })();
  }

  listDevices(userId: number): DeviceView[] {
    return (this.db
      .prepare("SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at")
      .all(userId) as { id: string; name: string; created_at: number; last_seen_at: number }[]).map((d) => ({
      id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at,
    }));
  }

  private async revokeDevice(deviceId: string, reason: string): Promise<void> {
    const now = this.now();
    this.revokeDeviceRows(deviceId, now);
    audit(this.db, now, "system", reason, { deviceId });
    await this.revoker.revokeDevices([deviceId]);
  }

  private revokeDeviceRows(deviceId: string, now: number): void {
    this.db.prepare("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, deviceId);
    this.db.prepare("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?").run(now, deviceId);
  }

  private assertUserUsable(userId: number, disabled: number, now: number): void {
    if (disabled) throw Errors.accountDisabled();
    const sub = this.db.prepare("SELECT expires_at FROM subscriptions WHERE user_id = ?").get(userId) as
      | { expires_at: number }
      | undefined;
    if (!sub || sub.expires_at <= now) throw Errors.subscriptionExpired();
  }

  private recentFailures(username: string, now: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?")
      .get(username, now - AUTH.lockoutWindowMs) as { n: number };
    return row.n;
  }

  private async issuePair(userId: number, deviceId: string, familyId: string, now: number): Promise<TokenPair> {
    const refreshToken = newOpaqueToken();
    this.db
      .prepare("INSERT INTO refresh_tokens (device_id, family_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(deviceId, familyId, sha256(refreshToken), now + AUTH.refreshTokenTtlMs, now);
    return {
      accessToken: await this.access.issue({ userId, deviceId }, now),
      refreshToken,
      accessExpiresAt: now + AUTH.accessTokenTtlMs,
      deviceId,
    };
  }
}
