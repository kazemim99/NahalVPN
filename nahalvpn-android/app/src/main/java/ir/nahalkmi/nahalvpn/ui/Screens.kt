package ir.nahalkmi.nahalvpn.ui

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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.RadioButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ir.nahalkmi.nahalvpn.R
import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.api.AppRelease
import ir.nahalkmi.nahalvpn.api.Device
import ir.nahalkmi.nahalvpn.api.Location
import ir.nahalkmi.nahalvpn.api.Me
import ir.nahalkmi.nahalvpn.util.Jalali
import ir.nahalkmi.nahalvpn.vpn.FailReason
import ir.nahalkmi.nahalvpn.vpn.Metric
import ir.nahalkmi.nahalvpn.vpn.SpeedResult
import ir.nahalkmi.nahalvpn.vpn.Transport
import ir.nahalkmi.nahalvpn.vpn.VpnState
import ir.nahalkmi.nahalvpn.vpn.isTesting
import java.util.Locale

@Composable
private fun isFa() = LocalConfiguration.current.locales[0].language == "fa"

@Composable
fun locationName(l: Location) = if (isFa()) l.name.fa else l.name.en

// ── Login ─────────────────────────────────────────────────────────────────────

@Composable
fun LoginScreen(ui: LoginUi, onSignIn: (username: String, password: String, replaceDeviceId: String?) -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        BrandMark(72.dp)
        Spacer(Modifier.height(20.dp))
        Text(stringResource(R.string.login_title), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        Text(stringResource(R.string.login_subtitle), color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (ui.revokedNotice) {
            Spacer(Modifier.height(12.dp))
            Notice(stringResource(R.string.session_revoked), MaterialTheme.colorScheme.tertiary)
        }
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.username)) },
            singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii))
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.password)) },
            singleLine = true, visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        ui.error?.let {
            Spacer(Modifier.height(8.dp))
            Text(loginError(it), color = MaterialTheme.colorScheme.error)
            if (it is ApiError.DeviceLimit) it.devices.forEach { d ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(d.name, Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                    TextButton({ onSignIn(username, password, d.id) }, enabled = !ui.busy) { Text(stringResource(R.string.remove_and_sign_in)) }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        Button(onClick = { onSignIn(username, password, null) }, enabled = !ui.busy && username.isNotBlank() && password.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().height(52.dp)) { Text(stringResource(R.string.sign_in)) }
        if (ui.busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
    }
}

@Composable
private fun BrandMark(size: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(size).clip(CircleShape).background(Nahal.Pine), contentAlignment = Alignment.Center) {
        Image(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, Modifier.size(size * 1.35f))
    }
}

@Composable
private fun loginError(e: ApiError) = when (e) {
    is ApiError.InvalidCredentials -> stringResource(R.string.error_invalid_credentials)
    is ApiError.TooManyAttempts -> stringResource(R.string.error_too_many_attempts)
    is ApiError.DeviceLimit -> stringResource(R.string.error_device_limit, e.devices.size)
    is ApiError.AccountDisabled -> stringResource(R.string.fail_disabled)
    is ApiError.SubscriptionExpired -> stringResource(R.string.fail_expired)
    is ApiError.Network -> stringResource(R.string.error_network)
    else -> e.code
}

// ── Home ──────────────────────────────────────────────────────────────────────

data class HomeUi(
    val state: VpnState,
    val locations: List<Location>,
    val selected: String?,
    val networkError: Boolean,
    val update: AppRelease?,
    val expiresAt: Long?,
    val killSwitch: Boolean,
    val ping: Metric<Int>,
    val speed: Metric<SpeedResult>,
    /** The protocol the user picked; null = automatic. */
    val protocol: Transport? = null,
)

data class HomeActions(
    val onConnect: () -> Unit,
    val onDisconnect: () -> Unit,
    val onSelect: (String) -> Unit,
    val onRefresh: () -> Unit,
    val onUpdate: (AppRelease) -> Unit,
    val onKillSwitch: (Boolean) -> Unit,
    val onPing: () -> Unit,
    val onSpeed: () -> Unit,
    val onProtocol: (Transport?) -> Unit = {},
)

/**
 * Everything that matters on one screen: connection state, location, exit IP, expiry, kill switch, and on-demand
 * download / upload / ping. Nothing runs by itself: the user taps Speed test or Ping.
 */
@Composable
fun HomeScreen(ui: HomeUi, a: HomeActions) {
    val connected = ui.state as? VpnState.Connected
    val selectedLocation = ui.locations.firstOrNull { it.id == ui.selected }
    var picking by rememberSaveable { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        HeaderRow(ui.killSwitch, a.onKillSwitch)
        ui.update?.let { Notice(stringResource(R.string.update_available, it.versionName), MaterialTheme.colorScheme.secondary) { a.onUpdate(it) } }
        if (ui.networkError) Notice(stringResource(R.string.error_network), MaterialTheme.colorScheme.error, a.onRefresh)

        StatusCard(
            state = ui.state, location = selectedLocation, canPick = ui.locations.size > 1,
            onToggle = { if (connected != null || ui.state is VpnState.Connecting || ui.state is VpnState.Reconnecting) a.onDisconnect() else a.onConnect() },
            onPick = { picking = true },
            protocol = ui.protocol, onProtocol = a.onProtocol,
        )

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            InfoTile(stringResource(R.string.exit_ip_label), connected?.exitIp?.let { ltr(it) } ?: "—", Modifier.weight(1f))
            ExpiryTile(ui.expiresAt, Modifier.weight(1f))
        }

        MeterCard(ui, a)
    }

    if (picking) LocationSheet(ui.locations, ui.selected, onSelect = { a.onSelect(it); picking = false }, onDismiss = { picking = false })
}

