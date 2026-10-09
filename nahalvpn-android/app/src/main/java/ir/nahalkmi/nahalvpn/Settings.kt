package ir.nahalkmi.nahalvpn

import android.content.Context
import android.os.Build
import java.util.UUID

/** Small, non-secret preferences: device identity, kill switch, last location. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /** Stable per-install identifier sent at login (not a hardware ID). */
    val deviceKey: String
        get() = prefs.getString("device_key", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("device_key", it).apply()
        }

    val deviceName: String = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(60).ifBlank { "Android" }

    var killSwitch: Boolean
        get() = prefs.getBoolean("kill_switch", true)
        set(value) = prefs.edit().putBoolean("kill_switch", value).apply()

    /** The protocol the user picked; null = automatic (VLESS, then OpenVPN UDP, then TCP). */
    var protocol: ir.nahalkmi.nahalvpn.vpn.Transport?
        get() = prefs.getString("protocol", null)?.let { n -> ir.nahalkmi.nahalvpn.vpn.Transport.entries.find { it.name == n } }
        set(value) = prefs.edit().putString("protocol", value?.name).apply()

    var lastLocation: String?
        get() = prefs.getString("last_location", null)
        set(value) = prefs.edit().putString("last_location", value).apply()
}
