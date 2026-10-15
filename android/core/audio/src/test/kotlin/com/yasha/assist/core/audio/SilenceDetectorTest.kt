package com.yasha.assist.core.audio

import org.junit.Assert.assertEquals
import org.junit.Test

// JVM mirror of the web tests/vad.test.ts scenarios — the two implementations
// must stay behaviorally identical (AUDIO-REFACTO-PLAN §9).

class SilenceDetectorTest {
    private class Harness {
        val dones = mutableListOf<VadDoneReason>()
        val detector = SilenceDetector { dones += it }

        // Quiet noise floor during the p10 window, then a frame cadence helper.
        fun warmNoise(t0: Long, untilMs: Long) {
            var t = t0
            while (t <= untilMs + 64) {
                detector.feed(0.002, t)
                t += 32
            }
        }
    }

    @Test
    fun `auto-stops on hangover after usable speech`() {
        val h = Harness()
        val t0 = 1000L
        h.warmNoise(t0, t0 + 500)
        var t = t0 + 600
        // speech onset: 4 frames above threshold
        repeat(4) { h.detector.feed(0.2, t); t += 32 }
        assertEquals(true, h.detector.speaking)
        assertEquals(0, h.dones.size)
        // keep talking
        repeat(10) { h.detector.feed(0.2, t); t += 32 }
        // silence longer than the hangover → auto-stop
        val silenceStart = t
        repeat(45) { h.detector.feed(0.001, silenceStart + it * 32) }
        assertEquals(listOf(VadDoneReason.SILENCE), h.dones)
        assertEquals(true, h.detector.done)
    }

    @Test
    fun `noise blip shorter than minSpeech never auto-stops`() {
        val h = Harness()
        val t0 = 0L
        h.warmNoise(t0, t0 + 500)
        var t = t0 + 600
        repeat(4) { h.detector.feed(0.2, t); t += 32 } // speaking
        repeat(3) { h.detector.feed(0.2, t); t += 32 } // ~96 ms of speech
        repeat(60) { h.detector.feed(0.001, t + it * 32) } // long silence
        assertEquals(0, h.dones.size) // re-armed, not done
        assertEquals(false, h.detector.done)
    }

    @Test
    fun `never auto-stops before the first utterance`() {
        val h = Harness()
        val t0 = 0L
        h.warmNoise(t0, t0 + 500)
        // silence forever (region-drawing grace)
        var t = t0 + 600
        repeat(200) { h.detector.feed(0.001, t); t += 32 }
        assertEquals(0, h.dones.size)
    }

    @Test
    fun `hard cap fires on max recording`() {
        val h = Harness()
        val t0 = 0L
        h.warmNoise(t0, t0 + 500)
        var t = t0 + 600
        repeat(4) { h.detector.feed(0.2, t); t += 32 }
        // continuous speech past the max cap without ever crossing the hangover
        val start = t
        repeat(1900) { h.detector.feed(0.2, start + it * 32) }
        assertEquals(listOf(VadDoneReason.MAX), h.dones)
    }

    @Test
    fun `noise floor threshold scales with the p10 of the first window`() {
        // Loud-ish floor: p10 0.05 → threshold 0.15 → 0.1 frames never speak.
        val h = Harness()
        var t = 0L
        while (t <= 520) { h.detector.feed(0.05, t); t += 32 }
        repeat(100) { h.detector.feed(0.1, t); t += 32 }
        assertEquals(false, h.detector.speaking)
        // Quiet floor: p10 0.001 → floor threshold 0.012 → 0.1 frames speak.
        val h2 = Harness()
        t = 0L
        while (t <= 520) { h2.detector.feed(0.001, t); t += 32 }
        repeat(4) { h2.detector.feed(0.1, t); t += 32 }
        assertEquals(true, h2.detector.speaking)
    }

    @Test
    fun `manual stop outcomes`() {
        val before = SilenceDetector { }.stop()
        assertEquals(VadStopOutcome.NO_SPEECH, before)

        val h = Harness()
        var t = 0L
        h.warmNoise(0L, 500L)
        t = 600
        repeat(4) { h.detector.feed(0.2, t); t += 32 }
        // usable speech → SILENCE
        h.detector.feed(0.2, t); t += 32
        h.detector.feed(0.2, t); t += 32
        repeat(8) { h.detector.feed(0.2, t); t += 32 } // > minSpeechMs
        assertEquals(VadStopOutcome.SILENCE, h.detector.stop())
        assertEquals(VadStopOutcome.NO_SPEECH, h.detector.stop()) // done is sticky
    }

    @Test
    fun `manual stop during short speech is too_short`() {
        val h = Harness()
        h.warmNoise(0L, 500L)
        var t = 600L
        repeat(4) { h.detector.feed(0.2, t); t += 32 }
        h.detector.feed(0.2, t)
        assertEquals(VadStopOutcome.TOO_SHORT, h.detector.stop())
    }
}
