package ir.nahalkmi.nahalvpn

import android.app.Application
import android.os.Build
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.SetupOptions
import ir.nahalkmi.nahalvpn.api.ApiClient
import ir.nahalkmi.nahalvpn.session.KeystoreTokenStore
import ir.nahalkmi.nahalvpn.session.SessionManager
import ir.nahalkmi.nahalvpn.update.UpdateManager
import ir.nahalkmi.nahalvpn.vpn.ConnectionManager
import ir.nahalkmi.nahalvpn.vpn.NahalVpnService
import ir.nahalkmi.nahalvpn.vpn.ProxyProber
import ir.nahalkmi.nahalvpn.vpn.Transport
import ir.nahalkmi.nahalvpn.vpn.VpnState
import ir.nahalkmi.nahalvpn.vpn.VpnTunnelHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** Object graph for the whole process (no DI framework; it is small). */
class AppGraph(app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val settings = Settings(app)
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build()
    val api = ApiClient(BuildConfig.API_BASE, http)
    val session = SessionManager(api, KeystoreTokenStore(app), settings.deviceKey, settings.deviceName)
    val prober = ProxyProber(http)
    val host = VpnTunnelHost(app, prober, scope)
    val connections = ConnectionManager(
        fetchConfig = { loc, proto -> session.authorized { api.connect(it, loc, proto) } },
        host = host,
        prober = prober,
        supported = BuildConfig.FORCE_TRANSPORTS.split(',').mapNotNull { n -> Transport.entries.find { it.name.equals(n.trim(), true) } }
            .toSet().ifEmpty { Transport.entries.toSet() }, // VLESS, then OpenVPN UDP/TCP (sing-box's built-in client)
        killSwitch = { settings.killSwitch },
        scope = scope,
    )
    val updates = UpdateManager(app, api, http)
}

class NahalApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun attachBaseContext(base: android.content.Context) = super.attachBaseContext(AppLocale.wrap(base))

    override fun onCreate() {
        super.onCreate()
        Libbox.setup(SetupOptions().apply {
            basePath = filesDir.path
            workingPath = File(filesDir, "work").path
            tempPath = cacheDir.path
            // Same rule as sing-box-for-android: work around golang/go#68760 on affected Android versions.
            fixAndroidStack = Build.VERSION.SDK_INT in 24..25 || Build.VERSION.SDK_INT >= 28
            logMaxLines = 300
        })
        graph = AppGraph(this)
        // Android took the VPN away (user or another VPN app): show "not connected" instead of reconnecting.
        graph.scope.launch { NahalVpnService.revoked.drop(1).collect { graph.connections.disconnect() } }
        graph.scope.launch {
            graph.connections.state.collect { s ->
                val service = NahalVpnService.instance.value ?: return@collect
                if (s is VpnState.Connected) service.updateNotification(getString(R.string.notif_connected, s.location.uppercase()))
            }
        }
    }
}
