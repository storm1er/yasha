package com.yasha.assist

import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

// No-op by design: real STT is server-side whisper via POST /api/speech/transcribe
// (SPEECH-PLAN). This RecognitionService exists only because Android 15 rejects a
// VoiceInteractionService whose metadata lacks a recognitionService ("NOT VALID:
// No recognitionService specified"). It never listens and immediately errors
// back, so nothing can hang on it.
class YashaRecognitionService : RecognitionService() {
    override fun onStartListening(intent: Intent?, callback: Callback) {
        callback.error(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED)
    }

    override fun onStopListening(callback: Callback) {
        callback.error(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED)
    }

    override fun onCancel(callback: Callback) {
        callback.error(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED)
    }
}
