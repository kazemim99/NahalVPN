package ir.nahalkmi.nahalvpn.vpn

import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.api.ConnectionConfig
import ir.nahalkmi.nahalvpn.api.OpenVpnConfig
import ir.nahalkmi.nahalvpn.api.VlessConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** How the device reaches the gateway, in fallback order (vpn-client-app "Automatic protocol selection"). */
enum class Transport(val protocol: String) { VLESS("vless"), OPENVPN_UDP("openvpn"), OPENVPN_TCP("openvpn") }

enum class FailReason { ALL_PROTOCOLS_FAILED, PROTOCOL_FAILED, SUBSCRIPTION_EXPIRED, ACCOUNT_DISABLED, LOCATION_UNAVAILABLE, SIGNED_OUT }

sealed interface VpnState {
    data object Idle : VpnState
    data class Connecting(val location: String, val transport: Transport) : VpnState
    data class Connected(val location: String, val transport: Transport, val exitIp: String) : VpnState
    /** The connection dropped; [blocking] = the kill switch holds all traffic until we are back. */
    data class Reconnecting(val location: String, val blocking: Boolean, val attempt: Int) : VpnState
    /** [transport]: the protocol the user chose, when [reason] is [FailReason.PROTOCOL_FAILED]. */
    data class Failed(val reason: FailReason, val location: String?, val transport: Transport? = null) : VpnState
}

/** What one tunnel attempt runs: a transport plus the backend config for it. */
data class TunnelPlan(val transport: Transport, val config: ConnectionConfig)

/** The VpnService side: owns the TUN device and the engines. */
interface TunnelHost {
    /** Establishes the TUN and starts the engine for [plan]; throws if the engine cannot start. */
    suspend fun start(plan: TunnelPlan)
    /** Tears everything down; traffic flows normally (outside any VPN) afterwards. */
    suspend fun stop()
    /** Kill switch: keep a TUN that captures all traffic and forwards none. */
    suspend fun holdBlocking()
    /** Emits when a running engine dies on its own. */
    val drops: Flow<Unit>
}

/** Checks that traffic passes through the running tunnel; returns the exit IP, or null if it did not within [timeoutMs]. */
fun interface Prober {
    suspend fun probe(timeoutMs: Long): String?
}

class ConnectionManager(
    private val fetchConfig: suspend (location: String, protocol: String) -> ConnectionConfig,
    private val host: TunnelHost,
    private val prober: Prober,
    /** Transports this build can run (VLESS only until the OpenVPN engine lands, task 7.1). */
    private val supported: Set<Transport>,
    private val killSwitch: () -> Boolean,
    private val scope: CoroutineScope,
    private val probeTimeoutMs: Long = 8_000,
    private val retryDelaysMs: List<Long> = listOf(1_000, 2_000, 5_000, 10_000, 20_000),
) {
    private val _state = MutableStateFlow<VpnState>(VpnState.Idle)
    val state: StateFlow<VpnState> = _state.asStateFlow()
    private val lock = Mutex()
    private var job: Job? = null
    private var lastOffered: List<String> = emptyList()
    private var lastOnly: Transport? = null

    init {
        scope.launch { host.drops.collect { onDrop() } }
    }

    /** One tap: connect (or switch) to [location]; [offered] = protocols the location offers. */
    /**
     * [only] = the protocol the user picked; null = automatic (VLESS, then OpenVPN UDP, then TCP). A picked protocol is
     * the only one tried: if it fails the user is told, rather than silently switched to another.
     */
    fun connect(location: String, offered: List<String>, only: Transport? = null) {
        lastOffered = offered
        lastOnly = only
        replaceJob { establish(location, offered, reconnecting = false) }
    }

    fun disconnect() {
        replaceJob {
            host.stop()
            _state.value = VpnState.Idle
        }
    }

    /** The session ended (logout or revoked): no VPN may stay up. */
    fun signedOut() {
        replaceJob {
            host.stop()
            _state.value = VpnState.Failed(FailReason.SIGNED_OUT, null)
        }
    }

    private fun replaceJob(block: suspend () -> Unit) {
        val previous = job
        job = scope.launch {
            previous?.cancel()
            previous?.join()
            lock.withLock { block() }
        }
    }

    /** Returns true when connected. On failure the tunnel is fully down unless [reconnecting] with the kill switch. */
    private suspend fun establish(location: String, offered: List<String>, reconnecting: Boolean): Boolean {
        val only = lastOnly
        val order = Transport.entries.filter { (only == null || it == only) && it in supported && it.protocol in offered }
        var openVpn: OpenVpnConfig? = null
        for (transport in order) {
            if (!reconnecting) _state.value = VpnState.Connecting(location, transport)
            val config: ConnectionConfig = try {
                if (transport.protocol == "openvpn") openVpn ?: (fetchConfig(location, "openvpn") as OpenVpnConfig).also { openVpn = it }
                else fetchConfig(location, transport.protocol) as VlessConfig
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                val fatal = fatalReason(e)
                if (fatal != null) {
                    host.stop()
                    _state.value = VpnState.Failed(fatal, location)
                    return false
                }
                continue // e.g. protocol_not_ready or a network hiccup: try the next transport
            }
            try {
                host.start(TunnelPlan(transport, config))
                val exitIp = prober.probe(probeTimeoutMs)
                if (exitIp != null) {
                    _state.value = VpnState.Connected(location, transport, exitIp)
                    return true
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // engine failed to start: fall through to the next transport
            }
            if (reconnecting && killSwitch()) host.holdBlocking() else host.stop()
        }
        if (!reconnecting) {
            host.stop() // never leave a half-open VPN behind (vpn-client-app "All protocols fail")
            _state.value = if (only != null) VpnState.Failed(FailReason.PROTOCOL_FAILED, location, only)
                else VpnState.Failed(FailReason.ALL_PROTOCOLS_FAILED, location)
        }
        return false
    }

    private fun onDrop() {
        val current = _state.value as? VpnState.Connected ?: return
        replaceJob {
            val blocking = killSwitch()
            if (blocking) host.holdBlocking() else host.stop()
            val offered = lastOffered
            var attempt = 0
            while (true) {
                attempt++
                _state.value = VpnState.Reconnecting(current.location, blocking, attempt)
                if (establish(current.location, offered, reconnecting = true)) return@replaceJob
                if (_state.value is VpnState.Failed) return@replaceJob // account-level failure: stop trying
                if (!blocking && attempt >= retryDelaysMs.size) {
                    host.stop()
                    _state.value = lastOnly?.let { VpnState.Failed(FailReason.PROTOCOL_FAILED, current.location, it) }
                        ?: VpnState.Failed(FailReason.ALL_PROTOCOLS_FAILED, current.location)
                    return@replaceJob
                }
                delay(retryDelaysMs[minOf(attempt - 1, retryDelaysMs.lastIndex)])
            }
        }
    }

    private fun fatalReason(e: ApiError): FailReason? = when (e) {
        is ApiError.SubscriptionExpired -> FailReason.SUBSCRIPTION_EXPIRED
        is ApiError.AccountDisabled -> FailReason.ACCOUNT_DISABLED
        is ApiError.LocationUnavailable -> FailReason.LOCATION_UNAVAILABLE
        is ApiError.InvalidToken -> FailReason.SIGNED_OUT
        else -> null
    }
}
