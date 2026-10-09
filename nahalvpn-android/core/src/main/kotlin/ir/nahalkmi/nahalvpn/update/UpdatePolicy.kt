package ir.nahalkmi.nahalvpn.update

import ir.nahalkmi.nahalvpn.api.AppRelease
import java.security.MessageDigest

/** vpn-client-app "Update channel": what to offer, and what may be installed. */
object UpdatePolicy {
    fun isNewer(release: AppRelease, installedVersionCode: Int): Boolean = release.versionCode > installedVersionCode

    /** The downloaded file must be exactly the published one. */
    fun fileMatches(bytes: ByteArray, release: AppRelease): Boolean =
        sha256Hex(bytes).equals(release.sha256.trim(), ignoreCase = true)

    /**
     * The APK must be signed only by the pinned NahalVPN release key. An unpinned build ([pinnedCertSha256] empty)
     * refuses every update rather than trusting whatever key signed the download.
     */
    fun signerAllowed(apkSignerCertsSha256: List<String>, pinnedCertSha256: String): Boolean {
        val pin = normalize(pinnedCertSha256)
        if (pin.isEmpty() || apkSignerCertsSha256.isEmpty()) return false
        return apkSignerCertsSha256.all { normalize(it) == pin }
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(java.util.Locale.ROOT, it) }

    private fun normalize(hex: String) = hex.replace(":", "").trim().lowercase()
}
