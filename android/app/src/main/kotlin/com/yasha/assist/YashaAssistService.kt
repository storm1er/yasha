package com.yasha.assist

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import com.yasha.assist.feature.assist.FloatyActivity
import com.yasha.assist.feature.assist.PendingAskStore

// Default-assistant controller once ROLE_ASSISTANT is granted (PLAN.md §M2).
// Long-press power / assistant gesture route here; the session surface (floaty,
// capture) lands in M3 — for now we hand off to the chat activity.
class YashaAssistService : VoiceInteractionService() {
    override fun onReady() { /* keep-alive; nothing to warm up yet */ }

    // Long-press power while the keyguard is up (HA parity): open our session.
    override fun onLaunchVoiceAssistFromKeyguard() {
        showSession(null, 0)
    }
}

// Sessions are created by the companion service declared in @xml/voice_interaction.
class YashaSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(params: Bundle?): VoiceInteractionSession = YashaSession(this)
}

class YashaSession(context: Context) : VoiceInteractionSession(context) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        openFloaty()
        // Deferred (Home Assistant pattern): finishing synchronously invalidates the
        // window token before doShow() runs → intermittent BadTokenException.
        android.os.Handler(android.os.Looper.getMainLooper()).post { finish() }
    }

    // System offers the screen bitmap when the user granted "screen contents"
    // (Digital-assistant settings) — capture backend #1 (PLAN.md §M3).
    override fun onHandleScreenshot(screenshot: Bitmap?) {
        if (screenshot != null) PendingAskStore.putAssistShot(screenshot)
    }

    private fun openFloaty() {
        context.startActivity(
            Intent(context, FloatyActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
    }
}
