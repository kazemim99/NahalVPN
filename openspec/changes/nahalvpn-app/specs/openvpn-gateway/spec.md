## ADDED Requirements

### Requirement: OpenVPN service on the gateway
The gateway SHALL run OpenVPN on port 2083 over UDP and over TCP, using a shared CA and server certificate with
`tls-crypt`, and SHALL NOT use port 1194.

#### Scenario: UDP connect
- **WHEN** a device with a valid NahalVPN OpenVPN profile connects over UDP to the gateway on 2083
- **THEN** the tunnel is established, and the device can reach the internet through its selected location

#### Scenario: TCP fallback
- **WHEN** UDP 2083 is blocked on the user's network and the app falls back to TCP 2083
- **THEN** the tunnel is established over TCP, and the device reaches the internet through its selected location

### Requirement: Backend-checked credentials
The gateway SHALL accept an OpenVPN login only if the backend confirms that the username and password belong to an
active device credential, and SHALL take the location from the username.

#### Scenario: Valid credential
- **WHEN** a device logs in with username `<user>@de` and its current password
- **THEN** the backend approves the login, and the session is assigned an address from DE's pool

#### Scenario: Revoked or expired credential
- **WHEN** a login uses a revoked password or belongs to an expired subscription
- **THEN** the login is rejected

#### Scenario: Unknown location
- **WHEN** the username names a location that does not exist or is disabled
- **THEN** the login is rejected

### Requirement: Location routing for OpenVPN traffic
The gateway SHALL route each OpenVPN session's decrypted traffic into its location's reverse tunnel as individual
streams, so that no TCP-in-TCP crosses the international leg, and SHALL fail closed when that location is down.

#### Scenario: Exit through the location
- **WHEN** an OpenVPN user on DE requests an IP-echo service
- **THEN** the response shows DE's foreign server IP

#### Scenario: Converter or tunnel down
- **WHEN** DE's converter or tunnel is unavailable
- **THEN** DE's OpenVPN traffic is dropped, and it does not exit from the gateway's IP

### Requirement: Session control and accounting
The gateway SHALL report per-session byte counts to the backend, and SHALL disconnect sessions on backend request.

#### Scenario: Forced disconnect
- **WHEN** the backend revokes a device that has an active OpenVPN session
- **THEN** that session is disconnected within 60 seconds, and reconnects are rejected
