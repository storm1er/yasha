package com.yasha.assist

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

// Fallback trigger #2: a dismissible "Ask Yasha" notification, shown while the
// assistant role is not held (PLAN.md §M2 fallbacks).
object AssistNotifier {
    private const val CHANNEL = "assist"
    const val NOTIF_ID = 42

    fun maybeShowFallback(context: Context, roleHeld: Boolean) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (roleHeld) {
            nm.cancel(NOTIF_ID)
            return
        }
        if (!nm.areNotificationsEnabled()) return // no runtime prompt pre-M3 polish
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, context.getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val tap = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_ASSIST, System.currentTimeMillis()),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val action = Notification.Action.Builder(null, context.getString(R.string.notif_ask), tap).build()
        val notif = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_yasha)
            .setContentTitle(context.getString(R.string.notif_title))
            .setContentText(context.getString(R.string.notif_text))
            .setContentIntent(tap)
            .addAction(action)
            .setOngoing(false)
            .build()
        nm.notify(NOTIF_ID, notif)
    }
}
