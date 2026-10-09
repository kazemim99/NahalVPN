## Context

The service today:

- **The Iran gateway** (one server inside Iran). It is a 2-vCPU Xeon E5-2680 v2 with 3.8 GB of RAM, running x-ui (3x-ui
  2.x) with one VLESS-WS-TLS inbound on 53726 that carries about 400–1,000 concurrent users. A Node admin and
  reseller panel (`panel/server-ir2.js`) sells x-ui clients under per-admin prefixes, with per-GB pricing.
- **Foreign exit is the DE exit server (OVH).** It runs a VLESS-WS relay on 127.0.0.1:8444 only.
- **Hard-won network facts** (these are constraints, not choices):
  - Connections that the Iran gateway opens toward foreign hosting IPs are throttled to about 2 Mbit/s per
    connection, then blackholed within hours.
  - Connections that the foreign side opens into the gateway are not throttled (about 200 Mbit/s measured).
  - The production carrier is therefore a reverse tunnel: Backhaul v0.7.2 wssmux (TLS, fixed pool of 8)
    from .222 into gateway port 47981, exposed on the gateway as 127.0.0.1:2055. Under identical load it had
    0% failures, against 12.4% for rathole and 12.8% for unencrypted tcpmux.
  - OpenVPN to the gateway works from real phones on port 2083 TCP and UDP. Port 1194 is filtered upstream.
  - WireGuard is blocked on every network tested.
  - The gateway was tested terminating OpenVPN and WireGuard, then converting decrypted traffic with
    tun2socks → xray mux → tunnel. That works, at roughly 1% of a core per Mbit/s for the converter plus about
    0.7% for OpenVPN.
- **Other constraints:**
  - `nahalkmi.ir` names are DNS-poisoned inside Iran.
  - SSH to the gateway is intermittently unreachable, so a jump host is needed.

The stakeholders are the owner/operator, the resellers (existing admin prefixes) and end users who are mostly on
Android.

## Goals / Non-Goals

**Goals:**
- One app with login, location list and one-tap connect, across VLESS (primary) and OpenVPN (fallback).
- The backend owns all server, protocol and credential decisions, so server swaps never touch users.
- Adding a location means one foreign server plus configuration, with no app release.
- The Iran gateway never initiates connections abroad. Every location fails closed.
- Per-user traffic statistics for operators; traffic is unlimited and never billed.
- Existing x-ui users (53726) keep working untouched during and after rollout.

**Non-Goals:**
- WireGuard, SoftEther, L2TP/IPsec, MikroTik.
- iOS, Windows and macOS clients in this change. The design must not block them, but only Android ships.
- Replacing the reseller panel's UI. The app backend integrates with it rather than rewriting it.
- In-app payments. Subscriptions are created by admins and resellers, as today.

## Decisions

### D1. Topology: one Iran entry, one reverse tunnel per location
`App → Iran gateway (domestic) → per-location Backhaul wssmux reverse tunnel → foreign exit → internet`.
Each location runs its own Backhaul server instance on the gateway, with its own port and token, mapped to its
own local port (2055 = DE/.222, 2056 = next location, and so on). The foreign server runs the relay plus the
Backhaul client.
- **Why:** this is the only topology measured to survive the filtering, and per-location instances isolate
  failures and tokens.
- **Alternatives considered:**
  - Users connecting directly to foreign servers: throttled and blocked.
  - Gateway-initiated tunnels: throttled and blackholed.
  - One shared Backhaul server multiplexing all locations: a single point of failure, and harder health checks.

### D2. Backend: a new `nahalvpn-api` service, not an extension of `server-ir2.js`
Node.js with TypeScript and SQLite (WAL mode; Postgres-compatible schema so it can move later). It runs on the
gateway behind HTTPS. It reads reseller and admin identities and prefixes from the panel, and writes per-user
credentials only through gateway APIs (D3, D4).
- **Why:**
  - The panel is a single-file monolith with JSON-file storage, coupled to x-ui's HTTP API, and x-ui has
    proven fragile (its update API is broken, and its email-uniqueness rules get in the way).
  - The app needs devices, sessions, multi-location, multi-protocol credentials and usage history, which the
    panel's model does not have.
