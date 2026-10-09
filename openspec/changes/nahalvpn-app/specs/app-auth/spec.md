## ADDED Requirements

### Requirement: Username and password login
The system SHALL authenticate app users with a username and password, and SHALL return a short-lived access token
and a rotating refresh token bound to the requesting device.

#### Scenario: Successful login
- **WHEN** a user with an active subscription submits a correct username and password from a device
- **THEN** the API returns an access token valid for no more than 15 minutes and a refresh token bound to that device ID

#### Scenario: Wrong password
- **WHEN** a user submits an incorrect password
- **THEN** the API rejects the login with a generic "invalid credentials" error that does not reveal whether the username exists

#### Scenario: Brute-force protection
- **WHEN** 10 failed logins occur for the same username within 15 minutes
- **THEN** further login attempts for that username are rejected for at least 15 minutes, and the event is logged

### Requirement: Token refresh and rotation
The system SHALL issue a new access token and a new refresh token when a valid refresh token is presented, and
SHALL invalidate the presented refresh token.

#### Scenario: Refresh succeeds
- **WHEN** the app presents a valid, unexpired refresh token for its device
- **THEN** the API returns a new access token and a new refresh token, and the old refresh token no longer works

#### Scenario: Refresh token reuse
- **WHEN** an already-used refresh token is presented again
- **THEN** the API rejects it and revokes every session of that device

### Requirement: Device limit
The system SHALL enforce a maximum number of active devices per subscription.

#### Scenario: Limit reached
- **WHEN** a user whose subscription allows N devices logs in from an (N+1)th device
- **THEN** the login is rejected with a "device limit reached" error that lists the active devices the user may remove

#### Scenario: Removing a device frees a slot
- **WHEN** the user removes one of their active devices
- **THEN** that device's sessions and connection credentials are revoked, and a new device can log in

### Requirement: Logout and revocation
The system SHALL revoke a device's sessions and its connection credentials on logout or administrative revocation.

#### Scenario: User logs out
- **WHEN** the user taps logout in the app
- **THEN** the device's refresh token is invalidated, and its VLESS and OpenVPN credentials stop working within 60 seconds

#### Scenario: Admin disables a user
- **WHEN** an admin or reseller disables a user
- **THEN** all of that user's sessions and connection credentials are revoked within 60 seconds, and active OpenVPN sessions are disconnected

### Requirement: Account administration
The system SHALL let admins and resellers list their app users and, for users they own, re-enable a disabled user,
reset a password and remove a signed-in device. Resellers SHALL only see and manage users they own; read-only admins
can list but not change anything.

#### Scenario: Reseller lists their users
- **WHEN** a reseller asks for the user list
- **THEN** only the users that reseller owns are returned, newest first, each with expiry, device limit, signed-in devices and status

#### Scenario: Admin re-enables a user
- **WHEN** an admin or reseller re-enables a disabled user whose subscription is still valid
- **THEN** the user can log in again

#### Scenario: Admin resets a password
- **WHEN** an admin or reseller sets a new password for a user
- **THEN** the old password stops working, the new one works, a lockout from failed attempts is cleared, and devices already signed in stay signed in

#### Scenario: Admin removes a device
- **WHEN** an admin or reseller removes one of a user's signed-in devices
- **THEN** that device's sessions and connection credentials are revoked, and the slot is free for another device

#### Scenario: Another reseller's user
- **WHEN** a reseller tries to list, re-enable, reset or remove a device of a user owned by another reseller
- **THEN** the user is not shown and every change is refused as not found

### Requirement: Password change
The system SHALL let a signed-in user change their own password by giving the current one. Passwords are at least 4
characters, because customers use short numeric codes; the login lockout limits guessing.

#### Scenario: User changes their password
- **WHEN** a signed-in user gives the correct current password and a new one
- **THEN** the old password stops working, the new one works, and the user's signed-in devices stay signed in

#### Scenario: Wrong current password
- **WHEN** the current password is wrong
- **THEN** the change is refused as invalid credentials and the attempt counts toward the login lockout
