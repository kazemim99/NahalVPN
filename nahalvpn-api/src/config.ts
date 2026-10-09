import { z } from "zod";

/**
 * An admin/reseller API caller. `super` can manage every user; `reseller` only the users it owns; `readonly` callers
 * may only read. `panel` is the reseller panel's service token: it acts as the panel admin named in `X-Act-As`.
 */
export const AdminSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["super", "reseller", "panel"]),
  readonly: z.boolean().optional(),
});
export type Admin = z.infer<typeof AdminSchema>;

const ConfigSchema = z.object({
  dbPath: z.string().min(1),
  jwtSecret: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(8790),
  /** Map of bearer token -> admin identity, from ADMIN_TOKENS (JSON). */
  adminTokens: z.record(z.string().min(24), AdminSchema).default({}),
  /** argon2id cost; lowered only in tests. */
  argonMemoryKiB: z.coerce.number().int().positive().default(19456),
  argonTimeCost: z.coerce.number().int().positive().default(2),
  /** Gateway xray (separate from x-ui): CLI binary and its gRPC API address. */
  xrayBin: z.string().default("/opt/nahalvpn/xray/xray"),
  xrayApi: z.string().default("127.0.0.1:10850"),
  /** Public gateway endpoint handed to the app. Only ever the Iran gateway, never a foreign server. */
  gatewayHost: z.string().default("api.nahalkmi.ir"),
  gatewayPort: z.coerce.number().int().positive().default(443),
  /** The reseller panel's admin roles file, read-only (task 2.8). */
  panelRolesFile: z.string().default("/opt/client-panel/admin-roles.json"),
  /** Shared secret for the gateway's own hooks (OpenVPN auth/connect/disconnect); unset = internal routes disabled. */
  internalToken: z.string().min(32).optional(),
  /** OpenVPN (task group 6). OPENVPN_USERS: "*" = everyone; otherwise a comma list of usernames (testing phase). */
  openvpnUsers: z.string().default(""),
  openvpnPort: z.coerce.number().int().positive().default(2083),
  openvpnServerName: z.string().default("gw.nahalvpn"),
  openvpnCaFile: z.string().default("/etc/nahalvpn/openvpn/ca.crt"),
  openvpnTlsCryptFile: z.string().default("/etc/nahalvpn/openvpn/tls-crypt.key"),
  openvpnMgmtUdp: z.string().default("/run/nahalvpn-ovpn/udp.sock"),
  openvpnMgmtTcp: z.string().default("/run/nahalvpn-ovpn/tcp.sock"),
  /** Release manifest for the app's update channel (vpn-client-app "Update channel"); absent = no update offered. */
  appReleaseFile: z.string().default("/etc/nahalvpn/app-release.json"),
  /** Panel admins (besides super tokens) who may turn the outage notice on and off: comma list, e.g. the owner. */
  noticeAdmins: z.string().default("mostafa"),
  /** Background work: usage collection + enforcement, and location health probes. 0 disables (tests). */
  usageIntervalMs: z.coerce.number().int().nonnegative().default(60_000),
  healthIntervalMs: z.coerce.number().int().nonnegative().default(30_000),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    dbPath: env.DB_PATH ?? "/var/lib/nahalvpn-api/nahalvpn.db",
    jwtSecret: env.JWT_SECRET,
    host: env.HOST,
    port: env.PORT,
    adminTokens: env.ADMIN_TOKENS ? JSON.parse(env.ADMIN_TOKENS) : {},
    argonMemoryKiB: env.ARGON_MEMORY_KIB,
    argonTimeCost: env.ARGON_TIME_COST,
    panelRolesFile: env.PANEL_ROLES_FILE,
    internalToken: env.INTERNAL_TOKEN,
    appReleaseFile: env.APP_RELEASE_FILE,
    noticeAdmins: env.NOTICE_ADMINS,
    openvpnUsers: env.OPENVPN_USERS,
    openvpnPort: env.OPENVPN_PORT,
    openvpnServerName: env.OPENVPN_SERVER_NAME,
    openvpnCaFile: env.OPENVPN_CA_FILE,
    openvpnTlsCryptFile: env.OPENVPN_TLS_CRYPT_FILE,
    openvpnMgmtUdp: env.OPENVPN_MGMT_UDP,
    openvpnMgmtTcp: env.OPENVPN_MGMT_TCP,
    xrayBin: env.XRAY_BIN,
    xrayApi: env.XRAY_API,
    gatewayHost: env.GATEWAY_HOST,
    gatewayPort: env.GATEWAY_PORT,
    usageIntervalMs: env.USAGE_INTERVAL_MS,
    healthIntervalMs: env.HEALTH_INTERVAL_MS,
  });
}

/** Business constants from the specs (app-auth, subscription-usage). */
export const AUTH = {
  accessTokenTtlMs: 15 * 60_000,
  refreshTokenTtlMs: 30 * 24 * 3_600_000,
  lockoutWindowMs: 15 * 60_000,
  lockoutMaxFailures: 10,
  defaultDeviceLimit: 1,
} as const;
