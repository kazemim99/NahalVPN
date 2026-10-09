import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Admin } from "../config.js";
import { AppError, Errors } from "../errors.js";
import type { AuthService } from "../services/auth-service.js";
import type { SubscriptionService } from "../services/subscription-service.js";
import { LocationInput, PROTOCOLS, type LocationService } from "../services/location-service.js";
import type { ProvisioningService } from "../services/provisioning-service.js";
import type { UsageService } from "../services/usage-service.js";
import { timingSafeEqual } from "node:crypto";
import type { PanelDirectory } from "../auth/panel-directory.js";
import type { NoticeService } from "../services/notice-service.js";
import { INSTANCES } from "../gateway/openvpn.js";
import type { OpenVpnService } from "../services/openvpn-service.js";

export interface AppDeps {
  auth: AuthService;
  subscriptions: SubscriptionService;
  locations: LocationService;
  provisioning: ProvisioningService;
  usage: UsageService;
  adminTokens: Record<string, Admin>;
  panel: PanelDirectory;
  ovpn: OpenVpnService;
  internalToken?: string;
  notice: NoticeService;
  /** Panel admins (besides super tokens) allowed to change the outage notice. */
  noticeAdmins: string[];
  /** Returns the raw release manifest (JSON text), or null if none is published. */
  appRelease?: () => string | null;
}

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  deviceId: z.string().min(8).max(128),
  deviceName: z.string().min(1).max(64).default("device"),
  replaceDeviceId: z.string().uuid().optional(),
});
const RefreshBody = z.object({ refreshToken: z.string().min(16).max(256) });
const PlanBody = z.object({
  days: z.number().int().positive().max(3660),
  months: z.number().int().positive().max(120),
  deviceLimit: z.number().int().positive().max(20).optional(),
});
const CreateUserBody = z.object({
  username: z.string().regex(/^[A-Za-z0-9._-]{3,32}$/),
  password: z.string().min(4).max(128),
  plan: PlanBody,
});
const IdParam = z.object({ id: z.coerce.number().int().positive() });
// The owner chose short numeric passwords for customers (a 4-digit code); the login lockout limits guessing.
const PasswordBody = z.object({ password: z.string().min(4).max(128) });
const ChangePasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(4).max(128) });
const AdminDeviceParam = IdParam.extend({ deviceId: z.string().uuid() });
const DeviceParam = z.object({ id: z.string().uuid() });
const LocationParam = z.object({ id: z.string().regex(/^[a-z]{2,8}$/) });
const ConnectBody = z.object({ location: z.string().regex(/^[a-z]{2,8}$/), protocol: z.enum(PROTOCOLS) });

const NoticeBody = z.object({ active: z.boolean(), message: z.string().max(500).optional() });
const AppRelease = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(32),
  apkUrl: z.string().url().startsWith("https://"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  notes: z.record(z.string(), z.string().max(2000)).default({}),
});
const OvpnAuthBody = z.object({
  instance: z.enum(INSTANCES), username: z.string().min(1).max(100), password: z.string().min(1).max(200),
  realAddr: z.string().min(3).max(64),
});
const OvpnConnectBody = z.object({ instance: z.enum(INSTANCES), realAddr: z.string().min(3).max(64) });
const OvpnDisconnectBody = OvpnConnectBody.extend({
  bytesIn: z.coerce.number().int().nonnegative().default(0), bytesOut: z.coerce.number().int().nonnegative().default(0),
});

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) throw Errors.invalidToken();
  return h.slice(7);
}

