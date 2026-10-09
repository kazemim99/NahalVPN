import { audit, type Db } from "../db.js";
import type { XrayGateway } from "../gateway/xray.js";

/** subscription-usage: per-user traffic statistics (per location + protocol; for operators only, never billed or limited) and expiry enforcement. */
export class UsageService {
  private readonly collectors: (() => Promise<number>)[] = [];
  private revoker?: { revokeUser(userId: number): Promise<void>; usersWithLiveCredentials(): number[] };

  constructor(private readonly db: Db, private readonly xray: XrayGateway, private readonly now: () => number = Date.now) {}

  /** Wired after construction (the provisioning service is created later). */
  attachRevoker(r: { revokeUser(userId: number): Promise<void>; usersWithLiveCredentials(): number[] }): void {
    this.revoker = r;
  }

  /** More usage sources (OpenVPN management), run after the gateway xray on every collection. */
  addCollector(c: () => Promise<number>): void {
    this.collectors.push(c);
  }

  /** Total bytes carried for a user (statistics only). */
  usedBytes(userId: number): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(up_bytes + down_bytes), 0) AS n FROM usage_samples WHERE user_id = ?")
      .get(userId) as { n: number };
    return r.n;
  }

  /** Total traffic split per location and protocol (reseller / operator view). */
  breakdown(userId: number): { location: string; protocol: string; upBytes: number; downBytes: number }[] {
    return this.db.prepare(
      `SELECT location_id AS location, protocol, SUM(up_bytes) AS upBytes, SUM(down_bytes) AS downBytes
         FROM usage_samples WHERE user_id = ? GROUP BY location_id, protocol ORDER BY location_id, protocol`,
    ).all(userId) as { location: string; protocol: string; upBytes: number; downBytes: number }[];
  }

  /** Pulls (and resets) per-credential counters from the gateway and books them per user, location and protocol. */
  async collect(): Promise<number> {
    const now = this.now();
    const traffic = await this.xray.takeUserTraffic();
    let booked = 0;
    const lookup = this.db.prepare(
      `SELECT d.user_id, a.location_id, c.protocol FROM credential_activations a
         JOIN credentials c ON c.id = a.credential_id JOIN devices d ON d.id = c.device_id WHERE a.email = ?`,
    );
    const insert = this.db.prepare(
      "INSERT INTO usage_samples (user_id, location_id, protocol, up_bytes, down_bytes, at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      for (const [email, t] of traffic) {
        if (t.up === 0 && t.down === 0) continue;
        const who = lookup.get(email) as { user_id: number; location_id: string; protocol: string } | undefined;
        if (!who) continue; // not an app credential (or already purged)
        insert.run(who.user_id, who.location_id, who.protocol, t.up, t.down, now);
        booked++;
      }
    })();
    for (const c of this.collectors) booked += await c();
    return booked;
  }

  /** Revokes live credentials of users whose subscription has expired. */
  async enforce(): Promise<{ userId: number; reason: "expired" }[]> {
    if (!this.revoker) throw new Error("UsageService.enforce called before attachRevoker");
    const now = this.now();
    const out: { userId: number; reason: "expired" }[] = [];
    for (const userId of this.revoker.usersWithLiveCredentials()) {
      const s = this.db.prepare("SELECT expires_at FROM subscriptions WHERE user_id = ?").get(userId) as
        | { expires_at: number } | undefined;
      if (!s || s.expires_at > now) continue;
      await this.revoker.revokeUser(userId);
      audit(this.db, now, "enforcer", "access.cut.expired", { userId });
      out.push({ userId, reason: "expired" });
    }
    return out;
  }

  async tick(): Promise<void> {
    await this.collect();
    await this.enforce();
  }
}
