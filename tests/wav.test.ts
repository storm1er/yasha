import { describe, expect, it } from "vitest";
import { encodeWavPcm16 } from "@/lib/browser/wav";

describe("encodeWavPcm16", () => {
  it("writes a canonical 44-byte header and int16 little-endian body", () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 0.5]), 16000);
    const dv = new DataView(wav.buffer);
    const ascii = (off: number, len: number) => String.fromCharCode(...wav.slice(off, off + len));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(dv.getUint32(4, true)).toBe(36 + 8);
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(dv.getUint32(16, true)).toBe(16);
    expect(dv.getUint16(20, true)).toBe(1);
    expect(dv.getUint16(22, true)).toBe(1);
    expect(dv.getUint32(24, true)).toBe(16000);
    expect(dv.getUint32(28, true)).toBe(32000);
    expect(dv.getUint16(32, true)).toBe(2);
    expect(dv.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe("data");
    expect(dv.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(52);
    expect(dv.getInt16(44, true)).toBe(0);
    expect(dv.getInt16(46, true)).toBe(32767);
    expect(dv.getInt16(48, true)).toBe(-32767);
    expect(dv.getInt16(50, true)).toBe(16384);
  });

  it("clamps out-of-range samples and handles empty input", () => {
    const wav = encodeWavPcm16(new Float32Array([2, -5]), 16000);
    const dv = new DataView(wav.buffer);
    expect(dv.getInt16(44, true)).toBe(32767);
    expect(dv.getInt16(46, true)).toBe(-32767);
    const empty = encodeWavPcm16(new Float32Array(0), 16000);
    expect(empty.byteLength).toBe(44);
    expect(new DataView(empty.buffer).getUint32(4, true)).toBe(36);
  });
});
