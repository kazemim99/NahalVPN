package ir.nahalkmi.nahalvpn.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.ConnectionOwner
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LocalDNSTransport
import io.nekohasekai.libbox.NeighborUpdateListener
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.PlatformUser
import io.nekohasekai.libbox.RoutePrefixIterator
import io.nekohasekai.libbox.ShellSession
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.SystemProxyStatus
import io.nekohasekai.libbox.TunOptions
import io.nekohasekai.libbox.WIFIState
import io.nekohasekai.libbox.BridgeOptions
import io.nekohasekai.libbox.BridgeSession
import ir.nahalkmi.nahalvpn.R
import ir.nahalkmi.nahalvpn.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import android.system.Os

/**
 * The one VpnService of the app: owns the TUN device, runs the sing-box engine (libbox) for VLESS, and implements the
 * kill switch's blocking TUN. The app's own package is excluded from the VPN so API calls always reach the gateway.
 * Driven by [VpnTunnelHost]; it never decides on its own when to connect.
 */
class NahalVpnService : VpnService(), PlatformInterface, CommandServerHandler {

    private var server: CommandServer? = null
    private var tun: ParcelFileDescriptor? = null
    private var blockingTun: ParcelFileDescriptor? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var postedNotice = -1L

    override fun attachBaseContext(newBase: android.content.Context) = super.attachBaseContext(ir.nahalkmi.nahalvpn.AppLocale.wrap(newBase))

    override fun onCreate() {
        super.onCreate()
        running.value = this
        watchNotice()
    }

    /**
     * While the VPN runs the user is usually in other apps, so the owner's outage notice also comes as a system
     * notification (vpn-client-app "Service notice"). The app's own traffic bypasses the tunnel, so this still works
     * when the tunnel is the thing that is down.
     */
    private fun watchNotice() = scope.launch {
        val api = (application as ir.nahalkmi.nahalvpn.NahalApp).graph.api
        val nm = getSystemService(NotificationManager::class.java)
        while (true) {
            runCatching { api.notice() }.onSuccess { n ->
                if (n.active && n.updatedAt != postedNotice) {
                    postedNotice = n.updatedAt
                    nm.notify(NOTICE_ID, noticeNotification(n.message.orEmpty()))
                } else if (!n.active && postedNotice != -1L) {
                    postedNotice = -1L
                    nm.cancel(NOTICE_ID)
                }
            }
            delay(60_000)
        }
    }

