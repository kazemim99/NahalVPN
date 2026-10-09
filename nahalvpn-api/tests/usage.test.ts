import { describe, expect, it } from "vitest";
import { isAddOk, isRemoveOk, parseUserStats } from "../src/gateway/xray.js";
import { DAY, GB, RESELLER_A, adminReq, authed, connect, setup, signedIn, withDE } from "./helpers.js";

describe("subscription-usage: statistics, unlimited traffic and expiry enforcement", () => {
  it("parses xray statsquery output", () => {
    const out = parseUserStats(JSON.stringify({ stat: [
      { name: "user>>>u1-abc.de>>>traffic>>>uplink", value: "100" },
      { name: "user>>>u1-abc.de>>>traffic>>>downlink", value: 2500 },
      { name: "inbound>>>in-de>>>traffic>>>uplink", value: 9 },
      { name: "user>>>u2-def.de>>>traffic>>>downlink" },
    ] }));
    expect([...out]).toEqual([["u1-abc.de", { up: 100, down: 2500 }], ["u2-def.de", { up: 0, down: 0 }]]);
    expect(parseUserStats("").size).toBe(0);
  });

  it("judges xray adu/rmu by their output (they exit 0 on RPC errors), using real xray 26 output", () => {
    expect(isRemoveOk(`remove user: nobody.de\nrpc error: code = Unknown desc = proxy/vless: User nobody.de not found.\nRemoved 0 user(s) in total.`)).toBe(true);
    expect(isRemoveOk(`remove user: u1-a.de\nRemoved 1 user(s) in total.`)).toBe(true);
    expect(isRemoveOk(`failed to dial 127.0.0.1:10850: connection refused\nRemoved 0 user(s) in total.`)).toBe(false);
    expect(isAddOk(`Added 1 user(s) in total.`)).toBe(true);
    expect(isAddOk(`rpc error: code = Unknown desc = User u1-a.de already exists.\nAdded 0 user(s) in total.`)).toBe(true);
    expect(isAddOk(`connection refused\nAdded 0 user(s) in total.`)).toBe(false);
  });

  it("VLESS traffic is recorded per user, location and protocol for the reseller; the app is told nothing about it", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    const c = (await connect(ctx, s.accessToken)).json();
    const email = ctx.xray.emailOf("in-de", c.uuid)!;
    ctx.xray.traffic.set(email, { up: 1_000_000, down: 52_000_000 });
    ctx.xray.traffic.set("someone-else@x-ui", { up: 5, down: 5 }); // not an app credential: ignored
    expect(await ctx.usage.collect()).toBe(1);
    ctx.xray.traffic.set(email, { up: 1, down: 2 });
    await ctx.usage.collect();

    const me = (await authed(ctx, "GET", "/v1/me", s.accessToken)).json();
    for (const key of ["quotaBytes", "usedBytes", "remainingBytes", "usage", "traffic", "trafficBytes"]) expect(me).not.toHaveProperty(key);

    const admin = (await adminReq(ctx, "GET", `/v1/admin/users/${s.userId}`, RESELLER_A)).json();
    expect(admin.trafficBytes).toBe(53_000_003);
    expect(admin.traffic).toEqual([{ location: "de", protocol: "vless", upBytes: 1_000_001, downBytes: 52_000_002 }]);
  });

  it("Traffic of a just-revoked credential is still counted for its user", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    const c = (await connect(ctx, s.accessToken)).json();
    const email = ctx.xray.emailOf("in-de", c.uuid)!;
    await authed(ctx, "POST", "/v1/auth/logout", s.accessToken);
    ctx.xray.traffic.set(email, { up: 10, down: 20 });
    await ctx.usage.collect();
    expect(ctx.usage.usedBytes(s.userId)).toBe(30);
  });

  it("Unlimited traffic: any amount of data never cuts access", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx, "nv-user1");
    const c = (await connect(ctx, s.accessToken)).json();
    ctx.xray.traffic.set(ctx.xray.emailOf("in-de", c.uuid)!, { up: 400 * GB, down: 600 * GB });
    await ctx.usage.tick();
    expect(ctx.xray.accepts("in-de", c.uuid)).toBe(true);
    expect(await ctx.usage.enforce()).toEqual([]);
    expect((await connect(ctx, s.accessToken)).statusCode).toBe(200);
  });

  it("Subscription expired: credentials revoked by the enforcer, other users untouched", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    const longer = await signedIn(ctx, "nv-long", { days: 90 }, "device-bbbbbbbb");
    const c = (await connect(ctx, s.accessToken)).json();
    const cl = (await connect(ctx, longer.accessToken)).json();
    ctx.clock.t += 30 * DAY;
    expect(await ctx.usage.enforce()).toEqual([{ userId: s.userId, reason: "expired" }]);
    expect(ctx.xray.accepts("in-de", c.uuid)).toBe(false);
    expect(ctx.xray.accepts("in-de", cl.uuid)).toBe(true);
    expect(await ctx.usage.enforce()).toEqual([]); // nothing of the expired user is live any more
  });

  it("Renewal brings an expired user back (login and connect work again)", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    ctx.clock.t += 31 * DAY;
    await ctx.usage.enforce();
    await adminReq(ctx, "POST", `/v1/admin/users/${s.userId}/renew`, RESELLER_A, { days: 30, months: 1 });
    const again = (await ctx.app.inject({
      method: "POST", url: "/v1/auth/login", payload: { username: "nv-user1", password: "correct-horse-1", deviceId: "device-aaaaaaaa", deviceName: "Pixel" },
    })).json();
    expect((await connect(ctx, again.accessToken)).statusCode).toBe(200);
  });
});
