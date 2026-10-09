package ir.nahalkmi.nahalvpn.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Windows has no flag emoji, so common flags are drawn; anything else gets a tidy country-code badge. */
private val HORIZONTAL = mapOf(
    "DE" to listOf(0xFF000000, 0xFFDD0000, 0xFFFFCE00), "NL" to listOf(0xFFAE1C28, 0xFFFFFFFF, 0xFF21468B),
    "AT" to listOf(0xFFED2939, 0xFFFFFFFF, 0xFFED2939), "RU" to listOf(0xFFFFFFFF, 0xFF0039A6, 0xFFD52B1E),
    "HU" to listOf(0xFFCE2939, 0xFFFFFFFF, 0xFF477050), "LU" to listOf(0xFFEF3340, 0xFFFFFFFF, 0xFF00A3E0),
    "EE" to listOf(0xFF0072CE, 0xFF000000, 0xFFFFFFFF), "LT" to listOf(0xFFFDB913, 0xFF006A44, 0xFFC1272D),
    "AM" to listOf(0xFFD90012, 0xFF0033A0, 0xFFF2A800), "BG" to listOf(0xFFFFFFFF, 0xFF00966E, 0xFFD62612),
)
private val VERTICAL = mapOf(
    "FR" to listOf(0xFF002395, 0xFFFFFFFF, 0xFFED2939), "IT" to listOf(0xFF009246, 0xFFFFFFFF, 0xFFCE2B37),
    "IE" to listOf(0xFF169B62, 0xFFFFFFFF, 0xFFFF883E), "BE" to listOf(0xFF000000, 0xFFFDDA24, 0xFFEF3340),
    "RO" to listOf(0xFF002B7F, 0xFFFCD116, 0xFFCE1126),
)

@Composable
fun CountryFlag(country: String, modifier: Modifier = Modifier) {
    val code = country.uppercase()
    val shape = RoundedCornerShape(5.dp)
    val m = modifier.size(width = 30.dp, height = 21.dp).clip(shape).border(0.5.dp, Color(0x33000000), shape)
    val h = HORIZONTAL[code]
    val v = VERTICAL[code]
    when {
        h != null -> Column(m) { h.forEach { Box(Modifier.fillMaxWidth().weight(1f).background(Color(it))) } }
        v != null -> Row(m) { v.forEach { Box(Modifier.fillMaxSize().weight(1f).background(Color(it))) } }
        else -> Box(m.background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Text(code.take(2), fontSize = 11.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
    }
}
