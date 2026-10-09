package ir.nahalkmi.nahalvpn.desktop

import com.sun.jna.platform.win32.Crypt32Util
import ir.nahalkmi.nahalvpn.api.TokenPair
import ir.nahalkmi.nahalvpn.session.TokenStore
import ir.nahalkmi.nahalvpn.vpn.Transport
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

/** %APPDATA%\NahalVPN: per-user app data (settings, the encrypted session). */
object AppDirs {
    val data: File = File(System.getenv("APPDATA") ?: System.getProperty("user.home"), "NahalVPN").apply { mkdirs() }
    val run: File = File(System.getenv("LOCALAPPDATA") ?: data.path, "NahalVPN").apply { mkdirs() }
}

private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

/** The OS proxy values we replaced, so they can be put back (also after a crash). */
@Serializable
data class SavedProxy(val enable: Int, val server: String?, val override: String?, val autoConfigUrl: String?, val ourServer: String)

@Serializable
private data class SettingsData(
    val deviceKey: String = UUID.randomUUID().toString(),
    val killSwitch: Boolean = true,
    val protocol: String? = null,
    val lastLocation: String? = null,
    val language: String = "fa",
    val savedProxy: SavedProxy? = null,
)

/** Small, non-secret preferences in settings.json. */
class DesktopSettings(private val file: File = File(AppDirs.data, "settings.json")) {
    private var d: SettingsData = runCatching { json.decodeFromString<SettingsData>(file.readText()) }.getOrElse { SettingsData() }
        .also { if (!file.exists()) write(it) }

    private fun write(v: SettingsData) {
        d = v
        file.writeText(json.encodeToString(SettingsData.serializer(), v))
    }

    val deviceKey get() = d.deviceKey
    val deviceName: String = "Windows " + (System.getenv("COMPUTERNAME") ?: "PC").take(40)
    var killSwitch: Boolean get() = d.killSwitch; set(v) = write(d.copy(killSwitch = v))
    var protocol: Transport?
        get() = d.protocol?.let { n -> Transport.entries.find { it.name == n } }
        set(v) = write(d.copy(protocol = v?.name))
    var lastLocation: String? get() = d.lastLocation; set(v) = write(d.copy(lastLocation = v))
    var language: String get() = d.language; set(v) = write(d.copy(language = v))
    var savedProxy: SavedProxy? get() = d.savedProxy; set(v) = write(d.copy(savedProxy = v))
}

/** The session, encrypted with Windows DPAPI for the current user (readable only by this Windows account). */
class DpapiTokenStore(private val file: File = File(AppDirs.data, "session.bin")) : TokenStore {
    override fun load(): TokenPair? = runCatching {
        json.decodeFromString<TokenPair>(String(Crypt32Util.cryptUnprotectData(file.readBytes())))
    }.getOrNull()

    override fun save(tokens: TokenPair) {
        file.writeBytes(Crypt32Util.cryptProtectData(json.encodeToString(TokenPair.serializer(), tokens).toByteArray()))
    }

    override fun clear() {
        file.delete()
    }
}
