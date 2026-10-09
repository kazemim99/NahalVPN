## ADDED Requirements

### Requirement: Login screen
The NahalVPN app SHALL let the user log in with a username and password, and SHALL keep the user logged in across
restarts until logout or revocation.

#### Scenario: First launch
- **WHEN** a new user opens the app and logs in with valid credentials
- **THEN** the app shows the location list and stores the session securely (Android Keystore-backed)

#### Scenario: Session revoked
- **WHEN** the backend rejects the app's refresh token
- **THEN** the app disconnects any active VPN and returns to the login screen with an explanatory message

### Requirement: Location picker and one-tap connect
The app SHALL show the available locations and connect to the selected one with a single tap, without the user
choosing a protocol or importing a profile.

#### Scenario: Connect
- **WHEN** the user selects "Germany" and taps Connect
- **THEN** the app fetches the connection configuration, establishes the VPN, and shows "Connected – Germany" with the exit IP

#### Scenario: Switch location
- **WHEN** the user is connected to Germany and selects Netherlands
- **THEN** the app disconnects and reconnects through Netherlands, with no other user action

### Requirement: Automatic protocol selection and fallback
The app SHALL try VLESS first, and SHALL fall back to OpenVPN UDP, then OpenVPN TCP, if the previous protocol fails
a health probe within 8 seconds.

#### Scenario: VLESS blocked on the network
- **WHEN** VLESS cannot pass the health probe within 8 seconds
- **THEN** the app connects with OpenVPN UDP (or TCP if UDP also fails), and shows which protocol is in use in the details view

#### Scenario: All protocols fail
- **WHEN** no protocol passes the health probe
- **THEN** the app shows a clear connection error and does not leave a half-open VPN that blocks the internet

### Requirement: Kill switch
The app SHALL offer a kill switch that blocks traffic outside the VPN while it is enabled and a connection drops.

#### Scenario: Connection drops with the kill switch on
- **WHEN** the VPN connection drops while the kill switch is enabled
- **THEN** no app traffic leaves the device outside the VPN until the app reconnects or the user disconnects

### Requirement: Account information
The app SHALL show the user's expiry date (Solar Hijri calendar, Persian numerals) and the active devices. It SHALL NOT show any data allowance or consumption, because traffic is unlimited.

#### Scenario: Account screen
- **WHEN** the user opens the account screen
- **THEN** the app shows the expiry date and the device list, with the option to remove another device, and no data figures

### Requirement: Localization
The app SHALL support Persian (right-to-left) and English, defaulting to the device language.

#### Scenario: Persian device
- **WHEN** the device language is Persian
- **THEN** all screens appear in Persian with right-to-left layout

### Requirement: Update channel
The app SHALL check for new versions from the backend and offer a signed update download, since a store may not be
available.

#### Scenario: Update available
- **WHEN** the backend reports a newer version than the installed one
- **THEN** the app offers the update with release notes, and installs only an APK signed with the NahalVPN release key

### Requirement: Service notice
The system SHALL let the owner turn on an outage notice from the panel. While it is on, every app (Android and
Windows, signed in or not) SHALL show its message in a modal when the app opens or comes back to the foreground, and
within about a minute while the app stays open. Only the owner and super admins can change it.

#### Scenario: Owner reports an outage
- **WHEN** the owner turns the notice on in the panel, with the default text or their own
- **THEN** users who open the app see a modal saying the connection is down and it is being looked into, and can close it

#### Scenario: Outage over
- **WHEN** the owner turns the notice off
- **THEN** the app stops showing the modal

#### Scenario: Reseller tries to change it
- **WHEN** a reseller or the read-only panel admin tries to turn the notice on or off
- **THEN** the change is refused

