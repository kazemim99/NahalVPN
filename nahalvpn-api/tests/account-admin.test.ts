// Spec: openspec/changes/nahalvpn-app/specs/app-auth/spec.md, "Account administration" (task 9.1)
import { beforeEach, describe, expect, it } from "vitest";
import { PANEL_TOKEN, RESELLER_A, RESELLER_B, SUPER_TOKEN, adminReq, authed, createUser, login, setup } from "./helpers.js";

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });

const del = (url: string, token: string) => ctx.app.inject({ method: "DELETE", url, headers: { authorization: `Bearer ${token}` } });

describe("Requirement: Account administration", () => {
  it("Reseller lists their users: only own users, newest first, with expiry, devices and status", async () => {
    const a1 = await createUser(ctx, RESELLER_A, "a-one");
    ctx.clock.t += 1000;
    const a2 = await createUser(ctx, RESELLER_A, "a-two", { deviceLimit: 2 });
    await createUser(ctx, RESELLER_B, "r-one");
    expect((await login(ctx, "a-two", "correct-horse-1")).statusCode).toBe(200);

    const res = await adminReq(ctx, "GET", "/v1/admin/users", RESELLER_A);
    expect(res.statusCode).toBe(200);
    const users = res.json().users;
    expect(users.map((u: { username: string }) => u.username)).toEqual(["a-two", "a-one"]);
    expect(users[0]).toMatchObject({ userId: a2.userId, owner: "ali", deviceLimit: 2, devices: 1, disabled: false, expiresAt: a2.expiresAt });
    expect(users[1]).toMatchObject({ userId: a1.userId, devices: 0, trafficBytes: 0 });

    // Traffic statistic: the sum of every usage sample of that user, across locations and protocols.
    const sample = ctx.db.prepare("INSERT INTO usage_samples (user_id, location_id, protocol, up_bytes, down_bytes, at) VALUES (?, 'de', ?, ?, ?, 0)");
    sample.run(a1.userId, "vless", 1000, 5000);
    sample.run(a1.userId, "openvpn", 200, 800);
    const again = (await adminReq(ctx, "GET", "/v1/admin/users", RESELLER_A)).json().users;
    expect(again.find((u: { userId: number }) => u.userId === a1.userId).trafficBytes).toBe(7000);
    expect(again.find((u: { userId: number }) => u.userId === a2.userId).trafficBytes).toBe(0);

    const all = (await adminReq(ctx, "GET", "/v1/admin/users", SUPER_TOKEN)).json().users;
    expect(all).toHaveLength(3);
    const viaPanel = await ctx.app.inject({ method: "GET", url: "/v1/admin/users", headers: { authorization: `Bearer ${PANEL_TOKEN}`, "x-act-as": "ramin" } });
    expect(viaPanel.json().users.map((u: { username: string }) => u.username)).toEqual(["r-one"]);
  });

  it("Admin re-enables a user: login works again", async () => {
    const { userId } = await createUser(ctx, RESELLER_A, "a-one");
    expect((await adminReq(ctx, "POST", `/v1/admin/users/${userId}/disable`, RESELLER_A)).statusCode).toBe(204);
    expect((await login(ctx, "a-one", "correct-horse-1")).json().error).toBe("account_disabled");
    expect((await adminReq(ctx, "POST", `/v1/admin/users/${userId}/enable`, RESELLER_A)).statusCode).toBe(204);
    expect((await login(ctx, "a-one", "correct-horse-1")).statusCode).toBe(200);
    expect((await adminReq(ctx, "GET", `/v1/admin/users/${userId}`, RESELLER_A)).json().disabled).toBe(false);
  });

  it("Admin resets a password: old fails, new works, lockout cleared, signed-in devices stay", async () => {
    const { userId } = await createUser(ctx, RESELLER_A, "a-one");
    const first = (await login(ctx, "a-one", "correct-horse-1")).json();
    for (let i = 0; i < 10; i++) await login(ctx, "a-one", "wrong-password", "device-bbbbbbbb");
    expect((await login(ctx, "a-one", "correct-horse-1", "device-bbbbbbbb")).json().error).toBe("too_many_attempts");

    const res = await adminReq(ctx, "POST", `/v1/admin/users/${userId}/password`, RESELLER_A, { password: "new-secret-22" });
    expect(res.statusCode).toBe(204);
    expect((await login(ctx, "a-one", "correct-horse-1")).json().error).toBe("invalid_credentials");
    expect((await login(ctx, "a-one", "new-secret-22")).statusCode).toBe(200); // same device as before: no extra slot
    expect((await authed(ctx, "GET", "/v1/me", first.accessToken)).statusCode).toBe(200);
    expect((await adminReq(ctx, "POST", `/v1/admin/users/${userId}/password`, RESELLER_A, { password: "abc" })).statusCode).toBe(400); // 4 characters is the minimum
  });

  it("Admin removes a device: its sessions and credentials are revoked and the slot is free", async () => {
    const { userId } = await createUser(ctx, RESELLER_A, "a-one");
    const first = (await login(ctx, "a-one", "correct-horse-1")).json();
    expect((await login(ctx, "a-one", "correct-horse-1", "device-bbbbbbbb")).statusCode).toBe(409); // limit 1
    const devices = (await adminReq(ctx, "GET", `/v1/admin/users/${userId}`, RESELLER_A)).json().devices;
    expect(devices).toHaveLength(1);

    expect((await del(`/v1/admin/users/${userId}/devices/${devices[0].id}`, RESELLER_A)).statusCode).toBe(204);
    expect(ctx.revoked).toContain(first.deviceId);
    expect((await authed(ctx, "POST", "/v1/auth/refresh", "", { refreshToken: first.refreshToken })).statusCode).toBe(401);
    expect((await login(ctx, "a-one", "correct-horse-1", "device-bbbbbbbb")).statusCode).toBe(200);
    expect((await del(`/v1/admin/users/${userId}/devices/${devices[0].id}`, RESELLER_A)).statusCode).toBe(404); // already gone
  });

  it("Another reseller's user: hidden and every change refused as not found; read-only admins cannot change", async () => {
    const { userId } = await createUser(ctx, RESELLER_A, "a-one");
    const first = (await login(ctx, "a-one", "correct-horse-1")).json();
    const deviceId = first.deviceId;
    expect((await adminReq(ctx, "GET", "/v1/admin/users", RESELLER_B)).json().users).toEqual([]);
    expect((await adminReq(ctx, "POST", `/v1/admin/users/${userId}/enable`, RESELLER_B)).statusCode).toBe(404);
    expect((await adminReq(ctx, "POST", `/v1/admin/users/${userId}/password`, RESELLER_B, { password: "new-secret-22" })).statusCode).toBe(404);
    expect((await del(`/v1/admin/users/${userId}/devices/${deviceId}`, RESELLER_B)).statusCode).toBe(404);

    const ro = { authorization: `Bearer ${PANEL_TOKEN}`, "x-act-as": "admin" };
    expect((await ctx.app.inject({ method: "GET", url: "/v1/admin/users", headers: ro })).json().users).toHaveLength(1);
    expect((await ctx.app.inject({ method: "POST", url: `/v1/admin/users/${userId}/password`, headers: ro, payload: { password: "new-secret-22" } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "DELETE", url: `/v1/admin/users/${userId}/devices/${deviceId}`, headers: ro })).statusCode).toBe(403);
    expect((await login(ctx, "a-one", "correct-horse-1")).statusCode).toBe(200); // nothing changed
  });

  it("Admin sets a 4-digit password: accepted", async () => {
    const { userId } = await createUser(ctx, RESELLER_A, "a-one");
    expect((await adminReq(ctx, "POST", `/v1/admin/users/${userId}/password`, RESELLER_A, { password: "4821" })).statusCode).toBe(204);
    expect((await login(ctx, "a-one", "4821")).statusCode).toBe(200);
  });

  it("User changes their own password: needs the current one; old stops working; this device stays signed in", async () => {
    await createUser(ctx, RESELLER_A, "a-one");
    const first = (await login(ctx, "a-one", "correct-horse-1")).json();
    const change = (current: string, next: string) =>
      authed(ctx, "POST", "/v1/me/password", first.accessToken, { currentPassword: current, newPassword: next });
    expect((await change("wrong-current", "7391")).json().error).toBe("invalid_credentials");
    expect((await change("correct-horse-1", "123")).statusCode).toBe(400);
    expect((await change("correct-horse-1", "7391")).statusCode).toBe(204);
    expect((await login(ctx, "a-one", "correct-horse-1")).json().error).toBe("invalid_credentials");
    expect((await login(ctx, "a-one", "7391")).statusCode).toBe(200);
    expect((await authed(ctx, "GET", "/v1/me", first.accessToken)).statusCode).toBe(200);
  });

  it("Wrong current passwords count toward the login lockout", async () => {
    await createUser(ctx, RESELLER_A, "a-one");
    const first = (await login(ctx, "a-one", "correct-horse-1")).json();
    for (let i = 0; i < 10; i++) {
      await authed(ctx, "POST", "/v1/me/password", first.accessToken, { currentPassword: "nope", newPassword: "7391" });
    }
    const res = await authed(ctx, "POST", "/v1/me/password", first.accessToken, { currentPassword: "correct-horse-1", newPassword: "7391" });
    expect(res.json().error).toBe("too_many_attempts");
  });
});
