## ADDED Requirements

### Requirement: Issue a connection configuration per user, location and protocol
The system SHALL return to an authenticated device a ready-to-use connection configuration for a requested location
and protocol, containing everything the app needs and nothing that identifies the foreign server.

#### Scenario: VLESS configuration
- **WHEN** an authenticated device requests (location DE, protocol VLESS)
- **THEN** it receives a VLESS configuration (gateway host, port, TLS SNI, WS path for DE, and a per-device user ID) that connects through the Iran gateway and exits from DE

#### Scenario: OpenVPN configuration
- **WHEN** an authenticated device requests (location DE, protocol OpenVPN)
- **THEN** it receives an OpenVPN profile for the gateway on port 2083 (UDP first, TCP fallback) and per-device credentials whose username selects DE

#### Scenario: No foreign addresses exposed
- **WHEN** any connection configuration is issued
- **THEN** it contains only gateway addresses, never the IP or hostname of a foreign server

### Requirement: Runtime credential provisioning without restarts
The system SHALL activate and deactivate VLESS and OpenVPN credentials on the gateway at runtime, without
restarting any service or disconnecting other users.

#### Scenario: Credential activated live
- **WHEN** a configuration is issued for a new device
- **THEN** the credential works within 10 seconds, and no other user's connection drops

#### Scenario: Credential deactivated live
- **WHEN** a device's credential is revoked
- **THEN** new connections with it are refused within 60 seconds, and other users are unaffected

### Requirement: Rotation
The system SHALL rotate a device's connection credentials on each login, and SHALL invalidate the previous ones.

#### Scenario: Old credential stops working after re-login
- **WHEN** a device logs in again and receives new credentials
- **THEN** the previously issued VLESS user ID and OpenVPN password for that device stop working within 60 seconds

### Requirement: Existing x-ui users unaffected
The system SHALL NOT modify x-ui's database, inbounds or clients when provisioning app credentials.

#### Scenario: Provisioning leaves x-ui untouched
- **WHEN** app credentials are created or revoked
- **THEN** x-ui's database and running inbounds are unchanged, and existing x-ui users (inbound 53726) stay connected
