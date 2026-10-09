// Spec: openspec/changes/nahalvpn-app/specs/app-auth/spec.md
import { beforeEach, describe, expect, it } from "vitest";
import { authed, createUser, login, setup, SUPER_TOKEN, RESELLER_A } from "./helpers.js";

let ctx: ReturnType<typeof setup>;
beforeEach(async () => {
  ctx = setup();
  await createUser(ctx, SUPER_TOKEN, "sara", { deviceLimit: 2 }); // most tests need two devices; the default (1) has its own test
});

describe("Requirement: Username and password login", () => {
  it("Successful login: access token ≤15 min + device-bound refresh token", async () => {
    const res = await login(ctx, "sara", "correct-horse-1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf("string");
    expect(body.refreshToken).toBeTypeOf("string");
    expect(body.accessExpiresAt - ctx.clock.t).toBeLessThanOrEqual(15 * 60_000);
    expect((await authed(ctx, "GET", "/v1/me", body.accessToken)).statusCode).toBe(200);
  });

  it("Wrong password: generic error that does not reveal whether the username exists", async () => {
    const wrongPw = await login(ctx, "sara", "nope-nope-1");
    const noUser = await login(ctx, "nobody", "nope-nope-1");
    expect(wrongPw.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPw.json()).toEqual(noUser.json());
    expect(wrongPw.json()).toEqual({ error: "invalid_credentials" });
  });

  it("Brute-force protection: 10 failures in 15 min lock the username for ≥15 min", async () => {
    for (let i = 0; i < 10; i++) expect((await login(ctx, "sara", "bad-pass-" + i)).statusCode).toBe(401);
    const locked = await login(ctx, "sara", "correct-horse-1");
    expect(locked.statusCode).toBe(429);
    ctx.clock.t += 14 * 60_000;
    expect((await login(ctx, "sara", "correct-horse-1")).statusCode).toBe(429);
    ctx.clock.t += 2 * 60_000; // failures now older than the 15-minute window
    expect((await login(ctx, "sara", "correct-horse-1")).statusCode).toBe(200);
  });

  it("Expired subscription: login returns subscription_expired", async () => {
    ctx.clock.t += 31 * 24 * 3_600_000;
    const res = await login(ctx, "sara", "correct-horse-1");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("subscription_expired");
  });
});

describe("Requirement: Token refresh and rotation", () => {
  it("Refresh succeeds: new pair returned, old refresh token stops working", async () => {
    const first = (await login(ctx, "sara", "correct-horse-1")).json();
    const r1 = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: first.refreshToken } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().refreshToken).not.toBe(first.refreshToken);
    const again = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: first.refreshToken } });
    expect(again.statusCode).toBe(401);
  });

  it("Refresh token reuse: rejected and every session of that device is revoked", async () => {
    const first = (await login(ctx, "sara", "correct-horse-1")).json();
    const second = (await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: first.refreshToken } })).json();
    // attacker replays the old token
    await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: first.refreshToken } });
    // the legitimate newer token is now dead too, and so is the access token
    const legit = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: second.refreshToken } });
    expect(legit.statusCode).toBe(401);
    expect((await authed(ctx, "GET", "/v1/me", second.accessToken)).statusCode).toBe(401);
    expect(ctx.revoked).toContain(first.deviceId);
  });
});

