package com.yasha.assist.core.audio

// Pure wav (mono PCM16 little-endian) assembly for captured mic audio.
// JVM-unit-tested (no android.* imports), mirrors lib/browser/wav.ts.

object WavWriter {
    const val SAMPLE_RATE = 16000

    fun pcm16ToLe(samples: ShortArray): ByteArray {
        val out = ByteArray(samples.size * 2)
        for (i in samples.indices) {
            out[i * 2] = (samples[i].toInt() and 0xFF).toByte()
            out[i * 2 + 1] = (samples[i].toInt() shr 8 and 0xFF).toByte()
        }
        return out
    }

    /** Wrap raw little-endian PCM16 mono bytes into a RIFF/WAVE container. */
    fun toWav(pcmLe: ByteArray, sampleRate: Int = SAMPLE_RATE): ByteArray {
        val out = ByteArray(44 + pcmLe.size)
        "RIFF".toByteArray().copyInto(out, 0)
        writeLe32(out, 4, 36 + pcmLe.size)
        "WAVE".toByteArray().copyInto(out, 8)
        "fmt ".toByteArray().copyInto(out, 12)
        writeLe32(out, 16, 16)
        writeLe16(out, 20, 1) // PCM
        writeLe16(out, 22, 1) // mono
        writeLe32(out, 24, sampleRate)
        writeLe32(out, 28, sampleRate * 2)
        writeLe16(out, 32, 2)
        writeLe16(out, 34, 16)
        "data".toByteArray().copyInto(out, 36)
        writeLe32(out, 40, pcmLe.size)
        pcmLe.copyInto(out, 44)
        return out
    }

    private fun writeLe32(b: ByteArray, off: Int, v: Int) {
        b[off] = (v and 0xFF).toByte()
        b[off + 1] = (v shr 8 and 0xFF).toByte()
        b[off + 2] = (v shr 16 and 0xFF).toByte()
        b[off + 3] = (v shr 24 and 0xFF).toByte()
    }

    private fun writeLe16(b: ByteArray, off: Int, v: Int) {
        b[off] = (v and 0xFF).toByte()
        b[off + 1] = (v shr 8 and 0xFF).toByte()
    }
}
