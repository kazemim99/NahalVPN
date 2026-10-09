package ir.nahalkmi.nahalvpn.session

import ir.nahalkmi.nahalvpn.api.ApiClient
import ir.nahalkmi.nahalvpn.api.ApiError
import ir.nahalkmi.nahalvpn.api.TokenPair
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Persists the session (Android Keystore-backed on device; in-memory in tests). */
interface TokenStore {
    fun load(): TokenPair?
    fun save(tokens: TokenPair)
    fun clear()
}

/** Why the user was sent back to the login screen. */
enum class SignOutReason { USER, REVOKED }

/**
 * vpn-client-app "Login screen": keeps the user signed in across restarts, refreshes the access token
 * transparently, and signs out (event [signedOut]) when the backend rejects the refresh token.
 */
class SessionManager(
    private val api: ApiClient,
    private val store: TokenStore,
    private val deviceKey: String,
    private val deviceName: String,
) {
    private val mutex = Mutex()
    private val _tokens = MutableStateFlow(store.load())
    val tokens: StateFlow<TokenPair?> = _tokens.asStateFlow()
    private val _signedOut = MutableSharedFlow<SignOutReason>(extraBufferCapacity = 4)
    val signedOut: SharedFlow<SignOutReason> = _signedOut.asSharedFlow()

    val isSignedIn: Boolean get() = _tokens.value != null

    suspend fun login(username: String, password: String, replaceDeviceId: String? = null) {
        val pair = api.login(username.trim(), password, deviceKey, deviceName, replaceDeviceId)
        store.save(pair)
        _tokens.value = pair
    }

    suspend fun logout() {
        val t = _tokens.value
        if (t != null) runCatching { api.logout(t.accessToken) }
        end(SignOutReason.USER)
    }

    /**
     * Runs [call] with a valid access token. On `invalid_token` it refreshes once (serialized, so parallel calls share
     * one refresh) and retries; if the refresh itself is rejected the session is over.
     */
    suspend fun <T> authorized(call: suspend (accessToken: String) -> T): T {
        val current = _tokens.value ?: throw ApiError.InvalidToken()
        return try {
            call(current.accessToken)
        } catch (e: ApiError.InvalidToken) {
            call(refreshAfter(current).accessToken)
        }
    }

    private suspend fun refreshAfter(stale: TokenPair): TokenPair = mutex.withLock {
        val now = _tokens.value ?: throw ApiError.InvalidToken()
        if (now.accessToken != stale.accessToken) return now // another caller already refreshed
        try {
            val fresh = api.refresh(now.refreshToken)
            store.save(fresh)
            _tokens.value = fresh
            fresh
        } catch (e: ApiError) {
            if (e is ApiError.Network) throw e
            end(SignOutReason.REVOKED)
            throw ApiError.InvalidToken()
        }
    }

    private fun end(reason: SignOutReason) {
        store.clear()
        _tokens.value = null
        _signedOut.tryEmit(reason)
    }
}
