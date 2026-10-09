package ir.nahalkmi.nahalvpn.desktop

import ir.nahalkmi.nahalvpn.api.ApiClient
import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.api.Device
import ir.nahalkmi.nahalvpn.api.Location
import ir.nahalkmi.nahalvpn.api.Me
import ir.nahalkmi.nahalvpn.api.Notice
import ir.nahalkmi.nahalvpn.session.SessionManager
import ir.nahalkmi.nahalvpn.session.SignOutReason
import ir.nahalkmi.nahalvpn.vpn.ConnectionManager
import ir.nahalkmi.nahalvpn.vpn.GatewayPing
import ir.nahalkmi.nahalvpn.vpn.Metric
import ir.nahalkmi.nahalvpn.vpn.ProxyMeterIo
import ir.nahalkmi.nahalvpn.vpn.ProxyProber
import ir.nahalkmi.nahalvpn.vpn.SpeedResult
import ir.nahalkmi.nahalvpn.vpn.Transport
import ir.nahalkmi.nahalvpn.vpn.TunnelMeter
import ir.nahalkmi.nahalvpn.vpn.VpnState
import ir.nahalkmi.nahalvpn.vpn.isTesting
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

const val API_BASE = "https://api.nahalkmi.ir"

data class LoginUi(val busy: Boolean = false, val error: ApiError? = null, val revokedNotice: Boolean = false)

/** Object graph + view state of the Windows app (one window, one process). */
class DesktopApp {
    private val bg = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val ui = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    val settings = DesktopSettings()
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build()
    private val api = ApiClient(API_BASE, http)
    private val session = SessionManager(api, DpapiTokenStore(), settings.deviceKey, settings.deviceName)
    private val prober = ProxyProber(http)
    private val proxy = WindowsProxy(settings)
    val engine = EngineHost(proxy, prober, bg)
    private val connections = ConnectionManager(
        fetchConfig = { loc, proto -> session.authorized { api.connect(it, loc, proto) } },
        host = engine, prober = prober, supported = Transport.entries.toSet(),
        killSwitch = { settings.killSwitch }, scope = bg,
    )

    val signedIn = MutableStateFlow(session.isSignedIn)
    val login = MutableStateFlow(LoginUi())
    val locations = MutableStateFlow<List<Location>>(emptyList())
    val me = MutableStateFlow<Me?>(null)
    val selected = MutableStateFlow(settings.lastLocation)
    val networkError = MutableStateFlow(false)
    val killSwitch = MutableStateFlow(settings.killSwitch)
    val protocol = MutableStateFlow(settings.protocol)
    val language = MutableStateFlow(settings.language)
    val vpn: StateFlow<VpnState> = connections.state
    private val _ping = MutableStateFlow<Metric<Int>>(Metric.Idle)
    val ping = _ping.asStateFlow()
    private val _speed = MutableStateFlow<Metric<SpeedResult>>(Metric.Idle)
    val speed = _speed.asStateFlow()
    private var meterJob: Job? = null
    private val _notice = MutableStateFlow<Notice?>(null)
    /** The owner's outage notice to show as a modal, or null (off, or closed since the app started). */
    val notice = _notice.asStateFlow()
    private var closedNotice = -1L

    init {
        // A crash or power cut while connected may have left the Windows proxy pointing at a dead port.
        runCatching { proxy.restore() }
        Runtime.getRuntime().addShutdownHook(Thread { engine.shutdown() })
        ui.launch {
            session.signedOut.collect { reason ->
                connections.signedOut()
                signedIn.value = false
                login.value = LoginUi(revokedNotice = reason == SignOutReason.REVOKED)
                me.value = null
                locations.value = emptyList()
            }
        }
        ui.launch {
            connections.state.collect {
                meterJob?.cancel()
                _ping.value = Metric.Idle
                _speed.value = Metric.Idle
            }
        }
        if (session.isSignedIn) refresh()
        // Outage notice: checked at start, then every minute; a failed read keeps what is shown.
        bg.launch {
            while (true) {
                runCatching { api.notice() }.onSuccess { n -> _notice.value = if (n.active && n.updatedAt != closedNotice) n else null }
                kotlinx.coroutines.delay(60_000)
            }
        }
    }

    fun closeNotice() { _notice.value?.let { closedNotice = it.updatedAt }; _notice.value = null }

    fun signIn(username: String, password: String, replaceDeviceId: String? = null) {
        if (login.value.busy) return
        login.value = LoginUi(busy = true)
        ui.launch {
            try {
                session.login(username, password, replaceDeviceId)
                login.value = LoginUi()
                signedIn.value = true
                refresh()
            } catch (e: ApiError) {
                login.value = LoginUi(error = e)
            }
        }
    }

    fun refresh() {
        ui.launch {
            try {
                val locs = session.authorized { api.locations(it) }
                locations.value = locs
                if (selected.value == null || locs.none { it.id == selected.value }) select(locs.firstOrNull { it.available }?.id)
                me.value = session.authorized { api.me(it) }
                networkError.value = false
            } catch (e: ApiError.Network) {
                networkError.value = true
            } catch (_: ApiError) {
            }
        }
    }

    fun select(id: String?) {
        selected.value = id
        settings.lastLocation = id
        val s = vpn.value
        if (id != null && (s is VpnState.Connected || s is VpnState.Connecting)) connect()
    }

    fun connect() {
        val loc = locations.value.firstOrNull { it.id == selected.value } ?: return
        connections.connect(loc.id, loc.protocols, only = protocol.value)
    }

    fun disconnect() = connections.disconnect()

    fun setProtocol(t: Transport?) {
        if (t == protocol.value) return
        settings.protocol = t
        protocol.value = t
        val s = vpn.value
        if (s is VpnState.Connected || s is VpnState.Connecting || s is VpnState.Reconnecting) connect()
    }

    fun setKillSwitch(on: Boolean) { settings.killSwitch = on; killSwitch.value = on }
    fun setLanguage(code: String) { settings.language = code; language.value = code }

    fun ping() {
        if (_ping.value.isTesting || _speed.value.isTesting) return
        _ping.value = Metric.Testing
        meterJob = ui.launch {
            val ms = if (vpn.value is VpnState.Connected) TunnelMeter(ProxyMeterIo(prober)).ping() else GatewayPing.ms("api.nahalkmi.ir")
            _ping.value = ms?.let { Metric.Done(it) } ?: Metric.Failed
        }
    }

    fun speedTest() {
        if (vpn.value !is VpnState.Connected || _speed.value.isTesting || _ping.value.isTesting) return
        _speed.value = Metric.Testing
        meterJob = ui.launch {
            val r = TunnelMeter(ProxyMeterIo(prober)).speed()
            _speed.value = if (r.downloadMbps == null && r.uploadMbps == null) Metric.Failed else Metric.Done(r)
        }
    }

    /** Changes the signed-in user's own password. Returns null on success, otherwise why it failed. */
    suspend fun changePassword(current: String, new: String): ApiError? =
        try { session.authorized { api.changePassword(it, current, new) }; null } catch (e: ApiError) { e }

    fun removeDevice(d: Device) {
        ui.launch {
            runCatching { session.authorized { api.removeDevice(it, d.id) } }
            refresh()
        }
    }

    fun signOut() { ui.launch { session.logout() } }

    /** Window closed: disconnect and put the Windows proxy back before the process ends. */
    fun close() = engine.shutdown()
}