@Composable
private fun HeaderRow(killSwitch: Boolean, onKillSwitch: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        BrandMark(34.dp)
        Spacer(Modifier.width(10.dp))
        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        val on = killSwitch
        val tint = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
        Row(
            Modifier.clip(RoundedCornerShape(50)).background(if (on) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)
                .clickable { onKillSwitch(!on) }.padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Lock, contentDescription = null, tint = tint, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(if (on) R.string.kill_switch_on else R.string.kill_switch_off), color = tint, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun StatusCard(
    state: VpnState, location: Location?, canPick: Boolean, onToggle: () -> Unit, onPick: () -> Unit,
    protocol: Transport?, onProtocol: (Transport?) -> Unit,
) {
    val connected = state is VpnState.Connected
    val busy = state is VpnState.Connecting || state is VpnState.Reconnecting
    val failed = state is VpnState.Failed
    val ring by animateColorAsState(
        when {
            connected -> MaterialTheme.colorScheme.secondary
            busy -> MaterialTheme.colorScheme.tertiary
            failed -> MaterialTheme.colorScheme.error
            else -> MaterialTheme.colorScheme.outline
        }, label = "ring",
    )
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.surface).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(132.dp).border(6.dp, ring, CircleShape).padding(9.dp).clip(CircleShape).background(ring.copy(alpha = 0.14f))
                .clickable(onClick = onToggle),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                stringResource(if (connected || busy) R.string.disconnect else R.string.connect),
                fontSize = 19.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface,
            )
        }
        Spacer(Modifier.height(14.dp))
        Text(
            statusLine(state, location), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center,
            color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
        // In Automatic mode, say which protocol was actually used; a chosen protocol is already shown in the picker below.
        if (connected && protocol == null) {
            Text(
                stringResource(R.string.via_protocol, transportLabel((state as VpnState.Connected).transport)),
                color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall,
            )
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 12.dp))
        Spacer(Modifier.height(14.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(
            Modifier.fillMaxWidth().clickable(enabled = canPick, onClick = onPick).padding(top = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(location?.let { flag(it.country) } ?: "🌐", fontSize = 24.sp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.location_label), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(location?.let { locationName(it) } ?: "—", style = MaterialTheme.typography.titleMedium)
            }
            if (canPick) Icon(Icons.Filled.ArrowDropDown, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        ProtocolPicker(protocol, location?.protocols ?: emptyList(), onProtocol)
    }
}

/** Dropdown: Automatic (recommended) or one specific protocol, limited to what the location offers. */
@Composable
private fun ProtocolPicker(selected: Transport?, offered: List<String>, onPick: (Transport?) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    val options: List<Transport?> = listOf(null) + Transport.entries.filter { it.protocol in offered }
    Box {
        Row(
            Modifier.fillMaxWidth().padding(top = 10.dp).clip(RoundedCornerShape(12.dp)).clickable { open = true }.padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(28.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(15.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.protocol_label), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(protocolName(selected), style = MaterialTheme.typography.titleMedium)
            }
            Icon(Icons.Filled.ArrowDropDown, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = MaterialTheme.colorScheme.surface) {
            options.forEach { t ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(protocolName(t), fontWeight = if (t == selected) FontWeight.SemiBold else FontWeight.Normal)
                            Text(protocolHint(t), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    },
                    trailingIcon = { if (t == selected) Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary) },
                    onClick = { open = false; onPick(t) },
                )
            }
        }
    }
}

@Composable
fun protocolName(t: Transport?): String = if (t == null) stringResource(R.string.protocol_auto) else transportLabel(t)

@Composable
private fun protocolHint(t: Transport?): String = stringResource(
    when (t) {
        null -> R.string.protocol_auto_hint
        Transport.VLESS -> R.string.protocol_vless_hint
        Transport.OPENVPN_UDP -> R.string.protocol_udp_hint
        Transport.OPENVPN_TCP -> R.string.protocol_tcp_hint
    },
)


@Composable
private fun statusLine(state: VpnState, location: Location?): String {
    val name = location?.let { locationName(it) } ?: ""
    return when (state) {
        VpnState.Idle -> stringResource(R.string.state_idle)
        is VpnState.Connecting -> stringResource(R.string.state_connecting, name)
        is VpnState.Connected -> stringResource(R.string.state_connected, name)
        is VpnState.Reconnecting ->
            if (state.blocking) stringResource(R.string.state_reconnecting_blocked) else stringResource(R.string.state_reconnecting, name)
        is VpnState.Failed -> state.transport.let { chosen -> if (state.reason == FailReason.PROTOCOL_FAILED && chosen != null)
            stringResource(R.string.fail_protocol, transportLabel(chosen))
        else stringResource(
            when (state.reason) {
                FailReason.ALL_PROTOCOLS_FAILED, FailReason.PROTOCOL_FAILED -> R.string.fail_all_protocols
                FailReason.SUBSCRIPTION_EXPIRED -> R.string.fail_expired
                FailReason.ACCOUNT_DISABLED -> R.string.fail_disabled
                FailReason.LOCATION_UNAVAILABLE -> R.string.fail_location
                FailReason.SIGNED_OUT -> R.string.state_idle
            },
        ) }
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

/** The expiry in the Solar Hijri calendar with Persian numerals ("۲۵ مهر ۱۴۰۵"), in every language. */
@Composable
private fun ExpiryTile(expiresAt: Long?, modifier: Modifier = Modifier) {
    if (expiresAt == null) { InfoTile(stringResource(R.string.expires), "—", modifier); return }
    val days = daysLeft(expiresAt, System.currentTimeMillis())
    val color = when {
        days <= 0 -> MaterialTheme.colorScheme.error
        days <= 3 -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.onSurface
    }
    val caption = if (days <= 0) stringResource(R.string.expired) else stringResource(R.string.days_left, localDigits(days.toString(), isFa()))
    InfoTile(stringResource(R.string.expires), Jalali.formatIsolated(expiresAt), modifier, color, caption)
}


@Composable
private fun MeterCard(ui: HomeUi, a: HomeActions) {
    val connected = ui.state is VpnState.Connected
    val speed = (ui.speed as? Metric.Done)?.value
    val fa = isFa()
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.surface).padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MeterTile(stringResource(R.string.download), mbps(speed?.downloadMbps, fa), "Mbps", ui.speed, Modifier.weight(1f))
            MeterTile(stringResource(R.string.upload), mbps(speed?.uploadMbps, fa), "Mbps", ui.speed, Modifier.weight(1f))
            MeterTile(
                stringResource(if (connected) R.string.ping else R.string.ping_gateway),
                (ui.ping as? Metric.Done)?.value?.let { localDigits(it.toString(), fa) } ?: "—", "ms", ui.ping, Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(14.dp))
        val busy = ui.ping.isTesting || ui.speed.isTesting
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilledTonalButton(
                a.onSpeed, Modifier.weight(1f).height(48.dp), enabled = connected && !busy,
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer),
            ) { Text(stringResource(R.string.speed_test), fontWeight = FontWeight.SemiBold) }
            Button(
                a.onPing, Modifier.weight(1f).height(48.dp), enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary, contentColor = MaterialTheme.colorScheme.onSecondary),
            ) { Text(stringResource(R.string.ping), fontWeight = FontWeight.SemiBold) }
        }
        if (!connected) Text(
            stringResource(R.string.speed_needs_vpn), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp),
        )
    }
}


