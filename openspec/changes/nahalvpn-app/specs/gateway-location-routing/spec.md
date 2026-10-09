## ADDED Requirements

### Requirement: Foreign-initiated reverse tunnel per location
Each location SHALL connect to the Iran gateway through an encrypted reverse tunnel that the foreign server opens,
using a small fixed pool of long-lived connections. The Iran gateway SHALL NOT open any connection to a foreign
location server.

#### Scenario: Tunnel established by the foreign side
- **WHEN** a location's foreign server starts
- **THEN** it opens its tunnel pool (8 connections by default) to its dedicated gateway port, the gateway exposes that location on its own local port, and no gateway-to-foreign connection is created

#### Scenario: Gateway never dials out
- **WHEN** gateway connections are audited for 24 hours under normal operation
- **THEN** there are no TCP connections initiated by the gateway to any configured foreign location IP

### Requirement: Traffic exits only through the chosen location
The system SHALL send every app user's traffic, VLESS or OpenVPN, only through the reverse tunnel of the location
the user selected.

#### Scenario: Exit IP matches the location
- **WHEN** a user connected to location DE requests an IP-echo service
- **THEN** the response shows DE's foreign server IP

#### Scenario: Two users, two locations
- **WHEN** user A is connected to DE and user B to NL at the same time
- **THEN** A's traffic exits from DE's IP, and B's traffic exits from NL's IP

### Requirement: Fail-closed per location
The system SHALL drop a user's traffic if their location's tunnel is unavailable, and SHALL NOT send it out
directly from the Iran gateway or through another location.

#### Scenario: Location tunnel down
- **WHEN** DE's tunnel is down and a DE user sends traffic
- **THEN** the traffic is dropped, it does not exit from the gateway's IP or from another location, and other locations keep working

### Requirement: Tunnel self-healing
The system SHALL automatically re-establish a location's tunnel pool after connections are lost.

#### Scenario: Pool collapses
- **WHEN** a location's established tunnel connections fall below the configured minimum
- **THEN** a watchdog on the foreign server restarts the tunnel client within 2 minutes, and the event is logged
