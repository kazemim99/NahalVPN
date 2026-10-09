## 1. Decisions and prerequisites

- [x] 1.1 Decide the API domain that resolves correctly inside Iran, and register its DNS. DONE: api.nahalkmi.ir (A record to the Iran gateway, Arvan DNS) resolves correctly via Shecan, Electro, TCI and Arvan NS; HTTPS verified from an Iranian network (a clean Iranian test host)
- [x] 1.2 Decide the account model: new app accounts, or existing reseller customers' identities (Open Question 2); record it in design.md
- [x] 1.3 Decide the default device limit per subscription (Open Question 3)
- [x] 1.4 Decide the client engines and licensing: GPL sing-box/ics-openvpn, or alternatives (Open Question 4)
- [x] 1.5 Decide gateway capacity: upgrade the Iran gateway, or add a gateway (optionally a separate IP for OpenVPN) (Open Question 5)
- [x] 1.6 Platform: Android-first native Kotlin. Branding: done by Claude per owner, in Tunnel/nahalvpn-brand (sapling-V mark, adaptive and themed Android icon, palette, Vazirmatn type, brand.html guide, BRAND.md)
- [ ] 1.7 Automate TLS renewal. DONE for api.nahalkmi.ir: Let's Encrypt via certbot HTTP-01 webroot, no Arvan key needed; certbot.timer active, dry-run renewal OK, nginx reload deploy hook. x-ui/tunnel cert (/etc/x-ui/cert, acme.sh): renewal was failing since 2026-10-03 (default :80 server returned 404 for the webroot); fixed 2026-10-08 with an ACME-only vhost + webroot /var/www/letsencrypt, LE staging validation passed for all 4 names, cron moved to 21:23 UTC. PENDING: confirm the first real renewal (due 2026-10-08 21:23 UTC)
- [x] 1.8 Create a management channel to foreign servers that does not need gateway-initiated SSH (an SSH port carried through each location's reverse tunnel); verify SSH to .222 through it

## 2. Backend foundation (nahalvpn-api)

- [x] 2.1 Create the `nahalvpn-api` repository and project skeleton (Node.js + TypeScript, lint, test runner, CI build). DONE: repo, TS, vitest, typecheck; 2026-10-08: ESLint 9 + typescript-eslint (`npm run lint`, clean) and GitHub Actions `.github/workflows/ci.yml` (lint, typecheck, test, build on Node 22). The workflow runs once the repo is pushed (owner approval); for a monorepo, move it to the root with `working-directory: nahalvpn-api`
- [x] 2.2 Define the SQLite schema and migrations: users, subscriptions, devices, sessions, credentials, locations, usage_samples, audit_log
- [x] 2.3 Implement login with password hashing (argon2id), a 15-minute JWT access token, and a rotating 30-day refresh token bound to the device; tests for app-auth "Successful login" and "Wrong password"
- [x] 2.4 Implement brute-force lockout (10 failures in 15 minutes); test "Brute-force protection"
- [x] 2.5 Implement refresh rotation and reuse detection; tests "Refresh succeeds" and "Refresh token reuse"
- [x] 2.6 Implement device registration, the device limit, device removal and logout; tests for app-auth "Device limit" and "Logout and revocation"
- [x] 2.7 Implement subscriptions (expiry, quota, device limit, owner) plus reseller create and renew endpoints that record renewals as sales; tests for subscription-usage "Subscriptions with expiry and quota"
- [x] 2.8 Read reseller and admin identities and prefixes from the existing panel (read-only integration); verify resellers can only manage their own users. DONE: role `panel` service token + `X-Act-As`, resolved per call from /opt/client-panel/admin-roles.json (read-only; prefixes null = super, `readonly` honoured, built-in `admin` read-only super, corrupt file fails closed); 6 tests. The panel's token is issued with 9.1
- [x] 2.9 Deploy nahalvpn-api on the gateway behind nginx HTTPS on the chosen domain, as a systemd service; verify that login works from an Iranian network

## 3. Location tunnels and the gateway xray

- [ ] 3.1 Template the per-location Backhaul wssmux server on the gateway (one instance per location: own port 4798x, token, local port 205x) and client on the foreign server, with an install script for the relay plus client
- [x] 3.2 Register location DE (.222, local 2055) in the locations table; reuse the existing production tunnel without changing x-ui's RELAY. DONE 2026-10-08: DE = tunnel 2055, inbound 10510, /nv/de; healthy
- [ ] 3.3 Generalize the .222 watchdog into a per-location tunnel watchdog; test "Pool collapses" by killing pool connections
- [x] 3.4 Deploy the standalone gateway xray (separate from x-ui) with the API, Handler and Stats services enabled; one VLESS-WS inbound per location behind nginx path routing; routing `in-<loc>` → `relay-<loc>` (mux 16); no direct outbound
- [x] 3.5 Verify gateway-location-routing "Exit IP matches the location" and "Location tunnel down" (fail-closed) for DE
- [x] 3.6 Implement a location health monitor (tunnel connection count plus end-to-end probe each minute) and an operator alert; tests for location-catalog "Tunnel down" and "Tunnel recovers". DONE: end-to-end probe every 30 s (GET /relay-stream through the location's tunnel port must return the foreign relay's 400), 3 failures = down, 1 success = up; transitions go to the journal + audit_log (`[health] location de is DOWN/UP`). Pool connection count stays with the .222 watchdog (3.3)
- [ ] 3.7 Audit for 24 hours that the gateway initiates no connections to foreign location IPs (gateway-location-routing "Gateway never dials out"). STARTED 2026-10-08 19:21 UTC: observe-only nft table `inet nv_audit` (`/etc/nahalvpn/nv-audit.nft`) counts + logs (`NV-DIALOUT`) NEW outbound to the DE exit server and .193; at start every connection with .222 was inbound (rathole :47970, backhaul :47981). Read `nft list table inet nv_audit` after 2026-10-09 19:21 UTC, then remove the table

## 4. Provisioning and accounting (VLESS)

- [x] 4.1 Implement the xray API client in nahalvpn-api: add and remove a user (email `u<id>.<loc>`) on a location inbound at runtime. DONE: `XrayCli` (adu/rmu/statsquery -reset); email `u<userId>-<cred8>.<loc>`; success judged from output because `xray api` exits 0 on RPC errors
- [x] 4.2 Implement `GET /locations` (localized names, protocols, availability) and `POST /connect {location, protocol}` returning a VLESS config with gateway-only addresses; tests for connection-provisioning "VLESS configuration" and "No foreign addresses exposed". DONE + super-admin `PUT/GET /v1/admin/locations`; e2e from a clean Iranian test host exits the DE exit server at 41 Mbit/s
- [x] 4.3 Implement per-login credential rotation and live revocation; tests "Credential activated live", "Credential deactivated live" and "Old credential stops working after re-login". DONE: DB decides first, gateway removal retried until confirmed; resync on start, api is PartOf=nahalvpn-xray (verified: xray restart restarts the api); e2e old credential REFUSED after re-login and logout
- [x] 4.4 Implement the usage collector (xray StatsService each 60 seconds, then usage_samples per user, location and protocol); test "VLESS usage recorded" (within 2%). DONE: e2e 20.00 MB download recorded as 20.04 MB (0.2%); usage counted per period (`usage_since`, reset by a quota-resetting renewal)
- [x] 4.5 Implement quota and expiry enforcement that revokes credentials; tests for subscription-usage "Subscription expired" (quota removed 2026-10-08: traffic is unlimited). DONE: runs after each collection (≤ 60 s); /connect refuses with quota_exhausted / subscription_expired
- [x] 4.6 Verify that x-ui's DB and inbound 53726 are unchanged after provisioning runs (connection-provisioning "Provisioning leaves x-ui untouched"). DONE: x-ui xray config md5 2a1e52767ad3 identical before/after deploy, e2e and gateway restart; 53726 listening with 860-1060 established users throughout; the api holds no x-ui file open

## 5. Android app (VLESS)

- [x] 5.1 Create the Android project (Kotlin, `VpnService`, encrypted storage via Android Keystore, Persian RTL and English resources). DONE 2026-10-08: `Tunnel/nahalvpn-android` (Kotlin + Compose, minSdk 23); session stored AES-GCM with an Android Keystore key; Persian RTL (Vazirmatn, Solar Hijri dates) + English
- [x] 5.2 Integrate the VLESS engine chosen in 1.4 and connect with a config from `/connect`; manual connect to DE works on a test phone. DONE on the Android 14 emulator against production: sing-box v1.14.2 libbox (lean build, tools/build_libbox.sh); 'Connected – Germany', exit the DE exit server, VLESS, 9 s (release build). Real-phone check folded into 5.8
- [x] 5.3 Build the login screen and session handling (refresh, and revoke leading to logout); tests for vpn-client-app "First launch" and "Session revoked". DONE: 8 SessionManager/ApiClient tests incl. "First launch" and "Session revoked"; plus "Remove and sign in" at the device limit (backend `replaceDeviceId`, 2 tests) verified on the emulator
- [x] 5.4 Build the location picker, one-tap connect, switching location and the connected-state UI with exit IP; tests "Connect" and "Switch location". DONE: 11 ConnectionManager tests (Connect, Switch location, fallback order, account errors, sign-out); emulator one-tap connect + exit IP. Switch location is unit-tested only (one location exists today)
- [x] 5.5 Implement the kill switch; test "Connection drops with the kill switch on". DONE: blocking TUN while reconnecting; emulator: network cut -> 'internet paused by the kill switch' (TUN 10.255.255.1/32 holds traffic) -> back 14 s after the network returns
- [x] 5.6 Build the account screen (expiry, devices, remove device; no data figures since traffic is unlimited); test "Account screen". DONE: remaining data / unlimited, Solar Hijri expiry, devices with remove; usage per period from the backend
- [ ] 5.7 Implement the signed-APK update channel; test "Update available" (rejects unsigned or wrong-key APKs). PARTIAL: backend `GET /v1/app/version` (deployed, returns no_release until a manifest is published) and app-side check/download/hash+pinned-signer verification (3 tests) are done; PENDING: release signing key (owner-held) and a publish step (APK under nginx + /etc/nahalvpn/app-release.json)
- [ ] 5.8 Closed beta with internal accounts on MCI, Irancell and home networks; record connect success and speeds

## 6. OpenVPN on the gateway

- [x] 6.1 Install OpenVPN 2.6 instances for UDP and TCP on 2083 (shared CA, server cert, tls-crypt, no 1194), as systemd services. DONE 2026-10-08 (TESTING ONLY: logins limited to OPENVPN_USERS=ovpn-test1): OpenVPN 2.6.19, units `nahalvpn-ovpn@udp|tcp`, udp4/tcp4-server 2083, EC P-256 CA + server cert CN gw.nahalvpn, tls-crypt, no 1194. DCO: openvpn is DCO-capable but the kernel module is absent (userspace data channel) - revisit with the gateway upgrade
- [x] 6.2 Implement `auth-user-pass-verify` against nahalvpn-api with the username `<user>@<loc>`; tests for openvpn-gateway "Valid credential", "Revoked or expired credential" and "Unknown location". DONE: hook.py -> `/v1/internal/openvpn/auth` (shared token, nginx-blocked publicly); 7 tests; e2e old/wrong password -> AUTH_FAILED
- [x] 6.3 Implement `client-connect` address assignment from the per-location pool (10.8.<loc>.0/24). DONE: API assigns the lowest free host in 10.80.<pool>.0/24 (UDP) / 10.81.<pool>.0/24 (TCP); DE pool 1
- [x] 6.4 Deploy one TUN-to-SOCKS converter per location feeding the gateway xray's SOCKS inbound into `relay-<loc>`; policy routing per pool with a blackhole fallback. DONE: `nahalvpn-tun@de` (tun2socks v2.6.0, nvtun-de) -> gateway xray `socks-de` 127.0.0.1:10610 -> relay-de; rules pref 2001/2002 -> table 2001, blackhole fallback metric 4000
- [ ] 6.5 Measure converter CPU for tun2socks versus hev-socks5-tunnel versus the sing-box TUN at 50 Mbit/s; pick the lowest, and enable OpenVPN DCO for UDP if available
- [x] 6.6 Verify openvpn-gateway "UDP connect", "TCP fallback", "Exit through the location" and "Converter or tunnel down" (fail-closed). DONE from a clean Iranian test host: UDP and TCP exit the DE exit server (~20 Mbit/s down, 21-25 up, DNS through the tunnel); TCP fallback with UDP 2083 dropped connects in 11 s (was 63 s before moving connect-timeout into the <connection> blocks); converter stopped -> traffic DROPPED (blackhole), restored after restart
- [x] 6.7 Implement the OpenVPN management-interface integration: per-session byte counts into usage_samples, and forced disconnect on revoke; tests "OpenVPN usage recorded" and "Forced disconnect". DONE: management `status 3` deltas each 60 s + final counts at client-disconnect; revoke -> management `kill ip:port`; e2e logout killed the session and the reconnect got AUTH_FAILED. NOTE: management counts tunnel wire bytes, ~5-8% above payload (e2e ratio 1.083) - billing decision pending
- [x] 6.8 Add OpenVPN profile generation to `/connect` (UDP first, TCP fallback, per-device credentials); test connection-provisioning "OpenVPN configuration". DONE: `/connect {protocol: openvpn}` returns `<user>@<loc>`, a fresh per-device password (hash stored) and an inline profile (UDP block first, TCP second)

## 7. Android app (OpenVPN and fallback)

- [x] 7.1 Integrate the OpenVPN engine chosen in 1.4 under the same `VpnService`. DONE 2026-10-08 (design change, see design.md "Product decisions"): instead of the ics-openvpn core, the sing-box v1.14 built-in `openvpn-client` endpoint in the same libbox (rebuilt with `with_openvpn`); one engine, one TUN, one kill switch. Backend `/connect` now also returns the OpenVPN server in structured form. Verified: emulator OpenVPN UDP connected 20 s; clean Iranian host (same engine + same config shape) UDP and TCP both connect in 4-5 s, exit the DE exit server, ~21 Mbit/s down / 24-29 up
- [x] 7.2 Implement automatic fallback (VLESS, then OpenVPN UDP, then OpenVPN TCP, with an 8-second health probe); tests "VLESS blocked on the network" and "All protocols fail". DONE: ConnectionManager tests (fallback order, "All protocols fail" tears everything down); emulator with VLESS broken on purpose (debug-only -Pnahal.breakVless) fell back to OpenVPN (UDP) by itself in 26 s and showed the protocol
- [ ] 7.3 Re-run the beta on real networks with VLESS deliberately blocked; record fallback success and gateway CPU under concurrent OpenVPN sessions

- [x] 7.4 Home screen redesign (owner request 2026-10-08): status, location, exit IP, Solar Hijri expiry with days left, kill-switch chip, on-demand Download/Upload (Mbps) and Ping (ms; through the VPN when connected, to the gateway when not); no data figures anywhere (traffic is unlimited)

- [x] 7.5 Protocol choice and Persian by default (owner request 2026-10-08): home-screen dropdown Automatic (VLESS → OpenVPN UDP → TCP) / VLESS / OpenVPN (UDP) / OpenVPN (TCP), remembered; a chosen protocol is the only one tried and a failure names it; changing it while connected reconnects (emulator: OpenVPN UDP 11 s, switch to VLESS 9 s). The app speaks Persian (RTL) whatever the phone language, with English selectable in Settings

## 8. Second location and scale checks

- [ ] 8.1 Provision a second foreign server with the install script from 3.1 (relay plus Backhaul wssmux client, watchdog); register location NL
- [ ] 8.2 Verify location-catalog "New location added" and gateway-location-routing "Two users, two locations" with no app update
- [ ] 8.3 Re-point DE to a replacement server, and verify "Foreign server replaced" (users exit from the new IP, no config change, NL unaffected)
- [ ] 8.4 Load test the gateway at the target concurrent users and throughput; confirm the capacity decision from 1.5, or trigger the upgrade

## 9. Rollout

- [x] 9.1 Add app-subscription management to the reseller panel (create, renew, disable, devices, usage) on top of the nahalvpn-api endpoints. DONE 2026-10-08: api `GET /v1/admin/users`, `POST .../enable`, `POST .../password`, `DELETE .../devices/:deviceId` (app-auth "Account administration", 5 tests, 75/75 green); panel tab "اپلیکیشن نهال" (create 1/2/3/6 months with auto `<prefix>1001` username + 8-char password, renew, disable/enable, new password, devices + sign-out, traffic statistic, copy-for-customer text; built-in admin read-only); panel service token issued (role panel, `/opt/client-panel/nahalvpn-panel.token`, 600). Deployed to 194; e2e through the panel 18/18 (`e2e_panel_app.py`), x-ui config unchanged
- [x] 9.2 Write the user guide (Persian and English): install the APK, log in, connect, troubleshoot. DONE 2026-10-08: `nahalvpn-site/guide.html` (fa) + `guide-en.html`, Android and Windows, labels match the app strings; live at https://app.nahalkmi.ir/guide.html, linked from the download page
- [ ] 9.3 Staged rollout: internal users, then selected resellers, then all; monitor connect success, fallback rate, gateway CPU and tunnel health per stage
- [ ] 9.4 Plan the gradual migration of existing x-ui users to app accounts; x-ui stays running until migration is complete. DRAFTED 2026-10-08 in design.md "x-ui user migration" (side by side, convert on request as `migrate` not a sale, capacity-gated waves, x-ui winds down by expiry); waiting on the four owner decisions listed there
