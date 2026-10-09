package ir.nahalkmi.nahalvpn.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/** Wire models of nahalvpn-api (`/v1/...`). Unknown fields are ignored so the backend can grow. */

@Serializable
data class TokenPair(
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAt: Long = 0,
    val deviceId: String,
)

/** The owner's outage notice (vpn-client-app "Service notice"); [message] is only sent while it is active. */
@Serializable
data class Notice(val active: Boolean, val message: String? = null, val updatedAt: Long = 0)

@Serializable
data class Device(val id: String, val name: String, val createdAt: Long = 0, val lastSeenAt: Long = 0)

@Serializable
data class Me(
    val username: String,
    val expiresAt: Long,
    val deviceLimit: Int = 1,
    val currentDeviceId: String,
    val devices: List<Device> = emptyList(),
)

@Serializable
data class LocalizedName(val en: String, val fa: String)

@Serializable
data class Location(
    val id: String,
    val country: String,
    val name: LocalizedName,
    val protocols: List<String>,
    val available: Boolean,
)

@Serializable
data class LocationList(val locations: List<Location>)

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("protocol")
sealed interface ConnectionConfig {
    val location: String
}

@Serializable
@SerialName("vless")
data class VlessConfig(
    override val location: String,
    val host: String,
    val port: Int,
    val uuid: String,
    val security: String = "tls",
    val sni: String,
    val fingerprint: String = "chrome",
    val network: String = "ws",
    val path: String,
    val uri: String = "",
) : ConnectionConfig

/** Where and how to reach the gateway's OpenVPN service (structured, so the app needs no .ovpn parsing). */
@Serializable
data class OpenVpnServer(val host: String, val port: Int, val serverName: String, val ca: String, val tlsCrypt: String)

@Serializable
@SerialName("openvpn")
data class OpenVpnConfig(
    override val location: String,
    val username: String,
    val password: String,
    val profile: String = "",
    val server: OpenVpnServer,
) : ConnectionConfig

/** `/v1/app/version`: the newest published build (task 5.7). */
@Serializable
data class AppRelease(
    val versionCode: Int,
    val versionName: String,
    val apkUrl: String,
    val sha256: String,
    val notes: Map<String, String> = emptyMap(),
)

@Serializable
internal data class ErrorBody(val error: String = "unknown", val devices: List<Device> = emptyList())
