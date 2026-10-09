import type { Instance, OpenVpnClient, OpenVpnManagement } from "../src/gateway/openvpn.js";

/** In-memory stand-in for the two OpenVPN instances' management interfaces. */
export class FakeOpenVpn implements OpenVpnManagement {
  readonly clients: Record<Instance, Map<string, OpenVpnClient>> = { udp: new Map(), tcp: new Map() };
  readonly killed: string[] = [];

  async status(instance: Instance): Promise<OpenVpnClient[]> {
    return [...this.clients[instance].values()];
  }

  async kill(instance: Instance, realAddr: string): Promise<boolean> {
    this.killed.push(`${instance}:${realAddr}`);
    return this.clients[instance].delete(realAddr);
  }

  /** A client on the wire (after the backend accepted it). */
  online(instance: Instance, realAddr: string, bytesIn = 0, bytesOut = 0): void {
    this.clients[instance].set(realAddr, { realAddr, bytesIn, bytesOut });
  }
}
