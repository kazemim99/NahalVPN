package ir.nahalkmi.nahalvpn.desktop

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.launch
import androidx.compose.ui.text.platform.Font
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.api.Location
import ir.nahalkmi.nahalvpn.api.Me
import ir.nahalkmi.nahalvpn.ui.daysLeft
import ir.nahalkmi.nahalvpn.ui.localDigits
import ir.nahalkmi.nahalvpn.ui.ltr
import ir.nahalkmi.nahalvpn.ui.mbps
import ir.nahalkmi.nahalvpn.ui.transportLabel
import ir.nahalkmi.nahalvpn.util.Jalali
import ir.nahalkmi.nahalvpn.vpn.FailReason
import ir.nahalkmi.nahalvpn.vpn.Metric
import ir.nahalkmi.nahalvpn.vpn.SpeedResult
import ir.nahalkmi.nahalvpn.vpn.Transport
import ir.nahalkmi.nahalvpn.vpn.VpnState
import ir.nahalkmi.nahalvpn.vpn.isTesting

// ── Brand (nahalvpn-brand/BRAND.md) ─────────────────────────────────────────────
private object Nahal {
    val Pine = Color(0xFF135447); val DeepRoot = Color(0xFF0B2E28); val Pistachio = Color(0xFFA6CE39); val Mist = Color(0xFFEEF5F0)
    val Saffron = Color(0xFFF2A93B); val Pomegranate = Color(0xFFC63D4F); val Ink = Color(0xFF1F2E2A); val Slate = Color(0xFF5E706B)
}

private val Colors = lightColorScheme(
    primary = Nahal.Pine, onPrimary = Nahal.Mist, primaryContainer = Color(0xFFD6E9DF), onPrimaryContainer = Nahal.DeepRoot,
    secondary = Nahal.Pistachio, onSecondary = Nahal.DeepRoot, secondaryContainer = Color(0xFFE4F0C4), onSecondaryContainer = Nahal.DeepRoot,
    tertiary = Nahal.Saffron, error = Nahal.Pomegranate, background = Nahal.Mist, onBackground = Nahal.Ink,
    surface = Color.White, onSurface = Nahal.Ink, surfaceVariant = Color(0xFFDDE8E2), onSurfaceVariant = Nahal.Slate,
    surfaceContainer = Color.White, surfaceContainerLow = Color.White, surfaceContainerHigh = Color.White,
    surfaceContainerHighest = Color.White, surfaceContainerLowest = Color.White,
    outline = Color(0xFFB7C7C1), outlineVariant = Color(0xFFD3DFD9),
)

private val Vazirmatn = FontFamily(
    Font("fonts/Vazirmatn-Regular.ttf", FontWeight.Normal),
    Font("fonts/Vazirmatn-Medium.ttf", FontWeight.Medium),
    Font("fonts/Vazirmatn-Medium.ttf", FontWeight.SemiBold),
    Font("fonts/Vazirmatn-Bold.ttf", FontWeight.Bold),
)

private val Type = Typography().let { t ->
    Typography(
        headlineMedium = t.headlineMedium.copy(fontFamily = Vazirmatn), headlineSmall = t.headlineSmall.copy(fontFamily = Vazirmatn),
        titleLarge = t.titleLarge.copy(fontFamily = Vazirmatn), titleMedium = t.titleMedium.copy(fontFamily = Vazirmatn),
        bodyLarge = t.bodyLarge.copy(fontFamily = Vazirmatn), bodyMedium = t.bodyMedium.copy(fontFamily = Vazirmatn),
        bodySmall = t.bodySmall.copy(fontFamily = Vazirmatn), labelLarge = t.labelLarge.copy(fontFamily = Vazirmatn),
        labelMedium = t.labelMedium.copy(fontFamily = Vazirmatn), labelSmall = t.labelSmall.copy(fontFamily = Vazirmatn),
    )
}

private val LocalS = staticCompositionLocalOf { FA }

