package com.yasha.assist

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.provider.Settings
import com.yasha.assist.feature.chat.ApkInstallGateway
import com.yasha.assist.feature.chat.InstallOutcome
import java.io.File

// PackageInstaller-backed update install (issue #34, Phase B): streams the
// verified APK into a full-install session and commits behind the system's
// single confirmation tap. No FileProvider — the APK bytes ride the session's
// own fd. commit() with an IntentSender must be reached from the foreground,
// so [foreground] mirrors MainActivity's lifecycle: a background completion
// defers (returns false) and the flow retries on resume.
class PackageInstallerGateway(private val context: Context) : ApkInstallGateway {

    @Volatile
    var foreground: Boolean = false

    override fun hasInstallPermission(): Boolean =
        context.packageManager.canRequestPackageInstalls()

    override fun openPermissionSettings() {
        // Per-app "install unknown apps" grant screen for this package.
        context.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    override fun launchInstall(dest: File, onResult: (InstallOutcome) -> Unit): Boolean {
        if (!foreground) return false
        val installer = context.packageManager.packageInstaller
        return try {
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setSize(dest.length()) // preallocate disk for the stream
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, dest.length()).use { out ->
                    dest.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                // The status receiver MUST be a MUTABLE PendingIntent when we
                // target SDK 35+ (the installer fills in the result extras).
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (android.os.Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                val resultIntent = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    Intent(ACTION_INSTALL_RESULT).setPackage(context.packageName),
                    flags,
                )
                context.registerReceiver(
                    object : BroadcastReceiver() {
                        override fun onReceive(receiverContext: Context, intent: Intent) {
                            val outcome = mapResult(intent) ?: return // user-action prompt: wait for the follow-up
                            receiverContext.unregisterReceiver(this)
                            onResult(outcome)
                        }
                    },
                    IntentFilter(ACTION_INSTALL_RESULT),
                    Context.RECEIVER_NOT_EXPORTED,
                )
                // All streams are closed → commit inside the session's lifetime
                // (Session.commit(IntentSender), public since API 21).
                session.commit(resultIntent.intentSender)
            }
            true
        } catch (_: Exception) {
            onResult(InstallOutcome.Failure)
            true // reported as Failed — no silent deferred retry
        }
    }

    private fun mapResult(intent: Intent): InstallOutcome? {
        // The system may ask for the user's confirmation tap through the
        // result itself (EXTRA_INTENT carries the prompt): launch it and wait
        // for the follow-up broadcast that carries the real verdict.
        (intent.getParcelableExtra(Intent.EXTRA_INTENT) as? Intent)?.let { prompt ->
            context.startActivity(prompt.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return null
        }
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
        return when {
            status == PackageInstaller.STATUS_SUCCESS -> InstallOutcome.Success
            status == PackageInstaller.STATUS_PENDING_USER_ACTION -> null // prompt without payload: follow-up decides
            status == PackageInstaller.STATUS_FAILURE_ABORTED -> InstallOutcome.Aborted
            // Signature mismatch (the one-time debug→release migration, R1, or
            // a wiped keystore) surfaces as CONFLICT (API 34+) or an
            // UPDATE_INCOMPATIBLE message on older levels.
            status == STATUS_FAILURE_CONFLICT ||
                message.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE", ignoreCase = true) ||
                message.contains("SIGNATURE", ignoreCase = true) -> InstallOutcome.Conflict
            else -> InstallOutcome.Failure
        }
    }

    private companion object {
        const val ACTION_INSTALL_RESULT = "com.yasha.assist.UPDATE_INSTALL_RESULT"
        // PackageInstaller.STATUS_FAILURE_CONFLICT (API 34; compileSdk 35 would
        // allow the symbol, but keeping the literal documents the minSdk floor).
        const val STATUS_FAILURE_CONFLICT = 8
    }
}
