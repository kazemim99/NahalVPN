import { describe, expect, it } from "vitest";
import { parseStatus3 } from "../src/gateway/openvpn.js";
import { DAY, INTERNAL_TOKEN, SUPER_TOKEN, DE, adminReq, authed, connect, login, setup, signedIn, withDE } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;

function hook(ctx: Ctx, path: "auth" | "connect" | "disconnect", payload: object, token: string | null = INTERNAL_TOKEN) {
  return ctx.app.inject({
    method: "POST", url: `/v1/internal/openvpn/${path}`, payload,
    headers: token === null ? {} : { "x-internal-token": token },
  });
}

/** Test user (allowed by OPENVPN_USERS) with an issued OpenVPN credential for DE. */
async function ovpnUser(ctx: Ctx, username = "ovpn-a", deviceId = "device-aaaaaaaa", plan: object = {}) {
  const s = await signedIn(ctx, username, plan, deviceId);
  const res = await connect(ctx, s.accessToken, "de", "openvpn");
  if (res.statusCode !== 200) throw new Error(`connect openvpn ${res.statusCode} ${res.body}`);
  return { ...s, cfg: res.json() as { username: string; password: string; profile: string } };
}

async function up(ctx: Ctx, instance: "udp" | "tcp", username: string, password: string, realAddr: string) {
  const a = await hook(ctx, "auth", { instance, username, password, realAddr });
  if (a.statusCode !== 204) return { auth: a.statusCode, address: null as string | null };
  const c = await hook(ctx, "connect", { instance, realAddr });
  return { auth: 204, address: c.statusCode === 200 ? (c.json().config as string) : null };
}

