package ir.nahalkmi.nahalvpn.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import ir.nahalkmi.nahalvpn.AppGraph
import ir.nahalkmi.nahalvpn.BuildConfig
import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.api.AppRelease
import ir.nahalkmi.nahalvpn.api.Device
import ir.nahalkmi.nahalvpn.api.Location
import ir.nahalkmi.nahalvpn.api.Me
import ir.nahalkmi.nahalvpn.api.Notice
import ir.nahalkmi.nahalvpn.session.SignOutReason
import ir.nahalkmi.nahalvpn.vpn.GatewayPing
import ir.nahalkmi.nahalvpn.vpn.Metric
import ir.nahalkmi.nahalvpn.vpn.ProxyMeterIo
import ir.nahalkmi.nahalvpn.vpn.SpeedResult
import ir.nahalkmi.nahalvpn.vpn.TunnelMeter
import ir.nahalkmi.nahalvpn.vpn.VpnState
import ir.nahalkmi.nahalvpn.vpn.isTesting
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class LoginUi(val busy: Boolean = false, val error: ApiError? = null, val revokedNotice: Boolean = false)

class AppViewModel(private val g: AppGraph) : ViewModel() {
    val signedIn: StateFlow<Boolean> get() = _signedIn
    private val _signedIn = MutableStateFlow(g.session.isSignedIn)
    private val _login = MutableStateFlow(LoginUi())
    val login: StateFlow<LoginUi> = _login.asStateFlow()
    private val _locations = MutableStateFlow<List<Location>>(emptyList())
    val locations: StateFlow<List<Location>> = _locations.asStateFlow()
    private val _me = MutableStateFlow<Me?>(null)
    val me: StateFlow<Me?> = _me.asStateFlow()
    private val _selected = MutableStateFlow(g.settings.lastLocation)
    val selected: StateFlow<String?> = _selected.asStateFlow()
    private val _notice = MutableStateFlow<Notice?>(null)
    /** The owner's outage notice to show as a modal, or null (off, or closed by the user since the app came to the front). */
    val notice: StateFlow<Notice?> = _notice.asStateFlow()
    private var closedNotice = -1L
    private val _networkError = MutableStateFlow(false)
    val networkError: StateFlow<Boolean> = _networkError.asStateFlow()
    private val _protocol = MutableStateFlow(g.settings.protocol)
    /** null = automatic. */
    val protocol: StateFlow<ir.nahalkmi.nahalvpn.vpn.Transport?> = _protocol.asStateFlow()
    private val _killSwitch = MutableStateFlow(g.settings.killSwitch)
    val killSwitch: StateFlow<Boolean> = _killSwitch.asStateFlow()
    private val _update = MutableStateFlow<AppRelease?>(null)
    val update: StateFlow<AppRelease?> = _update.asStateFlow()
    val vpn: StateFlow<VpnState> = g.connections.state

    private val _ping = MutableStateFlow<Metric<Int>>(Metric.Idle)
    val ping: StateFlow<Metric<Int>> = _ping.asStateFlow()
    private val _speed = MutableStateFlow<Metric<SpeedResult>>(Metric.Idle)
    val speed: StateFlow<Metric<SpeedResult>> = _speed.asStateFlow()
    private var meterJob: Job? = null
    private val gatewayHost = java.net.URI(BuildConfig.API_BASE).host

    init {
        viewModelScope.launch {
            g.session.signedOut.collect { reason ->
                g.connections.signedOut()
                _signedIn.value = false
                _login.value = LoginUi(revokedNotice = reason == SignOutReason.REVOKED)
                _me.value = null
                _locations.value = emptyList()
            }
        }
        // Results belong to one connection: any change of tunnel state clears them (and stops a running test).
        viewModelScope.launch {
            g.connections.state.collect {
                meterJob?.cancel()
                _ping.value = Metric.Idle
                _speed.value = Metric.Idle
            }
        }
        if (g.session.isSignedIn) refresh()
        viewModelScope.launch { runCatching { g.updates.check() }.getOrNull()?.let { _update.value = it } }
    }

