package ir.nahalkmi.nahalvpn.vpn

import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.api.ConnectionConfig
import ir.nahalkmi.nahalvpn.api.OpenVpnConfig
import ir.nahalkmi.nahalvpn.api.OpenVpnServer
import ir.nahalkmi.nahalvpn.api.VlessConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Records what the VpnService side was asked to do; tests decide which transports "pass" the probe. */
class FakeHost : TunnelHost {
    val log = mutableListOf<String>()
    var running: Transport? = null
    var blocking = false
    var failStart: Set<Transport> = emptySet()
    override val drops = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    override suspend fun start(plan: TunnelPlan) {
        log += "start ${plan.transport}:${plan.config.location}"
        if (plan.transport in failStart) throw IllegalStateException("engine")
        running = plan.transport; blocking = false
    }
    override suspend fun stop() { log += "stop"; running = null; blocking = false }
    override suspend fun holdBlocking() { log += "block"; running = null; blocking = true }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectionManagerTest {
    private val host = FakeHost()
    private var passing: Set<Transport> = setOf(Transport.VLESS)
    private var killSwitch = false
    private val fetched = mutableListOf<String>()
    private var fetchError: ApiError? = null

    private fun TestScope.manager(supported: Set<Transport> = Transport.entries.toSet()) = ConnectionManager(
        fetchConfig = { loc, proto ->
            fetched += "$loc/$proto"
            fetchError?.let { throw it }
            if (proto == "vless") VlessConfig(loc, "api.nahalkmi.ir", 443, "uuid-$loc", sni = "api.nahalkmi.ir", path = "/nv/$loc")
            else OpenVpnConfig(loc, "u@$loc", "pw", "client", OpenVpnServer("api.nahalkmi.ir", 2083, "gw.nahalvpn", "CA", "KEY")) as ConnectionConfig
        },
        host = host,
        prober = { if (host.running in passing) "198.51.100.22" else null },
        supported = supported,
        killSwitch = { killSwitch },
        // A regular (foreground) scope on the test scheduler: advanceUntilIdle() does not run backgroundScope work.
        scope = CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob()),
        retryDelaysMs = listOf(10, 10, 10),
    )

    @Test fun `Connect - one tap fetches the config, starts VLESS and shows the exit IP`() = runTest {
        val m = manager()
        m.connect("de", listOf("vless", "openvpn"))
        advanceUntilIdle()
        assertEquals(VpnState.Connected("de", Transport.VLESS, "198.51.100.22"), m.state.value)
        assertEquals(listOf("de/vless"), fetched)
    }

    @Test fun `VLESS blocked on the network - falls back to OpenVPN UDP, then TCP`() = runTest {
        passing = setOf(Transport.OPENVPN_TCP)
        val m = manager()
        m.connect("de", listOf("vless", "openvpn"))
        advanceUntilIdle()
        assertEquals(VpnState.Connected("de", Transport.OPENVPN_TCP, "198.51.100.22"), m.state.value)
        assertEquals(listOf("start VLESS:de", "stop", "start OPENVPN_UDP:de", "stop", "start OPENVPN_TCP:de"), host.log)
        assertEquals("one OpenVPN credential serves UDP and TCP", listOf("de/vless", "de/openvpn"), fetched)
    }

    @Test fun `All protocols fail - clear error and no half-open VPN`() = runTest {
        passing = emptySet()
        host.failStart = setOf(Transport.OPENVPN_UDP)
        val m = manager()
        m.connect("de", listOf("vless", "openvpn"))
        advanceUntilIdle()
        assertEquals(VpnState.Failed(FailReason.ALL_PROTOCOLS_FAILED, "de"), m.state.value)
        assertEquals(null, host.running)
        assertEquals(false, host.blocking)
        assertEquals("stop", host.log.last())
    }

    @Test fun `only transports this build supports and the location offers are tried`() = runTest {
        passing = emptySet()
        val m = manager(supported = setOf(Transport.VLESS))
        m.connect("de", listOf("vless", "openvpn"))
        advanceUntilIdle()
        assertEquals(listOf("start VLESS:de", "stop", "stop"), host.log)
    }

    @Test fun `Switch location - disconnects and reconnects through the new location`() = runTest {
        val m = manager()
        m.connect("de", listOf("vless"))
        advanceUntilIdle()
        m.connect("nl", listOf("vless"))
        advanceUntilIdle()
        assertEquals(VpnState.Connected("nl", Transport.VLESS, "198.51.100.22"), m.state.value)
        assertTrue(host.log.indexOf("start VLESS:nl") > host.log.indexOf("start VLESS:de"))
    }

