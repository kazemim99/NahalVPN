package ir.nahalkmi.nahalvpn.desktop

import ir.nahalkmi.nahalvpn.api.OpenVpnConfig
import ir.nahalkmi.nahalvpn.api.VlessConfig
import ir.nahalkmi.nahalvpn.vpn.CaptureMode
import ir.nahalkmi.nahalvpn.vpn.ProbeProxy
import ir.nahalkmi.nahalvpn.vpn.ProxyProber
import ir.nahalkmi.nahalvpn.vpn.SingBoxConfig
import ir.nahalkmi.nahalvpn.vpn.Transport
import ir.nahalkmi.nahalvpn.vpn.TunnelHost
import ir.nahalkmi.nahalvpn.vpn.TunnelPlan
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * [TunnelHost] on Windows: runs sing-box.exe (the same engine as on Android) as a child process in system-proxy mode
 * and points the Windows proxy at it. Kill switch: when the connection drops, the proxy keeps pointing at the dead
 * local port, so proxy-aware apps get no connection at all instead of going out directly.
 */
class EngineHost(
    private val proxy: WindowsProxy,
    private val prober: ProxyProber,
    private val scope: CoroutineScope,
    private val healthEveryMs: Long = 20_000,
) : TunnelHost {
    private val _drops = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    override val drops: SharedFlow<Unit> = _drops
    private var process: Process? = null
    private var monitor: Job? = null
    @Volatile private var stopping = false

    /** sing-box.exe from the installed app, or from the project during development. */
    private val engine: File by lazy {
        listOfNotNull(
            System.getProperty("compose.application.resources.dir")?.let { File(it, "sing-box.exe") },
            File("appResources/windows/sing-box.exe"),
            File("desktop/appResources/windows/sing-box.exe"),
        ).firstOrNull { it.isFile } ?: error("sing-box.exe not found")
    }

    override suspend fun start(plan: TunnelPlan) = withContext(Dispatchers.IO) {
        stopEngine()
        val host = when (val c = plan.config) { is VlessConfig -> c.host; is OpenVpnConfig -> c.server.host }
        val gatewayIp = InetAddress.getAllByName(host).first { it is Inet4Address }.hostAddress!!
        val port = ServerSocket(0).use { it.localPort }
        val probe = ProbeProxy(port, "", "")
        val log = File(AppDirs.run, "engine.log").path
        val config = when (val c = plan.config) {
            is VlessConfig -> SingBoxConfig.build(c, gatewayIp, probe, "warn", log, CaptureMode.SYSTEM_PROXY)
            is OpenVpnConfig -> SingBoxConfig.buildOpenVpn(c, plan.transport == Transport.OPENVPN_UDP, gatewayIp, probe, "warn", log, CaptureMode.SYSTEM_PROXY)
        }
        val cfgFile = File(AppDirs.run, "engine.json").apply { writeText(config) }
        stopping = false
        val p = ProcessBuilder(engine.path, "run", "-c", cfgFile.path)
            .redirectErrorStream(true).redirectOutput(File(AppDirs.run, "engine.out"))
            .start()
        process = p
        // Wait for the local port (or an early exit, e.g. a config error).
        val deadline = System.currentTimeMillis() + 8_000
        while (!portOpen(port)) {
            if (!p.isAlive) error("engine exited (${p.exitValue()})")
            if (System.currentTimeMillis() > deadline) error("engine did not open its port")
            delay(100)
        }
        prober.use(probe)
        proxy.point(port)
        watch(p)
    }

    override suspend fun stop() = withContext(Dispatchers.IO) {
        monitor?.cancel()
        stopEngine()
        proxy.restore()
    }

    /** Kill switch: no engine, but the Windows proxy still points at its (now closed) port. */
    override suspend fun holdBlocking() = withContext(Dispatchers.IO) {
        monitor?.cancel()
        stopEngine()
    }

    /** Called on app exit: never leave the user's Windows proxy pointing at NahalVPN. */
    fun shutdown() {
        monitor?.cancel()
        stopEngine()
        runCatching { proxy.restore() }
    }

    private fun stopEngine() {
        stopping = true
        process?.let { p ->
            p.destroy()
            if (!p.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly()
        }
        process = null
    }

    private fun watch(p: Process) {
        monitor?.cancel()
        monitor = scope.launch {
            var failures = 0
            while (true) {
                delay(if (p.isAlive) healthEveryMs else 0)
                if (!p.isAlive) {
                    if (!stopping) _drops.tryEmit(Unit)
                    return@launch
                }
                failures = if (prober.probe(8_000) == null) failures + 1 else 0
                if (failures >= 2) {
                    _drops.tryEmit(Unit)
                    return@launch
                }
            }
        }
    }

    private fun portOpen(port: Int) = runCatching { Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 200) } }.isSuccess
}
