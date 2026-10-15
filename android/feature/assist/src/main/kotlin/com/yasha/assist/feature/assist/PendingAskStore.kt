package com.yasha.assist.feature.assist

import android.graphics.Bitmap
import android.os.SystemClock

// Same-process handoff from the floaty to MainActivity: data URLs exceed safe
// binder/Intent payload sizes, so the payload travels through this store and the
// Intent only carries the assist tick.
object PendingAskStore {
    data class Pending(val text: String, val attachments: List<String>)

    private const val MAIN_ACTIVITY = "com.yasha.assist.MainActivity"

    @Volatile
    private var pending: Pending? = null

    @Volatile
    private var assistShot: Pair<Bitmap, Long>? = null

    fun put(p: Pending) { pending = p }

    fun consume(): Pending? = pending.also { pending = null }

    /** Screenshot offered by the assistant session (onHandleScreenshot), fresh for 30 s. */
    fun putAssistShot(bitmap: Bitmap) {
        assistShot?.first?.recycle()
        assistShot = bitmap to SystemClock.elapsedRealtime()
    }

    fun takeAssistShot(maxAgeMs: Long = 30_000): Bitmap? {
        val (bitmap, at) = assistShot ?: return null
        assistShot = null
        return if (SystemClock.elapsedRealtime() - at <= maxAgeMs) bitmap else bitmap.also { it.recycle() }.let { null }
    }

    fun mainActivityComponent() = MAIN_ACTIVITY
}
