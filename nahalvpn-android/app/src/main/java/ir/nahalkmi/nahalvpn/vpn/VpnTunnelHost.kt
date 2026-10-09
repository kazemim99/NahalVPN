package ir.nahalkmi.nahalvpn.vpn

import android.content.Context
import android.content.Intent
import android.os.Build
import ir.nahalkmi.nahalvpn.api.OpenVpnConfig
import ir.nahalkmi.nahalvpn.api.VlessConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import ir.nahalkmi.nahalvpn.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.Inet4Address
import java.net.InetAddress
import java.net.ServerSocket
import java.security.SecureRandom

/**
 * [TunnelHost] on Android: starts/stops [NahalVpnService], builds the engine config and watches the running tunnel.
 * A running tunnel is probed every [healthEveryMs]; two failures in a row count as a drop.
 */
class VpnTunnelHost(
    private val context: Context,
    private val prober: ProxyProber,
    private val scope: CoroutineScope,
    private val healthEveryMs: Long = 20_000,
) : TunnelHost {
    private val _drops = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    override val drops: SharedFlow<Unit> = _drops
    private var monitor: Job? = null

    override suspend fun start(plan: TunnelPlan) {
        val gatewayHost = when (val c = plan.config) {
            is VlessConfig -> c.host
            is OpenVpnConfig -> c.server.host
        }
        val gatewayIp = withContext(Dispatchers.IO) {
            InetAddress.getAllByName(gatewayHost).first { it is Inet4Address }.hostAddress!!
        }
        val service = ensureService()
        val probe = ProbeProxy(freePort(), "probe", randomSecret())
        prober.use(probe)
        val log = if (BuildConfig.DEBUG) File(context.filesDir, "box.log").path else null
        val level = if (BuildConfig.DEBUG) "info" else "warn"
        val json = when (val c = plan.config) {
            is VlessConfig -> SingBoxConfig.build(if (BuildConfig.BREAK_VLESS) c.copy(uuid = "00000000-0000-4000-8000-000000000000") else c, gatewayIp, probe, level, log)
            is OpenVpnConfig -> SingBoxConfig.buildOpenVpn(c, udp = plan.transport == Transport.OPENVPN_UDP, gatewayIp, probe, level, log)
        }
        service.startSingBox(json)
        watch()
    }

    override suspend fun stop() {
        monitor?.cancel()
        NahalVpnService.instance.value?.stopEngine()
        context.startService(Intent(context, NahalVpnService::class.java).setAction(NahalVpnService.ACTION_STOP))
    }

    override suspend fun holdBlocking() {
        monitor?.cancel()
        ensureService().holdBlocking()
    }

    private suspend fun ensureService(): NahalVpnService {
        NahalVpnService.instance.value?.let { return it }
        val intent = Intent(context, NahalVpnService::class.java)
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        return withTimeout(10_000) { NahalVpnService.instance.filterNotNull().first() }
    }

    private fun watch() {
        monitor?.cancel()
        monitor = scope.launch {
            var failures = 0
            while (true) {
                delay(healthEveryMs)
                failures = if (prober.probe(8_000) == null) failures + 1 else 0
                if (failures >= 2) {
                    _drops.tryEmit(Unit)
                    return@launch
                }
            }
        }
    }

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    private fun randomSecret(): String {
        val b = ByteArray(18).also { SecureRandom().nextBytes(it) }
        return android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE)
    }
}