describe("openvpn-gateway", () => {
  it("OpenVPN configuration: profile for the gateway on 2083, UDP first then TCP, per-device credentials naming DE", async () => {
    const ctx = setup();
    await withDE(ctx);
    const { cfg } = await ovpnUser(ctx);
    expect(cfg.username).toBe("ovpn-a@de");
    expect(cfg.password.length).toBeGreaterThanOrEqual(32);
    const udp = cfg.profile.indexOf("remote api.nahalkmi.ir 2083 udp");
    const tcp = cfg.profile.indexOf("remote api.nahalkmi.ir 2083 tcp-client");
    expect(udp).toBeGreaterThan(0);
    expect(tcp).toBeGreaterThan(udp);
    // TCP fallback within seconds: the UDP block carries its own timeout (options after the blocks are not inherited).
    expect(cfg.profile.slice(udp, tcp)).toContain("connect-timeout 8");
    expect(cfg.profile).toContain("<tls-crypt>");
    expect(cfg.profile).toContain("verify-x509-name gw.nahalvpn name");
    expect(cfg.profile).toContain("auth-user-pass");
    expect(cfg.profile).not.toContain("1194");
    // Structured form for the app's built-in engine.
    expect((cfg as unknown as { server: object }).server).toEqual({
      host: "api.nahalkmi.ir", port: 2083, serverName: "gw.nahalvpn",
      ca: expect.stringContaining("TESTCA"), tlsCrypt: expect.stringContaining("TESTKEY"),
    });
    expect(JSON.stringify(cfg)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  it("testing phase: OpenVPN is refused for users outside OPENVPN_USERS, at /connect and at the gateway", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx, "nv-user1");
    expect((await connect(ctx, s.accessToken, "de", "openvpn")).json().error).toBe("protocol_not_ready");
    expect((await hook(ctx, "auth", { instance: "udp", username: "nv-user1@de", password: "x".repeat(32), realAddr: "5.6.7.8:1000" })).statusCode).toBe(403);
  });

  it("Valid credential: login approved and the session gets an address from DE's pool", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await ovpnUser(ctx, "ovpn-a");
    const b = await ovpnUser(ctx, "ovpn-b", "device-bbbbbbbb");
    expect(await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:40000")).toEqual({ auth: 204, address: "ifconfig-push 10.80.1.2 255.255.0.0" });
    expect(await up(ctx, "udp", b.cfg.username, b.cfg.password, "9.9.9.9:50000")).toEqual({ auth: 204, address: "ifconfig-push 10.80.1.3 255.255.0.0" });
    expect((await up(ctx, "tcp", b.cfg.username, b.cfg.password, "9.9.9.9:50001")).address).toBe("ifconfig-push 10.81.1.2 255.255.0.0");
  });

  it("Revoked or expired credential: an older password, a wrong one, an expired or disabled subscription are rejected", async () => {
    const ctx = setup();
    await withDE(ctx);
    const first = await ovpnUser(ctx);
    const again = (await connect(ctx, first.accessToken, "de", "openvpn")).json(); // re-issue revokes the first
    expect((await up(ctx, "udp", "ovpn-a@de", first.cfg.password, "5.6.7.8:1")).auth).toBe(403);
    expect((await up(ctx, "udp", "ovpn-a@de", "wrong-" + again.password.slice(6), "5.6.7.8:2")).auth).toBe(403);
    expect((await up(ctx, "udp", "ovpn-a@de", again.password, "5.6.7.8:3")).auth).toBe(204);

    ctx.clock.t += 30 * DAY;
    expect((await up(ctx, "udp", "ovpn-a@de", again.password, "5.6.7.8:4")).auth).toBe(403);
  });

  it("Revoked credential: re-login on the device rotates OpenVPN credentials too", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await ovpnUser(ctx);
    await login(ctx, "ovpn-a", "correct-horse-1");
    expect((await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:1")).auth).toBe(403);
  });

  it("Unknown location: a missing, disabled or down location, or a bad username, is rejected", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await ovpnUser(ctx);
    for (const u of ["ovpn-a@xx", "ovpn-a", "@de", "ovpn-a@DE"]) {
      expect((await up(ctx, "udp", u, a.cfg.password, "5.6.7.8:1")).auth).toBe(403);
    }
    ctx.probe.ok = () => false;
    for (let n = 0; n < 3; n++) await ctx.health.tick();
    expect((await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:1")).auth).toBe(403);
    ctx.probe.ok = () => true;
    await ctx.health.tick();
    await adminReq(ctx, "PUT", "/v1/admin/locations/de", SUPER_TOKEN, { ...DE, enabled: false });
    expect((await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:1")).auth).toBe(403);
  });

  it("client-connect without a preceding approved auth, or long after it, is refused", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await ovpnUser(ctx);
    expect((await hook(ctx, "connect", { instance: "udp", realAddr: "1.1.1.1:1" })).statusCode).toBe(403);
    expect((await hook(ctx, "auth", { instance: "udp", username: a.cfg.username, password: a.cfg.password, realAddr: "5.6.7.8:9" })).statusCode).toBe(204);
    ctx.clock.t += 3 * 60_000;
    expect((await hook(ctx, "connect", { instance: "udp", realAddr: "5.6.7.8:9" })).statusCode).toBe(403);
  });

  it("Forced disconnect: revoking the device kills its live session and reconnects are rejected", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await ovpnUser(ctx);
    await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:40000");
    ctx.ovpnMgmt.online("udp", "5.6.7.8:40000");
    expect((await authed(ctx, "POST", "/v1/auth/logout", a.accessToken)).statusCode).toBe(204);
    expect(ctx.ovpnMgmt.killed).toEqual(["udp:5.6.7.8:40000"]);
    expect((await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:40001")).auth).toBe(403);
  });

  it("OpenVPN usage recorded per user, location and protocol; the disconnect books the rest exactly once", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await ovpnUser(ctx);
    await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:40000");
    ctx.ovpnMgmt.online("udp", "5.6.7.8:40000", 1_000, 50_000);
    await ctx.usage.collect();
    ctx.ovpnMgmt.online("udp", "5.6.7.8:40000", 1_500, 80_000);
    await ctx.usage.collect();
    await ctx.usage.collect(); // nothing new
    await hook(ctx, "disconnect", { instance: "udp", realAddr: "5.6.7.8:40000", bytesIn: 2_000, bytesOut: 100_000 });
    await hook(ctx, "disconnect", { instance: "udp", realAddr: "5.6.7.8:40000", bytesIn: 2_000, bytesOut: 100_000 }); // duplicate
    expect(ctx.usage.breakdown(a.userId)).toEqual([{ location: "de", protocol: "openvpn", upBytes: 2_000, downBytes: 100_000 }]);
  });

  it("unlimited traffic over OpenVPN: heavy use never kills the session or blocks new logins", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await ovpnUser(ctx);
    await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:40000");
    ctx.ovpnMgmt.online("udp", "5.6.7.8:40000", 400 * 1024 ** 3, 600 * 1024 ** 3);
    await ctx.usage.tick();
    expect(ctx.ovpnMgmt.killed).toEqual([]);
    expect((await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:40001")).auth).toBe(204);
  });

  it("a session OpenVPN no longer reports is closed and its address is reused", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await ovpnUser(ctx);
    expect((await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:1")).address).toBe("ifconfig-push 10.80.1.2 255.255.0.0");
    await ctx.usage.collect(); // not in status (e.g. OpenVPN restarted)
    expect((await up(ctx, "udp", a.cfg.username, a.cfg.password, "5.6.7.8:2")).address).toBe("ifconfig-push 10.80.1.2 255.255.0.0");
  });

  it("gateway hooks need the internal token", async () => {
    const ctx = setup();
    const body = { instance: "udp", username: "a@de", password: "x", realAddr: "1.2.3.4:5" };
    expect((await hook(ctx, "auth", body, null)).statusCode).toBe(404);
    expect((await hook(ctx, "auth", body, "wrong-token-wrong-token-wrong-token!")).statusCode).toBe(404);
  });

  it("parses management `status 3` output", () => {
    const text = [
      "TITLE\tOpenVPN 2.6.12 x86_64-pc-linux-gnu",
      "HEADER\tCLIENT_LIST\tCommon Name\tReal Address\tVirtual Address\tVirtual IPv6 Address\tBytes Received\tBytes Sent\tConnected Since\tConnected Since (time_t)\tUsername\tClient ID\tPeer ID\tData Channel Cipher",
      "CLIENT_LIST\tovpn-a@de\t5.6.7.8:40000\t10.80.1.2\t\t12345\t678910\t2026-10-08 09:00:00\t1791450000\tovpn-a@de\t3\t0\tAES-128-GCM",
      "ROUTING_TABLE\t10.80.1.2\tovpn-a@de\t5.6.7.8:40000\t2026-10-08 09:00:01\t1791450001",
      "END",
    ].join("\n");
    expect(parseStatus3(text)).toEqual([{ realAddr: "5.6.7.8:40000", bytesIn: 12345, bytesOut: 678910 }]);
  });
});
