import { describe, expect, it } from "vitest";
import { PANEL_TOKEN, RESELLER_A, setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;
const plan = { days: 30, months: 1 };

function asPanel(ctx: Ctx, actAs: string | undefined, method: "GET" | "POST" | "PUT", url: string, payload?: object) {
  return ctx.app.inject({
    method, url, ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${PANEL_TOKEN}`, ...(actAs === undefined ? {} : { "x-act-as": actAs }) },
  });
}

describe("reseller panel integration (task 2.8)", () => {
  it("the panel acts as one of its resellers; the user is owned by that reseller", async () => {
    const ctx = setup();
    const res = await asPanel(ctx, "ali", "POST", "/v1/admin/users", { username: "A-app-1", password: "correct-horse-1", plan });
    expect(res.statusCode).toBe(201);
    expect(res.json().owner).toBe("ali");
    // ali's own direct token sees it as well: same identity.
    const id = res.json().userId;
    expect((await ctx.app.inject({ method: "GET", url: `/v1/admin/users/${id}`, headers: { authorization: `Bearer ${RESELLER_A}` } })).statusCode).toBe(200);
  });

  it("resellers acting through the panel only see and manage their own users", async () => {
    const ctx = setup();
    const id = (await asPanel(ctx, "ali", "POST", "/v1/admin/users", { username: "A-app-1", password: "correct-horse-1", plan })).json().userId;
    expect((await asPanel(ctx, "ramin", "GET", `/v1/admin/users/${id}`)).statusCode).toBe(404);
    expect((await asPanel(ctx, "ramin", "POST", `/v1/admin/users/${id}/renew`, plan)).statusCode).toBe(404);
    expect((await asPanel(ctx, "ramin", "POST", `/v1/admin/users/${id}/disable`)).statusCode).toBe(404);
    expect((await asPanel(ctx, "boss", "GET", `/v1/admin/users/${id}`)).statusCode).toBe(200); // prefixes: null = super
  });

  it("unknown, missing or malformed X-Act-As is refused", async () => {
    const ctx = setup();
    const body = { username: "x-app-1", password: "correct-horse-1", plan };
    expect((await asPanel(ctx, undefined, "POST", "/v1/admin/users", body)).statusCode).toBe(403);
    expect((await asPanel(ctx, "mallory", "POST", "/v1/admin/users", body)).statusCode).toBe(403);
    expect((await asPanel(ctx, "__proto__", "POST", "/v1/admin/users", body)).statusCode).toBe(403);
    expect((await asPanel(ctx, "../etc", "POST", "/v1/admin/users", body)).statusCode).toBe(403);
  });

  it("read-only panel admins (including the built-in 'admin') can read but not write", async () => {
    const ctx = setup();
    const id = (await asPanel(ctx, "ali", "POST", "/v1/admin/users", { username: "A-app-1", password: "correct-horse-1", plan })).json().userId;
    expect((await asPanel(ctx, "admin", "GET", `/v1/admin/users/${id}`)).statusCode).toBe(200);
    expect((await asPanel(ctx, "admin", "POST", `/v1/admin/users/${id}/renew`, plan)).statusCode).toBe(403);
    expect((await asPanel(ctx, "viewer", "POST", "/v1/admin/users", { username: "V-app-1", password: "correct-horse-1", plan })).statusCode).toBe(403);
    expect((await asPanel(ctx, "admin", "GET", "/v1/admin/locations")).statusCode).toBe(200);
  });

  it("a reseller removed from the panel loses access immediately", async () => {
    const ctx = setup();
    expect((await asPanel(ctx, "ramin", "POST", "/v1/admin/users", { username: "R-app-1", password: "correct-horse-1", plan })).statusCode).toBe(201);
    ctx.panelRoles.json = JSON.stringify({ ali: { prefixes: ["A"] } });
    expect((await asPanel(ctx, "ramin", "POST", "/v1/admin/users", { username: "R-app-2", password: "correct-horse-1", plan })).statusCode).toBe(403);
  });

  it("a missing or corrupt roles file fails closed (only the built-in read-only admin remains)", async () => {
    const ctx = setup();
    ctx.panelRoles.json = "{not json";
    expect((await asPanel(ctx, "ali", "POST", "/v1/admin/users", { username: "A-app-1", password: "correct-horse-1", plan })).statusCode).toBe(403);
    expect((await asPanel(ctx, "admin", "POST", "/v1/admin/users", { username: "A-app-1", password: "correct-horse-1", plan })).statusCode).toBe(403);
  });
});
