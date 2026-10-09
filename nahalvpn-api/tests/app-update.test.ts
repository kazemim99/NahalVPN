import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const RELEASE = {
  versionCode: 2, versionName: "0.2.0", apkUrl: "https://api.nahalkmi.ir/app/nahalvpn-0.2.0.apk",
  sha256: "a".repeat(64), notes: { en: "Faster connect", fa: "اتصال سریع‌تر" },
};

describe("vpn-client-app: update channel", () => {
  it("Update available: the published release is served to the app without auth", async () => {
    const ctx = setup({ appRelease: () => JSON.stringify(RELEASE) });
    const res = await ctx.app.inject({ method: "GET", url: "/v1/app/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(RELEASE);
  });

  it("no manifest, or a broken / unsafe one, means no update is offered", async () => {
    for (const raw of [null, "{not json", JSON.stringify({ ...RELEASE, apkUrl: "http://evil/x.apk" }), JSON.stringify({ ...RELEASE, sha256: "xyz" })]) {
      const ctx = setup({ appRelease: () => raw });
      const res = await ctx.app.inject({ method: "GET", url: "/v1/app/version" });
      expect(res.statusCode).toBe(404);
    }
  });
});
