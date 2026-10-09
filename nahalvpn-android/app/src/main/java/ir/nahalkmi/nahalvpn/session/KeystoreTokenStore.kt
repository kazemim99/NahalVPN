package ir.nahalkmi.nahalvpn.session

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import ir.nahalkmi.nahalvpn.api.TokenPair
import kotlinx.serialization.json.Json
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * vpn-client-app "First launch": the session is stored encrypted with an AES-256-GCM key that lives in the
 * Android Keystore (never leaves it). Anything unreadable (e.g. the key was wiped) is treated as signed out.
 */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    override fun load(): TokenPair? {
        val stored = prefs.getString(KEY_BLOB, null) ?: return null
        return runCatching {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, IV_BYTES))
            json.decodeFromString<TokenPair>(String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES)))
        }.getOrElse {
            clear()
            null
        }
    }

    override fun save(tokens: TokenPair) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val body = cipher.doFinal(json.encodeToString(TokenPair.serializer(), tokens).toByteArray())
        prefs.edit().putString(KEY_BLOB, Base64.encodeToString(cipher.iv + body, Base64.NO_WRAP)).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_BLOB).apply()
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "nahalvpn.session"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_BLOB = "blob"
        const val IV_BYTES = 12
    }
}
