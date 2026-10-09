package ir.nahalkmi.nahalvpn.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class DaysLeftTest {
    private val day = 24L * 3_600_000
    private val now = 1_800_000_000_000

    @Test fun `whole days are rounded up so the last partial day still counts`() {
        assertEquals(7, daysLeft(now + 7 * day, now))
        assertEquals(7, daysLeft(now + 6 * day + 1, now))
        assertEquals(1, daysLeft(now + 2 * 3_600_000, now))
    }

    @Test fun `expired or exactly now is zero`() {
        assertEquals(0, daysLeft(now, now))
        assertEquals(0, daysLeft(now - day, now))
    }

    @Test fun `digits follow the language`() {
        assertEquals("۱۲", localDigits("12", true))
        assertEquals("12", localDigits("12", false))
    }
}
