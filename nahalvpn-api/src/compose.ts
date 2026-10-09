import { AUTH, type Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { AccessTokens } from "./auth/access-token.js";
import { argonHasher } from "./auth/crypto.js";
import { AuthService } from "./services/auth-service.js";
import { SubscriptionService } from "./services/subscription-service.js";
import type { CredentialRevoker } from "./services/revocation.js";
import { LocationService } from "./services/location-service.js";
import { ProvisioningService } from "./services/provisioning-service.js";
import { UsageService } from "./services/usage-service.js";
import { HealthMonitor, relayProbe, type Probe } from "./services/health-monitor.js";
import { XrayCli, type XrayGateway } from "./gateway/xray.js";
import { readFileSync } from "node:fs";
import { PanelDirectory } from "./auth/panel-directory.js";
import { OpenVpnManagementSocket, type OpenVpnManagement } from "./gateway/openvpn.js";
import { OpenVpnService } from "./services/openvpn-service.js";
import { NoticeService } from "./services/notice-service.js";
import { buildApp } from "./http/app.js";

/** Wires the object graph. Tests pass an in-memory DB, a fake clock, a fake gateway and a recording revoker. */
export function compose(
  config: Config,
  opts: {
    db?: Db; now?: () => number; revoker?: CredentialRevoker; xray?: XrayGateway; probe?: Probe; panel?: PanelDirectory;
    ovpnMgmt?: OpenVpnManagement; ovpnFiles?: { ca: string; tlsCrypt: string }; appRelease?: () => string | null;
    logLevel?: string;
  } = {},
) {
  const db = opts.db ?? openDb(config.dbPath);
  const now = opts.now ?? Date.now;
  const hasher = argonHasher(config.argonMemoryKiB, config.argonTimeCost);
  const access = new AccessTokens(config.jwtSecret, AUTH.accessTokenTtlMs);
  const xray = opts.xray ?? new XrayCli(config.xrayBin, config.xrayApi);

  const locations = new LocationService(db, now);
  const usage = new UsageService(db, xray, now);
  const ovpnUsers = config.openvpnUsers.trim();
  const ovpn = new OpenVpnService(
    db,
    opts.ovpnMgmt ?? new OpenVpnManagementSocket({ udp: config.openvpnMgmtUdp, tcp: config.openvpnMgmtTcp }),
    {
      allowedUsers: ovpnUsers === "*" ? "*" : ovpnUsers.split(",").map((u) => u.trim()).filter(Boolean),
      host: config.gatewayHost,
      port: config.openvpnPort,
      serverName: config.openvpnServerName,
      caPem: () => opts.ovpnFiles?.ca ?? readFileSync(config.openvpnCaFile, "utf8"),
      tlsCryptKey: () => opts.ovpnFiles?.tlsCrypt ?? readFileSync(config.openvpnTlsCryptFile, "utf8"),
    },
    now,
  );
  usage.addCollector(() => ovpn.collect());
  const provisioning = new ProvisioningService(
    db, xray, locations, { host: config.gatewayHost, port: config.gatewayPort, sni: config.gatewayHost }, now, ovpn,
  );
  usage.attachRevoker(provisioning);
  const health = new HealthMonitor(locations, opts.probe ?? relayProbe);

  const extra = opts.revoker;
  const revoker: CredentialRevoker = extra
    ? { async revokeDevices(ids) { await provisioning.revokeDevices(ids); await extra.revokeDevices(ids); } }
    : provisioning;
  const auth = new AuthService(db, hasher, access, revoker, now);
  const subscriptions = new SubscriptionService(db, hasher, now);
  const notice = new NoticeService(db, now);
  const app = buildApp(
    {
      auth, subscriptions, locations, provisioning, usage, ovpn, adminTokens: config.adminTokens,
      internalToken: config.internalToken,
      notice, noticeAdmins: config.noticeAdmins.split(",").map((n) => n.trim()).filter(Boolean),
      appRelease: opts.appRelease ?? (() => { try { return readFileSync(config.appReleaseFile, "utf8"); } catch { return null; } }),
      panel: opts.panel ?? new PanelDirectory(config.panelRolesFile),
    },
    { logLevel: opts.logLevel },
  );
  return { db, auth, subscriptions, locations, provisioning, usage, ovpn, health, notice, app };
}
