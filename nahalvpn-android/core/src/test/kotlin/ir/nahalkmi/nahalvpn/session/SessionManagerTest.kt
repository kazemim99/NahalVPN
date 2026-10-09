package ir.nahalkmi.nahalvpn.session

import ir.nahalkmi.nahalvpn.api.ApiClient
import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.api.Me
import ir.nahalkmi.nahalvpn.api.TokenPair
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class MemoryTokenStore(var saved: TokenPair? = null) : TokenStore {
    override fun load() = saved
    override fun save(tokens: TokenPair) { saved = tokens }
    override fun clear() { saved = null }
}

/** vpn-client-app "Login screen": first launch, staying signed in, and "Session revoked". */
class SessionManagerTest {
    private val server = MockWebServer()
    private val refreshes = AtomicInteger()
    private var refreshAllowed = true
    private var validAccess = "access-2"

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/auth/login" -> json(200, """{"accessToken":"access-1","refreshToken":"refresh-1","accessExpiresAt":1,"deviceId":"dev-1"}""")
                    .also { validAccess = "access-1" }
                "/v1/auth/refresh" -> {
                    refreshes.incrementAndGet()
                    if (refreshAllowed) json(200, """{"accessToken":"access-2","refreshToken":"refresh-2","accessExpiresAt":2,"deviceId":"dev-1"}""")
                        .also { validAccess = "access-2" }
                    else json(401, """{"error":"invalid_token"}""")
                }
                "/v1/me" ->
                    if (request.getHeader("Authorization") == "Bearer $validAccess") json(200, ME) else json(401, """{"error":"invalid_token"}""")
                "/v1/auth/logout" -> MockResponse().setResponseCode(204)
                else -> json(404, """{"error":"not_found"}""")
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun manager(store: TokenStore = MemoryTokenStore()) =
        SessionManager(ApiClient(server.url("").toString().trimEnd('/'), OkHttpClient()), store, "device-key-123", "Pixel")

    @Test fun `First launch - login stores the session and it survives a restart`() = runTest {
        val store = MemoryTokenStore()
        manager(store).login("  nv-user1 ", "secret-pass")
        assertEquals("refresh-1", store.saved?.refreshToken)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"username\":\"nv-user1\"") && body.contains("\"deviceId\":\"device-key-123\""))
        val restarted = manager(store)
        assertTrue(restarted.isSignedIn)
    }

    @Test fun `expired access token is refreshed once and the call retried`() = runTest {
        val m = manager(MemoryTokenStore(TokenPair("stale", "refresh-1", 0, "dev-1")))
        val me: Me = m.authorized { token -> apiFor().me(token) }
        assertEquals("nv-user1", me.username)
        assertEquals(1, refreshes.get())
        assertEquals("access-2", m.tokens.value?.accessToken)
    }

    @Test fun `parallel calls share a single refresh`() = runTest {
        val m = manager(MemoryTokenStore(TokenPair("stale", "refresh-1", 0, "dev-1")))
        (1..5).map { async { m.authorized { token -> apiFor().me(token) } } }.awaitAll()
        assertEquals(1, refreshes.get())
    }

    @Test fun `Session revoked - rejected refresh token signs out and clears storage`() = runTest {
        refreshAllowed = false
        val store = MemoryTokenStore(TokenPair("stale", "refresh-1", 0, "dev-1"))
        val m = manager(store)
        val signedOut = async { m.signedOut.first() }
        try {
            m.authorized { token -> apiFor().me(token) }
            fail("expected InvalidToken")
        } catch (_: ApiError.InvalidToken) {
        }
        assertEquals(SignOutReason.REVOKED, signedOut.await())
        assertNull(store.saved)
        assertFalse(m.isSignedIn)
    }

    @Test fun `wrong password surfaces invalid_credentials and stores nothing`() = runTest {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = json(401, """{"error":"invalid_credentials"}""")
        }
        val store = MemoryTokenStore()
        try {
            manager(store).login("nv-user1", "bad")
            fail("expected InvalidCredentials")
        } catch (_: ApiError.InvalidCredentials) {
        }
        assertNull(store.saved)
    }

    @Test fun `device limit returns the active devices so the user can remove one`() = runTest {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                json(409, """{"error":"device_limit_reached","devices":[{"id":"a","name":"Pixel"},{"id":"b","name":"Tablet"}]}""")
        }
        try {
            manager().login("nv-user1", "secret-pass")
            fail("expected DeviceLimit")
        } catch (e: ApiError.DeviceLimit) {
            assertEquals(listOf("Pixel", "Tablet"), e.devices.map { it.name })
        }
    }

    @Test fun `logout signs out even when the network is down`() = runTest {
        val store = MemoryTokenStore(TokenPair("access-1", "refresh-1", 0, "dev-1"))
        val m = manager(store)
        server.shutdown()
        m.logout()
        assertNull(store.saved)
    }

    private fun apiFor() = ApiClient(server.url("").toString().trimEnd('/'), OkHttpClient())

    companion object {
        const val ME = """{"username":"nv-user1","expiresAt":1800000000000,"deviceLimit":1,"currentDeviceId":"dev-1",
            "devices":[{"id":"dev-1","name":"Pixel","createdAt":1,"lastSeenAt":2}],"unknownField":true}"""

        fun json(code: Int, body: String) =
            MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    }
}