@Composable
private fun MeterTile(label: String, value: String, unit: String, metric: Metric<*>, modifier: Modifier = Modifier) {
    Column(
        modifier.clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.background).padding(vertical = 12.dp, horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        Spacer(Modifier.height(6.dp))
        Box(Modifier.height(30.dp), contentAlignment = Alignment.Center) {
            if (metric is Metric.Testing) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.5.dp)
            else Text(ltr(value), fontSize = 22.sp, fontWeight = FontWeight.Bold,
                color = if (metric is Metric.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        }
        Text(if (metric is Metric.Failed) stringResource(R.string.failed) else unit, style = MaterialTheme.typography.bodySmall,
            color = if (metric is Metric.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LocationSheet(locations: List<Location>, selected: String?, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.locations), style = MaterialTheme.typography.titleMedium)
            locations.forEach { l -> LocationRow(l, l.id == selected) { onSelect(l.id) } }
        }
    }
}

@Composable
private fun LocationRow(l: Location, selected: Boolean, onClick: () -> Unit) {
    val border = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).border(2.dp, border, RoundedCornerShape(14.dp))
            .clickable(enabled = l.available, onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(flag(l.country), fontSize = 24.sp)
        Spacer(Modifier.size(12.dp))
        Text(locationName(l), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge,
            color = if (l.available) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
        if (!l.available) Text(stringResource(R.string.location_unavailable), color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall)
    }
}


// ── Account ───────────────────────────────────────────────────────────────────

@Composable
fun AccountScreen(
    me: Me?, onRemove: (Device) -> Unit, onSignOut: () -> Unit,
    onChangePassword: (current: String, new: String, done: (ApiError?) -> Unit) -> Unit = { _, _, done -> done(null) },
) {
    var changing by rememberSaveable { mutableStateOf(false) }
    if (changing) ChangePasswordDialog(onChangePassword) { changing = false }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.account), style = MaterialTheme.typography.headlineSmall)
        if (me != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                InfoTile(stringResource(R.string.username), me.username, Modifier.weight(1f))
                ExpiryTile(me.expiresAt, Modifier.weight(1f))
            }
            Text(stringResource(R.string.devices, localDigits(me.devices.size.toString(), isFa()), localDigits(me.deviceLimit.toString(), isFa())), style = MaterialTheme.typography.titleMedium)
            me.devices.forEach { d ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surface).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(d.name)
                        if (d.id == me.currentDeviceId) Text(stringResource(R.string.this_device), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                    if (d.id != me.currentDeviceId) TextButton({ onRemove(d) }) { Text(stringResource(R.string.remove)) }
                }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        OutlinedButton({ changing = true }, Modifier.fillMaxWidth()) { Text(stringResource(R.string.change_password)) }
        OutlinedButton(onSignOut, Modifier.fillMaxWidth()) { Text(stringResource(R.string.sign_out)) }
    }
}

