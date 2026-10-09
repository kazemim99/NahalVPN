import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What provisioning needs from the gateway xray. A fake implements this in tests. */
export interface XrayGateway {
  addUser(inbound: InboundRef, email: string, uuid: string): Promise<void>;
  removeUser(inboundTag: string, email: string): Promise<void>;
  /** Per-user byte counters since the previous call (the counters are reset by the query). */
  takeUserTraffic(): Promise<Map<string, { up: number; down: number }>>;
}

export interface InboundRef {
  tag: string;      // in-<loc>
  port: number;     // 127.0.0.1:<port>
  wsPath: string;   // /nv/<loc>
}

/**
 * Talks to the gateway xray through the `xray api` CLI (HandlerService / StatsService over gRPC).
 * Note: `xray api adu` needs the full inbound object (listen, port, streamSettings), not only tag + clients.
 */
export class XrayCli implements XrayGateway {
  constructor(private readonly bin: string, private readonly server: string) {}

  async addUser(inbound: InboundRef, email: string, uuid: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "nv-adu-"));
    const file = join(dir, "adu.json");
    try {
      await writeFile(file, JSON.stringify({
        inbounds: [{
          tag: inbound.tag, listen: "127.0.0.1", port: inbound.port, protocol: "vless",
          settings: { clients: [{ id: uuid, email }], decryption: "none" },
          streamSettings: { network: "ws", wsSettings: { path: inbound.wsPath } },
        }],
      }));
      const out = await this.api(["adu", `--server=${this.server}`, file]);
      if (!isAddOk(out)) throw new Error(`xray adu failed: ${out.trim()}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async removeUser(inboundTag: string, email: string): Promise<void> {
    const out = await this.api(["rmu", `--server=${this.server}`, `-tag=${inboundTag}`, email]);
    if (!isRemoveOk(out)) throw new Error(`xray rmu failed: ${out.trim()}`);
  }

  async takeUserTraffic(): Promise<Map<string, { up: number; down: number }>> {
    const { stdout } = await run(
      this.bin, ["api", "statsquery", `--server=${this.server}`, "-pattern", "user>>>", "-reset"], { timeout: 15_000 },
    );
    return parseUserStats(stdout);
  }

  /** `xray api adu/rmu` exit 0 even when the RPC fails, so callers judge the combined output, not the exit code. */
  private async api(args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await run(this.bin, ["api", ...args], { timeout: 15_000 });
      return stdout + stderr;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`;
    }
  }
}

/** Added, or already present (idempotent: resync after a partial failure, or a DB/gateway mismatch). */
export function isAddOk(out: string): boolean {
  return /Added 1 user/.test(out) || /already exists/i.test(out);
}

/** Removed, or not present (revocation must be idempotent). A dead gateway ("connection refused") is a failure. */
export function isRemoveOk(out: string): boolean {
  return /Removed 1 user/.test(out) || /User .+ not found/i.test(out);
}

/** Parses `xray api statsquery` JSON: names look like `user>>>EMAIL>>>traffic>>>uplink`. */
export function parseUserStats(json: string): Map<string, { up: number; down: number }> {
  const out = new Map<string, { up: number; down: number }>();
  const data = JSON.parse(json || "{}") as { stat?: { name: string; value?: string | number }[] };
  for (const s of data.stat ?? []) {
    const m = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(s.name);
    if (!m) continue;
    const email = m[1]!;
    const entry = out.get(email) ?? { up: 0, down: 0 };
    const v = Number(s.value ?? 0);
    if (m[2] === "uplink") entry.up += v; else entry.down += v;
    out.set(email, entry);
  }
  return out;
}
