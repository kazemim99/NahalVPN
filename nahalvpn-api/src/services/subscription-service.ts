import { AUTH, type Admin } from "../config.js";
import { audit, type Db } from "../db.js";
import { Errors } from "../errors.js";
import type { PasswordHasher } from "../auth/crypto.js";

const DAY_MS = 24 * 3_600_000;

export interface Plan {
  /** Length of one period in days (e.g. 30). */
  days: number;
  /** Plan months, used for sales counting (one order per month, as in the existing panel). */
  months: number;
  /** Devices that may be signed in at once (default 1). Traffic is unlimited: there is no data quota. */
  deviceLimit?: number;
}

export interface SubscriptionView {
  userId: number;
  username: string;
  owner: string;
  disabled: boolean;
  expiresAt: number;
  deviceLimit: number;
}

export interface SubscriptionListItem extends SubscriptionView {
  createdAt: number;
  /** Devices currently signed in. */
  devices: number;
  /** All traffic the user has carried, in bytes (a statistic for resellers; nothing is limited by it). */
  trafficBytes: number;
}

export class SubscriptionService {
  constructor(
    private readonly db: Db,
    private readonly hasher: PasswordHasher,
    private readonly now: () => number = Date.now,
  ) {}

  /** subscription-usage: "Reseller creates a subscription". */
  async createUser(actor: Admin, username: string, password: string, plan: Plan): Promise<SubscriptionView> {
    const now = this.now();
    if (this.db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw Errors.conflict("username taken");
    const hash = await this.hasher.hash(password);
    const userId = this.db.transaction(() => {
      const id = Number(
        this.db.prepare("INSERT INTO users (username, password_hash, owner, created_at) VALUES (?, ?, ?, ?)").run(
          username, hash, actor.name, now,
        ).lastInsertRowid,
      );
      this.db
        .prepare("INSERT INTO subscriptions (user_id, expires_at, device_limit, updated_at) VALUES (?, ?, ?, ?)")
        .run(id, now + plan.days * DAY_MS, plan.deviceLimit ?? AUTH.defaultDeviceLimit, now);
      this.db.prepare("INSERT INTO sales (user_id, owner, kind, months, created_at) VALUES (?, ?, 'create', ?, ?)").run(
        id, actor.name, plan.months, now,
      );
      audit(this.db, now, actor.name, "user.created", { id, username, plan });
      return id;
    })();
    return this.get(actor, userId);
  }

  /** subscription-usage: "Renewal" - extends from max(now, expiry); recorded as a sale. */
  renew(actor: Admin, userId: number, plan: Plan): SubscriptionView {
    const now = this.now();
    const current = this.get(actor, userId);
    const base = Math.max(now, current.expiresAt);
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE subscriptions SET expires_at = ?, device_limit = ?, updated_at = ? WHERE user_id = ?")
        .run(base + plan.days * DAY_MS, plan.deviceLimit ?? current.deviceLimit, now, userId);
      this.db.prepare("INSERT INTO sales (user_id, owner, kind, months, created_at) VALUES (?, ?, 'renew', ?, ?)").run(
        userId, actor.name, plan.months, now,
      );
      audit(this.db, now, actor.name, "user.renewed", { userId, plan });
    })();
    return this.get(actor, userId);
  }

  /** Resellers see only their own users; super admins see everyone. */
  get(actor: Admin, userId: number): SubscriptionView {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.owner, u.disabled, s.expires_at, s.device_limit
           FROM users u JOIN subscriptions s ON s.user_id = u.id WHERE u.id = ?`,
      )
      .get(userId) as
      | { id: number; username: string; owner: string; disabled: number; expires_at: number; device_limit: number }
      | undefined;
    if (!row) throw Errors.notFound("user");
    if (actor.role !== "super" && row.owner !== actor.name) throw Errors.notFound("user");
    return {
      userId: row.id, username: row.username, owner: row.owner, disabled: row.disabled === 1,
      expiresAt: row.expires_at, deviceLimit: row.device_limit,
    };
  }

  /** subscription-usage "Reseller lists their users": newest first; resellers see only their own users. */
  list(actor: Admin): SubscriptionListItem[] {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.username, u.owner, u.disabled, u.created_at, s.expires_at, s.device_limit,
                (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices,
                COALESCE(t.bytes, 0) AS traffic
           FROM users u JOIN subscriptions s ON s.user_id = u.id
           LEFT JOIN (SELECT user_id, SUM(up_bytes + down_bytes) AS bytes FROM usage_samples GROUP BY user_id) t
             ON t.user_id = u.id
          WHERE ? = 'super' OR u.owner = ?
          ORDER BY u.created_at DESC, u.id DESC`,
      )
      .all(actor.role, actor.name) as {
      id: number; username: string; owner: string; disabled: number; created_at: number; expires_at: number;
      device_limit: number; devices: number; traffic: number;
    }[];
    return rows.map((r) => ({
      userId: r.id, username: r.username, owner: r.owner, disabled: r.disabled === 1, expiresAt: r.expires_at,
      deviceLimit: r.device_limit, createdAt: r.created_at, devices: r.devices, trafficBytes: r.traffic,
    }));
  }

  /** The owning user's own view (app account screen). */
  forUser(userId: number): SubscriptionView {
    return this.get({ name: "self", role: "super" }, userId);
  }
}
