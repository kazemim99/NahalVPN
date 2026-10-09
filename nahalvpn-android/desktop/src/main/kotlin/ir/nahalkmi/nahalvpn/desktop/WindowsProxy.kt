package ir.nahalkmi.nahalvpn.desktop

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.platform.win32.Advapi32Util
import com.sun.jna.platform.win32.WinReg

/**
 * The Windows (WinINET) proxy setting used by browsers and most apps. NahalVPN points it at the engine's local port
 * while connected and puts the user's previous values back afterwards - including after a crash, on next start.
 */
class WindowsProxy(private val settings: DesktopSettings) {
    private val root = WinReg.HKEY_CURRENT_USER
    private val key = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
    private val bypass = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;*.local;<local>"

    private interface WinInet : Library {
        fun InternetSetOptionW(hInternet: Pointer?, dwOption: Int, lpBuffer: Pointer?, dwBufferLength: Int): Boolean
    }
    private val wininet: WinInet by lazy { Native.load("wininet", WinInet::class.java) }

    fun point(port: Int) {
        val ours = "127.0.0.1:$port"
        if (settings.savedProxy == null) {
            settings.savedProxy = SavedProxy(
                enable = readInt("ProxyEnable") ?: 0, server = readString("ProxyServer"), override = readString("ProxyOverride"),
                autoConfigUrl = readString("AutoConfigURL"), ourServer = ours,
            )
        } else {
            settings.savedProxy = settings.savedProxy!!.copy(ourServer = ours)
        }
        // A PAC script would take precedence over the manual proxy, so it is set aside while connected.
        runCatching { Advapi32Util.registryDeleteValue(root, key, "AutoConfigURL") }
        Advapi32Util.registrySetStringValue(root, key, "ProxyServer", ours)
        Advapi32Util.registrySetStringValue(root, key, "ProxyOverride", bypass)
        Advapi32Util.registrySetIntValue(root, key, "ProxyEnable", 1)
        refresh()
    }

    /** Puts back whatever was there before NahalVPN (no-op if nothing was changed). */
    fun restore() {
        val saved = settings.savedProxy ?: return
        if (readString("ProxyServer") == saved.ourServer || readInt("ProxyEnable") == 1) {
            setOrDelete("ProxyServer", saved.server)
            setOrDelete("ProxyOverride", saved.override)
            setOrDelete("AutoConfigURL", saved.autoConfigUrl)
            Advapi32Util.registrySetIntValue(root, key, "ProxyEnable", saved.enable)
            refresh()
        }
        settings.savedProxy = null
    }

    fun current(): String? = if (readInt("ProxyEnable") == 1) readString("ProxyServer") else null

    private fun setOrDelete(name: String, value: String?) {
        if (value == null) runCatching { Advapi32Util.registryDeleteValue(root, key, name) }
        else Advapi32Util.registrySetStringValue(root, key, name, value)
    }

    private fun readString(name: String): String? =
        if (Advapi32Util.registryValueExists(root, key, name)) runCatching { Advapi32Util.registryGetStringValue(root, key, name) }.getOrNull() else null

    private fun readInt(name: String): Int? =
        if (Advapi32Util.registryValueExists(root, key, name)) runCatching { Advapi32Util.registryGetIntValue(root, key, name) }.getOrNull() else null

    /** Tell running apps (browsers) the setting changed: INTERNET_OPTION_SETTINGS_CHANGED, then INTERNET_OPTION_REFRESH. */
    private fun refresh() {
        runCatching {
            wininet.InternetSetOptionW(null, 39, null, 0)
            wininet.InternetSetOptionW(null, 37, null, 0)
        }
    }
}
