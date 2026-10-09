import { request } from "node:http";
import type { LocationService } from "./location-service.js";

/** A probe returns true if the location's reverse tunnel answers end to end. */
export type Probe = (tunnelPort: number) => Promise<boolean>;

/**
 * Probes the relay through the location's tunnel: an HTTP GET on the relay's WS path must come back from the
 * foreign xray (it answers 400 to a non-upgrade request). Anything else, or no answer in 5 s, is a failure.
 */
export const relayProbe: Probe = (tunnelPort) =>
  new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: tunnelPort, path: "/relay-stream", timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 400);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });

/** location-catalog "Location health": probes every enabled location; logs transitions for the operator. */
export class HealthMonitor {
  constructor(
    private readonly locations: LocationService,
    private readonly probe: Probe,
    private readonly notify: (msg: string) => void = (m) => console.warn(`[health] ${m}`),
  ) {}

  async tick(): Promise<void> {
    for (const loc of this.locations.all().filter((l) => l.enabled)) {
      const ok = await this.probe(loc.tunnelPort).catch(() => false);
      const change = this.locations.recordProbe(loc.id, ok);
      if (change) this.notify(`location ${loc.id} is ${change.toUpperCase()}`);
    }
  }
}
