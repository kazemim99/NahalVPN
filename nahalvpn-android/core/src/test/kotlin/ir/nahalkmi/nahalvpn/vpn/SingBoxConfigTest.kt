package ir.nahalkmi.nahalvpn.vpn

import ir.nahalkmi.nahalvpn.api.OpenVpnConfig
import ir.nahalkmi.nahalvpn.api.OpenVpnServer
import ir.nahalkmi.nahalvpn.api.VlessConfig
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SingBoxConfigTest {
    private val NL = System.lineSeparator().let { "\u000A" }
    private val vless = VlessConfig(
        location = "de", host = "api.nahalkmi.ir", port = 443, uuid = "11111111-2222-3333-4444-555555555555",
        sni = "api.nahalkmi.ir", path = "/nv/de",
    )
    private val cfg = SingBoxConfig.parse(SingBoxConfig.build(vless, "203.0.113.10", ProbeProxy(17890, "probe", "s3cret")))

    private fun JsonObject.str(key: String) = this[key]!!.jsonPrimitive.content

    @Test fun `VLESS outbound uses the gateway, TLS with a Chrome fingerprint, and the location's WS path`() {
        val out = cfg["outbounds"]!!.jsonArray.first { it.jsonObject.str("tag") == "proxy" }.jsonObject
        assertEquals("the app-resolved gateway IP", "203.0.113.10", out.str("server"))
        assertEquals("api.nahalkmi.ir", out["tls"]!!.jsonObject.str("server_name"))
        assertEquals("11111111-2222-3333-4444-555555555555", out.str("uuid"))
        assertEquals("chrome", out["tls"]!!.jsonObject["utls"]!!.jsonObject.str("fingerprint"))
        assertEquals("/nv/de", out["transport"]!!.jsonObject.str("path"))
        assertEquals("api.nahalkmi.ir", out["transport"]!!.jsonObject["headers"]!!.jsonObject.str("Host"))
    }

    @Test fun `all device traffic goes through the TUN and DNS is hijacked into the tunnel`() {
        val tun = cfg["inbounds"]!!.jsonArray.first { it.jsonObject.str("type") == "tun" }.jsonObject
        assertEquals("true", tun.str("auto_route"))
        assertEquals("proxy", cfg["route"]!!.jsonObject.str("final"))
        assertTrue(cfg["route"]!!.jsonObject["rules"]!!.toString().contains("hijack-dns"))
        assertEquals("remote", cfg["dns"]!!.jsonObject.str("final"))
    }

    @Test fun `the probe proxy is local-only and password protected`() {
        val probe = cfg["inbounds"]!!.jsonArray.first { it.jsonObject.str("tag") == "probe-in" }.jsonObject
        assertEquals("127.0.0.1", probe.str("listen"))
        assertEquals("s3cret", probe["users"]!!.jsonArray.single().jsonObject.str("password"))
    }

    private val ovpn = OpenVpnConfig(
        location = "de", username = "nv-user1@de", password = "pw-secret", profile = "",
        server = OpenVpnServer("api.nahalkmi.ir", 2083, "gw.nahalvpn",
            ca = "-----BEGIN CERTIFICATE-----" + NL + "QUJD" + NL + "-----END CERTIFICATE-----" + NL,
            tlsCrypt = listOf("-----BEGIN OpenVPN Static key V1-----", "0011", "2233", "-----END OpenVPN Static key V1-----").joinToString(NL) + NL),
    )

    private fun endpoint(udp: Boolean) =
        SingBoxConfig.parse(SingBoxConfig.buildOpenVpn(ovpn, udp, "203.0.113.10", ProbeProxy(17890, "probe", "s3cret")))["endpoints"]!!.jsonArray.single().jsonObject

    @Test fun `OpenVPN endpoint has the gateway IP on 2083, tls-crypt, the CA, credentials and the chosen transport`() {
        val udp = endpoint(true)
        assertEquals("openvpn-client", udp.str("type"))
        assertEquals("proxy", udp.str("tag")) // same tag as the VLESS outbound: DNS and routing are shared
        assertEquals("203.0.113.10", udp.str("server"))
        assertEquals("2083", udp.str("server_port"))
        assertEquals("udp", udp.str("network"))
        assertEquals("tcp", endpoint(false).str("network"))
        assertEquals("nv-user1@de", udp.str("username"))
        assertEquals("packets clamped below the path MTU", "1360", udp.str("mss_fix"))
        assertEquals("pw-secret", udp.str("password"))
        val tls = udp["tls"]!!.jsonObject
        assertEquals("gw.nahalvpn", tls.str("server_name"))
        assertEquals("tls_crypt", tls["control_wrap"]!!.jsonObject.str("type"))
        assertEquals(listOf("-----BEGIN OpenVPN Static key V1-----", "0011", "2233", "-----END OpenVPN Static key V1-----"),
            tls["control_wrap"]!!.jsonObject["key"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("-----BEGIN CERTIFICATE-----", "QUJD", "-----END CERTIFICATE-----"),
            tls["certificate"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun `OpenVPN config routes everything into the endpoint and exposes the same local probe`() {
        val cfg = SingBoxConfig.parse(SingBoxConfig.buildOpenVpn(ovpn, true, "203.0.113.10", ProbeProxy(17890, "probe", "s3cret")))
        assertEquals("proxy", cfg["route"]!!.jsonObject.str("final"))
        assertTrue(cfg["inbounds"]!!.toString().contains("probe-in"))
        assertFalse("the VLESS outbound is not present", cfg["outbounds"]!!.toString().contains("vless"))
    }

    @Test fun `Windows system-proxy mode - no TUN, one loopback mixed port without credentials, same outbound`() {
        val c = SingBoxConfig.parse(SingBoxConfig.build(vless, "203.0.113.10", ProbeProxy(17890, "", ""), mode = CaptureMode.SYSTEM_PROXY))
        val inbounds = c["inbounds"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("mixed"), inbounds.map { it.str("type") })
        assertEquals("127.0.0.1", inbounds.single().str("listen"))
        assertEquals("17890", inbounds.single().str("listen_port"))
        assertFalse("the OS proxy cannot authenticate", inbounds.single().containsKey("users"))
        assertFalse(c["route"]!!.jsonObject.containsKey("auto_detect_interface"))
        assertEquals("203.0.113.10", c["outbounds"]!!.jsonArray.first { it.jsonObject.str("tag") == "proxy" }.jsonObject.str("server"))
        val ov = SingBoxConfig.parse(SingBoxConfig.buildOpenVpn(ovpn, false, "203.0.113.10", ProbeProxy(17890, "", ""), mode = CaptureMode.SYSTEM_PROXY))
        assertEquals("tcp", ov["endpoints"]!!.jsonArray.single().jsonObject.str("network"))
        assertFalse(ov.toString().contains("\"tun\""))
    }

    @Test fun `no foreign server address ever appears`() {
        val text = cfg.toString()
        assertFalse(text.contains("155.117"))
        // Only the Iran gateway, the local probe proxy, the tunnel's own address and the in-tunnel DNS server.
        assertFalse(Regex("""\b(?!127\.0\.0\.1|1\.1\.1\.1|172\.19\.0\.1|194\.1\.155\.230)\d{1,3}(\.\d{1,3}){3}\b""").containsMatchIn(text))
    }
}
