// Regression: found in the production smoke test 2026-10-08 - body-less POSTs sent with
// "Content-Type: application/json" returned 500.
import { beforeEach, describe, expect, it } from "vitest";
import { createUser, login, setup, SUPER_TOKEN } from "./helpers.js";

let ctx: ReturnType<typeof setup>;
beforeEach(async () => {
  ctx = setup();
  await createUser(ctx, SUPER_TOKEN, "sara");
});

const jsonHeaders = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("HTTP robustness", () => {
  it("logout with JSON content-type and empty body succeeds", async () => {
    const s = (await login(ctx, "sara", "correct-horse-1")).json();
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/logout", headers: jsonHeaders(s.accessToken), payload: "" });
    expect(res.statusCode).toBe(204);
  });

  it("admin disable with JSON content-type and empty body succeeds", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/admin/users/1/disable", headers: jsonHeaders(SUPER_TOKEN), payload: "" });
    expect(res.statusCode).toBe(204);
  });

  it("malformed JSON is a 400, not a 500", async () => {
    const res = await ctx.app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" }, payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_json");
  });

  it("oversized body is a 413, not a 500", async () => {
    const res = await ctx.app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
      payload: JSON.stringify({ username: "x".repeat(20_000) }),
    });
    expect(res.statusCode).toBe(413);
  });
});