    fun signIn(username: String, password: String, replaceDeviceId: String? = null) {
        if (_login.value.busy) return
        _login.value = LoginUi(busy = true)
        viewModelScope.launch {
            try {
                g.session.login(username, password, replaceDeviceId)
                _login.value = LoginUi()
                _signedIn.value = true
                refresh()
            } catch (e: ApiError) {
                _login.value = LoginUi(error = e)
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            try {
                val locs = g.session.authorized { g.api.locations(it) }
                _locations.value = locs
                if (_selected.value == null || locs.none { it.id == _selected.value }) select(locs.firstOrNull { it.available }?.id)
                _me.value = g.session.authorized { g.api.me(it) }
                _networkError.value = false
            } catch (e: ApiError.Network) {
                _networkError.value = true
            } catch (_: ApiError) {
            }
        }
    }

    fun select(locationId: String?) {
        _selected.value = locationId
        g.settings.lastLocation = locationId
        val connected = vpn.value
        // Switch location: if a tunnel is up, move it (vpn-client-app "Switch location").
        if (locationId != null && (connected is VpnState.Connected || connected is VpnState.Connecting)) connect()
    }

    /** Call after the VPN permission was granted. */
    fun connect() {
        val loc = _locations.value.firstOrNull { it.id == _selected.value } ?: return
        g.connections.connect(loc.id, loc.protocols, only = _protocol.value)
    }

    /** Pick a protocol (null = automatic). If a tunnel is up or coming up, it moves to the new protocol right away. */
    fun setProtocol(t: ir.nahalkmi.nahalvpn.vpn.Transport?) {
        if (t == _protocol.value) return
        g.settings.protocol = t
        _protocol.value = t
        val s = vpn.value
        if (s is VpnState.Connected || s is VpnState.Connecting || s is VpnState.Reconnecting) connect()
    }

    fun disconnect() = g.connections.disconnect()

    /**
     * Ping on demand. Connected: round trip through the VPN to the internet. Not connected: time to reach the gateway,
     * so the user can tell whether the network can reach NahalVPN at all.
     */
    fun ping() {
        if (_ping.value.isTesting || _speed.value.isTesting) return
        _ping.value = Metric.Testing
        meterJob = viewModelScope.launch {
            val ms = if (vpn.value is VpnState.Connected) TunnelMeter(ProxyMeterIo(g.prober)).ping() else GatewayPing.ms(gatewayHost)
            _ping.value = ms?.let { Metric.Done(it) } ?: Metric.Failed
        }
    }

    /** Download + upload speed through the VPN on demand (about 21 MB); only while connected. */
    fun speedTest() {
        if (vpn.value !is VpnState.Connected || _speed.value.isTesting || _ping.value.isTesting) return
        _speed.value = Metric.Testing
        meterJob = viewModelScope.launch {
            val r = TunnelMeter(ProxyMeterIo(g.prober)).speed()
            _speed.value = if (r.downloadMbps == null && r.uploadMbps == null) Metric.Failed else Metric.Done(r)
        }
    }

    /** Reads the outage notice; a failed read keeps what is shown (the network may be the very problem). */
    suspend fun checkNotice() {
        runCatching { g.api.notice() }.onSuccess { n -> _notice.value = if (n.active && n.updatedAt != closedNotice) n else null }
    }

    fun closeNotice() { _notice.value?.let { closedNotice = it.updatedAt }; _notice.value = null }

    /** The app came to the front: show an active notice again even if it was closed before. */
    fun noticeOnOpen() { closedNotice = -1L }

    fun signOut() {
        viewModelScope.launch { g.session.logout() }
    }

    /** [done] gets null on success, otherwise the reason (wrong current password, lockout, offline). */
    fun changePassword(current: String, new: String, done: (ApiError?) -> Unit) {
        viewModelScope.launch {
            done(try { g.session.authorized { g.api.changePassword(it, current, new) }; null } catch (e: ApiError) { e })
        }
    }

    fun removeDevice(device: Device) {
        viewModelScope.launch {
            runCatching { g.session.authorized { g.api.removeDevice(it, device.id) } }
            refresh()
        }
    }

    fun setKillSwitch(on: Boolean) {
        g.settings.killSwitch = on
        _killSwitch.value = on
    }

    fun installUpdate(release: AppRelease) {
        viewModelScope.launch { g.updates.downloadAndInstall(release) }
    }
}
