package ir.nahalkmi.nahalvpn.util

import java.util.Calendar
import java.util.TimeZone

/**
 * Solar Hijri (Jalali) calendar for the expiry date: always shown this way, in Persian numerals, in every language
 * ("۲۵ مهر ۱۴۰۵"). Pure arithmetic (no ICU), so it also works on Android 6-7.
 * The conversion follows the well-known 33-year-cycle algorithm (jalaali-js), valid for years -61..3177.
 */
object Jalali {
    data class Date(val year: Int, val month: Int, val day: Int)

    private val MONTHS = arrayOf(
        "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
    )
    private val BREAKS = intArrayOf(-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178)
    private val TEHRAN: TimeZone = TimeZone.getTimeZone("Asia/Tehran")

    fun fromGregorian(gy: Int, gm: Int, gd: Int): Date {
        var jy = gy - 621
        val r = cal(jy)
        val jdn1f = gregorianToJdn(gy, 3, r.march)
        var k = gregorianToJdn(gy, gm, gd) - jdn1f
        if (k >= 0) {
            if (k <= 185) return Date(jy, 1 + k / 31, k % 31 + 1)
            k -= 186
        } else {
            jy -= 1
            k += 179
            if (r.leap == 1) k += 1
        }
        return Date(jy, 7 + k / 30, k % 30 + 1)
    }

    /** The calendar day in Tehran (Iran has no daylight saving time since 2022) that contains [epochMs]. */
    fun fromEpochMs(epochMs: Long): Date {
        val c = Calendar.getInstance(TEHRAN).apply { timeInMillis = epochMs }
        return fromGregorian(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
    }

    /** "۲۵ مهر ۱۴۰۵" */
    fun format(epochMs: Long): String {
        val d = fromEpochMs(epochMs)
        return persianDigits("${d.day} ${MONTHS[d.month - 1]} ${d.year}")
    }

    /**
     * [format] as an isolated right-to-left run (RLI ... PDI), so its words and numbers keep Persian reading order
     * ("۲۵ مهر ۱۴۰۵") even inside a left-to-right screen such as the English UI.
     */
    fun formatIsolated(epochMs: Long): String = "\u2067" + format(epochMs) + "\u2069"

    fun persianDigits(s: String): String = buildString {
        for (ch in s) append(if (ch in '0'..'9') '۰' + (ch - '0') else ch)
    }

    private class Cal(val leap: Int, val march: Int)

    private fun cal(jy: Int): Cal {
        require(jy >= BREAKS.first() && jy < BREAKS.last()) { "Jalali year out of range: $jy" }
        val gy = jy + 621
        var leapJ = -14
        var jp = BREAKS[0]
        var jump = 0
        for (i in 1 until BREAKS.size) {
            val jm = BREAKS[i]
            jump = jm - jp
            if (jy < jm) break
            leapJ += div(jump, 33) * 8 + div(jump % 33, 4)
            jp = jm
        }
        var n = jy - jp
        leapJ += div(n, 33) * 8 + div(n % 33 + 3, 4)
        if (jump % 33 == 4 && jump - n == 4) leapJ += 1
        val leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150
        val march = 20 + leapJ - leapG
        if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33
        var leap = ((n + 1) % 33 - 1).mod(4)
        if (leap == -1) leap = 4
        return Cal(leap, march)
    }

    private fun div(a: Int, b: Int) = a / b

    private fun gregorianToJdn(gy: Int, gm: Int, gd: Int): Int {
        var d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * ((gm + 9) % 12) + 2, 5) + gd - 34840408
        d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752
        return d
    }
}
