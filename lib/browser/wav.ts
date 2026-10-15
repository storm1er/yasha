// Pure wav (PCM16 mono) encoding for captured mic audio (SPEECH-PLAN P2).
// Runs in the browser AND node (unit-tested); no DOM/WebAudio dependencies.

/**
 * Encode mono Float32 samples (-1..1) as a 16-bit PCM RIFF/WAVE byte array
 * at `sampleRate` (we capture at 16 kHz). Values are clamped.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const out = new Uint8Array(44 + n * 2);
  const dv = new DataView(out.buffer);
  const put = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) out[off + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  put(8, "WAVE");
  put(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, "data");
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    dv.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return out;
}
