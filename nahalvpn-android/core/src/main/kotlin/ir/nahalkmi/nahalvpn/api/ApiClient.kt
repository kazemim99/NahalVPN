package ir.nahalkmi.nahalvpn.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/** Thin, stateless HTTP client for nahalvpn-api. Token handling lives in [SessionManager]. */
class ApiClient(private val baseUrl: String, private val http: OkHttpClient) {
    internal val json = Json { ignoreUnknownKeys = true; explicitNulls = false; classDiscriminator = "protocol" }
    private val jsonType = "application/json".toMediaType()

    /** [replaceDeviceId]: at the device limit, sign that (own) device out to sign in here. */
    suspend fun login(username: String, password: String, deviceKey: String, deviceName: String, replaceDeviceId: String? = null): TokenPair =
        post("/v1/auth/login", null, buildJsonObject {
            put("username", username); put("password", password); put("deviceId", deviceKey); put("deviceName", deviceName)
            if (replaceDeviceId != null) put("replaceDeviceId", replaceDeviceId)
        }.toString())

    suspend fun refresh(refreshToken: String): TokenPair =
        post("/v1/auth/refresh", null, buildJsonObject { put("refreshToken", refreshToken) }.toString())

    suspend fun logout(accessToken: String) { postUnit("/v1/auth/logout", accessToken) }

    suspend fun me(accessToken: String): Me = get("/v1/me", accessToken)

    suspend fun removeDevice(accessToken: String, deviceId: String) {
        send<Unit?>(Request.Builder().url(baseUrl + "/v1/me/devices/" + deviceId).delete().auth(accessToken).build()) { null }
    }

    /** Changes the signed-in user's own password; the other devices stay signed in. */
    suspend fun changePassword(accessToken: String, current: String, new: String) {
        val body = buildJsonObject { put("currentPassword", current); put("newPassword", new) }.toString()
        send<Unit?>(Request.Builder().url(baseUrl + "/v1/me/password").post(body.toRequestBody(jsonType)).auth(accessToken).build()) { null }
    }

    suspend fun locations(accessToken: String): List<Location> = get<LocationList>("/v1/locations", accessToken).locations

    suspend fun connect(accessToken: String, location: String, protocol: String): ConnectionConfig =
        post("/v1/connect", accessToken, buildJsonObject { put("location", location); put("protocol", protocol) }.toString())

    suspend fun latestRelease(): AppRelease = get("/v1/app/version", null)

    /** Public: the outage notice, readable before sign-in. */
    suspend fun notice(): Notice = get("/v1/app/notice", null)

    private suspend inline fun <reified T> get(path: String, token: String?): T =
        send(Request.Builder().url(baseUrl + path).get().auth(token).build()) { json.decodeFromString<T>(it) }

    private suspend inline fun <reified T> post(path: String, token: String?, body: String): T =
        send(Request.Builder().url(baseUrl + path).post(body.toRequestBody(jsonType)).auth(token).build()) {
            json.decodeFromString<T>(it)
        }

    private suspend fun postUnit(path: String, token: String?) {
        send<Unit?>(Request.Builder().url(baseUrl + path).post(EMPTY_JSON.toRequestBody(jsonType)).auth(token).build()) { null }
    }

    private fun Request.Builder.auth(token: String?): Request.Builder =
        if (token == null) this else header("Authorization", "Bearer $token")

    private suspend fun <T> send(request: Request, parse: (String) -> T): T = withContext(Dispatchers.IO) {
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw ApiError.Network(e)
        }
        response.use { r ->
            val text = r.body?.string().orEmpty()
            if (r.isSuccessful) return@withContext parse(text)
            val body = runCatching { json.decodeFromString<ErrorBody>(text) }.getOrDefault(ErrorBody())
            throw ApiError.from(r.code, body)
        }
    }

    private companion object {
        const val EMPTY_JSON = "{}"
    }
}
