import { connect } from "node:net";

export const INSTANCES = ["udp", "tcp"] as const;
export type Instance = (typeof INSTANCES)[number];

export interface OpenVpnClient {
  realAddr: string;   // ip:port
  bytesIn: number;    // received from the client (client upload)
  bytesOut: number;   // sent to the client (client download)
}

/** What the backend needs from the two OpenVPN instances (management interface). A fake implements it in tests. */
export interface OpenVpnManagement {
  status(instance: Instance): Promise<OpenVpnClient[]>;
  /** Disconnects the session from this real address. Resolves false if no such session (already gone). */
  kill(instance: Instance, realAddr: string): Promise<boolean>;
}

/** Talks to each instance's management interface over a unix socket (`management <path> unix`). */
export class OpenVpnManagementSocket implements OpenVpnManagement {
  constructor(private readonly sockets: Record<Instance, string>, private readonly timeoutMs = 5000) {}

  async status(instance: Instance): Promise<OpenVpnClient[]> {
    return parseStatus3(await this.command(instance, "status 3", /^END$/m));
  }

  async kill(instance: Instance, realAddr: string): Promise<boolean> {
    const out = await this.command(instance, `kill ${realAddr}`, /^(SUCCESS|ERROR):.*$/m);
    if (/^SUCCESS:/m.test(out)) return true;
    if (/common name '.*' not found|client-instance not found|not found/i.test(out)) return false;
    throw new Error(`openvpn ${instance} kill ${realAddr}: ${out.trim()}`);
  }

  private command(instance: Instance, cmd: string, done: RegExp): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.sockets[instance]);
      let buf = "";
      let sent = false;
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`openvpn ${instance} management timeout`)); }, this.timeoutMs);
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        if (!sent && buf.includes(">INFO:")) {
          sent = true;
          buf = "";
          sock.write(`${cmd}\n`);
          return;
        }
        // Real-time notifications (">...") may interleave; the answer is complete when the terminator shows up.
        const answer = buf.split("\n").filter((l) => !l.startsWith(">")).join("\n");
        if (sent && done.test(answer)) {
          clearTimeout(timer);
          sock.end("quit\n");
          resolve(answer);
        }
      });
      sock.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }
}

/**
 * Parses `status 3` (tab-separated). CLIENT_LIST columns: CN, Real Address, Virtual Address, Virtual IPv6,
 * Bytes Received, Bytes Sent, Connected Since, Connected Since (time_t), Username, Client ID, Peer ID, Cipher.
 */
export function parseStatus3(text: string): OpenVpnClient[] {
  const out: OpenVpnClient[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.split("\t");
    if (f[0] !== "CLIENT_LIST" || f.length < 7) continue;
    out.push({ realAddr: f[2]!, bytesIn: Number(f[5]) || 0, bytesOut: Number(f[6]) || 0 });
  }
  return out;
}
