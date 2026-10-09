package ir.nahalkmi.nahalvpn

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * NahalVPN speaks Persian by default, whatever the phone's language (owner decision 2026-10-08); English stays
 * available from Settings. Applied to the Application, the Activity and the VPN service so notifications match.
 */
object AppLocale {
    const val PERSIAN = "fa"
    const val ENGLISH = "en"
    private const val KEY = "language"

    fun get(context: Context): String =
        context.getSharedPreferences("settings", Context.MODE_PRIVATE).getString(KEY, PERSIAN) ?: PERSIAN

    fun set(context: Context, language: String) {
        context.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putString(KEY, language).apply()
    }

    /** A context whose resources, layout direction (RTL for Persian) and formatting use the app language. */
    fun wrap(base: Context): Context {
        val locale = Locale.forLanguageTag(if (get(base) == ENGLISH) "en" else "fa-IR")
        Locale.setDefault(locale)
        val config = Configuration(base.resources.configuration)
        config.setLocale(locale)
        config.setLayoutDirection(locale)
        return base.createConfigurationContext(config)
    }
}
