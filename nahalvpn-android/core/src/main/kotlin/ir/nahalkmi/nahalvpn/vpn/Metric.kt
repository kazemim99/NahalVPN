package ir.nahalkmi.nahalvpn.vpn

/** State of one on-demand measurement (ping or speed test) as the home screen shows it. */
sealed interface Metric<out T> {
    data object Idle : Metric<Nothing>
    data object Testing : Metric<Nothing>
    data class Done<T>(val value: T) : Metric<T>
    data object Failed : Metric<Nothing>
}

val Metric<*>.isTesting: Boolean get() = this is Metric.Testing
