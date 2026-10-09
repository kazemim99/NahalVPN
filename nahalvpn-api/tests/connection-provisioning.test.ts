import { describe, expect, it } from "vitest";
import { DAY, authed, connect, login, setup, signedIn, withDE } from "./helpers.js";

describe("connection-provisioning", () => {
  it("VLESS configuration: gateway host, TLS SNI, DE path and a per-device user ID, live on the DE inbound", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    const res = await connect(ctx, s.accessToken);
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c).toMatchObject({
      protocol: "vless", location: "de", host: "api.nahalkmi.ir", port: 443, security: "tls", sni: "api.nahalkmi.ir",
      network: "ws", path: "/nv/de",
    });
    expect(c.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.uri).toBe(
      `vless://${c.uuid}@api.nahalkmi.ir:443?encryption=none&security=tls&sni=api.nahalkmi.ir&fp=chrome&type=ws&host=api.nahalkmi.ir&path=%2Fnv%2Fde#NahalVPN-de`,
    );
    expect(ctx.xray.accepts("in-de", c.uuid)).toBe(true);
    expect(ctx.xray.emailOf("in-de", c.uuid)).toBe(`u${s.userId}-${c.uuid.slice(0, 8)}.de`);
  });

  it("No foreign addresses exposed: no IP literal and no tunnel or inbound port in the config", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    const text = (await connect(ctx, s.accessToken)).body;
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toContain("2055");
    expect(text).not.toContain("10510");
  });

  it("Connecting again reuses the live credential (no duplicate gateway user)", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    const a = (await connect(ctx, s.accessToken)).json();
    const b = (await connect(ctx, s.accessToken)).json();
    expect(b.uuid).toBe(a.uuid);
    expect(ctx.xray.adds).toBe(1);
  });

  it("Credential deactivated live: logout removes it from the gateway; other users unaffected", async () => {
    const ctx = setup();
    await withDE(ctx);
    const one = await signedIn(ctx, "nv-user1");
    const two = await signedIn(ctx, "nv-user2", {}, "device-bbbbbbbb");
    const c1 = (await connect(ctx, one.accessToken)).json();
    const c2 = (await connect(ctx, two.accessToken)).json();
    expect((await authed(ctx, "POST", "/v1/auth/logout", one.accessToken)).statusCode).toBe(204);
    expect(ctx.xray.accepts("in-de", c1.uuid)).toBe(false);
    expect(ctx.xray.accepts("in-de", c2.uuid)).toBe(true);
  });

  it("Old credential stops working after re-login; the device gets a new one", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    const old = (await connect(ctx, s.accessToken)).json();
    const again = (await login(ctx, "nv-user1", "correct-horse-1")).json();
    expect(again.deviceId).toBe(s.deviceId);
    expect(ctx.xray.accepts("in-de", old.uuid)).toBe(false);
    const fresh = (await connect(ctx, again.accessToken)).json();
    expect(fresh.uuid).not.toBe(old.uuid);
    expect(ctx.xray.accepts("in-de", fresh.uuid)).toBe(true);
  });

  it("Removing another device revokes that device's credential only", async () => {
    const ctx = setup();
    await withDE(ctx);
    const a = await signedIn(ctx, "nv-user1", { deviceLimit: 2 }, "device-aaaaaaaa");
    const b = (await login(ctx, "nv-user1", "correct-horse-1", "device-bbbbbbbb", "Tablet")).json();
    const ca = (await connect(ctx, a.accessToken)).json();
    const cb = (await connect(ctx, b.accessToken)).json();
    expect((await authed(ctx, "DELETE", `/v1/me/devices/${b.deviceId}`, a.accessToken)).statusCode).toBe(204);
    expect(ctx.xray.accepts("in-de", cb.uuid)).toBe(false);
    expect(ctx.xray.accepts("in-de", ca.uuid)).toBe(true);
  });

  it("Refuses unknown locations, OpenVPN until group 6, and expired subscriptions", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    expect((await connect(ctx, s.accessToken, "xx")).statusCode).toBe(404);
    expect((await connect(ctx, s.accessToken, "de", "openvpn")).json().error).toBe("protocol_not_ready");
    expect(ctx.xray.adds).toBe(0);
    ctx.clock.t += 30 * DAY;
    // Access tokens live 15 minutes, so check the service directly as well as the route.
    expect([401, 403]).toContain((await connect(ctx, s.accessToken)).statusCode);
    await expect(ctx.provisioning.connect(s.userId, s.deviceId, "de", "vless")).rejects.toMatchObject({ code: "subscription_expired" });
    expect(ctx.xray.adds).toBe(0);
  });

  it("Gateway briefly unreachable on revoke: access is cut in the DB and the removal is retried", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    const c = (await connect(ctx, s.accessToken)).json();
    ctx.xray.failRemovals = true;
    expect((await authed(ctx, "POST", "/v1/auth/logout", s.accessToken)).statusCode).toBe(204);
    expect(ctx.xray.accepts("in-de", c.uuid)).toBe(true);
    expect(await ctx.provisioning.retryPendingRemovals()).toBe(1);
    ctx.xray.failRemovals = false;
    expect(await ctx.provisioning.retryPendingRemovals()).toBe(0);
    expect(ctx.xray.accepts("in-de", c.uuid)).toBe(false);
  });

  it("Gateway restart: resync re-adds active credentials only", async () => {
    const ctx = setup();
    await withDE(ctx);
    const one = await signedIn(ctx, "nv-user1");
    const two = await signedIn(ctx, "nv-user2", {}, "device-bbbbbbbb");
    const c1 = (await connect(ctx, one.accessToken)).json();
    const c2 = (await connect(ctx, two.accessToken)).json();
    await authed(ctx, "POST", "/v1/auth/logout", two.accessToken);
    ctx.xray.restart();
    expect(await ctx.provisioning.resync()).toEqual({ added: 1, failed: 0 });
    expect(ctx.xray.accepts("in-de", c1.uuid)).toBe(true);
    expect(ctx.xray.accepts("in-de", c2.uuid)).toBe(false);
  });
});
