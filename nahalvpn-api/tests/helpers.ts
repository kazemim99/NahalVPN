import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { compose } from "../src/compose.js";
import type { Config } from "../src/config.js";
import type { CredentialRevoker } from "../src/services/revocation.js";
import { FakeXray } from "./fake-xray.js";
import { FakeOpenVpn } from "./fake-openvpn.js";
import { PanelDirectory } from "../src/auth/panel-directory.js";

export const SUPER_TOKEN = "super-token-0123456789abcdef";
export const RESELLER_A = "reseller-a-token-0123456789ab";
export const RESELLER_B = "reseller-b-token-0123456789ab";
export const PANEL_TOKEN = "panel-service-token-0123456789";
export const INTERNAL_TOKEN = "internal-hook-token-0123456789abcdef";
export const GB = 1024 ** 3;
export const DAY = 24 * 3_600_000;

export const DE = {
  country: "DE", nameEn: "Germany", nameFa: "آلمان", protocols: ["vless", "openvpn"],
  tunnelPort: 2055, inboundPort: 10510, wsPath: "/nv/de", poolIndex: 1, enabled: true,
};

export function setup(opts: { probeOk?: (port: number) => boolean; appRelease?: () => string | null } = {}) {
  const clock = { t: Date.UTC(2026, 9, 8, 12, 0, 0) };
  const revoked: string[] = [];
  const revoker: CredentialRevoker = { async revokeDevices(ids) { revoked.push(...ids); } };
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const config: Config = {
    dbPath: ":memory:",
    jwtSecret: "test-secret-test-secret-test-secret-123",
    host: "127.0.0.1",
    port: 0,
    adminTokens: {
      [SUPER_TOKEN]: { name: "mostafa", role: "super" },
      [RESELLER_A]: { name: "ali", role: "reseller" },
      [RESELLER_B]: { name: "ramin", role: "reseller" },
      [PANEL_TOKEN]: { name: "client-panel", role: "panel" },
    },
    argonMemoryKiB: 1024,
    argonTimeCost: 1,
    xrayBin: "/nonexistent/xray",
    xrayApi: "127.0.0.1:1",
    gatewayHost: "api.nahalkmi.ir",
    gatewayPort: 443,
    usageIntervalMs: 0,
    healthIntervalMs: 0,
    panelRolesFile: "/opt/client-panel/admin-roles.json",
    internalToken: INTERNAL_TOKEN,
    openvpnUsers: "ovpn-a,ovpn-b",
    openvpnPort: 2083,
    openvpnServerName: "gw.nahalvpn",
    openvpnCaFile: "/nonexistent/ca.crt",
    openvpnTlsCryptFile: "/nonexistent/tls-crypt.key",
    openvpnMgmtUdp: "/nonexistent/udp.sock",
    openvpnMgmtTcp: "/nonexistent/tcp.sock",
    appReleaseFile: "/nonexistent/app-release.json",
    noticeAdmins: "ali",
  };
  // What the panel's admin-roles.json would contain; tests may rewrite it to simulate panel edits.
  const panelRoles = {
    json: JSON.stringify({ ali: { prefixes: ["A"] }, ramin: { prefixes: ["R"] }, boss: { prefixes: null }, viewer: { prefixes: ["V"], readonly: true } }),
  };
  const panel = new PanelDirectory(config.panelRolesFile, () => panelRoles.json);
  const xray = new FakeXray();
  const probe = { ok: opts.probeOk ?? (() => true) };
  const ovpnMgmt = new FakeOpenVpn();
  const ovpnFiles = {
    ca: "-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----",
    tlsCrypt: "-----BEGIN OpenVPN Static key V1-----\nTESTKEY\n-----END OpenVPN Static key V1-----",
  };
  const ctx = compose(config, { db, now: () => clock.t, revoker, xray, probe: async (p) => probe.ok(p), panel, ovpnMgmt, ovpnFiles,
    appRelease: opts.appRelease ?? (() => null) });
  return { ...ctx, clock, revoked, xray, probe, panelRoles, ovpnMgmt };
}

type Ctx = ReturnType<typeof setup>;

export async function createUser(ctx: Ctx, token: string, username: string, plan: object = {}) {
  const res = await ctx.app.inject({
    method: "POST", url: "/v1/admin/users", headers: { authorization: `Bearer ${token}` },
    payload: { username, password: "correct-horse-1", plan: { days: 30, months: 1, ...plan } },
  });
  if (res.statusCode !== 201) throw new Error(`createUser ${res.statusCode} ${res.body}`);
  return res.json() as { userId: number; expiresAt: number; deviceLimit: number; owner: string };
}

export function login(ctx: Ctx, username: string, password: string, deviceId = "device-aaaaaaaa", deviceName = "Pixel") {
  return ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { username, password, deviceId, deviceName } });
}

export function authed(ctx: Ctx, method: "GET" | "POST" | "DELETE", url: string, accessToken: string, payload?: object) {
  return ctx.app.inject({ method, url, headers: { authorization: `Bearer ${accessToken}` }, ...(payload ? { payload } : {}) });
}

export function adminReq(ctx: Ctx, method: "GET" | "POST" | "PUT", url: string, token: string, payload?: object) {
  return ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

/** Registers DE and runs one health tick so it is available. */
export async function withDE(ctx: Ctx) {
  const res = await adminReq(ctx, "PUT", "/v1/admin/locations/de", SUPER_TOKEN, DE);
  if (res.statusCode !== 200) throw new Error(`upsert DE ${res.statusCode} ${res.body}`);
  await ctx.health.tick();
}

/** Creates a user, logs in a device and returns its access token. */
export async function signedIn(ctx: Ctx, username = "nv-user1", plan: object = {}, deviceId = "device-aaaaaaaa") {
  const u = await createUser(ctx, RESELLER_A, username, plan);
  const res = await login(ctx, username, "correct-horse-1", deviceId);
  if (res.statusCode !== 200) throw new Error(`login ${res.statusCode} ${res.body}`);
  const t = res.json() as { accessToken: string; refreshToken: string; deviceId: string };
  return { ...t, userId: u.userId };
}

export async function connect(ctx: Ctx, accessToken: string, location = "de", protocol = "vless") {
  return authed(ctx, "POST", "/v1/connect", accessToken, { location, protocol });
}
