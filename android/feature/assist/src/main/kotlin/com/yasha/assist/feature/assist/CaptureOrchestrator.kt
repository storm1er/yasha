package com.yasha.assist.feature.assist

import android.graphics.Bitmap
import com.yasha.assist.core.capture.CaptureResult
import com.yasha.assist.core.capture.CaptureResult.Unavailable

// Capture priority (PLAN.md §M3): assist-session shot → accessibility shot.
// (MediaProjection one-shot arrives with M5 watch mode.)
sealed interface Background {
    data class Shot(val bitmap: Bitmap) : Background
    data object Protected : Background
    data object NoSource : Background
}

object CaptureOrchestrator {
    suspend fun grab(): Background {
        PendingAskStore.takeAssistShot()?.let { return Background.Shot(it) }
        return when (val r = YashaAccessibilityService.capture()) {
            is CaptureResult.Success -> Background.Shot(r.bitmap)
            CaptureResult.Secure -> Background.Protected
            is CaptureResult.Denied, Unavailable -> Background.NoSource
        }
    }
}
