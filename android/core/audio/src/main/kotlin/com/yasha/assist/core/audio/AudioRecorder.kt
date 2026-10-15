package com.yasha.assist.core.audio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import kotlin.math.sqrt

// Push-to-talk capture: 16 kHz mono PCM16 via AudioRecord, amplitude callback
// for the UI. Android-facing; the wav assembly itself is WavWriter (tested).

interface MicRecorder {
    /** False when the mic is unavailable (permission revoked at runtime,
     * device busy). Must be safe to call again after a failure. */
    fun start(): Boolean

    /** Stop and return the capture as wav bytes (null when nothing was recorded). */
    fun stopWav(): ByteArray?

    /** Stop and discard. Safe to call multiple times. */
    fun cancel()
}

class AudioRecorder(
    private val sampleRate: Int = WavWriter.SAMPLE_RATE,
    private val levelListener: (rms: Double) -> Unit = {},
) : MicRecorder {

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile private var running = false

    override fun start(): Boolean {
        if (running) return true
        return try {
            val minBuf = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            ).coerceAtLeast(4096)
            val rec = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2,
            )
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                rec.release()
                return false
            }
            pcm.reset()
            record = rec
            running = true
            rec.startRecording()
            thread = Thread {
                val buf = ShortArray(minBuf / 2)
                while (running) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) {
                        pcm.write(WavWriter.pcm16ToLe(buf.copyOf(n)), 0, n * 2)
                        var sum = 0.0
                        for (i in 0 until n) sum += (buf[i].toDouble() / 32768.0) * (buf[i].toDouble() / 32768.0)
                        levelListener(sqrt(sum / n))
                    }
                }
            }.also { it.start() }
            true
        } catch (_: SecurityException) {
            running = false
            releaseQuietly()
            false
        } catch (_: IllegalStateException) {
            running = false
            releaseQuietly()
            false
        }
    }

    override fun stopWav(): ByteArray? {
        val hadRecording = join()
        return try {
            if (!hadRecording || pcm.size() == 0) null else WavWriter.toWav(pcm.toByteArray(), sampleRate)
        } finally {
            pcm.reset()
        }
    }

    override fun cancel() {
        join()
        pcm.reset()
    }

    private fun join(): Boolean {
        val wasRunning = running
        running = false
        thread?.join(2000)
        thread = null
        releaseQuietly()
        return wasRunning
    }

    private fun releaseQuietly() {
        try {
            record?.stop()
        } catch (_: IllegalStateException) {
            // already stopped
        }
        record?.release()
        record = null
    }
}
