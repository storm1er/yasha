package com.yasha.assist

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.yasha.assist.core.net.ApiResult

// Periodic background update check (issue #34 Phase C).
//
// Not-newer / disabled        → reminders come down, stale artifacts go away.
// Newer (not dismissed)       → "update available" notification.
// Auto-download over Wi-Fi on → also run the build/download/verify pipeline;
//                               success flips to a "ready to install" reminder
//                               (the INSTALL tap always happens in the app).
// The pure decision tree lives in AutoUpdate.kt (JVM-tested); this class is
// context glue only.
class UpdateCheckWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as? YashaApp ?: return Result.success()
        val store = app.sessionStore
        if (!store.signedIn()) return Result.success()

        val api = autoUpdateApi(app.client)
        val version = when (val r = api.fetchAppVersion()) {
            is ApiResult.Ok -> r.value
            // Kill-switch is explicit; anything else is connectivity noise.
            is ApiResult.Err -> {
                if (r.code == "app_updates_disabled") UpdateNotifications.cancelAll(applicationContext)
                return Result.success()
            }
        }

        if (version.versionCode <= com.yasha.assist.BuildConfig.VERSION_CODE) {
            UpdateNotifications.cancelAll(applicationContext)
            return Result.success()
        }

        val cacheDir = applicationContext.cacheDir
        if (pendingVerifiedApk(cacheDir)?.versionCode == version.versionCode) {
            UpdateNotifications.readyToInstall(applicationContext, version.versionName)
            return Result.success()
        }

        if (version.versionCode > store.dismissedUpdateCode) {
            UpdateNotifications.available(applicationContext, version.versionName)
        }
        if (!store.autoDownloadWifi || !onUnmeteredWifi(applicationContext)) return Result.success()

        return when (runAutoUpdate(api, version, cacheDir)) {
            AutoUpdateOutcome.Ready -> {
                UpdateNotifications.readyToInstall(applicationContext, version.versionName)
                Result.success()
            }
            AutoUpdateOutcome.Building -> Result.retry()
            else -> Result.success()
        }
    }

    private fun onUnmeteredWifi(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) } ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }
}
