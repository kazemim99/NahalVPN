import { describe, expect, it } from "vitest";
import { HealthMonitor } from "../src/services/health-monitor.js";
import { DE, RESELLER_A, SUPER_TOKEN, adminReq, authed, connect, setup, signedIn, withDE } from "./helpers.js";

const NL = { ...DE, country: "NL", nameEn: "Netherlands", nameFa: "هلند", tunnelPort: 2056, inboundPort: 10511, wsPath: "/nv/nl" };

describe("location-catalog", () => {
  it("List locations: localized names, protocols and availability; disabled locations hidden", async () => {
    const ctx = setup();
    await withDE(ctx);
    await adminReq(ctx, "PUT", "/v1/admin/locations/nl", SUPER_TOKEN, { ...NL, enabled: false });
    const s = await signedIn(ctx);
    const res = await authed(ctx, "GET", "/v1/locations", s.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      locations: [{ id: "de", country: "DE", name: { en: "Germany", fa: "آلمان" }, protocols: ["vless", "openvpn"], available: true }],
    });
  });

  it("Locations require a signed-in device", async () => {
    const ctx = setup();
    expect((await ctx.app.inject({ method: "GET", url: "/v1/locations" })).statusCode).toBe(401);
  });

  it("New location added: appears for the app without an app update", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    await adminReq(ctx, "PUT", "/v1/admin/locations/nl", SUPER_TOKEN, NL);
    await ctx.health.tick();
    const ids = (await authed(ctx, "GET", "/v1/locations", s.accessToken)).json().locations.map((l: { id: string }) => l.id);
    expect(ids).toEqual(["de", "nl"]);
    expect((await connect(ctx, s.accessToken, "nl")).json().path).toBe("/nv/nl");
  });

  it("Only super admins manage locations, and input is validated", async () => {
    const ctx = setup();
    expect((await adminReq(ctx, "PUT", "/v1/admin/locations/de", RESELLER_A, DE)).statusCode).toBe(403);
    expect((await adminReq(ctx, "GET", "/v1/admin/locations", RESELLER_A)).statusCode).toBe(403);
    expect((await adminReq(ctx, "PUT", "/v1/admin/locations/de", SUPER_TOKEN, { ...DE, wsPath: "/etc/passwd" })).statusCode).toBe(400);
    expect((await adminReq(ctx, "PUT", "/v1/admin/locations/DE1", SUPER_TOKEN, DE)).statusCode).toBe(400);
  });

  it("Tunnel down: after 3 failed probes the location is unavailable and connect is refused", async () => {
    const ctx = setup();
    await withDE(ctx);
    const s = await signedIn(ctx);
    ctx.probe.ok = () => false;
    await ctx.health.tick();
    await ctx.health.tick();
    expect((await authed(ctx, "GET", "/v1/locations", s.accessToken)).json().locations[0].available).toBe(true);
    await ctx.health.tick();
    expect((await authed(ctx, "GET", "/v1/locations", s.accessToken)).json().locations[0].available).toBe(false);
    const res = await connect(ctx, s.accessToken);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("location_unavailable");
  });

  it("Tunnel recovers: one good probe makes the location available again, and the operator is told", async () => {
    const notes: string[] = [];
    const ctx = setup({ probeOk: () => false });
    await adminReq(ctx, "PUT", "/v1/admin/locations/de", SUPER_TOKEN, DE);
    const health = new HealthMonitor(ctx.locations, async (p) => ctx.probe.ok(p), (m) => notes.push(m));
    ctx.probe.ok = () => true;
    await health.tick();
    ctx.probe.ok = () => false;
    for (let i = 0; i < 3; i++) await health.tick();
    expect(ctx.locations.get("de").healthy).toBe(false);
    ctx.probe.ok = () => true;
    await health.tick();
    expect(ctx.locations.get("de").healthy).toBe(true);
    expect(notes).toEqual(["location de is UP", "location de is DOWN", "location de is UP"]);
  });

  it("Probes the location's own tunnel port", async () => {
    const seen: number[] = [];
    const ctx = setup({ probeOk: (p) => { seen.push(p); return true; } });
    await adminReq(ctx, "PUT", "/v1/admin/locations/de", SUPER_TOKEN, DE);
    await adminReq(ctx, "PUT", "/v1/admin/locations/nl", SUPER_TOKEN, NL);
    await ctx.health.tick();
    expect(seen).toEqual([2055, 2056]);
  });
});
