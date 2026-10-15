package com.yasha.assist.core.audio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class WavWriterTest {
    private fun u16(b: ByteArray, off: Int) = (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)
    private fun u32(b: ByteArray, off: Int) =
        (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8) or
            ((b[off + 2].toInt() and 0xFF) shl 16) or ((b[off + 3].toInt() and 0xFF) shl 24)

    @Test fun assemblesCanonicalHeader() {
        val wav = WavWriter.toWav(byteArrayOf(0x01, 0x00, 0x02, 0x00), 16000)
        assertEquals(48, wav.size)
        assertEquals("RIFF", String(wav, 0, 4))
        assertEquals(36 + 4, u32(wav, 4))
        assertEquals("WAVE", String(wav, 8, 4))
        assertEquals("fmt ", String(wav, 12, 4))
        assertEquals(16, u32(wav, 16))
        assertEquals(1, u16(wav, 20))
        assertEquals(1, u16(wav, 22))
        assertEquals(16000, u32(wav, 24))
        assertEquals(32000, u32(wav, 28))
        assertEquals(2, u16(wav, 32))
        assertEquals(16, u16(wav, 34))
        assertEquals("data", String(wav, 36, 4))
        assertEquals(4, u32(wav, 40))
        assertArrayEquals(byteArrayOf(0x01, 0x00, 0x02, 0x00), wav.copyOfRange(44, 48))
    }

    @Test fun pcmConversionIsLittleEndianAndNegativeSafe() {
        val le = WavWriter.pcm16ToLe(shortArrayOf(1, -2, Short.MAX_VALUE, Short.MIN_VALUE))
        assertArrayEquals(
            byteArrayOf(0x01, 0x00, 0xFE.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0x7F.toByte(), 0x00.toByte(), 0x80.toByte()),
            le,
        )
    }
}