describe("Requirement: Device limit", () => {
  it("Default: an account is usable on one device only; a second device is refused with the first listed", async () => {
    await createUser(ctx, SUPER_TOKEN, "solo");
    expect((await login(ctx, "solo", "correct-horse-1", "device-one-1111")).statusCode).toBe(200);
    const second = await login(ctx, "solo", "correct-horse-1", "device-two-2222");
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("device_limit_reached");
    expect(second.json().devices).toHaveLength(1);
  });

  it("Limit reached: (N+1)th device rejected with the list of active devices", async () => {
    expect((await login(ctx, "sara", "correct-horse-1", "device-one-1111")).statusCode).toBe(200);
    expect((await login(ctx, "sara", "correct-horse-1", "device-two-2222")).statusCode).toBe(200);
    const third = await login(ctx, "sara", "correct-horse-1", "device-three-33");
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toBe("device_limit_reached");
    expect(third.json().devices).toHaveLength(2);
  });

  it("Same device logging in again does not consume another slot", async () => {
    await login(ctx, "sara", "correct-horse-1", "device-one-1111");
    await login(ctx, "sara", "correct-horse-1", "device-one-1111");
    expect((await login(ctx, "sara", "correct-horse-1", "device-two-2222")).statusCode).toBe(200);
  });

  it("Removing a device frees a slot and revokes its sessions and credentials", async () => {
    const one = (await login(ctx, "sara", "correct-horse-1", "device-one-1111")).json();
    const two = (await login(ctx, "sara", "correct-horse-1", "device-two-2222")).json();
    const del = await authed(ctx, "DELETE", `/v1/me/devices/${two.deviceId}`, one.accessToken);
    expect(del.statusCode).toBe(204);
    expect(ctx.revoked).toContain(two.deviceId);
    expect((await authed(ctx, "GET", "/v1/me", two.accessToken)).statusCode).toBe(401);
    expect((await login(ctx, "sara", "correct-horse-1", "device-three-33")).statusCode).toBe(200);
  });

  it("Limit reached: the user can sign out one of their own devices to sign in here", async () => {
    await login(ctx, "sara", "correct-horse-1", "device-one-1111");
    const two = (await login(ctx, "sara", "correct-horse-1", "device-two-2222")).json();
    const third = await ctx.app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { username: "sara", password: "correct-horse-1", deviceId: "device-three-33", deviceName: "New", replaceDeviceId: two.deviceId },
    });
    expect(third.statusCode).toBe(200);
    expect(ctx.revoked).toContain(two.deviceId);
    expect((await authed(ctx, "GET", "/v1/me", two.accessToken)).statusCode).toBe(401);
    const me = (await authed(ctx, "GET", "/v1/me", third.json().accessToken)).json();
    expect(me.devices.map((d: { name: string }) => d.name).sort()).toEqual(["New", "Pixel"]);
  });

  it("Limit reached: replacing needs the right password and one of the user's own devices", async () => {
    await login(ctx, "sara", "correct-horse-1", "device-one-1111");
    await login(ctx, "sara", "correct-horse-1", "device-two-2222");
    const bad = (body: object) => ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: body });
    const base = { username: "sara", deviceId: "device-three-33", deviceName: "New" };
    expect((await bad({ ...base, password: "wrong-password", replaceDeviceId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(401);
    const other = await bad({ ...base, password: "correct-horse-1", replaceDeviceId: "00000000-0000-4000-8000-000000000000" });
    expect(other.statusCode).toBe(409);
    expect(ctx.revoked).toEqual([]);
  });
});

describe("Requirement: Logout and revocation", () => {
  it("User logs out: refresh token invalidated and credentials revoked", async () => {
    const s = (await login(ctx, "sara", "correct-horse-1")).json();
    expect((await authed(ctx, "POST", "/v1/auth/logout", s.accessToken)).statusCode).toBe(204);
    expect(ctx.revoked).toContain(s.deviceId);
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(r.statusCode).toBe(401);
  });

  it("Admin disables a user: all sessions and credentials revoked, login refused", async () => {
    const a = (await login(ctx, "sara", "correct-horse-1", "device-one-1111")).json();
    const b = (await login(ctx, "sara", "correct-horse-1", "device-two-2222")).json();
    const res = await ctx.app.inject({
      method: "POST", url: `/v1/admin/users/1/disable`, headers: { authorization: `Bearer ${SUPER_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    expect(ctx.revoked).toEqual(expect.arrayContaining([a.deviceId, b.deviceId]));
    expect((await authed(ctx, "GET", "/v1/me", a.accessToken)).statusCode).toBe(401);
    expect((await login(ctx, "sara", "correct-horse-1")).json().error).toBe("account_disabled");
  });

  it("A reseller cannot disable another reseller's user", async () => {
    const res = await ctx.app.inject({
      method: "POST", url: `/v1/admin/users/1/disable`, headers: { authorization: `Bearer ${RESELLER_A}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
