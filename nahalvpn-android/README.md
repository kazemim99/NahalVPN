# NahalVPN for Android

The NahalVPN app: sign in with a reseller-issued account, pick a location, tap Connect. Traffic goes through the
Iran gateway (`api.nahalkmi.ir`) and exits from the chosen foreign location. The app never sees a foreign
server's address.

- Kotlin and Jetpack Compose. Persian (RTL, Solar Hijri dates) and English, following the device language.
- minSdk 23 (Android 6), targetSdk 36.
- Engine: sing-box v1.14.2 (`libbox`, GPLv3) for both protocols: VLESS, and OpenVPN through sing-box's built-in
  OpenVPN client. The app tries VLESS, then OpenVPN UDP, then OpenVPN TCP.
- Traffic is unlimited: the app shows no data figures. The expiry is always shown in the Solar Hijri calendar with
  Persian numerals. Accounts allow one device by default.
- Brand assets come from `../nahalvpn-brand`. The font is Vazirmatn (SIL OFL, see `licenses/`).

## Build

1. Build the engine once: `tools/build_libbox.sh` writes `app/libs/libbox.aar`. Read the header of the script
   first. It needs Go 1.25.x and, inside Iran, a Go module mirror.
2. Build the app:
   - Run the unit tests with `./gradlew testDebugUnitTest`.
   - `./gradlew assembleDebug -Pnahal.abi=x86_64` builds a single-ABI APK for the emulator.
   - Debug-only test switches: `-Pnahal.transports=openvpn_udp` (or `vless`, `openvpn_tcp`, comma-separated) limits the
     protocols tried, and `-Pnahal.breakVless=true` makes VLESS fail on purpose to exercise the fallback. Release builds
     ignore both.
   - `./gradlew assembleRelease` builds one APK per CPU type (about 20 MB each) plus a universal APK (about 59 MB).

3. Windows app (`:desktop`, Compose Desktop, system-proxy mode):
   - Build the engine once: `tools/build_sing_box_windows.sh` writes `desktop/appResources/windows/sing-box.exe`
     (same sing-box version and tags as libbox; the output is reproducible).
   - `JAVA_HOME=<JDK 21 with jpackage, e.g. Temurin> ./gradlew :desktop:packageMsi` builds the MSI installer.

To verify updates, a release build must pin its signing certificate:
`-Pnahal.releaseCertSha256=<sha256 of the release cert>`. An unpinned build refuses every update.

The production release key is created and kept by the owner; it is never generated or stored by tooling in this
repo. Test builds are signed with the local debug key. If the release key is ever lost, every installed app has to be
uninstalled and reinstalled.

## How it fits together

| Piece | Role |
|---|---|
| `api/ApiClient` | HTTP client for nahalvpn-api (`/v1/...`) |
| `session/SessionManager` | Login, transparent token refresh, sign-out when the backend revokes the session. Tokens are stored AES-GCM encrypted with an Android Keystore key. |
| `vpn/ConnectionManager` | Engine-agnostic state machine. Tries VLESS, then OpenVPN UDP, then OpenVPN TCP, each with an 8-second probe. If nothing passes, the tunnel is torn down completely. When a running connection drops and the kill switch is on, it holds a blocking TUN and keeps reconnecting. |
| `vpn/NahalVpnService` | The `VpnService`. It owns the TUN, runs libbox, and implements the blocking TUN. The app's own package is excluded from the VPN, so API calls always work. |
| `vpn/ProxyProber` | Probes the tunnel through libbox's local, password-protected proxy and reads the exit IP. |
| `vpn/TunnelMeter` | On-demand Ping (median of 4 tiny requests after a warm-up) and Speed test (3 parallel downloads, then 2 uploads; about 21 MB). Never runs by itself. |
| `util/Jalali` | Solar Hijri conversion and formatting without ICU (works on Android 6-7). |
| `update/*` | Update channel. It offers newer builds from `/v1/app/version` and installs only a file whose hash matches and that is signed by the pinned key. |

## Verified (2026-10-08, Android 14 emulator against the production gateway)

- **Sign in:** works through the real UI. At the device limit, "Remove and sign in" signs out the chosen device; its
  gateway credential is revoked in the same second.
- **Connect:** shows "Connected – Germany", the DE exit server's IP as the exit IP, protocol VLESS. It takes 9 s on a release build
  and 15 s on a debug build. Disconnect removes the TUN.
- **Kill switch:** with the network cut, the app holds a blocking TUN and shows "internet paused by the kill switch".
  When the network returns it reconnects by itself in about 14 s.
- **Persian:** the whole UI is in Persian with right-to-left layout and Solar Hijri dates.
- **Release build:** the minified (R8) release build works end to end.

## Verified (2026-10-08, after the home screen redesign and the OpenVPN engine)

- **Tests:** 48 unit tests pass, and the release build works on the emulator.
- **Home screen:**
  - Ping while disconnected measures the gateway (6 ms).
  - Ping through VLESS: 400 ms.
  - Speed test through VLESS: 10.8 Mbps down and 8.9 Mbps up.
- **OpenVPN UDP:** connects on the emulator.
- **Fallback:** with VLESS broken on purpose, the app falls back to OpenVPN (UDP) in 26 s.
- **OpenVPN on a clean Iranian host:** UDP and TCP both connect in 4-5 s and exit from Germany. This used the same engine with the same config shape.
- **Caveat:** the development PC itself reaches the internet through the DE exit server. On the emulator, the exit IP alone therefore proves nothing; gateway-side logs and counters were used instead. The same reason explains why OpenVPN TCP stalled on the emulator but works from the clean host.