export function buildApp(deps: AppDeps, opts: { logLevel?: string } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logLevel ? { level: opts.logLevel } : false, bodyLimit: 16 * 1024 });

  // Clients (including the Android app) may send "Content-Type: application/json" with an empty body on
  // body-less POSTs such as logout; treat that as {} instead of rejecting it.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError("invalid_json", 400), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, ...err.extra });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid_request", issues: err.issues });
    // Fastify's own client errors (malformed request, payload too large, ...) keep their 4xx status.
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({ error: "invalid_request" });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  const user = (req: FastifyRequest) => deps.auth.authenticate(bearer(req));
  /** Resolves the caller; the panel's service token acts as the panel admin named in X-Act-As. */
  const caller = (req: FastifyRequest): Admin => {
    const a = deps.adminTokens[bearer(req)];
    if (!a) throw Errors.forbidden();
    if (a.role !== "panel") return a;
    const actAs = req.headers["x-act-as"];
    const resolved = typeof actAs === "string" ? deps.panel.resolve(actAs) : null;
    if (!resolved) throw Errors.forbidden();
    return resolved;
  };
  const admin = (req: FastifyRequest): Admin => caller(req);
  const writer = (req: FastifyRequest): Admin => {
    const a = caller(req);
    if (a.readonly) throw Errors.forbidden();
    return a;
  };
  const superAdmin = (req: FastifyRequest, write = false): Admin => {
    const a = write ? writer(req) : admin(req);
    if (a.role !== "super") throw Errors.forbidden();
    return a;
  };
  /** Traffic statistics for resellers/operators only: nothing is limited or billed by bytes. */
  const trafficView = (userId: number) => ({ trafficBytes: deps.usage.usedBytes(userId), traffic: deps.usage.breakdown(userId) });

  app.get("/healthz", async () => ({ ok: true }));

  // ── Update channel: the newest signed build (public; the app verifies hash + signing key itself) ──
  app.get("/v1/app/version", async (_req, reply) => {
    const raw = deps.appRelease?.() ?? null;
    const parsed = raw === null ? null : AppRelease.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
    if (!parsed?.success) return reply.status(404).send({ error: "no_release" });
    return parsed.data;
  });

  // ── Outage notice: public, so the app can show it even on the sign-in screen ──
  app.get("/v1/app/notice", async () => {
    const n = deps.notice.get();
    return n.active ? n : { active: false, updatedAt: n.updatedAt };
  });

  // ── App (end user) ────────────────────────────────────────────────────────
  app.post("/v1/auth/login", async (req) => {
    const b = LoginBody.parse(req.body);
    return deps.auth.login(b.username, b.password, b.deviceId, b.deviceName, b.replaceDeviceId);
  });
  app.post("/v1/auth/refresh", async (req) => deps.auth.refresh(RefreshBody.parse(req.body).refreshToken));
  app.post("/v1/auth/logout", async (req, reply) => {
    const { deviceId } = await user(req);
    await deps.auth.logout(deviceId);
    return reply.status(204).send();
  });
  app.get("/v1/me", async (req) => {
    const { userId, deviceId } = await user(req);
    const s = deps.subscriptions.forUser(userId);
    return {
      username: s.username,
      expiresAt: s.expiresAt,
      deviceLimit: s.deviceLimit,
      currentDeviceId: deviceId,
      devices: deps.auth.listDevices(userId),
    };
  });
  app.post("/v1/me/password", async (req, reply) => {
    const { userId } = await user(req);
    const b = ChangePasswordBody.parse(req.body);
    await deps.auth.changePassword(userId, b.currentPassword, b.newPassword);
    return reply.status(204).send();
  });
  app.delete("/v1/me/devices/:id", async (req, reply) => {
    const { userId } = await user(req);
    await deps.auth.removeDevice(userId, DeviceParam.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get("/v1/locations", async (req) => {
    await user(req);
    return { locations: deps.locations.listForApp() };
  });
  app.post("/v1/connect", async (req) => {
    const { userId, deviceId } = await user(req);
    const b = ConnectBody.parse(req.body);
    return deps.provisioning.connect(userId, deviceId, b.location, b.protocol);
  });

  // ── Admin / reseller ──────────────────────────────────────────────────────
  app.get("/v1/admin/users", async (req) => ({ users: deps.subscriptions.list(admin(req)) }));
  app.post("/v1/admin/users", async (req, reply) => {
    const a = writer(req);
    const b = CreateUserBody.parse(req.body);
    return reply.status(201).send(await deps.subscriptions.createUser(a, b.username, b.password, b.plan));
  });
  app.get("/v1/admin/users/:id", async (req) => {
    const v = deps.subscriptions.get(admin(req), IdParam.parse(req.params).id);
    return { ...v, ...trafficView(v.userId), devices: deps.auth.listDevices(v.userId) };
  });
  app.post("/v1/admin/users/:id/renew", async (req) =>
    deps.subscriptions.renew(writer(req), IdParam.parse(req.params).id, PlanBody.parse(req.body)),
  );
  app.post("/v1/admin/users/:id/disable", async (req, reply) => {
    const a = writer(req);
    const { id } = IdParam.parse(req.params);
    deps.subscriptions.get(a, id); // ownership check
    await deps.auth.disableUser(id, a.name);
    return reply.status(204).send();
  });
  app.post("/v1/admin/users/:id/enable", async (req, reply) => {
    const a = writer(req);
    const { id } = IdParam.parse(req.params);
    deps.subscriptions.get(a, id); // ownership check
    deps.auth.enableUser(id, a.name);
    return reply.status(204).send();
  });
  app.post("/v1/admin/users/:id/password", async (req, reply) => {
    const a = writer(req);
    const { id } = IdParam.parse(req.params);
    const { password } = PasswordBody.parse(req.body);
    deps.subscriptions.get(a, id); // ownership check
    await deps.auth.resetPassword(id, password, a.name);
    return reply.status(204).send();
  });
  app.delete("/v1/admin/users/:id/devices/:deviceId", async (req, reply) => {
    const a = writer(req);
    const { id, deviceId } = AdminDeviceParam.parse(req.params);
    deps.subscriptions.get(a, id); // ownership check
    await deps.auth.removeDevice(id, deviceId);
    return reply.status(204).send();
  });

  // ── Gateway hooks (the OpenVPN scripts on this box). Also blocked at nginx; the shared token is the real gate. ──
  const internal = (req: FastifyRequest) => {
    const want = deps.internalToken;
    const got = req.headers["x-internal-token"];
    if (!want || typeof got !== "string" || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
      throw Errors.notFound("route");
    }
  };
  app.post("/v1/internal/openvpn/auth", async (req, reply) => {
    internal(req);
    const b = OvpnAuthBody.parse(req.body);
    const ok = deps.ovpn.authenticate(b.instance, b.username, b.password, b.realAddr);
    return reply.status(ok ? 204 : 403).send();
  });
  app.post("/v1/internal/openvpn/connect", async (req, reply) => {
    internal(req);
    const b = OvpnConnectBody.parse(req.body);
    const line = deps.ovpn.clientConnect(b.instance, b.realAddr);
    return line ? { config: line } : reply.status(403).send();
  });
  app.post("/v1/internal/openvpn/disconnect", async (req, reply) => {
    internal(req);
    const b = OvpnDisconnectBody.parse(req.body);
    deps.ovpn.clientDisconnect(b.instance, b.realAddr, b.bytesIn, b.bytesOut);
    return reply.status(204).send();
  });

  // ── Outage notice (owner / super admins) ─────────────────────────────────
  const canEditNotice = (a: Admin) => !a.readonly && (a.role === "super" || deps.noticeAdmins.includes(a.name));
  app.get("/v1/admin/notice", async (req) => ({ ...deps.notice.get(), canEdit: canEditNotice(admin(req)) }));
  /** Who the caller is; `owner` = may use owner-only panel features (outage notice, backups). */
  app.get("/v1/admin/me", async (req) => {
    const a = admin(req);
    return { name: a.name, role: a.role, readonly: a.readonly === true, owner: canEditNotice(a) };
  });
  app.put("/v1/admin/notice", async (req) => {
    const a = admin(req);
    if (!canEditNotice(a)) throw Errors.forbidden();
    const b = NoticeBody.parse(req.body);
    return deps.notice.set(a.name, b.active, b.message);
  });

  // ── Locations (super admin only: they decide where traffic exits) ────────
  app.get("/v1/admin/locations", async (req) => {
    superAdmin(req);
    return { locations: deps.locations.all() };
  });
  app.put("/v1/admin/locations/:id", async (req) => {
    const a = superAdmin(req, true);
    return deps.locations.upsert(a.name, LocationParam.parse(req.params).id, LocationInput.parse(req.body));
  });

  return app;
}