fun main() = application {
    val app = remember { DesktopApp() }
    val state = rememberWindowState(size = DpSize(440.dp, 860.dp))
    val language by app.language.collectAsState()
    val s = if (language == "en") EN else FA
    Window(
        onCloseRequest = { app.close(); exitApplication() },
        state = state, title = s.appName, icon = painterResource("icon.svg"),
    ) {
        CompositionLocalProvider(LocalS provides s, LocalLayoutDirection provides if (s.rtl) LayoutDirection.Rtl else LayoutDirection.Ltr) {
            MaterialTheme(colorScheme = Colors, typography = Type) {
                val notice by app.notice.collectAsState()
                androidx.compose.runtime.LaunchedEffect(notice?.updatedAt) {
                    if (notice != null) { state.isMinimized = false; window.toFront(); window.requestFocus() }
                }
                notice?.let { n ->
                    AlertDialog(
                        onDismissRequest = app::closeNotice,
                        title = { Text(s.noticeTitle) },
                        text = { Text(n.message.orEmpty(), style = MaterialTheme.typography.bodyLarge) },
                        confirmButton = { TextButton(app::closeNotice) { Text(s.noticeOk) } },
                    )
                }
                val signedIn by app.signedIn.collectAsState()
                if (!signedIn) {
                    val login by app.login.collectAsState()
                    LoginScreen(login, app::signIn)
                } else {
                    MainScreen(app)
                }
            }
        }
    }
}

@Composable
private fun MainScreen(app: DesktopApp) {
    val s = LocalS.current
    var tab by remember { mutableIntStateOf(0) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                listOf(s.home to Icons.Filled.Home, s.account to Icons.Filled.Person, s.settings to Icons.Filled.Settings)
                    .forEachIndexed { i, (label, icon) ->
                        NavigationBarItem(
                            selected = tab == i, onClick = { tab = i }, icon = { Icon(icon, null) }, label = { Text(label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.primary, selectedTextColor = MaterialTheme.colorScheme.primary,
                                indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                            ),
                        )
                    }
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when (tab) {
                0 -> HomeScreen(app)
                1 -> {
                    val me by app.me.collectAsState()
                    AccountScreen(me, app)
                }
                else -> SettingsScreen(app)
            }
        }
    }
}

// ── Login ──────────────────────────────────────────────────────────────────────

