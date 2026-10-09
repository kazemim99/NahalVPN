## ADDED Requirements

### Requirement: Location list
The system SHALL provide authenticated apps with the list of locations, each with an ID, a country code, a display
name in the user's language, the protocols it offers, and its current availability.

#### Scenario: App loads locations
- **WHEN** an authenticated app requests the location list
- **THEN** it receives every enabled location with ID, country code, localized name, supported protocols (VLESS and/or OpenVPN) and availability (up/down)

### Requirement: Locations are data, not app releases
The system SHALL allow an operator to add, rename, disable or re-point a location (replace its foreign server)
without an app update and without interrupting other locations.

#### Scenario: New location added
- **WHEN** an operator adds location NL with its tunnel endpoint and enables it
- **THEN** apps see NL in the location list on their next refresh, and users can connect to it with no app update

#### Scenario: Foreign server replaced
- **WHEN** an operator re-points location DE to a new foreign server
- **THEN** users connecting to DE afterwards exit from the new server's IP, their app configuration needs no change, and other locations are unaffected

#### Scenario: Location disabled
- **WHEN** an operator disables a location
- **THEN** it disappears from the location list, and new connection requests for it are rejected

### Requirement: Location health
The system SHALL determine each location's availability from the health of its reverse tunnel and an end-to-end
probe, at least once per minute.

#### Scenario: Tunnel down
- **WHEN** a location's reverse tunnel has no established connections, or its end-to-end probe fails 3 times in a row
- **THEN** the location is reported as down in the location list within 2 minutes, and the operator is notified

#### Scenario: Tunnel recovers
- **WHEN** a down location's probe succeeds again
- **THEN** the location is reported as up again within 2 minutes
