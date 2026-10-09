package ir.nahalkmi.nahalvpn.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import androidx.core.content.FileProvider
import ir.nahalkmi.nahalvpn.BuildConfig
import ir.nahalkmi.nahalvpn.R
import ir.nahalkmi.nahalvpn.api.ApiClient
import ir.nahalkmi.nahalvpn.api.AppRelease
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

/**
 * vpn-client-app "Update channel" (task 5.7): asks the backend for the newest build, downloads it, and hands it to the
 * system installer only if the file hash matches and the APK is signed by the pinned NahalVPN release key.
 */
class UpdateManager(private val context: Context, private val api: ApiClient, private val http: OkHttpClient) {

    suspend fun check(): AppRelease? {
        val release = api.latestRelease()
        return release.takeIf { UpdatePolicy.isNewer(it, BuildConfig.VERSION_CODE) }
    }

    suspend fun downloadAndInstall(release: AppRelease) {
        val file = withContext(Dispatchers.IO) {
            val dir = File(context.cacheDir, "updates").apply { mkdirs() }
            val out = File(dir, "nahalvpn-${release.versionCode}.apk")
            http.newCall(Request.Builder().url(release.apkUrl).build()).execute().use { r ->
                check(r.isSuccessful) { "download ${r.code}" }
                out.outputStream().use { r.body!!.byteStream().copyTo(it) }
            }
            out
        }
        val ok = withContext(Dispatchers.IO) {
            UpdatePolicy.fileMatches(file.readBytes(), release) &&
                UpdatePolicy.signerAllowed(signerDigests(file), BuildConfig.RELEASE_CERT_SHA256)
        }
        if (!ok) {
            file.delete()
            Toast.makeText(context, R.string.update_rejected, Toast.LENGTH_LONG).show()
            return
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        context.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** SHA-256 of every certificate that signed the APK file. */
    @Suppress("DEPRECATION")
    private fun signerDigests(apk: File): List<String> {
        val pm = context.packageManager
        val signatures = if (Build.VERSION.SDK_INT >= 28) {
            val info = pm.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: return emptyList()
            val si = info.signingInfo ?: return emptyList()
            si.apkContentsSigners // the certificates that actually signed this file (not the rotation history)
        } else {
            pm.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNATURES)?.signatures
        } ?: return emptyList()
        return signatures.map { s -> MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(java.util.Locale.ROOT, it) } }
    }
}
