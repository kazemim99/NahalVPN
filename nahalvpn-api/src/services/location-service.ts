import { z } from "zod";
import { audit, type Db } from "../db.js";
import { Errors } from "../errors.js";

export const PROTOCOLS = ["vless", "openvpn"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const LocationInput = z.object({
  country: z.string().regex(/^[A-Z]{2}$/),
  nameEn: z.string().min(1).max(40),
  nameFa: z.string().min(1).max(40),
  protocols: z.array(z.enum(PROTOCOLS)).min(1),
  tunnelPort: z.number().int().min(1).max(65535),
  inboundPort: z.number().int().min(1).max(65535),
  wsPath: z.string().regex(/^\/nv\/[a-z]{2,8}$/),
  /** OpenVPN address pools 10.80.<poolIndex>.0/24 (UDP) and 10.81.<poolIndex>.0/24 (TCP); 0 = no OpenVPN pool yet. */
  poolIndex: z.number().int().min(0).max(250).default(0),
  enabled: z.boolean().default(true),
});
export type LocationInput = z.infer<typeof LocationInput>;

export interface Location extends LocationInput {
  id: string;
  healthy: boolean;
}

interface Row {
  id: string; country: string; name_en: string; name_fa: string; protocols: string; tunnel_port: number;
  inbound_port: number; ws_path: string; pool_index: number; enabled: number; healthy: number; fail_count: number;
}

const toLocation = (r: Row): Location => ({
  id: r.id, country: r.country, nameEn: r.name_en, nameFa: r.name_fa, protocols: JSON.parse(r.protocols),
  tunnelPort: r.tunnel_port, inboundPort: r.inbound_port, wsPath: r.ws_path, poolIndex: r.pool_index, enabled: r.enabled === 1, healthy: r.healthy === 1,
});

/** location-catalog spec. Locations are data: added, re-pointed or disabled without an app release. */
export class LocationService {
  /** Consecutive failed probes before a location is reported down (spec: "fails 3 times in a row"). */
  static readonly FAILURES_TO_DOWN = 3;

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  upsert(actor: string, id: string, input: LocationInput): Location {
    if (!/^[a-z]{2,8}$/.test(id)) throw Errors.conflict("location id must be 2-8 lowercase letters");
    const now = this.now();
    this.db.prepare(
      `INSERT INTO locations (id, country, name_en, name_fa, protocols, tunnel_port, inbound_port, ws_path, pool_index, enabled, updated_at)
       VALUES (@id, @country, @nameEn, @nameFa, @protocols, @tunnelPort, @inboundPort, @wsPath, @poolIndex, @enabled, @now)
       ON CONFLICT(id) DO UPDATE SET country=@country, name_en=@nameEn, name_fa=@nameFa, protocols=@protocols,
         tunnel_port=@tunnelPort, inbound_port=@inboundPort, ws_path=@wsPath, pool_index=@poolIndex, enabled=@enabled, updated_at=@now`,
    ).run({ ...input, id, protocols: JSON.stringify(input.protocols), enabled: input.enabled ? 1 : 0, now });
    audit(this.db, now, actor, "location.upsert", { id, ...input });
    return this.get(id);
  }

  get(id: string): Location {
    const r = this.db.prepare("SELECT * FROM locations WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw Errors.notFound("location");
    return toLocation(r);
  }

  all(): Location[] {
    return (this.db.prepare("SELECT * FROM locations ORDER BY id").all() as Row[]).map(toLocation);
  }

  /** What the app sees: enabled locations only, with availability. */
  listForApp() {
    return this.all().filter((l) => l.enabled).map((l) => ({
      id: l.id, country: l.country, name: { en: l.nameEn, fa: l.nameFa }, protocols: l.protocols, available: l.healthy,
    }));
  }

  /** Records a health probe. Returns the transition ("down" / "up") if availability changed. */
  recordProbe(id: string, ok: boolean): "down" | "up" | null {
    const r = this.db.prepare("SELECT healthy, fail_count FROM locations WHERE id = ?").get(id) as
      | { healthy: number; fail_count: number } | undefined;
    if (!r) return null;
    const now = this.now();
    if (ok) {
      this.db.prepare("UPDATE locations SET healthy = 1, fail_count = 0 WHERE id = ?").run(id);
      if (r.healthy === 0) { audit(this.db, now, "health", "location.up", { id }); return "up"; }
      return null;
    }
    const fails = r.fail_count + 1;
    const down = fails >= LocationService.FAILURES_TO_DOWN;
    this.db.prepare("UPDATE locations SET fail_count = ?, healthy = ? WHERE id = ?").run(fails, down ? 0 : r.healthy, id);
    if (down && r.healthy === 1) { audit(this.db, now, "health", "location.down", { id, fails }); return "down"; }
    return null;
  }
}