    private fun noticeNotification(message: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(NOTICE_CHANNEL, getString(R.string.notice_title), NotificationManager.IMPORTANCE_HIGH))
        }
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, NOTICE_CHANNEL)
            else Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH)
        return builder.setSmallIcon(R.drawable.ic_launcher_monochrome).setContentTitle(getString(R.string.notice_title))
            .setContentText(message).setStyle(Notification.BigTextStyle().bigText(message))
            .setContentIntent(open).setAutoCancel(true).build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }
        startInForeground(getString(R.string.notif_working))
        return START_NOT_STICKY
    }

    override fun onRevoke() {
        // The user (or another VPN app) took the VPN away: stop and let the app show "not connected".
        revoked.value++
        stopEverything()
    }

    override fun onDestroy() {
        scope.cancel()
        closeEngine()
        closeBlocking()
        running.value = null
        super.onDestroy()
    }

    // ── Driven by VpnTunnelHost ─────────────────────────────────────────────────

    suspend fun startSingBox(configJson: String) = withContext(Dispatchers.IO) {
        closeEngine()
        val s = Libbox.newCommandServer(this@NahalVpnService, this@NahalVpnService)
        s.start()
        server = s
        try {
            s.startOrReloadService(configJson, OverrideOptions())
        } catch (e: Exception) {
            closeEngine()
            throw e
        }
        closeBlocking() // the real TUN is up now; drop the kill-switch TUN if one was holding traffic
    }

    suspend fun stopEngine() = withContext(Dispatchers.IO) { closeEngine() }

    /** Kill switch: a TUN that takes every route and is never read, so nothing leaves the device outside the VPN. */
    suspend fun holdBlocking() = withContext(Dispatchers.IO) {
        closeEngine()
        if (blockingTun != null) return@withContext
        val b = Builder().setSession(getString(R.string.app_name)).setMtu(1500)
            .addAddress("10.255.255.1", 32).addRoute("0.0.0.0", 0)
            .addAddress("fd00:6e61:6861:6c::1", 128).addRoute("::", 0)
        runCatching { b.addDisallowedApplication(packageName) }
        blockingTun = b.establish()
    }

    fun updateNotification(text: String) = startInForeground(text)

    private fun stopEverything() {
        closeEngine()
        closeBlocking()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun closeEngine() {
        server?.let { s ->
            runCatching { s.closeService() }
            runCatching { s.close() }
        }
        server = null
        tun?.let { runCatching { it.close() } }
        tun = null
    }

    private fun closeBlocking() {
        blockingTun?.let { runCatching { it.close() } }
        blockingTun = null
    }

    private fun startInForeground(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val n = builder.setSmallIcon(R.drawable.ic_launcher_monochrome).setContentTitle(getString(R.string.app_name))
            .setContentText(text).setContentIntent(open).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIFICATION_ID, n)
    }

    // ── libbox PlatformInterface ────────────────────────────────────────────────

    override fun openTun(options: TunOptions): Int {
        if (prepare(this) != null) throw IllegalStateException("VPN permission missing")
        val b = Builder().setSession(getString(R.string.app_name)).setMtu(options.getMTU())
        val v4 = options.getInet4Address().toList()
        val v6 = options.getInet6Address().toList()
        v4.forEach { b.addAddress(it.first, it.second) }
        v6.forEach { b.addAddress(it.first, it.second) }
        if (options.getAutoRoute()) {
            options.getDNSServerAddress().toStrings().forEach { b.addDnsServer(it) }
            val r4 = options.getInet4RouteAddress().toList()
            val r6 = options.getInet6RouteAddress().toList()
            if (r4.isNotEmpty()) r4.forEach { b.addRoute(it.first, it.second) } else if (v4.isNotEmpty()) b.addRoute("0.0.0.0", 0)
            if (r6.isNotEmpty()) r6.forEach { b.addRoute(it.first, it.second) } else if (v6.isNotEmpty()) b.addRoute("::", 0)
            else b.addRoute("::", 0).also { b.addAddress("fd00:6e61:6861:6c::2", 128) } // swallow IPv6 instead of leaking it
        }
        runCatching { b.addDisallowedApplication(packageName) }
        if (Build.VERSION.SDK_INT >= 29) b.setMetered(false)
        val pfd = b.establish() ?: throw IllegalStateException("VPN permission missing")
        tun?.let { runCatching { it.close() } }
        tun = pfd
        return pfd.fd
    }

    override fun usePlatformAutoDetectInterfaceControl() = true
    override fun autoDetectInterfaceControl(fd: Int) {
        if (!protect(fd)) throw IllegalStateException("protect($fd) failed")
    }

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        val cm = getSystemService(ConnectivityManager::class.java)
        val report = { network: Network? ->
            val name = network?.let { cm.getLinkProperties(it)?.interfaceName }
            // Index via if_nametoindex (an ioctl): java.net.NetworkInterface needs netlink, which Android denies to apps.
            val index = name?.let { runCatching { Os.if_nametoindex(it) }.getOrDefault(0) } ?: 0
            if (name == null || index <= 0) listener.updateDefaultInterface("", -1, false, false)
            else {
                val caps = cm.getNetworkCapabilities(network)
                val metered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false
                listener.updateDefaultInterface(name, index, metered, false)
            }
        }
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = report(network)
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) = report(network)
            override fun onLost(network: Network) = report(cm.activeNetwork)
        }
        networkCallback = cb
        if (Build.VERSION.SDK_INT >= 24) cm.registerDefaultNetworkCallback(cb) else cm.registerNetworkCallback(
            android.net.NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), cb,
        )
        report(cm.activeNetwork)
    }

    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        networkCallback = null
    }

    /** Underlying (non-VPN) networks from ConnectivityManager; no netlink involved. */
    override fun getInterfaces(): NetworkInterfaceIterator {
        val cm = getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION")
        val list = cm.allNetworks.mapNotNull { network ->
            val lp = cm.getLinkProperties(network) ?: return@mapNotNull null
            val caps = cm.getNetworkCapabilities(network) ?: return@mapNotNull null
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return@mapNotNull null
            val name = lp.interfaceName ?: return@mapNotNull null
            val index = runCatching { Os.if_nametoindex(name) }.getOrDefault(0)
            if (index <= 0) return@mapNotNull null
            io.nekohasekai.libbox.NetworkInterface().apply {
                this.name = name
                this.index = index
                setMTU(if (Build.VERSION.SDK_INT >= 29 && lp.mtu > 0) lp.mtu else 1500)
                addresses = StringArrayIterator(lp.linkAddresses.map { "${it.address.hostAddress?.substringBefore('%')}/${it.prefixLength}" })
                dnsServer = StringArrayIterator(lp.dnsServers.mapNotNull { it.hostAddress })
                type = when {
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> Libbox.InterfaceTypeWIFI
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Libbox.InterfaceTypeCellular
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Libbox.InterfaceTypeEthernet
                    else -> Libbox.InterfaceTypeOther
                }
                metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                flags = GO_FLAG_UP or GO_FLAG_RUNNING or GO_FLAG_MULTICAST
            }
        }
        return object : NetworkInterfaceIterator {
            private val it = list.iterator()
            override fun hasNext() = it.hasNext()
            override fun next() = it.next()
        }
    }

    override fun localDNSTransport(): LocalDNSTransport? = null
    override fun useProcFS() = false
    override fun findConnectionOwner(ipProtocol: Int, sourceAddress: String, sourcePort: Int, destinationAddress: String, destinationPort: Int): ConnectionOwner =
        throw UnsupportedOperationException("not used")
    override fun underNetworkExtension() = false
    override fun includeAllNetworks() = false
    override fun readWIFIState(): WIFIState? = null
    override fun clearDNSCache() {}
    override fun sendNotification(notification: io.nekohasekai.libbox.Notification) {}
    override fun cancelNotification(identifier: String, typeID: Int) {}
    override fun startNeighborMonitor(listener: NeighborUpdateListener) {}
    override fun closeNeighborMonitor(listener: NeighborUpdateListener) {}
    override fun registerMyInterface(name: String) {}
    override fun usePlatformShell() = false
    override fun checkPlatformShell() = throw UnsupportedOperationException("no shell")
    override fun openShellSession(user: PlatformUser, command: String, environ: StringIterator, term: String, rows: Int, cols: Int): ShellSession =
        throw UnsupportedOperationException("no shell")
    override fun lookupUser(username: String): PlatformUser = throw UnsupportedOperationException("no users")
    override fun lookupSFTPServer(): String = throw UnsupportedOperationException("no sftp")
    override fun readSystemSSHHostKey(): String = throw UnsupportedOperationException("no ssh")
    override fun tailscaleHostname() = ""
    override fun usePlatformBridge() = false
    override fun createBridge(options: BridgeOptions): BridgeSession = throw UnsupportedOperationException("no bridge")

    // ── libbox CommandServerHandler ────────────────────────────────────────────

    override fun serviceStop() { closeEngine() }
    override fun serviceReload() {}
    override fun getSystemProxyStatus(): SystemProxyStatus = SystemProxyStatus()
    override fun setSystemProxyEnabled(enabled: Boolean) {}
    override fun triggerNativeCrash() {}
    override fun writeDebugMessage(message: String) { android.util.Log.d("libbox", message) }
    override fun connectSSHAgent(): Int = throw UnsupportedOperationException("no ssh agent")

    companion object {
        const val ACTION_STOP = "ir.nahalkmi.nahalvpn.STOP"
        private const val CHANNEL = "vpn"
        private const val NOTIFICATION_ID = 1
        private const val NOTICE_CHANNEL = "notice"
        private const val NOTICE_ID = 2
        // Go net.Flags bits (libbox reads NetworkInterface.flags as net.Flags).
        private const val GO_FLAG_UP = 1
        private const val GO_FLAG_MULTICAST = 16
        private const val GO_FLAG_RUNNING = 32
        val running = MutableStateFlow<NahalVpnService?>(null)
        /** Incremented whenever Android revokes the VPN (another VPN app, or the user in settings). */
        val revoked = MutableStateFlow(0)
        val instance: StateFlow<NahalVpnService?> get() = running
    }
}

private fun RoutePrefixIterator.toList(): List<Pair<String, Int>> {
    val out = mutableListOf<Pair<String, Int>>()
    while (hasNext()) next().let { out += it.address() to it.prefix() }
    return out
}

private fun StringIterator.toStrings(): List<String> {
    val out = mutableListOf<String>()
    while (hasNext()) out += next()
    return out
}

private class StringArrayIterator(values: List<String>) : StringIterator {
    private val it = values.iterator()
    override fun hasNext() = it.hasNext()
    override fun next(): String = it.next()
    override fun len(): Int = 0
}
