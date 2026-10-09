package ir.nahalkmi.nahalvpn.desktop

import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.ui.transportLabel
import ir.nahalkmi.nahalvpn.vpn.Metric
import ir.nahalkmi.nahalvpn.vpn.Transport
import ir.nahalkmi.nahalvpn.vpn.VpnState
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.system.exitProcess

/**
 * Developer end-to-end check of the Windows app logic without the window (`gradlew :desktop:e2eCheck`):
 * sign in, connect with each protocol choice, ping + speed test, disconnect, and verify the Windows proxy setting
 * is pointed at the engine while connected and restored afterwards.
 */
fun main(args: Array<String>): Unit = runBlocking {
    val (user, pass) = args
    val app = DesktopApp()
    val proxy = WindowsProxy(app.settings)
    val before = proxy.current()
    println("windows proxy before: ${before ?: "off"}")

    app.signIn(user, pass)
    withTimeoutOrNull(30_000) { while (app.login.value.busy || (!app.signedIn.value && app.login.value.error == null)) delay(100) }
    (app.login.value.error as? ApiError.DeviceLimit)?.let { e ->
        println("device limit -> replacing ${e.devices.first().name}")
        app.signIn(user, pass, e.devices.first().id)
        withTimeoutOrNull(30_000) { while (!app.signedIn.value) delay(100) }
    }
    check(app.signedIn.value) { "sign-in failed: ${app.login.value.error}" }
    withTimeoutOrNull(20_000) { while (app.locations.value.isEmpty() || app.me.value == null) delay(100) }
    println("signed in; locations=${app.locations.value.map { it.id }} expires=${ir.nahalkmi.nahalvpn.util.Jalali.format(app.me.value!!.expiresAt)} devices=${app.me.value!!.deviceLimit}")

    var ok = true
    for (choice in listOf<Transport?>(null, Transport.OPENVPN_UDP, Transport.OPENVPN_TCP, Transport.VLESS)) {
        val label = choice?.let { transportLabel(it) } ?: "Automatic"
        app.setProtocol(choice)
        val t0 = System.currentTimeMillis()
        app.connect()
        val s = withTimeoutOrNull(90_000) {
            while (app.vpn.value !is VpnState.Connected && app.vpn.value !is VpnState.Failed) delay(200)
            app.vpn.value
        }
        val secs = (System.currentTimeMillis() - t0) / 1000
        if (s !is VpnState.Connected) { println("[$label] FAILED after $secs s: $s"); ok = false; continue }
        val proxyNow = proxy.current()
        print("[$label] connected via ${transportLabel(s.transport)} in $secs s, exit ${s.exitIp}, windows proxy -> $proxyNow")
        if (proxyNow?.startsWith("127.0.0.1:") != true) { ok = false; print("  !! proxy not set") }
        app.ping()
        withTimeoutOrNull(40_000) { while (app.ping.value !is Metric.Done && app.ping.value !is Metric.Failed) delay(200) }
        print(" | ping ${(app.ping.value as? Metric.Done)?.value ?: "failed"} ms")
        run {
            app.speedTest()
            withTimeoutOrNull(60_000) { while (app.speed.value !is Metric.Done && app.speed.value !is Metric.Failed) delay(200) }
            val r = (app.speed.value as? Metric.Done)?.value
            print(" | down ${r?.downloadMbps?.let { "%.1f".format(it) } ?: "-"} up ${r?.uploadMbps?.let { "%.1f".format(it) } ?: "-"} Mbps")
        }
        println()
        app.disconnect()
        withTimeoutOrNull(15_000) { while (app.vpn.value !is VpnState.Idle) delay(100) }
        delay(500)
        val after = proxy.current()
        println("   disconnected; windows proxy -> ${after ?: "off"}${if (after == before) " (restored)" else "  !! NOT RESTORED"}")
        if (after != before) ok = false
    }
    app.setProtocol(null)
    app.close()
    println(if (ok) "E2E OK" else "E2E PROBLEMS")
    exitProcess(if (ok) 0 else 1) as Unit
}