- **Alternatives considered:**
  - Extending `server-ir2.js`: quickest to start, but entangles the app with x-ui quirks.
  - Running on a foreign server: unreachable or throttled from inside Iran.

### D3. VLESS for the app: a dedicated "gateway xray" managed through the xray API, separate from x-ui
The gateway xray runs as a standalone instance with:
- **One inbound per location:** VLESS-WS-TLS, each on its own WS path behind a single TLS listener (nginx on
  the gateway routes by path), tagged `in-<loc>`.
- **Routing:** `in-<loc>` → outbound `relay-<loc>` (VLESS-WS to `127.0.0.1:205x`, mux 16).
- **No direct outbound** for app inbounds, so it fails closed.

Users are added and removed at runtime with the HandlerService API (email `u<id>.<loc>`, same user ID across
locations). Per-user traffic comes from StatsService.
- **Why:**
  - No restarts, so connected users are not dropped.
  - Per-location stats.
  - It avoids x-ui's DB and email limits.
- **Alternatives considered:**
  - One inbound with per-user routing (`user` rule): switching location would mean re-adding the user and
    regenerating routing.
  - Adding app users to x-ui: restarts, DB coupling, the email-uniqueness limit.

### D4. OpenVPN: two gateway instances (UDP and TCP on 2083), location chosen at login, routed by address pool
- **Authentication:** each instance uses `auth-user-pass-verify` (via-file) calling the backend; credentials are
  issued per device. The OpenVPN username carries the location (`<user>@<loc>`).
- **Addressing:** `client-connect` assigns an address from that location's pool (`10.8.<loc>.0/24`).
- **Routing:** policy routing sends each pool into that location's converter (`tun-<loc>`, one converter per
  location), into a local SOCKS inbound on the gateway xray, and on to `relay-<loc>`. Each per-location table has
  a blackhole fallback.
- **Crypto:** shared CA, server cert, and `tls-crypt`. There are no per-user certificates; revocation is done by
  credential.
- **Converter:** start with tun2socks (proven). Evaluate hev-socks5-tunnel or the sing-box TUN for lower CPU
  before scaling. Enable OpenVPN DCO for UDP if the kernel module is available.
- **Why:**
  - The ports are proven from real phones.
  - The location lives in data (the username), not in an extra port per location.
  - Per-location converters keep fail-closed behaviour per location.
  - The international leg carries streams, so there is no TCP-over-TCP.
- **Alternatives considered:**
  - One OpenVPN instance per location: multiplies ports and processes.
  - Terminating OpenVPN on the foreign server: TCP-over-TCP on the lossy leg, a single shared UDP channel
    through the tunnel, and the server would see every client as 127.0.0.1.

### D5. Auth and sessions
- **Login:** username and password give a short-lived access token (JWT, 15 minutes) plus a refresh token
  (30 days, rotating) bound to a device ID.
- **Device limit:** set per subscription.
- **Credential rotation:** VLESS user IDs and OpenVPN passwords are issued per device and rotated on each login.
- **Revocation:** on logout, device removal, re-login or expiry, the backend removes the credential
  through D3 and D4, and kills active OpenVPN sessions through the management interface.
- **Why:** a leaked config cannot outlive its device, and admins can revoke instantly.

### D6. Accounting and enforcement
- **Collection:** a collector polls xray StatsService (per `u<id>.<loc>`) and the OpenVPN management `status`
  every 60 seconds, then writes usage rows per user, location and protocol.
- **Enforcement:** runs on each collection and revokes per D5.
- **Pricing:** usage feeds the existing per-GB reseller pricing.

### D7. API reachability from inside Iran
The API is served on a domain that resolves correctly inside Iran: either a dedicated domain, or the Arvan CDN in
front of the gateway. It must not depend on `nahalkmi.ir` resolution. The app also ships the gateway IP with a
pinned certificate as a fallback.
- **Why:** `nahalkmi.ir` is DNS-poisoned domestically, and the app must be able to log in even when DNS
  interferes.

