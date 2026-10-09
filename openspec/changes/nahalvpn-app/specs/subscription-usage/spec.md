## ADDED Requirements

### Requirement: Subscriptions with expiry and a device limit
The system SHALL associate each app user with a subscription that has an expiry time, a device limit (1 by default),
and the owning admin or reseller. Traffic is unlimited: there is no data quota, allowance or per-byte billing.

#### Scenario: Reseller creates a subscription
- **WHEN** a reseller creates an app user with a 30-day plan
- **THEN** the user can log in, and the subscription shows expiry = creation + 30 days, devices = 1, owner = that reseller, and no data quota

#### Scenario: Renewal
- **WHEN** a reseller renews an active or expired subscription for another period
- **THEN** the expiry is extended according to the plan, the device limit is kept unless the plan changes it, and the renewal is recorded as a sale for that reseller

### Requirement: Per-user traffic statistics
The system SHALL record each user's uploaded and downloaded bytes per location and per protocol, at least once per
minute, for operators and resellers only. These figures never limit access, never appear in the user's app, and
never affect billing (OpenVPN and VLESS differ in protocol overhead, and that difference has no consequence).

#### Scenario: VLESS traffic recorded
- **WHEN** a user transfers data over VLESS through location DE
- **THEN** within 2 minutes the reseller view shows the user's traffic for (DE, VLESS) increased by the transferred bytes

#### Scenario: OpenVPN traffic recorded
- **WHEN** a user transfers data over OpenVPN through location DE
- **THEN** within 2 minutes the reseller view shows the user's traffic for (DE, OpenVPN) increased by the transferred bytes

#### Scenario: No data limit
- **WHEN** a user transfers any amount of data
- **THEN** the user's access is not cut, and the app shows no data figures

### Requirement: Enforcement of expiry
The system SHALL stop a user's access when the subscription expires.

#### Scenario: Subscription expired
- **WHEN** the current time passes the subscription expiry
- **THEN** within 2 minutes all of the user's connection credentials are revoked, and login returns "subscription expired"

### Requirement: Expiry visibility
The system SHALL show the expiry to the user in the app, and traffic statistics and expiry to the owning reseller
in the panel.

#### Scenario: User checks the expiry
- **WHEN** the user opens the app
- **THEN** the home screen shows the expiry date in the Persian (Solar Hijri) calendar with Persian numerals, for example "۲۵ مهر ۱۴۰۵"
