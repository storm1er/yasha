package com.yasha.assist.core.audio

// Pure silence detector fed by RMS frames (AUDIO-REFACTO-PLAN §9). Mirror of
// the web lib/browser/vad.ts — constants and behavior MUST stay in sync.
//
// Contract:
//  - noise floor = p10 of the first noiseFloorWindowMs frames; speech starts
//    after speechOnFrames consecutive frames at/above max(0.012, floor * 3).
//  - silence after speech (>= hangoverMs) → auto-stop when at least
//    minSpeechMs were spoken; a shorter blip re-arms the waiting phase
//    (never auto-stops on silence alone).
//  - total speech above maxRecordingMs → onDone(MAX).
//  - before any speech: auto-stop never fires (region-drawing grace in the
//    floaty — only manual stop ends the recording).
//  - stop() before usable speech → TOO_SHORT (caller discards + warns).

enum class VadDoneReason { SILENCE, MAX }

enum class VadStopOutcome { SILENCE, TOO_SHORT, NO_SPEECH }

object Vad {
    const val START_THRESHOLD_RMS_MIN = 0.012
    const val NOISE_FLOOR_FACTOR = 3.0
    const val NOISE_FLOOR_WINDOW_MS = 500L
    const val SPEECH_ON_FRAMES = 4
    const val HANGOVER_MS = 1200L
    const val MIN_SPEECH_MS = 300L
    const val MAX_RECORDING_MS = 60000L

    // Onset approximation for the speechOn run (frame cadence ~30–60 ms).
    const val FRAME_ESTIMATE_MS = 32L

    fun startThreshold(noiseFloorP10: Double): Double =
        maxOf(START_THRESHOLD_RMS_MIN, noiseFloorP10 * NOISE_FLOOR_FACTOR)
}

class SilenceDetector(private val onDone: (VadDoneReason) -> Unit) {
    private enum class Phase { NOISE, WAITING, SPEAKING, DONE }

    private var phase = Phase.NOISE
    private var startedSet = false
    private var startedAt = 0L
    private var speechStartedAt = 0L
    private var lastSpokeAt = 0L
    private var aboveRun = 0
    private var threshold = Vad.START_THRESHOLD_RMS_MIN
    private val noiseFrames = mutableListOf<Double>()

    val speaking: Boolean get() = phase == Phase.SPEAKING
    val done: Boolean get() = phase == Phase.DONE

    // Only reached while SPEAKING; speechStartedAt ≤ lastSpokeAt, always ≥ 0.
    private fun spokeMs(): Long = lastSpokeAt - speechStartedAt

    private fun finish(reason: VadDoneReason) {
        phase = Phase.DONE
        onDone(reason)
    }

    fun feed(rms: Double, nowMs: Long) {
        if (phase == Phase.DONE) return
        // Explicit flag: a 0-based clock (tests) must not re-arm every frame.
        if (!startedSet) {
            startedSet = true
            startedAt = nowMs
        }
        if (phase == Phase.NOISE) {
            noiseFrames += rms
            if (nowMs - startedAt >= Vad.NOISE_FLOOR_WINDOW_MS && noiseFrames.size >= 3) {
                val sorted = noiseFrames.sorted()
                val p10 = sorted[((sorted.size - 1) * 0.1).toInt()]
                threshold = Vad.startThreshold(p10)
                phase = Phase.WAITING
            }
            return
        }
        val above = rms >= threshold
        if (phase == Phase.WAITING) {
            aboveRun = if (above) aboveRun + 1 else 0
            if (aboveRun >= Vad.SPEECH_ON_FRAMES) {
                phase = Phase.SPEAKING
                // Approximate the onset: the run started (aboveRun-1) frames ago.
                speechStartedAt = nowMs - (aboveRun - 1) * Vad.FRAME_ESTIMATE_MS
                lastSpokeAt = nowMs
            }
            return
        }
        // SPEAKING
        if (above) lastSpokeAt = nowMs
        if (nowMs - speechStartedAt >= Vad.MAX_RECORDING_MS) {
            finish(VadDoneReason.MAX)
            return
        }
        if (nowMs - lastSpokeAt >= Vad.HANGOVER_MS) {
            if (spokeMs() < Vad.MIN_SPEECH_MS) {
                // Noise blip, not speech: re-arm (never auto-stops on silence alone).
                phase = Phase.WAITING
                aboveRun = 0
                return
            }
            finish(VadDoneReason.SILENCE)
        }
    }

    fun stop(): VadStopOutcome {
        if (phase == Phase.DONE) return VadStopOutcome.NO_SPEECH
        val wasSpeaking = phase == Phase.SPEAKING
        val usable = wasSpeaking && spokeMs() >= Vad.MIN_SPEECH_MS
        phase = Phase.DONE
        return when {
            usable -> VadStopOutcome.SILENCE
            wasSpeaking -> VadStopOutcome.TOO_SHORT
            else -> VadStopOutcome.NO_SPEECH
        }
    }
}
