// Spec: openspec/changes/nahalvpn-app/specs/vpn-client-app/spec.md, "Service notice"
import { beforeEach, describe, expect, it } from "vitest";
import { PANEL_TOKEN, RESELLER_A, RESELLER_B, SUPER_TOKEN, setup } from "./helpers.js";

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });

const pub = () => ctx.app.inject({ method: "GET", url: "/v1/app/notice" });
const put = (headers: Record<string, string>, payload: object) =>
  ctx.app.inject({ method: "PUT", url: "/v1/admin/notice", headers, payload });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const panelAs = (name: string) => ({ authorization: `Bearer ${PANEL_TOKEN}`, "x-act-as": name });

describe("Requirement: Service notice", () => {
  it("Off by default: the public notice is inactive and carries no message", async () => {
    const res = await pub();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false, updatedAt: 0 });
  });

  it("Owner turns it on: every app (no sign-in needed) gets the message; turning it off hides it", async () => {
    const on = await put(panelAs("ali"), { active: true }); // ali is in NOTICE_ADMINS for the tests
    expect(on.statusCode).toBe(200);
    expect(on.json().message).toContain("ارتباط قطع شده است");
    const seen = (await pub()).json();
    expect(seen).toMatchObject({ active: true, updatedAt: ctx.clock.t });
    expect(seen.message).toContain("صبور باشید");

    ctx.clock.t += 60_000;
    expect((await put(bearer(SUPER_TOKEN), { active: true, message: "بروزرسانی سرور تا ساعت ۲۲" })).json().message).toBe("بروزرسانی سرور تا ساعت ۲۲");
    expect((await pub()).json().message).toBe("بروزرسانی سرور تا ساعت ۲۲");

    expect((await put(bearer(SUPER_TOKEN), { active: false })).statusCode).toBe(200);
    expect((await pub()).json()).toEqual({ active: false, updatedAt: ctx.clock.t });
  });

  it("Only the owner and super admins may change it; others can read whether they may", async () => {
    expect((await put(bearer(RESELLER_B), { active: true })).statusCode).toBe(403);
    expect((await put(panelAs("ramin"), { active: true })).statusCode).toBe(403);
    expect((await put(panelAs("admin"), { active: true })).statusCode).toBe(403); // read-only built-in admin
    expect((await pub()).json().active).toBe(false);
    const view = (h: Record<string, string>) => ctx.app.inject({ method: "GET", url: "/v1/admin/notice", headers: h });
    expect((await view(panelAs("ali"))).json().canEdit).toBe(true);
    expect((await view(panelAs("ramin"))).json().canEdit).toBe(false);
    expect((await view(bearer(RESELLER_A))).json().canEdit).toBe(true); // ali's own token: same name
    expect((await view(bearer(SUPER_TOKEN))).json().canEdit).toBe(true);
  });

  it("The panel can ask whether the signed-in admin is the owner (owner-only features such as backups)", async () => {
    const me = (h: Record<string, string>) => ctx.app.inject({ method: "GET", url: "/v1/admin/me", headers: h });
    expect((await me(panelAs("ali"))).json()).toEqual({ name: "ali", role: "reseller", readonly: false, owner: true });
    expect((await me(panelAs("ramin"))).json().owner).toBe(false);
    expect((await me(panelAs("admin"))).json()).toMatchObject({ readonly: true, owner: false });
    expect((await me(panelAs("nobody"))).statusCode).toBe(403);
  });
});
