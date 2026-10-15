package com.yasha.assist.feature.assist

import org.junit.Assert.assertEquals
import org.junit.Test

class ListenStateMachineTest {
    @Test
    fun `auto-starts once when enabled and granted`() {
        val sm = ListenStateMachine()
        assertEquals(true, sm.onShown(audioEnabled = true, micGranted = true))
        assertEquals(false, sm.onShown(audioEnabled = true, micGranted = true))
    }

    @Test
    fun `never auto-starts without audio input or permission`() {
        assertEquals(false, ListenStateMachine().onShown(audioEnabled = false, micGranted = true))
        assertEquals(false, ListenStateMachine().onShown(audioEnabled = true, micGranted = false))
        assertEquals(false, ListenStateMachine().onShown(audioEnabled = false, micGranted = false))
    }

    @Test
    fun `permission-denied decision is not retried on re-show`() {
        val sm = ListenStateMachine()
        assertEquals(false, sm.onShown(audioEnabled = true, micGranted = false))
        // mic granted mid-session via the button flow — auto-start stays off
        assertEquals(false, sm.onShown(audioEnabled = true, micGranted = true))
    }

    @Test
    fun `usable take always auto-sends (audio alone is content)`() {
        // The recorder controller only invokes the audio-ready callback with a
        // usable WAV (min-speech guard applied there); the floaty must always
        // submit it — drawing the region or empty text never blocks the send.
        assertEquals(true, ListenStateMachine().shouldAutoSend())
    }
}
