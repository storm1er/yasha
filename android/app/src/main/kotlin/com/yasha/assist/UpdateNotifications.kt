package com.yasha.assist

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

// Update notifications (issue #34 Phase C). Two ids on one LOW-importance
// channel: "available" (offer) and "ready to install" (auto-download finished,
// waiting for the user's Install tap). Taps open MainActivity with the update
// extras — the updater dialog (and the installer) then live in the foreground,
// exactly where PackageInstaller needs them.
object UpdateNotifications {
    private const val CHANNEL = "updates"
    const val ID_AVAILABLE = 3401
    const val ID_READY = 3402

    private fun manager(context: Context): NotificationManager {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL,
                context.getString(R.string.update_notif_channel),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
        return nm
    }

    fun available(context: Context, versionName: String) =
        post(context, ID_AVAILABLE, R.string.update_notif_available_title, versionName, ready = false)

    fun readyToInstall(context: Context, versionName: String) {
        manager(context).cancel(ID_AVAILABLE)
        post(context, ID_READY, R.string.update_notif_ready_title, versionName, ready = true)
    }

    fun cancelAll(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.cancel(ID_AVAILABLE)
        nm.cancel(ID_READY)
    }

    private fun post(context: Context, id: Int, titleRes: Int, versionName: String, ready: Boolean) {
        val tap = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_UPDATE, System.currentTimeMillis())
                .putExtra(MainActivity.EXTRA_UPDATE_READY, ready)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_yasha)
            .setContentTitle(context.getString(titleRes))
            .setContentText(context.getString(
                if (ready) R.string.update_notif_ready_text else R.string.update_notif_available_text,
                versionName,
            ))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        manager(context).notify(id, notif)
    }
}
