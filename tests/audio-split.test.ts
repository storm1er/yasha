import { describe, expect, it } from "vitest";
import { encodeWavPcm16 } from "@/lib/browser/wav";
import { AUDIO_SEGMENT_MAX_SECONDS, splitAudioDataUrl } from "@/lib/audio-split";

const RATE = 16_000;
const BYTES_PER_SECOND = RATE * 2; // mono PCM16

function riffWav(body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(4 + body.length, 4);
  out.write("WAVE", 8, "latin1");
  body.copy(out, 12);
  return out;
}

function chunk(id: string, body: Buffer, declaredSize?: number): Buffer {
  const out = Buffer.alloc(8 + body.length);
  out.write(id, 0, "latin1");
  out.writeUInt32LE(declaredSize ?? body.length, 4);
  body.copy(out, 8);
  return out;
}

function fmtBody(channels: number, bits: number, audioFormat = 1): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(audioFormat, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(RATE, 4);
  b.writeUInt32LE(RATE * channels * 2, 8);
  b.writeUInt16LE(channels * 2, 12);
  b.writeUInt16LE(bits, 14);
  return b;
}

function wavDataUrl(seconds: number, channels = 1, bits = 16): string {
  const samples = new Float32Array(Math.round(seconds * RATE) * channels);
  const mono = Buffer.from(encodeWavPcm16(samples, RATE));
  const pcm = mono.subarray(44);
  const url = (wav: Buffer) => `data:audio/wav;base64,${wav.toString("base64")}`;
  if (channels === 1 && bits === 16) return url(mono);
  return url(riffWav(Buffer.concat([chunk("fmt ", fmtBody(channels, bits)), chunk("data", pcm)])));
}

function decode(url: string): Buffer {
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

/** Minimal chunk walk: returns chunk ids plus the concatenated data payload. */
function chunks(buf: Buffer): { ids: string[]; data: Buffer } {
  const ids: string[] = [];
  const parts: Buffer[] = [];
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    const end = Math.min(start + size, buf.length);
    ids.push(id);
    if (id === "data") parts.push(buf.subarray(start, end));
    pos = start + size + (size % 2);
  }
  return { ids, data: Buffer.concat(parts) };
}

const b64Url = (bytes: Buffer) => `data:audio/wav;base64,${bytes.toString("base64")}`;

describe("splitAudioDataUrl — pass-through cases", () => {
  it("keeps non-wav mimes untouched", () => {
    const mp3 = "data:audio/mpeg;base64,A/8=";
    expect(splitAudioDataUrl(mp3)).toEqual([mp3]);
  });

  it("keeps at-or-under-cap audio untouched (identity, incl. exactly 30 s)", () => {
    for (const seconds of [0.5, AUDIO_SEGMENT_MAX_SECONDS]) {
      const url = wavDataUrl(seconds);
      expect(splitAudioDataUrl(url)).toEqual([url]);
    }
  });

  it("keeps undecodable / unexpected RIFF layouts untouched", () => {
    const tooShort = Buffer.from("RIFF");
    const noRiffMagic = Buffer.alloc(44); // long enough, wrong magic
    const notWave = riffWav(Buffer.alloc(0));
    notWave.write("OCTET", 8, "latin1"); // magic broken at offset 8
    const noChunks = riffWav(Buffer.alloc(0));
    const truncatedFmt = riffWav(
      Buffer.concat([chunk("fmt ", Buffer.alloc(8)), chunk("data", Buffer.alloc(BYTES_PER_SECOND))])
    );
    const dataOnly = riffWav(chunk("data", Buffer.alloc(BYTES_PER_SECOND)));
    const floatCoding = riffWav(
      Buffer.concat([chunk("fmt ", fmtBody(1, 32, 3)), chunk("data", Buffer.alloc(40))])
    );
    const eightBit = riffWav(
      Buffer.concat([chunk("fmt ", fmtBody(1, 8)), chunk("data", Buffer.alloc(40))])
    );
    const noData = riffWav(chunk("fmt ", fmtBody(1, 16)));
    for (const broken of [tooShort, noRiffMagic, notWave, noChunks, truncatedFmt, dataOnly, floatCoding, eightBit, noData]) {
      const url = b64Url(broken);
      expect(splitAudioDataUrl(url)).toEqual([url]);
    }
  });

  it("returns pass-through when the segment cap degenerates (maxSeconds ≤ 0)", () => {
    const url = wavDataUrl(61);
    expect(splitAudioDataUrl(url, 0)).toEqual([url]);
  });
});

describe("splitAudioDataUrl — splitting", () => {
  it("splits a 61 s mono clip into 30 s + 30 s + 1 s with lossless payload", () => {
    const url = wavDataUrl(61);
    const segments = splitAudioDataUrl(url);
    expect(segments.length).toBe(3);
    const original = chunks(decode(url));
    const all: Buffer[] = [];
    segments.forEach((seg, i) => {
      const parsed = chunks(decode(seg));
      expect(parsed.ids).toEqual(["fmt ", "data"]);
      const expectedSeconds = i < 2 ? AUDIO_SEGMENT_MAX_SECONDS : 1;
      expect(parsed.data.length).toBe(expectedSeconds * BYTES_PER_SECOND);
      all.push(parsed.data);
    });
    expect(Buffer.concat(all).equals(original.data)).toBe(true);
  });

  it("splits stereo audio using the frame-aligned byte rate", () => {
    const url = wavDataUrl(31, 2);
    const segments = splitAudioDataUrl(url);
    expect(segments.length).toBe(2);
    const all = Buffer.concat(segments.map((s) => chunks(decode(s)).data));
    expect(all.equals(chunks(decode(url)).data)).toBe(true);
    // the rebuilt headers carry the original channel count
    expect(decode(segments[0]!).readUInt16LE(22)).toBe(2);
    expect(chunks(decode(segments[1]!)).data.length).toBe(BYTES_PER_SECOND * 2);
  });

  it("honours a custom maxSeconds", () => {
    const url = wavDataUrl(5);
    const segments = splitAudioDataUrl(url, 2);
    expect(segments.length).toBe(3);
    expect(chunks(decode(segments[2]!)).data.length).toBe(1 * BYTES_PER_SECOND);
  });

  it("splits despite odd-size padding chunks and a truncated data-size field", () => {
    const original = decode(wavDataUrl(61));
    const fmt = original.subarray(12, 36); // "fmt " chunk: 8-byte header + 16-byte body
    const payload = original.subarray(44);
    const declaredSize = Buffer.alloc(4);
    declaredSize.writeUInt32LE(payload.length + 999, 0); // oversized → parse must clamp
    const rebuilt = riffWav(
      Buffer.concat([
        fmt,
        // odd-size chunk + its real padding byte (chunk() writes header+body only)
        Buffer.concat([chunk("LIST", Buffer.from("abc", "latin1")), Buffer.alloc(1)]),
        Buffer.concat([Buffer.from("data", "latin1"), declaredSize, payload]),
      ])
    );
    const segments = splitAudioDataUrl(b64Url(rebuilt));
    expect(segments.length).toBe(3);
    expect(Buffer.concat(segments.map((s) => chunks(decode(s)).data)).equals(payload)).toBe(true);
  });
});
