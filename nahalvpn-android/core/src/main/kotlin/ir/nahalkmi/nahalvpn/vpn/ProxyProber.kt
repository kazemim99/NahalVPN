package ir.nahalkmi.nahalvpn.vpn

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.internal.closeQuietly
import okio.BufferedSink
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit

/**
 * Probes the running tunnel through the engine's local, password-protected proxy (the app itself is outside the VPN)
 * and returns the exit IP as seen on the internet.
 */
class ProxyProber(private val base: OkHttpClient) : Prober {
    @Volatile private var proxy: ProbeProxy? = null

    fun use(p: ProbeProxy) { proxy = p }

    /** An HTTP client whose traffic goes through the tunnel, or null if no tunnel has been started. */
    fun client(callTimeoutMs: Long): OkHttpClient? {
        val p = proxy ?: return null
        return base.newBuilder()
            .proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", p.port)))
            .proxyAuthenticator { _, response ->
                if (response.request.header("Proxy-Authorization") != null) null
                else response.request.newBuilder().header("Proxy-Authorization", Credentials.basic(p.username, p.password)).build()
            }
            .callTimeout(callTimeoutMs, TimeUnit.MILLISECONDS)
            .build()
    }

    override suspend fun probe(timeoutMs: Long): String? {
        val client = client(timeoutMs.coerceAtMost(8_000)) ?: return null
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val ip = withContext(Dispatchers.IO) {
                runCatching {
                    client.newCall(Request.Builder().url(IP_ECHO).build()).execute().use { r ->
                        r.body?.string()?.trim()?.takeIf { r.isSuccessful && IPV4.matches(it) }
                    }
                }.getOrNull()
            }
            if (ip != null) return ip
            delay(500) // the engine may still be coming up
        }
        return null
    }

    private companion object {
        const val IP_ECHO = "https://api.ipify.org"
        val IPV4 = Regex("""\d{1,3}(\.\d{1,3}){3}""")
    }
}

/** [MeterIo] over the tunnel: ping against a tiny 204 endpoint, speed against Cloudflare's public speed endpoints. */
class ProxyMeterIo(private val prober: ProxyProber) : MeterIo {
    private val client by lazy { prober.client(20_000) }

    override suspend fun smallRequest(): Boolean = withContext(Dispatchers.IO) {
        val c = client ?: return@withContext false
        runCatching { c.newCall(Request.Builder().url(PING_URL).head().build()).execute().use { it.code in 200..399 } }.getOrDefault(false)
    }

    /**
     * Cloudflare first; if it refuses (all users share one exit IP, so rate limits are possible) or fails, OVH's
     * public test file - same network as the exit servers. Reads at most [bytes] either way.
     */
    override suspend fun download(bytes: Long): Long = withContext(Dispatchers.IO) {
        val c = client ?: return@withContext 0L
        for (url in listOf("$SPEED_URL/__down?bytes=$bytes", FALLBACK_DOWNLOAD)) {
            val got = runCatching {
                c.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    if (!r.isSuccessful) return@use 0L
                    val src = r.body!!.source()
                    val buf = ByteArray(64 * 1024)
                    var total = 0L
                    while (total < bytes) {
                        val n = src.read(buf, 0, minOf(buf.size.toLong(), bytes - total).toInt())
                        if (n < 0) break
                        total += n
                    }
                    total
                }
            }.getOrDefault(0L)
            if (got > 0) return@withContext got
        }
        0L
    }

    override suspend fun upload(bytes: Long): Long = withContext(Dispatchers.IO) {
        val c = client ?: return@withContext 0L
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = bytes
            override fun writeTo(sink: BufferedSink) {
                val chunk = ByteArray(64 * 1024)
                var left = bytes
                while (left > 0) {
                    val n = minOf(left, chunk.size.toLong()).toInt()
                    sink.write(chunk, 0, n)
                    left -= n
                }
            }
        }
        runCatching {
            c.newCall(Request.Builder().url("$SPEED_URL/__up").post(body).build()).execute().use { r ->
                r.body?.closeQuietly()
                if (r.isSuccessful) bytes else 0L
            }
        }.getOrDefault(0L)
    }

    private companion object {
        const val PING_URL = "https://www.gstatic.com/generate_204"
        const val SPEED_URL = "https://speed.cloudflare.com"
        const val FALLBACK_DOWNLOAD = "https://proof.ovh.net/files/10Mb.dat"
    }
}

/** Time to open a TCP connection to the gateway: what "Ping" measures while the VPN is off. */
object GatewayPing {
    suspend fun ms(host: String, port: Int = 443, samples: Int = 3): Int? = withContext(Dispatchers.IO) {
        val times = mutableListOf<Long>()
        repeat(samples) {
            val t0 = System.nanoTime()
            val ok = runCatching { java.net.Socket().use { it.connect(InetSocketAddress(host, port), 3_000) } }.isSuccess
            if (ok) times += (System.nanoTime() - t0) / 1_000_000
        }
        TunnelMeter.median(times)?.toInt()
    }
}