### D8. Android client: native Kotlin, two embedded engines
- **VLESS:** sing-box (libbox) or AndroidLibXrayLite.
- **OpenVPN:** the ics-openvpn core.
- **Shared:** one `VpnService` owns the TUN device and the kill switch.
- **Connect flow:** VLESS first; if the health probe fails within 8 seconds, fall back to OpenVPN UDP, then TCP.
- **Config:** fetched on connect and cached encrypted.
- **Why:** native control of `VpnService` and both cores is needed for reliable fallback and the kill switch.
- **Alternatives considered:** Flutter with platform channels (faster UI, but both engines still need native
  glue). It is a possible later step if iOS is added.

## Risks / Trade-offs

- **Gateway CPU:** 2 old vCPUs are already about 40% busy. A single 40–50 Mbit/s OpenVPN flow pushed the box to
  80–90%. → Upgrade or replace the gateway (at least 8 modern vCPUs) before opening OpenVPN broadly. Measure a
  lighter converter. Cap OpenVPN sessions per gateway. Allow additional gateways later; the app gets a gateway
  list.
- **Single gateway:** one Iran entry point. → The design allows several gateways, and every foreign server can
  connect into each one. The app API returns an ordered gateway list.
- **Visibility of OpenVPN:** a recognizable OpenVPN handshake on the production IP may draw filtering to the IP
  the V2Ray users also depend on. → Run OpenVPN on a separate gateway IP once available, and keep it as a fallback
  rather than the default.
- **Location IPs get blocked:** foreign IPs have been blocked before, though only those the gateway connected
  to. → A location is just data; replacing its server means installing the relay and Backhaul client, and the
  app is unaffected.
- **Certificate expiry:** the tunnel and gateway TLS certificate (nahalkmi) expires on 2026-11-02. → Automate
  renewal (ACME DNS challenge) and restart dependents through a deploy hook.
- **GPL licensing:** ics-openvpn and the OpenVPN libraries are GPL, and sing-box is GPL too. → Owner decision on
  distributing source, or choose differently licensed cores (see Open Questions).
- **Distribution:** Google Play may be unavailable or restricted for Iranian developers and users. → Plan for
  signed APK distribution with an in-app update check.
- **Backhaul maturity:** it is a single-maintainer project. → rathole remains a tested fallback carrier, and the
  per-location tunnel is an interface (one local port per location), so the carrier can change without affecting
  the app.

## Migration Plan

0. **Prerequisites:**
   - Gateway capacity decision (upgrade or replace).
   - Certificate automation.
   - A management channel to foreign servers that does not need gateway-initiated SSH.
   - Choice of API domain.
1. **Backend and VLESS:** deploy `nahalvpn-api` and the gateway xray alongside x-ui. Create location DE (.222) on
   2055. Run internal accounts only.
2. **Android app with VLESS only:** closed beta with internal users.
3. **OpenVPN:** add the UDP and TCP instances on 2083 with the converters, plus the app fallback. Re-measure CPU.
4. **Second location:** a new foreign server with a Backhaul client, then a backend location row. Verify there is
   no app change.
5. **Reseller rollout:** resellers create app subscriptions in the panel. Existing x-ui users migrate gradually;
   x-ui stays as it is.

**Rollback:** every phase is additive. Stop the new services and remove the routing tables; x-ui and its users are
unaffected at every step.

### x-ui user migration (task 9.4, drafted 2026-10-08)
Starting point: the Iran box serves about 170 x-ui clients (ali 30, mostafa 117, shahriar 21 at the time of writing),
each with an expiry and a GB allowance, sold through the panel by prefix. App accounts are time-based and unlimited.

1. **Side by side (now possible):** resellers sell new customers app accounts from the panel tab
   "اپلیکیشن نهال". Existing x-ui clients keep working untouched.
