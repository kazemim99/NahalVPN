package ir.nahalkmi.nahalvpn.vpn

import ir.nahalkmi.nahalvpn.api.OpenVpnConfig
import ir.nahalkmi.nahalvpn.api.VlessConfig
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * Local, authenticated proxy on 127.0.0.1 that only this app uses: it lets the app (which is excluded from its own
 * VPN so API calls always work) probe the tunnel and read the exit IP.
 */
data class ProbeProxy(val port: Int, val username: String, val password: String)

/**
 * How traffic reaches the engine. [TUN]: Android's VpnService captures the whole device. [SYSTEM_PROXY]: Windows v1 -
 * the OS proxy setting points at a local, unauthenticated mixed (HTTP + SOCKS) port; no admin rights, no driver.
 */
enum class CaptureMode { TUN, SYSTEM_PROXY }

/** Builds the sing-box (v1.14) configuration for one connection from a backend `/connect` answer. */
object SingBoxConfig {
    const val TUN_ADDRESS = "172.19.0.1/30"
    const val MTU = 1500
    const val OPENVPN_MSS_FIX = 1360

    /**
     * [gatewayIp] is resolved by the app before the tunnel exists (Android's resolver; sing-box's own resolver has no
     * system DNS on Android). The hostname stays the TLS SNI and WebSocket Host.
     */
    fun build(
        c: VlessConfig, gatewayIp: String, probe: ProbeProxy, logLevel: String = "warn", logFile: String? = null,
        mode: CaptureMode = CaptureMode.TUN,
    ): String = assemble(probe, logLevel, logFile, mode, outbounds = { vlessOutbound(c, gatewayIp) }, endpoints = null)

    /**
     * OpenVPN through sing-box's built-in client (userspace; sing-box owns the one TUN and the kill switch).
     * [udp] picks the transport for this attempt; UDP and TCP are separate attempts so the fallback logic stays in
     * [ConnectionManager] (8-second probe each).
     */
    fun buildOpenVpn(
        c: OpenVpnConfig, udp: Boolean, gatewayIp: String, probe: ProbeProxy, logLevel: String = "warn", logFile: String? = null,
        mode: CaptureMode = CaptureMode.TUN,
    ): String = assemble(probe, logLevel, logFile, mode, outbounds = null, endpoints = { openVpnEndpoint(c, udp, gatewayIp) })

    private fun pemLines(pem: String): List<String> = pem.trim().lines().map { it.trim() }.filter { it.isNotEmpty() }

    private fun kotlinx.serialization.json.JsonArrayBuilder.openVpnEndpoint(c: OpenVpnConfig, udp: Boolean, gatewayIp: String) {
        addJsonObject {
            put("type", "openvpn-client"); put("tag", "proxy")
            put("server", gatewayIp); put("server_port", c.server.port); put("network", if (udp) "udp" else "tcp")
            put("username", c.username); put("password", c.password); put("auth_retry", "none")
            putJsonObject("tls") {
                put("server_name", c.server.serverName); put("server_name_type", "name")
                putJsonArray("certificate") { pemLines(c.server.ca).forEach { add(it) } }
                putJsonObject("control_wrap") {
                    put("type", "tls_crypt")
                    putJsonArray("key") { pemLines(c.server.tlsCrypt).forEach { add(it) } }
                }
            }
            putJsonArray("data_ciphers") { add("AES-128-GCM"); add("AES-256-GCM"); add("CHACHA20-POLY1305") }
            put("redirect_gateway", true)
            // Keep tunnelled packets small: mobile networks, PPPoE and a VPN-in-VPN all lower the path MTU, and full-size
            // UDP datagrams then vanish (small requests work, uploads stall). Same idea as OpenVPN's --mssfix.
            put("mss_fix", OPENVPN_MSS_FIX)
        }
    }

    private fun kotlinx.serialization.json.JsonArrayBuilder.vlessOutbound(c: VlessConfig, gatewayIp: String) {
        addJsonObject {
                put("type", "vless"); put("tag", "proxy")
                put("server", gatewayIp); put("server_port", c.port); put("uuid", c.uuid)
                put("packet_encoding", "xudp")
                putJsonObject("tls") {
                    put("enabled", c.security == "tls"); put("server_name", c.sni)
                    putJsonObject("utls") { put("enabled", true); put("fingerprint", c.fingerprint) }
                }
                putJsonObject("transport") {
                    put("type", c.network); put("path", c.path)
                    putJsonObject("headers") { put("Host", c.sni) }
                }
        }
    }

    private fun assemble(
        probe: ProbeProxy, logLevel: String, logFile: String?, mode: CaptureMode,
        outbounds: (kotlinx.serialization.json.JsonArrayBuilder.() -> Unit)?,
        endpoints: (kotlinx.serialization.json.JsonArrayBuilder.() -> Unit)?,
    ): String = buildJsonObject {
        putJsonObject("log") {
            put("level", logLevel); put("timestamp", true)
            if (logFile != null) put("output", logFile)
        }
        putJsonObject("dns") {
            putJsonArray("servers") {
                // Apps' DNS goes through the tunnel (DNS over TCP to 1.1.1.1, exits abroad, not filtered locally).
                addJsonObject { put("type", "tcp"); put("tag", "remote"); put("server", "1.1.1.1"); put("detour", "proxy") }
            }
            put("final", "remote")
            put("strategy", "ipv4_only")
        }
        putJsonArray("inbounds") {
            if (mode == CaptureMode.TUN) {
                addJsonObject {
                    put("type", "tun"); put("tag", "tun-in")
                    putJsonArray("address") { add(TUN_ADDRESS) }
                    put("mtu", MTU); put("auto_route", true); put("strict_route", true); put("stack", "gvisor")
                }
                addJsonObject {
                    put("type", "mixed"); put("tag", "probe-in"); put("listen", "127.0.0.1"); put("listen_port", probe.port)
                    putJsonArray("users") { addJsonObject { put("username", probe.username); put("password", probe.password) } }
                }
            } else {
                // The OS proxy cannot send credentials, so this port has none; it listens on loopback only.
                addJsonObject {
                    put("type", "mixed"); put("tag", "proxy-in"); put("listen", "127.0.0.1"); put("listen_port", probe.port)
                }
            }
        }
        putJsonArray("outbounds") {
            outbounds?.invoke(this)
            addJsonObject { put("type", "direct"); put("tag", "direct") }
        }
        if (endpoints != null) putJsonArray("endpoints") { endpoints(this) }
        putJsonObject("route") {
            putJsonArray("rules") {
                addJsonObject { put("action", "sniff") }
                addJsonObject { put("protocol", "dns"); put("action", "hijack-dns") }
            }
            put("final", "proxy")
            if (mode == CaptureMode.TUN) put("auto_detect_interface", true)
        }
    }.toString()

    /** For tests and diagnostics. */
    fun parse(json: String): JsonObject = kotlinx.serialization.json.Json.parseToJsonElement(json) as JsonObject
}