    @Test fun `account problems stop immediately with the reason`() = runTest {
        fetchError = ApiError.SubscriptionExpired()
        val m = manager()
        m.connect("de", listOf("vless", "openvpn"))
        advanceUntilIdle()
        assertEquals(VpnState.Failed(FailReason.SUBSCRIPTION_EXPIRED, "de"), m.state.value)
        assertEquals("no fallback for account problems", listOf("de/vless"), fetched)
    }

    @Test fun `Connection drops with the kill switch on - traffic is blocked until the app reconnects`() = runTest {
        killSwitch = true
        val m = manager()
        m.connect("de", listOf("vless"))
        advanceUntilIdle()
        passing = emptySet() // the network is gone for a while
        host.drops.tryEmit(Unit)
        // With the kill switch the retry loop never gives up, so step virtual time instead of running until idle.
        advanceTimeBy(35); runCurrent()
        val s = m.state.value
        assertTrue("still trying while blocking: $s", s is VpnState.Reconnecting && s.blocking && s.attempt >= 3)
        assertTrue("traffic held by a blocking TUN", host.blocking)
        assertTrue("never torn down to an open network", "stop" !in host.log.drop(1))
        passing = setOf(Transport.VLESS) // network back
        advanceTimeBy(20); runCurrent()
        assertEquals(VpnState.Connected("de", Transport.VLESS, "198.51.100.22"), m.state.value)
    }

    @Test fun `Connection drops with the kill switch off - tunnel is torn down, then retried a few times`() = runTest {
        val m = manager()
        m.connect("de", listOf("vless"))
        advanceUntilIdle()
        passing = emptySet()
        host.drops.tryEmit(Unit)
        advanceUntilIdle()
        assertEquals(VpnState.Failed(FailReason.ALL_PROTOCOLS_FAILED, "de"), m.state.value)
        assertEquals(false, host.blocking)
        assertEquals(null, host.running)
    }

    @Test fun `a dropped connection comes back by itself`() = runTest {
        val m = manager()
        m.connect("de", listOf("vless"))
        advanceUntilIdle()
        host.drops.tryEmit(Unit)
        advanceUntilIdle()
        assertEquals(VpnState.Connected("de", Transport.VLESS, "198.51.100.22"), m.state.value)
    }

    @Test fun `Session revoked - the VPN is torn down`() = runTest {
        val m = manager()
        m.connect("de", listOf("vless"))
        advanceUntilIdle()
        m.signedOut()
        advanceUntilIdle()
        assertEquals(VpnState.Failed(FailReason.SIGNED_OUT, null), m.state.value)
        assertEquals(null, host.running)
    }

    @Test fun `Chosen protocol - only that protocol is tried`() = runTest {
        passing = Transport.entries.toSet()
        val m = manager()
        m.connect("de", listOf("vless", "openvpn"), only = Transport.OPENVPN_TCP)
        advanceUntilIdle()
        assertEquals(VpnState.Connected("de", Transport.OPENVPN_TCP, "198.51.100.22"), m.state.value)
        assertEquals(listOf("start OPENVPN_TCP:de"), host.log)
    }

    @Test fun `Chosen protocol fails - clear error naming it, no silent fallback, nothing left running`() = runTest {
        passing = setOf(Transport.OPENVPN_UDP) // another protocol would work, but the user picked VLESS
        val m = manager()
        m.connect("de", listOf("vless", "openvpn"), only = Transport.VLESS)
        advanceUntilIdle()
        assertEquals(VpnState.Failed(FailReason.PROTOCOL_FAILED, "de", Transport.VLESS), m.state.value)
        assertEquals(listOf("start VLESS:de", "stop", "stop"), host.log)
        assertEquals(null, host.running)
    }

    @Test fun `Chosen protocol is kept when reconnecting after a drop`() = runTest {
        passing = Transport.entries.toSet()
        val m = manager()
        m.connect("de", listOf("vless", "openvpn"), only = Transport.OPENVPN_UDP)
        advanceUntilIdle()
        host.drops.tryEmit(Unit)
        advanceUntilIdle()
        assertEquals(VpnState.Connected("de", Transport.OPENVPN_UDP, "198.51.100.22"), m.state.value)
        assertTrue("never switched to VLESS", host.log.none { it.startsWith("start VLESS") })
    }

    @Test fun `disconnect returns to idle`() = runTest {
        val m = manager()
        m.connect("de", listOf("vless"))
        advanceUntilIdle()
        m.disconnect()
        advanceUntilIdle()
        assertEquals(VpnState.Idle, m.state.value)
        assertEquals(null, host.running)
    }
}
