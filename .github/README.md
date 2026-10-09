# NahalVPN

A VPN service for users in Iran: an Android and Windows app with VLESS and OpenVPN, several foreign exit locations,
and reseller-managed accounts. All traffic enters through one gateway inside Iran and leaves through the chosen
location over a reverse tunnel that the foreign server opens, so the gateway never dials out.

| Folder | What it is |
|---|---|
| [`nahalvpn-api/`](../nahalvpn-api) | Backend (Node 22, TypeScript, Fastify, SQLite): accounts, devices, sessions, locations, per-device VLESS/OpenVPN credentials, usage statistics, outage notice, backups (`deploy/`). |
| [`nahalvpn-android/`](../nahalvpn-android) | Android app (Kotlin, Compose), shared `:core` logic, and the Windows app (`:desktop`, Compose Desktop). Engine: sing-box. |
| [`nahalvpn-site/`](../nahalvpn-site) | The download page and user guide (Persian and English) served at app.nahalkmi.ir. |
| [`panel/`](../panel) | The reseller panel (x-ui clients and NahalVPN app accounts). Server secrets live in `secrets.json` on the server; see `secrets.example.json`. |
| [`openspec/`](../openspec) | The specification of the app (proposal, design, requirements with scenarios, tasks). |

Product decisions: traffic is unlimited (usage is a statistic only), one device per account by default, expiry
shown in the Solar Hijri calendar, Persian by default with English available.

Build and run instructions are in each folder's README. CI runs the backend's lint, typecheck, tests and build, and
the panel's unit tests.
