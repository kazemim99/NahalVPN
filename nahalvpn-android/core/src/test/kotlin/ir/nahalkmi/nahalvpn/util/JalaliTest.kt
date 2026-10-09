package ir.nahalkmi.nahalvpn.util

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

/** The expiry is always shown in the Solar Hijri calendar with Persian numerals (product decision 2026-10-08). */
class JalaliTest {
    private fun fmt(y: Int, m: Int, d: Int): String {
        val c = Calendar.getInstance(TimeZone.getTimeZone("Asia/Tehran")).apply { clear(); set(y, m - 1, d, 12, 0) }
        return Jalali.format(c.timeInMillis)
    }

    @Test fun `natural Persian format with Persian numerals`() {
        assertEquals("۲۳ مهر ۱۴۰۵", fmt(2026, 10, 15)) // matches ICU's persian calendar on Android 14
        assertEquals("۲۵ مهر ۱۴۰۵", fmt(2026, 10, 17))
    }

    @Test fun `new year, leap year end and month boundaries`() {
        assertEquals("۱ فروردین ۱۴۰۵", fmt(2026, 3, 21))
        assertEquals("۲۹ اسفند ۱۴۰۴", fmt(2026, 3, 20))   // 1404 is a common year
        assertEquals("۳۰ اسفند ۱۴۰۳", fmt(2025, 3, 20))   // 1403 is a leap year
        assertEquals("۱ فروردین ۱۴۰۴", fmt(2025, 3, 21))
        assertEquals("۱ فروردین ۱۴۰۳", fmt(2024, 3, 20))
        assertEquals("۳۱ شهریور ۱۴۰۵", fmt(2026, 9, 22))
        assertEquals("۱ مهر ۱۴۰۵", fmt(2026, 9, 23))
        assertEquals("۱ دی ۱۴۰۴", fmt(2025, 12, 22))
    }

    @Test fun `the calendar day is the one in Tehran, not UTC`() {
        // 2026-10-15 21:00 UTC is already 00:30 on 2026-10-16 in Tehran (UTC+3:30).
        val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { clear(); set(2026, 9, 15, 21, 0) }
        assertEquals("۲۴ مهر ۱۴۰۵", Jalali.format(utc.timeInMillis))
    }

    @Test fun `isolated form wraps the same text in RLI and PDI for mixed-direction screens`() {
        val c = Calendar.getInstance(TimeZone.getTimeZone("Asia/Tehran")).apply { clear(); set(2026, 9, 15, 12, 0) }
        assertEquals("\u2067" + "۲۳ مهر ۱۴۰۵" + "\u2069", Jalali.formatIsolated(c.timeInMillis))
    }

    @Test fun `persian digits only touch ASCII digits`() {
        assertEquals("۰۱۲۳۴۵۶۷۸۹ abc", Jalali.persianDigits("0123456789 abc"))
    }
}
