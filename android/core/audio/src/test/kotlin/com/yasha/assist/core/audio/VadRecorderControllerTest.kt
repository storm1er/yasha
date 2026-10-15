package com.yasha.assist.core.audio

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Test

private class FakeRecorder(
    var startOk: Boolean = true,
    var wav: ByteArray? = ByteArray(9000),
) : MicRecorder {
    var started = 0
    var stopped = 0
    var cancelled = 0
    var onLevel: ((Double) -> Unit)? = null
    override fun start(): Boolean { started += 1; return startOk }
    override fun stopWav(): ByteArray? { stopped += 1; return wav }
    override fun cancel() { cancelled += 1 }
}

class VadRecorderControllerTest {
    private class H(
        rec: FakeRecorder,
        maxWav: Long = VadRecorderController.DEFAULT_MAX_WAV_BYTES,
        clock: () -> Long = { System.currentTimeMillis() },
    ) {
        val wavs = mutableListOf<ByteArray>()
        val controller = VadRecorderController(
            scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob()),
            recorderFactory = { level -> rec.also { it.onLevel = level } },
            onAudioReady = { wavs += it },
            maxWavBytes = { maxWav },
            nowMs = clock,
        )
    }

    @Test
    fun `start refused when disabled or already recording`() {
        val rec = FakeRecorder()
        val h = H(rec)
        h.controller.start() // disabled
        assertEquals(RecorderPhase.IDLE, h.controller.state.value.phase)
        assertEquals(0, rec.started)

        h.controller.setEnabled(true)
        h.controller.start()
        h.controller.start() // second tap ignored
        assertEquals(RecorderPhase.RECORDING, h.controller.state.value.phase)
        assertEquals(1, rec.started)
    }

    @Test
    fun `start failure surfaces mic error without recording`() {
        val h = H(FakeRecorder(startOk = false))
        h.controller.setEnabled(true)
        h.controller.start()
        assertEquals(RecorderPhase.IDLE, h.controller.state.value.phase)
        assertEquals("mic", h.controller.state.value.error)
        h.controller.clearError()
        assertEquals(null, h.controller.state.value.error)
    }

    @Test
    fun `auto-stop on silence delivers the wav once`() {
        val rec = FakeRecorder()
        var clock = 10_000L
        val h = H(rec, clock = { clock })
        h.controller.setEnabled(true)
        h.controller.start()
        val onLevel = rec.onLevel!!
        // Noise floor window (p10), then speech, then hangover silence —
        // the fake clock drives the detector deterministically.
        repeat(20) { clock += 32; onLevel(0.002) }
        assertEquals(RecorderPhase.RECORDING, h.controller.state.value.phase)
        repeat(14) { clock += 32; onLevel(0.2) }
        assertEquals(0, h.wavs.size) // still recording
        repeat(60) { clock += 32; onLevel(0.001) }
        assertEquals(1, h.wavs.size)
        assertEquals(RecorderPhase.IDLE, h.controller.state.value.phase)
        assertEquals(1, rec.stopped)
    }

    @Test
    fun `manual stop before speech sends the take anyway`() {
        val rec = FakeRecorder()
        val h = H(rec)
        h.controller.setEnabled(true)
        h.controller.start()
        h.controller.stop()
        // No-speech manual stop still hands over the recording (web parity).
        assertEquals(1, h.wavs.size)
        assertEquals(RecorderPhase.IDLE, h.controller.state.value.phase)
    }

    @Test
    fun `tiny take is discarded with too_short`() {
        val rec = FakeRecorder(wav = ByteArray(100))
        val h = H(rec)
        h.controller.setEnabled(true)
        h.controller.start()
        h.controller.stop()
        assertEquals(0, h.wavs.size)
        assertEquals("too_short", h.controller.state.value.error)
        assertEquals(RecorderPhase.IDLE, h.controller.state.value.phase)
    }

    @Test
    fun `oversized take is discarded with too_large`() {
        val rec = FakeRecorder(wav = ByteArray(9000))
        val h = H(rec, maxWav = 8000)
        h.controller.setEnabled(true)
        h.controller.start()
        h.controller.stop()
        assertEquals(0, h.wavs.size)
        assertEquals("too_large", h.controller.state.value.error)
    }

    @Test
    fun `stop without recording is a no-op`() {
        val h = H(FakeRecorder())
        h.controller.setEnabled(true)
        h.controller.stop()
        assertEquals(RecorderPhase.IDLE, h.controller.state.value.phase)
    }

    @Test
    fun `cancel discards capture and resets state`() {
        val rec = FakeRecorder()
        val h = H(rec)
        h.controller.setEnabled(true)
        h.controller.start()
        h.controller.cancel()
        assertEquals(1, rec.cancelled)
        assertEquals(0, h.wavs.size)
        assertEquals(RecorderPhase.IDLE, h.controller.state.value.phase)
        assertEquals(0, h.controller.state.value.seconds)
    }
}
