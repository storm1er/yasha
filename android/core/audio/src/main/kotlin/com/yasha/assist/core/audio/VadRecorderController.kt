package com.yasha.assist.core.audio

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// VAD auto-stop recording controller (AUDIO-REFACTO-PLAN §8): owns the
// MicRecorder, feeds the on-device SilenceDetector, and hands the finished
// WAV to the caller (chat composer / floaty) for direct input_audio upload —
// there is no transcription hop anymore. JVM-unit-tested like its web hook
// counterpart (lib/browser/use-audio-input.ts).

enum class RecorderPhase { IDLE, RECORDING, SENDING }

data class RecorderState(
    val enabled: Boolean = false,
    val phase: RecorderPhase = RecorderPhase.IDLE,
    val seconds: Int = 0,
    val error: String? = null, // "mic" | "too_short" | "too_large" | null
)

class VadRecorderController(
    private val scope: CoroutineScope,
    private val recorderFactory: (onLevel: (rms: Double) -> Unit) -> MicRecorder,
    private val onAudioReady: (wav: ByteArray) -> Unit,
    // Cap on the WAV payload (the server caps the base64 data URL at
    // chat.maxAudioBytes; 4/3·wav + prefix must fit — this is the wav-side
    // approximation applied before upload).
    private val maxWavBytes: () -> Long = { DEFAULT_MAX_WAV_BYTES },
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow(RecorderState())
    val state: StateFlow<RecorderState> = _state.asStateFlow()

    private var recorder: MicRecorder? = null
    private var detector: SilenceDetector? = null
    private var ticker: Job? = null

    /** Feature gate from GET /api/audio/config (fast model is audio-capable). */
    fun setEnabled(enabled: Boolean) = _state.update { it.copy(enabled = enabled) }

    fun start() {
        val st = _state.value
        if (st.phase != RecorderPhase.IDLE || !st.enabled) return
        val det = SilenceDetector { finishUsable() }
        val rec = recorderFactory { rms -> det.feed(rms, nowMs()) }
        if (!rec.start()) {
            _state.update { it.copy(error = "mic") }
            return
        }
        recorder = rec
        detector = det
        _state.update { it.copy(phase = RecorderPhase.RECORDING, seconds = 0, error = null) }
        ticker = scope.launch {
            var seconds = 0
            while (true) {
                delay(1000)
                seconds += 1
                _state.update { if (it.phase == RecorderPhase.RECORDING) it.copy(seconds = seconds) else it }
            }
        }
    }

    /** Manual stop (square button): the detector decides whether the take is
     * usable — a too-short utterance is discarded with an error. */
    fun stop() {
        if (recorder == null) return
        when (detector?.stop() ?: VadStopOutcome.NO_SPEECH) {
            VadStopOutcome.TOO_SHORT -> discard("too_short")
            else -> finishUsable()
        }
    }

    fun cancel() {
        recorder?.cancel()
        teardown()
        _state.update { it.copy(phase = RecorderPhase.IDLE, seconds = 0) }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    // Auto-stop (silence/max) and manual stop converge here — runs on the
    // recorder's level thread for the auto path.
    private fun finishUsable() {
        val rec = synchronized(this) {
            val r = recorder ?: return
            recorder = null
            detector = null
            r
        }
        ticker?.cancel()
        ticker = null
        _state.update { it.copy(phase = RecorderPhase.SENDING, seconds = 0) }
        val wav = rec.stopWav()
        when {
            wav == null || wav.size < MIN_TAKE_BYTES -> _state.update {
                it.copy(phase = RecorderPhase.IDLE, error = "too_short")
            }
            wav.size.toLong() * 4 / 3 + DATA_URL_OVERHEAD_BYTES > maxWavBytes() -> _state.update {
                it.copy(phase = RecorderPhase.IDLE, error = "too_large")
            }
            else -> {
                onAudioReady(wav)
                _state.update { it.copy(phase = RecorderPhase.IDLE) }
            }
        }
    }

    private fun discard(error: String) {
        recorder?.cancel()
        teardown()
        _state.update { it.copy(phase = RecorderPhase.IDLE, seconds = 0, error = error) }
    }

    private fun teardown() {
        detector = null
        ticker?.cancel()
        ticker = null
    }

    companion object {
        const val DEFAULT_MAX_WAV_BYTES = 6_000_000L
        // ~250 ms of 16 kHz mono PCM16 — mirrors the web samples guard.
        const val MIN_TAKE_BYTES = 8000
        const val DATA_URL_OVERHEAD_BYTES = 64
    }
}
