package ir.nahalkmi.nahalvpn.vpn

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull

/** The network side of a measurement. Real one goes through the tunnel; tests use a fake. */
interface MeterIo {
    /** One small request on a kept-alive connection; false if it failed. */
    suspend fun smallRequest(): Boolean
    /** Reads [bytes] from the speed server; returns how many arrived (0 on failure). */
    suspend fun download(bytes: Long): Long
    /** Sends [bytes] to the speed server; returns how many were accepted (0 on failure). */
    suspend fun upload(bytes: Long): Long
}

data class SpeedResult(val downloadMbps: Double?, val uploadMbps: Double?)

/**
 * On-demand measurements only (never continuous): ping = median round trip of a few tiny requests on one connection
 * (after one warm-up that pays for the TLS handshake); speed = a short parallel download then upload, measured from
 * start to the last stream finishing. A full test moves roughly 21 MB.
 */
class TunnelMeter(
    private val io: MeterIo,
    private val nanoTime: () -> Long = System::nanoTime,
    private val pingSamples: Int = 4,
    private val downloadStreams: Int = 3,
    private val downloadBytesPerStream: Long = 5_000_000,
    private val uploadStreams: Int = 2,
    private val uploadBytesPerStream: Long = 2_500_000,
    private val phaseTimeoutMs: Long = 15_000,
) {
    /** Round-trip time in milliseconds, or null if the connection does not work. */
    suspend fun ping(): Int? {
        if (!io.smallRequest()) return null // warm-up: TLS + tunnel setup are not part of the answer
        val samples = mutableListOf<Long>()
        repeat(pingSamples) {
            val t0 = nanoTime()
            if (io.smallRequest()) samples += (nanoTime() - t0) / 1_000_000
        }
        return median(samples)?.toInt()
    }

    suspend fun speed(): SpeedResult = SpeedResult(
        downloadMbps = phase(downloadStreams, downloadBytesPerStream, io::download),
        uploadMbps = phase(uploadStreams, uploadBytesPerStream, io::upload),
    )

    private suspend fun phase(streams: Int, bytesEach: Long, run: suspend (Long) -> Long): Double? {
        val t0 = nanoTime()
        val moved = withTimeoutOrNull(phaseTimeoutMs) {
            coroutineScope { (1..streams).map { async { run(bytesEach) } }.awaitAll().sum() }
        } ?: return null
        val seconds = (nanoTime() - t0) / 1e9
        return if (moved <= 0 || seconds <= 0.0) null else moved * 8 / seconds / 1e6
    }

    companion object {
        fun median(values: List<Long>): Long? {
            if (values.size < 2) return values.firstOrNull() // one good sample is still an answer
            val s = values.sorted()
            return if (s.size % 2 == 1) s[s.size / 2] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2
        }
    }
}
