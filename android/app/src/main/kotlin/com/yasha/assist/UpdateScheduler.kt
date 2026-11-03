package com.yasha.assist

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

// Periodic update check (issue #34 Phase C): 6 h cadence, network required,
// exponential retry when the worker asks (server still building). Enqueued
// from YashaApp.onCreate and re-confirmed on every MainActivity start with the
// UPDATE policy, so an app launch refreshes the schedule (and its initial
// delay) without ever stacking work.
object UpdateScheduler {
    private const val UNIQUE = "yasha-update-check"

    fun schedule(context: Context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE,
            ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<UpdateCheckWorker>(6, TimeUnit.HOURS)
                .setInitialDelay(30, TimeUnit.SECONDS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(
                    androidx.work.BackoffPolicy.EXPONENTIAL,
                    20,
                    TimeUnit.MINUTES,
                )
                .build(),
        )
    }
}
