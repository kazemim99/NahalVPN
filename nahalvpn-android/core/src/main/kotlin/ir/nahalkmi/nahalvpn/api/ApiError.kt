package ir.nahalkmi.nahalvpn.api

/** Backend error codes the app reacts to (see nahalvpn-api `errors.ts`); everything else is [Other]. */
sealed class ApiError(val code: String, val status: Int) : Exception(code) {
    class InvalidCredentials : ApiError("invalid_credentials", 401)
    class TooManyAttempts : ApiError("too_many_attempts", 429)
    class AccountDisabled : ApiError("account_disabled", 403)
    class SubscriptionExpired : ApiError("subscription_expired", 403)
    class DeviceLimit(val devices: List<Device>) : ApiError("device_limit_reached", 409)
    class InvalidToken : ApiError("invalid_token", 401)
    class LocationUnavailable : ApiError("location_unavailable", 503)
    class ProtocolNotReady : ApiError("protocol_not_ready", 501)
    class Network(cause: Throwable) : ApiError("network", 0) { init { initCause(cause) } }
    class Other(code: String, status: Int) : ApiError(code, status)

    companion object {
        internal fun from(status: Int, body: ErrorBody): ApiError = when (body.error) {
            "invalid_credentials" -> InvalidCredentials()
            "too_many_attempts" -> TooManyAttempts()
            "account_disabled" -> AccountDisabled()
            "subscription_expired" -> SubscriptionExpired()
            "device_limit_reached" -> DeviceLimit(body.devices)
            "invalid_token" -> InvalidToken()
            "location_unavailable" -> LocationUnavailable()
            "protocol_not_ready" -> ProtocolNotReady()
            else -> Other(body.error, status)
        }
    }
}
