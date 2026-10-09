package ir.nahalkmi.nahalvpn.ui

import ir.nahalkmi.nahalvpn.util.Jalali
import ir.nahalkmi.nahalvpn.vpn.Transport
import java.util.Locale

/** Display helpers shared by the Android and Windows apps (no platform UI code here). */

fun transportLabel(t: Transport) = when (t) {
    Transport.VLESS -> "VLESS"
    Transport.OPENVPN_UDP -> "OpenVPN (UDP)"
    Transport.OPENVPN_TCP -> "OpenVPN (TCP)"
}

/** Whole days remaining, rounded up (a subscription ending in 2 hours still has "1 day"); 0 once expired. */
fun daysLeft(expiresAt: Long, now: Long): Long =
    if (expiresAt <= now) 0 else (expiresAt - now + DAY_MS - 1) / DAY_MS

private const val DAY_MS = 24L * 3_600_000

fun localDigits(s: String, persian: Boolean) = if (persian) Jalali.persianDigits(s) else s

/** "12.3" below 100 Mbps, "245" above; "—" when there is no value. */
fun mbps(v: Double?, persian: Boolean): String =
    v?.let { localDigits(if (it >= 100) "%.0f".format(Locale.ROOT, it) else "%.1f".format(Locale.ROOT, it), persian) } ?: "—"

/** Regional-indicator flag emoji from an ISO 3166-1 alpha-2 code. */
fun flag(country: String): String =
    if (country.length != 2) "🌐" else country.uppercase(Locale.ROOT).map { String(Character.toChars(0x1F1E6 + (it - 'A'))) }.joinToString("")

/** Unicode LEFT-TO-RIGHT ISOLATE ... POP DIRECTIONAL ISOLATE: numbers and addresses keep their order inside RTL text. */
fun ltr(s: String) = "⁦$s⁩"
