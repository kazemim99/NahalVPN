## Why

Users today get raw VLESS links or `.ovpn` files from resellers and must import and switch them by hand. When a
foreign server is replaced (which happened several times in October 2026 as IPs were blocked), every user has to
update their configuration. **NahalVPN** is a branded app in the style of ExpressVPN. The user logs in with a
username and password, picks a location and taps Connect. The backend decides which server, protocol and
credentials the user gets, so server changes become invisible to users.

This is the right time because the network side has now been proven end to end. An Iran gateway carries both
VLESS and OpenVPN out through an encrypted reverse tunnel that the foreign server opens (Backhaul wssmux, 0%
failures under load). Filtering never sees the Iran gateway opening a connection abroad, and new foreign
locations plug in without changing anything on the user side.

## What Changes

- **New: NahalVPN client app.**
  - Login with username and password.
  - A location list (for example Germany or the Netherlands).
  - One-tap connect and disconnect.
  - Automatic protocol choice: VLESS first, OpenVPN as fallback.
  - Status, data usage and subscription expiry shown in the app.
- **New: an app API on the backend.**
  - Authentication and session tokens.
  - Location catalogue and per-connection configuration delivery.
  - Revocation when a subscription expires or a device is removed.
  - It is reachable from inside Iran over the Iran gateway or the domestic CDN. It is never hosted only abroad,
    because `nahalkmi.ir` names are DNS-poisoned inside Iran.
- **New: per-location routing on the Iran gateway.**
  - Each foreign location connects its own encrypted reverse tunnel into the gateway.
  - Traffic for a location is routed only into that location's tunnel.
  - If a location's tunnel is down, its traffic is dropped rather than sent out from the Iran IP (fail-closed).
- **New: OpenVPN as a supported protocol on the gateway.**
  - It runs on port 2083 over TCP and UDP. Port 1194 is filtered.
  - Decrypted traffic goes into the same per-location tunnels through a TUN-to-proxy converter.
- **New: credential provisioning.**
  - VLESS user IDs and OpenVPN logins are created and removed through APIs (the xray API, plus an OpenVPN auth
    hook), with no x-ui panel edits or service restarts.
- **New: usage and subscription enforcement.**
  - Traffic is counted per user across protocols and locations.
  - Expiry is enforced; traffic is unlimited (no quota, no per-byte billing).
- **Explicitly out of scope:**
  - WireGuard: blocked nationally on every tested network.
  - SoftEther, L2TP/IPsec and MikroTik: excluded by decision.
  - Any design in which the Iran gateway opens connections to a foreign server.
- **Not breaking:** existing V2Ray users on the current x-ui inbound (53726) keep working unchanged during the
  rollout.

## Capabilities

### New Capabilities
- `app-auth`: username/password login, session tokens, device registration and limits, logout and revocation.
- `subscription-usage`: subscription plans, expiry and device limit (unlimited traffic); per-user traffic statistics
  across VLESS and OpenVPN (operators only); enforcement when the expiry is reached.
- `location-catalog`: the list of locations (country, display name, availability or health) that the backend
  serves to the app; adding or removing a location without an app release.
- `connection-provisioning`: issuing a connection configuration for a given user, location and protocol (VLESS
  user ID and parameters, or an OpenVPN profile and login); rotation and revocation; no restarts on the gateway.
- `gateway-location-routing`: the Iran gateway routes each user's traffic to the chosen location's reverse tunnel
  (foreign-initiated, encrypted, with a fixed connection pool); fail-closed; health per location.
- `openvpn-gateway`: OpenVPN service on the gateway (2083 TCP and UDP), with authentication against the backend,
  conversion of decrypted traffic into streams in the location tunnel, and per-user accounting.
- `vpn-client-app`: the NahalVPN app on Android first, other platforms later; login, location picker, one-tap
  connect, automatic protocol choice and fallback, status, usage and expiry display, and in-app configuration
  refresh.

### Modified Capabilities
<!-- None: no specs exist yet in openspec/specs/. -->

## Impact

- **Iran gateway:**
  - New services: the app API, OpenVPN, the TUN-to-proxy converter, and one tunnel endpoint per location.
  - xray needs one inbound or routing rule per location, managed through the xray API instead of hand edits in
    x-ui.
  - **CPU is the binding limit:** the gateway has 2 older vCPUs, and OpenVPN costs about 1.7% of a core per
    Mbit/s on it. Capacity planning and a gateway upgrade are part of this change.
- **Foreign servers (one per location, starting with the DE exit server):** the relay service plus a Backhaul wssmux
  client into the gateway. New locations reuse the same build.
- **Backend:**
  - Either extend the existing Node panel (`panel/server-ir2.js`) or build a separate service. That decision
    belongs in design.md.
  - New storage for app users, devices, sessions, subscriptions and usage.
  - Integration with the existing reseller and admin model and its per-GB pricing.
- **Client:** a new mobile codebase that embeds an xray or sing-box core for VLESS and an OpenVPN library. That
  means two VPN engines in one app.
- **Operations:**
  - Certificates: the tunnel TLS certificate expires on 2026-11-02, so renewal must be automated.
  - Watchdogs for each location's tunnel.
  - Management access to foreign servers must not depend on the gateway opening outbound connections.
- **Risk:** running recognizable VPN protocols (OpenVPN) on the production gateway IP could draw filtering
  attention to the IP that the V2Ray users also depend on.