/** The signed-in user changes their own password: current one first, then the new one (at least 4 characters). */
@Composable
private fun ChangePasswordDialog(onChange: (String, String, (ApiError?) -> Unit) -> Unit, onDismiss: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var current by rememberSaveable { mutableStateOf("") }
    var next by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val tooShort = stringResource(R.string.error_password_short)
    val wrong = stringResource(R.string.error_current_password)
    val tooMany = stringResource(R.string.error_too_many_attempts)
    val offline = stringResource(R.string.error_network)
    val done = stringResource(R.string.password_changed)
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.change_password)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(current, { current = it; error = null }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.current_password)) },
                    singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                OutlinedTextField(next, { next = it; error = null }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.new_password)) },
                    singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && current.isNotEmpty() && next.isNotEmpty(), onClick = {
                if (next.length < 4) { error = tooShort; return@TextButton }
                busy = true
                onChange(current, next) { e ->
                    busy = false
                    when (e) {
                        null -> { android.widget.Toast.makeText(context, done, android.widget.Toast.LENGTH_SHORT).show(); onDismiss() }
                        is ApiError.InvalidCredentials -> error = wrong
                        is ApiError.TooManyAttempts -> error = tooMany
                        is ApiError.Network -> error = offline
                        else -> error = tooShort
                    }
                }
            }) { Text(stringResource(R.string.pw_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.pw_cancel)) } },
    )
}

// ── Outage notice ─────────────────────────────────────────────────────────────

/** The owner's outage notice, shown over whatever screen is open (vpn-client-app "Service notice"). */
@Composable
fun NoticeDialog(message: String, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        icon = { Icon(Icons.Filled.Info, null, tint = MaterialTheme.colorScheme.tertiary) },
        title = { Text(stringResource(R.string.notice_title)) },
        text = { Text(message, style = MaterialTheme.typography.bodyLarge) },
        confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.notice_ok)) } },
    )
}

// ── Settings ──────────────────────────────────────────────────────────────────

@Composable
fun SettingsScreen(
    killSwitch: Boolean, onKillSwitch: (Boolean) -> Unit, onOpenVpnSettings: () -> Unit,
    language: String = "fa", onLanguage: (String) -> Unit = {},
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.settings), style = MaterialTheme.typography.headlineSmall)
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.surface).padding(vertical = 8.dp)) {
            Text(stringResource(R.string.language), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            listOf("fa" to "فارسی", "en" to "English").forEach { (code, name) ->
                Row(
                    Modifier.fillMaxWidth().clickable { onLanguage(code) }.padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = language == code, onClick = { onLanguage(code) })
                    Text(name, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.surface).padding(20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.kill_switch), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.kill_switch_hint), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(killSwitch, onKillSwitch)
        }
        Text(stringResource(R.string.always_on_hint), color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton(onOpenVpnSettings) { Text(stringResource(R.string.open_vpn_settings)) }
    }
}

@Composable
private fun Notice(text: String, color: Color, onClick: (() -> Unit)? = null) {
    val m = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(color.copy(alpha = 0.15f))
    Text(text, (if (onClick != null) m.clickable(onClick = onClick) else m).padding(14.dp), color = MaterialTheme.colorScheme.onBackground)
}
