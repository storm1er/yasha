package com.yasha.assist.feature.assist

// Auto-listen decision for the floaty (AUDIO-REFACTO-PLAN §8). Deliberately
// pure: FloatyScreen owns the VadRecorderController, this only answers
// "should capture start on show?". Touch NEVER cuts the mic anymore — region
// drawing keeps the recording running (the detector never auto-stops before
// the first utterance, so drawing time is tolerated).

class ListenStateMachine {
    private var autoStartDecided = false

    /** Floaty became visible. True → start capture immediately. Decided once
     * per screen instance; only when the audio feature is enabled AND the mic
     * is granted (permission-denied path simply never auto-starts). */
    fun onShown(audioEnabled: Boolean, micGranted: Boolean): Boolean {
        if (autoStartDecided) return false
        autoStartDecided = true
        return audioEnabled && micGranted
    }

    /** Recording stopped with a usable take: always auto-send (audio alone is
     * content — no typed text required). Manual stop without speech never
     * calls this. */
    fun shouldAutoSend(): Boolean = true
}
