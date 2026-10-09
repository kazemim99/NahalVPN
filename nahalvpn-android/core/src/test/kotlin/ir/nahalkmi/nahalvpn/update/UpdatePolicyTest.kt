package ir.nahalkmi.nahalvpn.update

import ir.nahalkmi.nahalvpn.api.AppRelease
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** vpn-client-app "Update available": offer newer builds, install only the published file signed by the release key. */
class UpdatePolicyTest {
    private val pin = "AB:CD:EF:01"
    private val bytes = "apk-bytes".toByteArray()
    private val release = AppRelease(5, "0.5.0", "https://api.nahalkmi.ir/app/nahalvpn-0.5.0.apk", UpdatePolicy.sha256Hex(bytes))

    @Test fun `hashes stay ASCII hex when the app runs in Persian`() {
        val before = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("fa-IR"))
            val hex = UpdatePolicy.sha256Hex("apk-bytes".toByteArray())
            assertTrue(hex, hex.matches(Regex("[0-9a-f]{64}")))
            assertTrue(UpdatePolicy.fileMatches(bytes, release))
        } finally {
            java.util.Locale.setDefault(before)
        }
    }

    @Test fun `only a higher versionCode is offered`() {
        assertTrue(UpdatePolicy.isNewer(release, 4))
        assertFalse(UpdatePolicy.isNewer(release, 5))
    }

    @Test fun `the download must match the published hash`() {
        assertTrue(UpdatePolicy.fileMatches(bytes, release))
        assertFalse(UpdatePolicy.fileMatches("tampered".toByteArray(), release))
    }

    @Test fun `only APKs signed by the pinned release key are installable`() {
        assertTrue(UpdatePolicy.signerAllowed(listOf("abcdef01"), pin))
        assertFalse("wrong key", UpdatePolicy.signerAllowed(listOf("deadbeef"), pin))
        assertFalse("extra signer", UpdatePolicy.signerAllowed(listOf("abcdef01", "deadbeef"), pin))
        assertFalse("unsigned", UpdatePolicy.signerAllowed(emptyList(), pin))
        assertFalse("unpinned build refuses everything", UpdatePolicy.signerAllowed(listOf("abcdef01"), ""))
    }
}
