package com.yasha.assist.feature.assist

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.graphics.Bitmap
import android.view.Display
import com.yasha.assist.core.capture.CaptureResult
import kotlinx.coroutines.suspendCancellableCoroutine
import java.lang.ref.WeakReference
import kotlin.coroutines.resume

// Capture backend #2 (PLAN.md §M3): AccessibilityService.takeScreenshot (API 30+).
// Minimal config: screenshots only — no window/content inspection.
class YashaAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceInfo = AccessibilityServiceInfo().apply {
            // Nothing to observe; keep the event stream as quiet as possible.
            eventTypes = 0
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        }
        instance = WeakReference(this)
    }

    override fun onDestroy() {
        if (instance?.get() === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) { /* unused */ }

    override fun onInterrupt() {
        if (instance?.get() === this) instance = null
    }

    /** One screenshot, with a single retry for the documented transient first-shot failures. */
    suspend fun screenshot(): CaptureResult {
        val first = takeScreenshotOnce()
        return if (first is CaptureResult.Unavailable) takeScreenshotOnce() else first
    }

    private suspend fun takeScreenshotOnce(): CaptureResult = suspendCancellableCoroutine { cont ->
        try {
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                mainExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshot: ScreenshotResult) {
                        val result = try {
                            val buffer = screenshot.hardwareBuffer
                            val bitmap = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
                                ?.copy(Bitmap.Config.ARGB_8888, false)
                            buffer.close()
                            if (bitmap != null) CaptureResult.Success(bitmap) else CaptureResult.Unavailable
                        } catch (_: Exception) {
                            CaptureResult.Unavailable
                        }
                        if (cont.isActive) cont.resume(result)
                    }

                    override fun onFailure(errorCode: Int) {
                        val result = when (errorCode) {
                            ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> CaptureResult.Secure
                            else -> CaptureResult.Unavailable
                        }
                        if (cont.isActive) cont.resume(result)
                    }                },
            )
        } catch (_: Exception) {
            if (cont.isActive) cont.resume(CaptureResult.Unavailable)
        }
        cont.invokeOnCancellation { /* in-flight screenshot is dropped by the system */ }
    }

    companion object {
        private var instance: WeakReference<YashaAccessibilityService>? = null

        fun isReady(): Boolean = instance?.get() != null

        suspend fun capture(): CaptureResult {
            val service = instance?.get() ?: return CaptureResult.Unavailable
            return service.screenshot()
        }
    }
}
