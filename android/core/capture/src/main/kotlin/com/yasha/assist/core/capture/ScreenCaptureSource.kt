package com.yasha.assist.core.capture

import android.graphics.Bitmap

// One capture API behind three backends (PLAN.md §M3), in preference order:
// 1. AssistSnapshot    — VoiceInteractionSession.onHandleScreenshot (assistant role)
// 2. AccessibilityShot — AccessibilityService.takeScreenshot (API 30+, ~333ms throttle,
//                        secure windows -> ERROR_SECURE)
// 3. ProjectionOneShot — MediaProjection consent per session (fallback + M5 watch mode)
sealed interface CaptureResult {
    data class Success(val bitmap: Bitmap) : CaptureResult
    data object Denied : CaptureResult
    data object Secure : CaptureResult
    data object Unavailable : CaptureResult
}

interface ScreenCaptureSource {
    suspend fun capture(): CaptureResult
}
