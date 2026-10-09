package ir.nahalkmi.nahalvpn.api

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The wire contract with nahalvpn-api (payloads copied from its responses). */
class ApiClientTest {
    private val server = MockWebServer()
    private lateinit var api: ApiClient

    @Before fun start() {
        server.start()
        api = ApiClient(server.url("").toString().trimEnd('/'), OkHttpClient())
    }

    @After fun stop() = server.shutdown()

    private fun respond(code: Int, body: String) =
        server.enqueue(MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body))

    @Test fun `locations are parsed with localized names and availability`() = runTest {
        respond(200, """{"locations":[{"id":"de","country":"DE","name":{"en":"Germany","fa":"آلمان"},"protocols":["vless","openvpn"],"available":true}]}""")
        val l = api.locations("t").single()
        assertEquals("آلمان", l.name.fa)
        assertTrue(l.available)
        assertEquals("Bearer t", server.takeRequest().getHeader("Authorization"))
    }

    @Test fun `connect returns a VLESS config`() = runTest {
        respond(200, """{"protocol":"vless","location":"de","host":"api.nahalkmi.ir","port":443,"uuid":"0f0e","security":"tls",
            "sni":"api.nahalkmi.ir","fingerprint":"chrome","network":"ws","path":"/nv/de","uri":"vless://x"}""")
        val c = api.connect("t", "de", "vless") as VlessConfig
        assertEquals("/nv/de", c.path)
        assertEquals("""{"location":"de","protocol":"vless"}""", server.takeRequest().body.readUtf8())
    }

    @Test fun `connect returns an OpenVPN config`() = runTest {
        respond(200, """{"protocol":"openvpn","location":"de","username":"u@de","password":"p","profile":"client\n",
            "server":{"host":"api.nahalkmi.ir","port":2083,"serverName":"gw.nahalvpn","ca":"CA","tlsCrypt":"KEY"}}""")
        val c = api.connect("t", "de", "openvpn") as OpenVpnConfig
        assertEquals("u@de", c.username)
        assertEquals(2083, c.server.port)
        assertEquals("gw.nahalvpn", c.server.serverName)
    }

    @Test fun `change password posts both passwords and maps a wrong current one`() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        api.changePassword("t", "1234", "5678")
        val req = server.takeRequest()
        assertEquals("/v1/me/password", req.path)
        assertEquals("""{"currentPassword":"1234","newPassword":"5678"}""", req.body.readUtf8())
        respond(401, """{"error":"invalid_credentials"}""")
        try { api.changePassword("t", "bad", "5678"); fail("should throw") } catch (e: ApiError.InvalidCredentials) { /* expected */ }
    }

    @Test fun `notice is read without a token, active or not`() = runTest {
        respond(200, """{"active":true,"message":"ارتباط قطع شده است","updatedAt":5}""")
        val n = api.notice()
        assertTrue(n.active)
        assertEquals("ارتباط قطع شده است", n.message)
        assertEquals(null, server.takeRequest().getHeader("Authorization"))
        respond(200, """{"active":false,"updatedAt":0}""")
        assertEquals(false, api.notice().active)
    }

    @Test fun `backend error codes map to typed errors`() = runTest {
        respond(403, """{"error":"subscription_expired"}""")
        respond(503, """{"error":"location_unavailable"}""")
        respond(500, "<html>oops</html>")
        try { api.connect("t", "de", "vless"); fail() } catch (_: ApiError.SubscriptionExpired) {}
        try { api.connect("t", "de", "vless"); fail() } catch (_: ApiError.LocationUnavailable) {}
        try { api.connect("t", "de", "vless"); fail() } catch (e: ApiError.Other) { assertEquals(500, e.status) }
    }

    @Test fun `no server is a network error, not a crash`() = runTest {
        server.shutdown()
        try { api.locations("t"); fail() } catch (_: ApiError.Network) {}
    }

    @Test fun `login can sign out one of the user's devices to free a slot`() = runTest {
        respond(200, """{"accessToken":"a","refreshToken":"r","accessExpiresAt":1,"deviceId":"d"}""")
        api.login("u", "p", "key-12345678", "Pixel", replaceDeviceId = "old-device")
        assertTrue(server.takeRequest().body.readUtf8().contains("\"replaceDeviceId\":\"old-device\""))
    }

    @Test fun `logout sends an empty JSON body`() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        api.logout("t")
        assertEquals("{}", server.takeRequest().body.readUtf8())
    }
}
