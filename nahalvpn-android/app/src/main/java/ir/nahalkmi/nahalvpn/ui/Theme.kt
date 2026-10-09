package ir.nahalkmi.nahalvpn.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import ir.nahalkmi.nahalvpn.R

/** NahalVPN palette (nahalvpn-brand/BRAND.md). */
object Nahal {
    val Pine = Color(0xFF135447)
    val DeepRoot = Color(0xFF0B2E28)
    val Pistachio = Color(0xFFA6CE39)
    val Mist = Color(0xFFEEF5F0)
    val Saffron = Color(0xFFF2A93B)
    val Pomegranate = Color(0xFFC63D4F)
    val Ink = Color(0xFF1F2E2A)
    val Slate = Color(0xFF5E706B)
}

// Every container/variant slot is set, so no stock Material (lavender) colour leaks into indicators or tracks.
private val Light = lightColorScheme(
    primary = Nahal.Pine, onPrimary = Nahal.Mist, primaryContainer = Color(0xFFD6E9DF), onPrimaryContainer = Nahal.DeepRoot,
    secondary = Nahal.Pistachio, onSecondary = Nahal.DeepRoot, secondaryContainer = Color(0xFFE4F0C4), onSecondaryContainer = Nahal.DeepRoot,
    tertiary = Nahal.Saffron, error = Nahal.Pomegranate, background = Nahal.Mist, onBackground = Nahal.Ink,
    surface = Color.White, onSurface = Nahal.Ink, surfaceVariant = Color(0xFFDDE8E2), onSurfaceVariant = Nahal.Slate,
    surfaceContainer = Color.White, surfaceContainerLow = Color.White, surfaceContainerHigh = Color.White,
    surfaceContainerHighest = Color.White, surfaceContainerLowest = Color.White,
    outline = Color(0xFFB7C7C1), outlineVariant = Color(0xFFD3DFD9),
)

private val Dark = darkColorScheme(
    primary = Nahal.Pistachio, onPrimary = Nahal.DeepRoot, primaryContainer = Color(0xFF1C4A41), onPrimaryContainer = Nahal.Mist,
    secondary = Nahal.Pistachio, onSecondary = Nahal.DeepRoot, secondaryContainer = Color(0xFF2E5326), onSecondaryContainer = Nahal.Mist,
    tertiary = Nahal.Saffron, error = Color(0xFFE5737F), background = Nahal.DeepRoot, onBackground = Nahal.Mist,
    surface = Color(0xFF123A33), onSurface = Nahal.Mist, surfaceVariant = Color(0xFF1C4A41), onSurfaceVariant = Color(0xFFA9BDB7),
    surfaceContainer = Color(0xFF123A33), surfaceContainerLow = Color(0xFF123A33), surfaceContainerHigh = Color(0xFF16423A),
    surfaceContainerHighest = Color(0xFF16423A), surfaceContainerLowest = Color(0xFF0E322C),
    outline = Color(0xFF3F6A60), outlineVariant = Color(0xFF2A5048),
)

/** Vazirmatn (SIL OFL, licenses/Vazirmatn-OFL.txt): the brand face, Persian and Latin in one family. */
private val Vazirmatn = FontFamily(
    Font(R.font.vazirmatn_regular, FontWeight.Normal),
    Font(R.font.vazirmatn_medium, FontWeight.Medium),
    Font(R.font.vazirmatn_medium, FontWeight.SemiBold),
    Font(R.font.vazirmatn_bold, FontWeight.Bold),
)

private val NahalTypography = Typography().let { t ->
    Typography(
        displayLarge = t.displayLarge.copy(fontFamily = Vazirmatn), displayMedium = t.displayMedium.copy(fontFamily = Vazirmatn),
        displaySmall = t.displaySmall.copy(fontFamily = Vazirmatn), headlineLarge = t.headlineLarge.copy(fontFamily = Vazirmatn),
        headlineMedium = t.headlineMedium.copy(fontFamily = Vazirmatn), headlineSmall = t.headlineSmall.copy(fontFamily = Vazirmatn),
        titleLarge = t.titleLarge.copy(fontFamily = Vazirmatn), titleMedium = t.titleMedium.copy(fontFamily = Vazirmatn),
        titleSmall = t.titleSmall.copy(fontFamily = Vazirmatn), bodyLarge = t.bodyLarge.copy(fontFamily = Vazirmatn),
        bodyMedium = t.bodyMedium.copy(fontFamily = Vazirmatn), bodySmall = t.bodySmall.copy(fontFamily = Vazirmatn),
        labelLarge = t.labelLarge.copy(fontFamily = Vazirmatn), labelMedium = t.labelMedium.copy(fontFamily = Vazirmatn),
        labelSmall = t.labelSmall.copy(fontFamily = Vazirmatn),
    )
}

@Composable
fun NahalTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, typography = NahalTypography, content = content)
}
