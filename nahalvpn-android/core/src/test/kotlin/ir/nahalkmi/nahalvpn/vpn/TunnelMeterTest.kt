package ir.nahalkmi.nahalvpn.vpn

import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Speed and ping are measured only on request; these tests drive the meter with virtual time. */
class TunnelMeterTest {
    private class FakeIo(
        val scope: TestScope,
        val rtts: ArrayDeque<Long> = ArrayDeque(),
        val downloadMs: Long = 1000,
        val uploadMs: Long = 1000,
        val failDownload: Boolean = false,
        val failUpload: Boolean = false,
        val failAll: Boolean = false,
    ) : MeterIo {
        var smallRequests = 0
        override suspend fun smallRequest(): Boolean {
            smallRequests++
            if (failAll) return false
            delay(rtts.removeFirstOrNull() ?: 50)
            return true
        }
        override suspend fun download(bytes: Long): Long { delay(downloadMs); return if (failDownload) 0 else bytes }
        override suspend fun upload(bytes: Long): Long { delay(uploadMs); return if (failUpload) 0 else bytes }
    }

    private fun TestScope.meter(io: FakeIo, timeoutMs: Long = 15_000) =
        TunnelMeter(io, nanoTime = { testScheduler.currentTime * 1_000_000 }, phaseTimeoutMs = timeoutMs)

    @Test fun `ping is the median of the samples after a warm-up that is not counted`() = runTest {
        val io = FakeIo(this, rtts = ArrayDeque(listOf(900L, 180L, 220L, 200L, 5000L)))
        assertEquals(210, meter(io).ping()) // samples 180, 220, 200, 5000 -> median of (200, 220)
        assertEquals(5, io.smallRequests)
    }

    @Test fun `ping fails cleanly when the tunnel carries nothing`() = runTest {
        val io = FakeIo(this, failAll = true)
        assertNull(meter(io).ping())
        assertEquals("gives up after the warm-up", 1, io.smallRequests)
    }

    @Test fun `download and upload speed in Mbps from the parallel streams`() = runTest {
        // 3 x 5 MB in 1 s = 120 Mbit/s; 2 x 2.5 MB in 2 s = 20 Mbit/s
        val r = meter(FakeIo(this, downloadMs = 1000, uploadMs = 2000)).speed()
        assertEquals(120.0, r.downloadMbps!!, 0.01)
        assertEquals(20.0, r.uploadMbps!!, 0.01)
    }

    @Test fun `one failing direction does not hide the other`() = runTest {
        val r = meter(FakeIo(this, failUpload = true)).speed()
        assertNotNull(r.downloadMbps)
        assertNull(r.uploadMbps)
    }

    @Test fun `a stalled phase is abandoned at its timeout instead of hanging`() = runTest {
        val r = meter(FakeIo(this, downloadMs = 60_000), timeoutMs = 5_000).speed()
        assertNull(r.downloadMbps)
        assertNotNull(r.uploadMbps)
        assertTrue("whole test stays bounded", testScheduler.currentTime < 10_000)
    }

    @Test fun `median handles odd, even and single samples`() {
        assertEquals(20L, TunnelMeter.median(listOf(30, 10, 20)))
        assertEquals(25L, TunnelMeter.median(listOf(10, 20, 30, 40)))
        assertEquals(7L, TunnelMeter.median(listOf(7)))
        assertNull(TunnelMeter.median(emptyList()))
    }
}
