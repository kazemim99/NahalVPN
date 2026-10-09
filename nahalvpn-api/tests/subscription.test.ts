// Spec: openspec/changes/nahalvpn-app/specs/subscription-usage/spec.md ("Subscriptions with expiry")
import { beforeEach, describe, expect, it } from "vitest";
import { createUser, DAY, login, RESELLER_A, RESELLER_B, setup } from "./helpers.js";

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });

const renew = (userId: number, token: string, plan: object) =>
  ctx.app.inject({ method: "POST", url: `/v1/admin/users/${userId}/renew`, headers: { authorization: `Bearer ${token}` }, payload: plan });

describe("Requirement: Subscriptions with expiry (unlimited traffic, one device by default)", () => {
  it("Reseller creates a 30-day subscription: one device by default, no data quota", async () => {
    const u = await createUser(ctx, RESELLER_A, "reza", { days: 30 });
    expect(u.expiresAt).toBe(ctx.clock.t + 30 * DAY);
    expect(u.deviceLimit).toBe(1);
    expect(u.owner).toBe("ali");
    expect(u).not.toHaveProperty("quotaBytes");
    expect((await login(ctx, "reza", "correct-horse-1")).statusCode).toBe(200);
  });

  it("A plan can allow more devices, and a legacy quotaBytes in the request is ignored", async () => {
    const u = await createUser(ctx, RESELLER_A, "reza", { deviceLimit: 3, quotaBytes: 5 });
    expect(u.deviceLimit).toBe(3);
    expect(u).not.toHaveProperty("quotaBytes");
  });

  it("Renewal of an active subscription extends from the current expiry and records a sale", async () => {
    const u = await createUser(ctx, RESELLER_A, "reza");
    ctx.clock.t += 10 * DAY;
    const res = await renew(u.userId, RESELLER_A, { days: 30, months: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().expiresAt).toBe(u.expiresAt + 30 * DAY);
    const sales = ctx.db.prepare("SELECT kind, owner, months FROM sales WHERE user_id = ? ORDER BY id").all(u.userId);
    expect(sales).toEqual([{ kind: "create", owner: "ali", months: 1 }, { kind: "renew", owner: "ali", months: 1 }]);
  });

  it("Renewal of an expired subscription extends from now", async () => {
    const u = await createUser(ctx, RESELLER_A, "reza");
    ctx.clock.t += 45 * DAY;
    const res = await renew(u.userId, RESELLER_A, { days: 30, months: 1 });
    expect(res.json().expiresAt).toBe(ctx.clock.t + 30 * DAY);
    expect((await login(ctx, "reza", "correct-horse-1")).statusCode).toBe(200);
  });

  it("Renewal keeps the device limit unless the plan changes it", async () => {
    const u = await createUser(ctx, RESELLER_A, "reza", { deviceLimit: 2 });
    expect((await renew(u.userId, RESELLER_A, { days: 30, months: 1 })).json().deviceLimit).toBe(2);
    expect((await renew(u.userId, RESELLER_A, { days: 30, months: 1, deviceLimit: 1 })).json().deviceLimit).toBe(1);
  });

  it("A reseller can only renew its own users", async () => {
    const u = await createUser(ctx, RESELLER_A, "reza");
    expect((await renew(u.userId, RESELLER_B, { days: 30, months: 1 })).statusCode).toBe(404);
  });

  it("Duplicate usernames are rejected", async () => {
    await createUser(ctx, RESELLER_A, "reza");
    await expect(createUser(ctx, RESELLER_B, "REZA")).rejects.toThrow(/409/);
  });
});