2. **Convert on request, one customer at a time:** a "move to the app" action on an x-ui client in the panel creates
   an app account for the same reseller with the client's remaining days, recorded as a migration, not a sale (new
   `kind = 'migrate'` in `sales`, excluded from order counts). The x-ui client is left enabled until it expires, so
   the customer can fall back while trying the app. Nothing is deleted from x-ui.
3. **Waves with a capacity gate:** at most a few dozen conversions a day, watching gateway CPU, tunnel health and
   connect success (task 9.3). OpenVPN for migrated users waits for the gateway upgrade decided in OQ5;
   until then `OPENVPN_USERS` stays a list and migrated users connect over VLESS.
4. **End of x-ui:** x-ui keeps running until its last client expires or the owner sets a cutover date. It is never
   stopped while it still has active clients.

**Owner decisions needed before step 2:**
- Does a migrated customer get their remaining x-ui time free (no sale), and how is an unused GB allowance treated
  when the app has no data limit?
- How many devices does a migrated customer get (the default is 1; some x-ui configs are shared across devices today)?
- Is there a cutover date for x-ui, or does it wind down by expiry only?
- When does OpenVPN open to everyone (`OPENVPN_USERS=*`), given the gateway capacity limit?

## Decisions Taken (2026-10-08)

- **API domain (OQ1):** a **subdomain of `nahalkmi.ir` behind the Arvan CDN** (working name `api.nahalkmi.ir`).
  - Because the zone is DNS-poisoned domestically, domestic resolution of the subdomain must be tested before
    the app depends on it.
  - The app keeps the gateway IP with a pinned certificate as a fallback (D7).
- **Accounts (OQ2):** **reseller-created accounts.**
  - Admins and resellers create NahalVPN app users (username, password and plan) through the panel and
    nahalvpn-api.
  - Existing x-ui users keep their configs and migrate gradually (task 9.4).
- **Device limit (OQ3):** default is **1 device** per subscription (owner decision 2026-10-08), configurable per plan. This was the proposed
  default and was not objected to.
- **Licensing (OQ4):** **GPL is acceptable.** sing-box (libbox) for VLESS and ics-openvpn for OpenVPN. The app
  source must be available to APK recipients.
- **Capacity (OQ5):** **upgrade or replace the gateway** with a modern server of 8+ vCPUs before OpenVPN opens
  broadly. The current box serves x-ui users meanwhile.
- **Platform (OQ6):** **Android first, native Kotlin.** This is the proposed default.
- **Branding (OQ7):** still open; assets are needed before task 5.x UI polish.

## Open Questions

1. **API domain:** which domain does the app API use? `nahalkmi.ir` is poisoned domestically, so options are a new
   domain, Arvan-fronted or not.
2. **Accounts:** are app accounts new and separate, or do existing reseller customers log in with their current
   identity (email or ID)? This affects migration.
3. **Device limit:** the default number of devices per subscription.
4. **Licensing:** is publishing source under GPL acceptable? This decides sing-box/ics-openvpn versus the
   alternatives.
5. **Gateway capacity:** upgrade the current gateway, or add a second gateway (optionally a separate IP for
   OpenVPN)?
6. **Platforms:** are iOS or Windows needed soon? That would favour Flutter now rather than native Kotlin.
7. **Branding and UX assets:** logo, colours, Persian/English UI. Is RTL Persian the default?

## Product decisions (2026-10-08)

- **Traffic is unlimited.** There is no quota, data allowance or per-byte billing, and nothing about data volume is shown in the app.
  OpenVPN-versus-VLESS wire overhead therefore has no effect on any account. Traffic statistics are kept for operators only.
- **One device per account by default**; a plan may allow more.
- **Expiry is shown in the Persian calendar** with Persian numerals (for example "۲۵ مهر ۱۴۰۵") in every language.
- **Release signing key:** created and held by the owner; never generated or stored by the assistant.
- **OpenVPN client engine:** the sing-box v1.14 built-in `openvpn-client` endpoint, in the same libbox as VLESS, instead of
  ics-openvpn. One engine, one TUN, one kill switch; no second native core or build chain.
