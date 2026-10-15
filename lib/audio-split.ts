// Splitting for over-long voice messages. The Gemma 4 E2B/E4B audio encoder
// (llama.cpp conformer front-end) silently DROPS everything past the first
// 30-second window — a 31s clip transcribes exactly like its 30s head
// (verified live against gemma-4-E4B: a 52s clip yielded only the first 30s,
// while two sequential ≤30s input_audio parts on the same turn transcribed in
// full). So audio reaching the model must be cut into ≤30s PCM segments, sent
// as multiple input_audio parts (chat) or transcribed segment-by-segment
// (captions). Both clients (web WAV encoder, Android WavWriter) record 16-bit
// PCM WAV, which splits losslessly at byte boundaries; any other container
// (mpeg/flac from older clients) passes through unsplittable.
//
// Pure module (Buffer only) — runs in node and is unit-testable.

/** Hard cap of the model's audio window, in seconds (verified live). */
export const AUDIO_SEGMENT_MAX_SECONDS = 30;

const WAV_DATAURL_RE = /^data:audio\/wav;base64,([A-Za-z0-9+/]*={0,2})$/;

type PcmWav = { sampleRate: number; channels: number; data: Buffer };

/** Parses a RIFF/WAVE buffer into PCM16 `data`; null when anything about the
 *  file makes splitting unsafe (not RIFF/WAVE, missing chunks, truncated fmt,
 *  non-PCM coding, or not 16-bit). */
function parsePcmWav(bytes: Buffer): PcmWav | null {
  if (bytes.length < 44) return null;
  if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") return null;
  let pcm = false;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = bytes.toString("latin1", pos, pos + 4);
    const size = bytes.readUInt32LE(pos + 4);
    const start = pos + 8;
    const end = Math.min(start + size, bytes.length);
    if (id === "fmt " && end - start >= 16) {
      pcm = bytes.readUInt16LE(start) === 1;
      channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      bitsPerSample = bytes.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = bytes.subarray(start, end);
    }
    pos = start + size + (size % 2);
  }
  if (!data || !pcm || bitsPerSample !== 16) return null;
  return { sampleRate, channels, data };
}

/** Canonical 44-byte RIFF/WAVE header + PCM16 payload (same layout as the
 *  web encoder and the Android WavWriter). */
function encodeWav(sampleRate: number, channels: number, pcm: Buffer): Buffer {
  const out = Buffer.alloc(44 + pcm.length);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write("WAVE", 8, "latin1");
  out.write("fmt ", 12, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  return out;
}

/**
 * Splits an `data:audio/wav;base64,` URL into ≤`maxSeconds` segments
 * (PCM16 byte-boundary cuts, fresh headers). Returns the original single
 * element array for anything at/under the cap or not safely splittable
 * (non-wav mime, broken/unexpected RIFF layout, zero-size guard for the
 * caller parameter).
 */
export function splitAudioDataUrl(dataUrl: string, maxSeconds = AUDIO_SEGMENT_MAX_SECONDS): string[] {
  const match = WAV_DATAURL_RE.exec(dataUrl);
  if (!match) return [dataUrl];
  const wav = parsePcmWav(Buffer.from(match[1]!, "base64"));
  if (!wav) return [dataUrl];
  const segmentBytes = Math.floor(maxSeconds * wav.channels * 2 * wav.sampleRate);
  if (segmentBytes < 1 || wav.data.length <= segmentBytes) return [dataUrl];
  const segments: string[] = [];
  for (let offset = 0; offset < wav.data.length; offset += segmentBytes) {
    const chunk = wav.data.subarray(offset, Math.min(offset + segmentBytes, wav.data.length));
    segments.push(`data:audio/wav;base64,${encodeWav(wav.sampleRate, wav.channels, chunk).toString("base64")}`);
  }
  return segments;
}