@Composable
private fun LoginScreen(ui: LoginUi, onSignIn: (String, String, String?) -> Unit) {
    val s = LocalS.current
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        BrandMark(72.dp)
        Spacer(Modifier.height(20.dp))
        Text(s.loginTitle, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        Text(s.loginSubtitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (ui.revokedNotice) { Spacer(Modifier.height(12.dp)); Notice(s.sessionRevoked, MaterialTheme.colorScheme.tertiary) }
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text(s.username) }, singleLine = true)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text(s.password) }, singleLine = true,
            visualTransformation = PasswordVisualTransformation())
        ui.error?.let { e ->
            Spacer(Modifier.height(8.dp))
            Text(
                when (e) {
                    is ApiError.InvalidCredentials -> s.errInvalid
                    is ApiError.TooManyAttempts -> s.errTooMany
                    is ApiError.DeviceLimit -> s.errDeviceLimit(e.devices.size)
                    is ApiError.AccountDisabled -> s.failDisabled
                    is ApiError.SubscriptionExpired -> s.failExpired
                    is ApiError.Network -> s.errNetwork
                    else -> e.code
                },
                color = MaterialTheme.colorScheme.error,
            )
            if (e is ApiError.DeviceLimit) e.devices.forEach { d ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(d.name, Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                    TextButton({ onSignIn(username, password, d.id) }, enabled = !ui.busy) { Text(s.removeAndSignIn) }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        Button({ onSignIn(username, password, null) }, Modifier.fillMaxWidth().height(52.dp),
            enabled = !ui.busy && username.isNotBlank() && password.isNotEmpty()) { Text(s.signIn) }
        if (ui.busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
    }
}

@Composable
private fun BrandMark(size: Dp) {
    Image(painterResource("icon.svg"), null, Modifier.size(size).clip(CircleShape))
}

// ── Home ───────────────────────────────────────────────────────────────────────

@Composable
private fun HomeScreen(app: DesktopApp) {
    val s = LocalS.current
    val state by app.vpn.collectAsState()
    val locations by app.locations.collectAsState()
    val selected by app.selected.collectAsState()
    val me by app.me.collectAsState()
    val kill by app.killSwitch.collectAsState()
    val protocol by app.protocol.collectAsState()
    val ping by app.ping.collectAsState()
    val speed by app.speed.collectAsState()
    val netErr by app.networkError.collectAsState()
    val connected = state as? VpnState.Connected
    val location = locations.firstOrNull { it.id == selected }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrandMark(34.dp)
            Spacer(Modifier.width(10.dp))
            Text(s.appName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            val tint = if (kill) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(if (kill) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { app.setKillSwitch(!kill) }.padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Lock, null, tint = tint, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (kill) s.killOn else s.killOff, color = tint, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
        if (netErr) Notice(s.errNetwork, MaterialTheme.colorScheme.error) { app.refresh() }

        StatusCard(state, location, locations, protocol, app)

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            InfoTile(s.yourIp, connected?.exitIp?.let { ltr(it) } ?: "—", Modifier.weight(1f))
            ExpiryTile(me?.expiresAt, Modifier.weight(1f))
        }
        MeterCard(connected != null, ping, speed, app)
    }
}

@Composable
private fun StatusCard(state: VpnState, location: Location?, locations: List<Location>, protocol: Transport?, app: DesktopApp) {
    val s = LocalS.current
    val connected = state is VpnState.Connected
    val busy = state is VpnState.Connecting || state is VpnState.Reconnecting
    val failed = state is VpnState.Failed
    val ring by animateColorAsState(
        when { connected -> MaterialTheme.colorScheme.secondary; busy -> MaterialTheme.colorScheme.tertiary
            failed -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.outline }, label = "ring",
    )
    var picking by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.surface).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(132.dp).border(6.dp, ring, CircleShape).padding(9.dp).clip(CircleShape).background(ring.copy(alpha = 0.14f))
                .clickable { if (connected || busy) app.disconnect() else app.connect() },
            contentAlignment = Alignment.Center,
        ) { Text(if (connected || busy) s.disconnect else s.connect, fontSize = 19.sp, fontWeight = FontWeight.SemiBold) }
        Spacer(Modifier.height(14.dp))
        val name = location?.let { if (s.rtl) it.name.fa else it.name.en } ?: ""
        Text(
            when (state) {
                VpnState.Idle -> s.idle
                is VpnState.Connecting -> s.connecting(name)
                is VpnState.Connected -> s.connected(name)
                is VpnState.Reconnecting -> if (state.blocking) s.reconnectingBlocked else s.reconnecting(name)
                is VpnState.Failed -> state.transport.let { chosen ->
                    if (state.reason == FailReason.PROTOCOL_FAILED && chosen != null) s.failProtocol(transportLabel(chosen))
                    else when (state.reason) {
                        FailReason.SUBSCRIPTION_EXPIRED -> s.failExpired
                        FailReason.ACCOUNT_DISABLED -> s.failDisabled
                        FailReason.LOCATION_UNAVAILABLE -> s.failLocation
                        FailReason.SIGNED_OUT -> s.idle
                        else -> s.failAll
                    }
                }
            },
            style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center,
            color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
        if (connected && protocol == null) Text(s.viaProtocol(transportLabel((state as VpnState.Connected).transport)),
            color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 12.dp))
        Spacer(Modifier.height(14.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Box {
            Row(Modifier.fillMaxWidth().clickable(enabled = locations.size > 1) { picking = true }.padding(top = 12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                if (location != null) CountryFlag(location.country) else Text("🌐", fontSize = 24.sp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(s.location, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(name.ifEmpty { "—" }, style = MaterialTheme.typography.titleMedium)
                }
                if (locations.size > 1) Icon(Icons.Filled.ArrowDropDown, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            DropdownMenu(picking, { picking = false }, containerColor = MaterialTheme.colorScheme.surface) {
                locations.forEach { l ->
                    DropdownMenuItem(text = { Text(if (s.rtl) l.name.fa else l.name.en) }, leadingIcon = { CountryFlag(l.country) }, enabled = l.available,
                        onClick = { picking = false; app.select(l.id) })
                }
            }
        }
        ProtocolPicker(protocol, location?.protocols ?: emptyList(), app::setProtocol)
    }
}

@Composable
private fun ProtocolPicker(selected: Transport?, offered: List<String>, onPick: (Transport?) -> Unit) {
    val s = LocalS.current
    var open by remember { mutableStateOf(false) }
    val options: List<Transport?> = listOf(null) + Transport.entries.filter { it.protocol in offered }
    fun name(t: Transport?) = if (t == null) s.protocolAuto else transportLabel(t)
    fun hint(t: Transport?) = when (t) { null -> s.protocolAutoHint; Transport.VLESS -> s.vlessHint; Transport.OPENVPN_UDP -> s.udpHint; Transport.OPENVPN_TCP -> s.tcpHint }
    Box {
        Row(Modifier.fillMaxWidth().padding(top = 10.dp).clip(RoundedCornerShape(12.dp)).clickable { open = true }.padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(28.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Lock, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(15.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(s.protocol, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(name(selected), style = MaterialTheme.typography.titleMedium)
            }
            Icon(Icons.Filled.ArrowDropDown, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        DropdownMenu(open, { open = false }, containerColor = MaterialTheme.colorScheme.surface) {
            options.forEach { t ->
                DropdownMenuItem(
                    text = { Column { Text(name(t), fontWeight = if (t == selected) FontWeight.SemiBold else FontWeight.Normal)
                        Text(hint(t), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                    trailingIcon = { if (t == selected) Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.primary) },
                    onClick = { open = false; onPick(t) },
                )
            }
        }
    }
}

@Composable
private fun InfoTile(label: String, value: String, modifier: Modifier = Modifier, valueColor: Color = MaterialTheme.colorScheme.onSurface, caption: String? = null) {
    Column(modifier.clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.surface).padding(14.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = valueColor, maxLines = 1)
        if (caption != null) Text(caption, style = MaterialTheme.typography.bodySmall, color = valueColor.copy(alpha = 0.85f))
    }
}

/** Expiry: always the Solar Hijri calendar with Persian numerals ("۲۵ مهر ۱۴۰۵"). */
@Composable
private fun ExpiryTile(expiresAt: Long?, modifier: Modifier = Modifier) {
    val s = LocalS.current
    if (expiresAt == null) { InfoTile(s.expires, "—", modifier); return }
    val days = daysLeft(expiresAt, System.currentTimeMillis())
    val color = when { days <= 0 -> MaterialTheme.colorScheme.error; days <= 3 -> MaterialTheme.colorScheme.tertiary; else -> MaterialTheme.colorScheme.onSurface }
    InfoTile(s.expires, Jalali.formatIsolated(expiresAt), modifier, color,
        if (days <= 0) s.expired else s.daysLeft(localDigits(days.toString(), s.rtl)))
}

@Composable
private fun MeterCard(connected: Boolean, ping: Metric<Int>, speed: Metric<SpeedResult>, app: DesktopApp) {
    val s = LocalS.current
    val r = (speed as? Metric.Done)?.value
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.surface).padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MeterTile(s.download, mbps(r?.downloadMbps, s.rtl), "Mbps", speed, Modifier.weight(1f))
            MeterTile(s.upload, mbps(r?.uploadMbps, s.rtl), "Mbps", speed, Modifier.weight(1f))
            MeterTile(if (connected) s.ping else s.pingGateway,
                (ping as? Metric.Done)?.value?.let { localDigits(it.toString(), s.rtl) } ?: "—", "ms", ping, Modifier.weight(1f))
        }
        Spacer(Modifier.height(14.dp))
        val busy = ping.isTesting || speed.isTesting
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilledTonalButton(app::speedTest, Modifier.weight(1f).height(48.dp), enabled = connected && !busy,
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer)) { Text(s.speedTest, fontWeight = FontWeight.SemiBold) }
            Button(app::ping, Modifier.weight(1f).height(48.dp), enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary, contentColor = MaterialTheme.colorScheme.onSecondary)) {
                Text(s.ping, fontWeight = FontWeight.SemiBold)
            }
        }
        if (!connected) Text(s.speedNeedsVpn, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun MeterTile(label: String, value: String, unit: String, metric: Metric<*>, modifier: Modifier = Modifier) {
    val s = LocalS.current
    Column(modifier.clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.background).padding(vertical = 12.dp, horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        Spacer(Modifier.height(6.dp))
        Box(Modifier.height(30.dp), contentAlignment = Alignment.Center) {
            if (metric is Metric.Testing) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.5.dp)
            else Text(ltr(value), fontSize = 22.sp, fontWeight = FontWeight.Bold,
                color = if (metric is Metric.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        }
        Text(if (metric is Metric.Failed) s.failed else unit, style = MaterialTheme.typography.bodySmall,
            color = if (metric is Metric.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ── Account / Settings ─────────────────────────────────────────────────────────

@Composable
private fun AccountScreen(me: Me?, app: DesktopApp) {
    val s = LocalS.current
    var changing by remember { mutableStateOf(false) }
    if (changing) ChangePasswordDialog(app) { changing = false }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(s.account, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
            TextButton(app::signOut) { Text(s.signOut) }
        }
        if (me != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                InfoTile(s.username, me.username, Modifier.weight(1f))
                ExpiryTile(me.expiresAt, Modifier.weight(1f))
            }
            Text(s.devices(localDigits(me.devices.size.toString(), s.rtl), localDigits(me.deviceLimit.toString(), s.rtl)),
                style = MaterialTheme.typography.titleMedium)
            me.devices.forEach { d ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surface).padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(d.name)
                        if (d.id == me.currentDeviceId) Text(s.thisDevice, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                    if (d.id != me.currentDeviceId) TextButton({ app.removeDevice(d) }) { Text(s.remove) }
                }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        OutlinedButton({ changing = true }, Modifier.fillMaxWidth()) { Text(s.changePassword) }
        OutlinedButton(app::signOut, Modifier.fillMaxWidth()) { Text(s.signOut) }
    }
}

/** The signed-in user changes their own password: current one first, then the new one (at least 4 characters). */
@Composable
private fun ChangePasswordDialog(app: DesktopApp, onDismiss: () -> Unit) {
    val s = LocalS.current
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(s.changePassword) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (done) { Text(s.passwordChanged, color = MaterialTheme.colorScheme.primary); return@Column }
                OutlinedTextField(current, { current = it; error = null }, Modifier.fillMaxWidth(), label = { Text(s.currentPassword) },
                    singleLine = true, visualTransformation = PasswordVisualTransformation())
                OutlinedTextField(next, { next = it; error = null }, Modifier.fillMaxWidth(), label = { Text(s.newPassword) },
                    singleLine = true, visualTransformation = PasswordVisualTransformation())
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            if (done) TextButton(onDismiss) { Text("OK") }
            else TextButton(enabled = !busy && current.isNotEmpty() && next.isNotEmpty(), onClick = {
                if (next.length < 4) { error = s.errPasswordShort; return@TextButton }
                busy = true
                scope.launch {
                    val e = app.changePassword(current, next)
                    busy = false
                    when (e) {
                        null -> done = true
                        is ApiError.InvalidCredentials -> error = s.errCurrentPassword
                        is ApiError.TooManyAttempts -> error = s.errTooMany
                        is ApiError.Network -> error = s.errNetwork
                        else -> error = s.errPasswordShort
                    }
                }
            }) { Text(s.save) }
        },
        dismissButton = { if (!done) TextButton(onDismiss, enabled = !busy) { Text(s.cancel) } },
    )
}

@Composable
private fun SettingsScreen(app: DesktopApp) {
    val s = LocalS.current
    val kill by app.killSwitch.collectAsState()
    val language by app.language.collectAsState()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(s.settings, style = MaterialTheme.typography.headlineSmall)
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.surface).padding(vertical = 8.dp)) {
            Text(s.language, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            listOf("fa" to "فارسی", "en" to "English").forEach { (code, name) ->
                Row(Modifier.fillMaxWidth().clickable { app.setLanguage(code) }.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(language == code, { app.setLanguage(code) })
                    Text(name, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.surface).padding(20.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(s.killSwitch, style = MaterialTheme.typography.titleMedium)
                Text(s.killSwitchHint, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(kill, app::setKillSwitch)
        }
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.surface).padding(20.dp)) {
            Text(s.modeTitle, style = MaterialTheme.typography.titleMedium)
            Text(s.modeHint, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Notice(text: String, color: Color, onClick: (() -> Unit)? = null) {
    val m = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(color.copy(alpha = 0.15f))
    Text(text, (if (onClick != null) m.clickable(onClick = onClick) else m).padding(14.dp), color = MaterialTheme.colorScheme.onBackground)
}
