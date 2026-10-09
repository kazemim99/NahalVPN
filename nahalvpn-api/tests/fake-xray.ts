import type { InboundRef, XrayGateway } from "../src/gateway/xray.js";

/** In-memory stand-in for the gateway xray: tracks live users per inbound and per-user traffic counters. */
export class FakeXray implements XrayGateway {
  readonly inbounds = new Map<string, Map<string, string>>(); // tag -> email -> uuid
  readonly traffic = new Map<string, { up: number; down: number }>();
  failRemovals = false;
  adds = 0;

  async addUser(inbound: InboundRef, email: string, uuid: string): Promise<void> {
    const users = this.inbounds.get(inbound.tag) ?? new Map<string, string>();
    if (users.has(email)) throw new Error(`User ${email} already exists.`);
    users.set(email, uuid);
    this.inbounds.set(inbound.tag, users);
    this.adds++;
  }

  async removeUser(tag: string, email: string): Promise<void> {
    if (this.failRemovals) throw new Error("connection refused");
    this.inbounds.get(tag)?.delete(email);
  }

  async takeUserTraffic() {
    const out = new Map(this.traffic);
    this.traffic.clear();
    return out;
  }

  /** Would a VLESS client with this UUID be accepted on this inbound? */
  accepts(tag: string, uuid: string): boolean {
    return [...(this.inbounds.get(tag)?.values() ?? [])].includes(uuid);
  }

  emailOf(tag: string, uuid: string): string | undefined {
    for (const [email, id] of this.inbounds.get(tag) ?? []) if (id === uuid) return email;
    return undefined;
  }

  /** Simulates a gateway restart: runtime-added users are gone. */
  restart(): void {
    this.inbounds.clear();
  }
}
