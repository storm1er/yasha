import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_DATAURL_CHARS,
  buildUpstreamMessages,
  normalizeAttachments,
  parseStoredImages,
  parseStoredAudio,
  audioInputPart,
  audioInputParts,
  dataUrlBytes,
} from "@/lib/chat-attachments";
import { VOICE_MESSAGE_MARKER } from "@/lib/audio-input";
import { encodeWavPcm16 } from "@/lib/browser/wav";

const PNG = "data:image/png;base64," + "A".repeat(16);
const JPEG = "data:image/jpeg;base64," + "B+/9".repeat(4) + "==";
const WAV = "data:audio/wav;base64," + "UklGRg==";
const MP3 = "data:audio/mpeg;base64," + "A/8=";
const MAX_AUDIO = 1024 * 1024;

function longWavDataUrl(seconds: number): string {
  const wav = encodeWavPcm16(new Float32Array(seconds * 16000), 16000);
  return "data:audio/wav;base64," + Buffer.from(wav).toString("base64");
}

describe("normalizeAttachments", () => {
  it("treats missing / non-array / empty input as no images", () => {
    expect(normalizeAttachments(undefined, 4, MAX_AUDIO)).toEqual({ images: [], audio: null });
    expect(normalizeAttachments(null, 4, MAX_AUDIO)).toEqual({ images: [], audio: null });
    expect(normalizeAttachments([], 4, MAX_AUDIO)).toEqual({ images: [], audio: null });
  });

  it("rejects non-object non-array shapes", () => {
    expect(normalizeAttachments("nope", 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
    expect(normalizeAttachments(42, 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
  });

  it("enforces the per-message count cap", () => {
    expect(normalizeAttachments([PNG, PNG], 1, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "too_many" });
  });

  it("rejects non-strings and non-image / bad data URLs", () => {
    expect(normalizeAttachments([42], 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
    expect(normalizeAttachments(["https://evil/x.png"], 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
    expect(normalizeAttachments(["data:image/gif;base64," + "A".repeat(16)], 4, MAX_AUDIO)).toEqual({
      images: [],
      audio: null,
      error: "unsupported",
    });
  });

  it("accepts png/jpeg/webp base64 payloads", () => {
    expect(normalizeAttachments([PNG, JPEG], 4, MAX_AUDIO)).toEqual({ images: [PNG, JPEG], audio: null });
  });

  it("enforces the per-image size cap", () => {
    const huge = "data:image/png;base64," + "A".repeat(MAX_IMAGE_DATAURL_CHARS - 22 + 1);
    expect(huge.length).toBeGreaterThan(MAX_IMAGE_DATAURL_CHARS);
    expect(normalizeAttachments([huge], 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "too_large" });
  });
});

describe("normalizeAttachments — audio", () => {
  it("object form: images + audio", () => {
    expect(normalizeAttachments({ images: [PNG], audio: WAV }, 4, MAX_AUDIO)).toEqual({ images: [PNG], audio: WAV });
  });

  it("object form: missing keys are fine", () => {
    expect(normalizeAttachments({}, 4, MAX_AUDIO)).toEqual({ images: [], audio: null });
    expect(normalizeAttachments({ images: null, audio: null }, 4, MAX_AUDIO)).toEqual({ images: [], audio: null });
  });

  it("object form: images must be an array", () => {
    expect(normalizeAttachments({ images: "x" }, 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
  });

  it("object form: image validation errors propagate", () => {
    expect(normalizeAttachments({ images: [42] }, 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
    expect(normalizeAttachments({ images: [PNG, PNG], audio: WAV }, 1, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "too_many" });
  });

  it("rejects malformed audio / bad mime / non-string", () => {
    expect(normalizeAttachments({ audio: "not-a-data-url" }, 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
    expect(normalizeAttachments({ audio: "data:audio/ogg;base64,AAAA" }, 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
    expect(normalizeAttachments({ audio: 42 }, 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "unsupported" });
  });

  it("enforces the audio byte cap", () => {
    const big = "data:audio/wav;base64," + "A".repeat(4 * 1024 * 1024);
    expect(normalizeAttachments({ audio: big }, 4, MAX_AUDIO)).toEqual({ images: [], audio: null, error: "too_large" });
  });
});

describe("parseStoredImages", () => {
  it("returns [] for absent or broken meta", () => {
    expect(parseStoredImages(null, 4)).toEqual([]);
    expect(parseStoredImages("{oops", 4)).toEqual([]);
    expect(parseStoredImages(JSON.stringify({ images: "x" }), 4)).toEqual([]);
  });

  it("keeps only strings, capped at the configured limit", () => {
    const meta = JSON.stringify({ images: [PNG, 7, JPEG] });
    expect(parseStoredImages(meta, 1)).toEqual([PNG]);
    expect(parseStoredImages(meta, 4)).toEqual([PNG, JPEG]);
  });
});

describe("parseStoredAudio", () => {
  it("null for absent / broken / invalid meta", () => {
    expect(parseStoredAudio(null)).toBeNull();
    expect(parseStoredAudio("{oops")).toBeNull();
    expect(parseStoredAudio(JSON.stringify({ audio: "http://x" }))).toBeNull();
    expect(parseStoredAudio(JSON.stringify({ audio: 7 }))).toBeNull();
  });

  it("returns the stored data URL", () => {
    expect(parseStoredAudio(JSON.stringify({ audio: WAV }))).toBe(WAV);
  });
});

describe("audioInputPart / dataUrlBytes", () => {
  it("maps mimes to llama-server format names", () => {
    expect(audioInputPart(WAV).input_audio.format).toBe("wav");
    expect(audioInputPart(MP3).input_audio.format).toBe("mp3");
  });

  it("flac is accepted and mapped", () => {
    const flac = "data:audio/flac;base64," + "AAAA";
    expect(audioInputPart(flac).input_audio.format).toBe("flac");
  });

  it("falls back to wav format for unvalidated direct calls", () => {
    expect(audioInputPart("garbage").input_audio).toEqual({ data: "garbage", format: "wav" });
  });

  it("computes approximate decoded sizes", () => {
    expect(dataUrlBytes("data:audio/wav;base64,AAAA")).toBe(3);
    expect(dataUrlBytes("data:audio/wav;base64,AA==")).toBe(1);
    expect(dataUrlBytes("data:audio/wav;base64,AAA=")).toBe(2);
  });
});

describe("buildUpstreamMessages", () => {
  it("passes image-less messages through as plain text", () => {
    expect(buildUpstreamMessages([{ role: "user", content: "hi", images: [] }], 4)).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("builds text+image parts, dropping text when empty", () => {
    const out = buildUpstreamMessages(
      [
        { role: "user", content: "look", images: [PNG] },
        { role: "user", content: "", images: [JPEG] },
      ],
      4
    );
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: PNG } },
      ],
    });
    expect(out[1]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: JPEG } }],
    });
  });

  it("drops the oldest images when the window budget is exceeded", () => {
    const out = buildUpstreamMessages(
      [
        { role: "user", content: "old", images: [PNG, JPEG] },
        { role: "user", content: "new", images: [PNG, JPEG] },
      ],
      3
    );
    const partsOf = (m: (typeof out)[number]) =>
      (m.content as { type: string }[]).filter((p) => p.type === "image_url").length;
    expect(partsOf(out[0])).toBe(1); // oldest image dropped
    expect(partsOf(out[1])).toBe(2); // newest kept
    expect((out[0].content as { type: string; text?: string }[])[0]).toEqual({ type: "text", text: "old" });
  });

  it("zero budget keeps texts and drops every image", () => {
    expect(buildUpstreamMessages([{ role: "user", content: "t", images: [PNG] }], 0)).toEqual([
      { role: "user", content: "t" },
    ]);
  });

  it("falls back to no images when a budget key is not found", () => {
    // A message whose role read differs between the budget-fill pass and the
    // map pass misses budget.get() -> `?? []` fallback (text preserved).
    let roleReads = 0;
    const flipping = {
      get role() {
        roleReads += 1;
        return roleReads === 1 ? "user" : "system";
      },
      content: "kept",
      images: [PNG],
    };
    expect(buildUpstreamMessages([flipping], 4)).toEqual([{ role: "system", content: "kept" }]);
  });

  it("sends real audio parts only at audioIndex; older audio becomes the marker", () => {
    const out = buildUpstreamMessages(
      [
        { role: "user", content: "first", images: [], audio: WAV },
        { role: "assistant", content: "ok", images: [] },
        { role: "user", content: "second", images: [], audio: MP3 },
      ],
      4,
      2
    );
    expect(out[0]).toEqual({ role: "user", content: `first\n${VOICE_MESSAGE_MARKER}` });
    expect(out[1]).toEqual({ role: "assistant", content: "ok" });
    expect(out[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "second" },
        { type: "input_audio", input_audio: { data: MP3, format: "mp3" } },
      ],
    });
  });

  it("marker-only audio message (empty text) at replay", () => {
    const out = buildUpstreamMessages([{ role: "user", content: "", images: [], audio: WAV }], 4, -1);
    expect(out[0]).toEqual({ role: "user", content: VOICE_MESSAGE_MARKER });
  });

  it("audio-only newest message: parts without text", () => {
    const out = buildUpstreamMessages([{ role: "user", content: "", images: [], audio: WAV }], 4, 0);
    expect(out[0]).toEqual({
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: WAV, format: "wav" } }],
    });
  });

  it("splits over-30s audio at audioIndex into multiple input_audio parts", () => {
    const LONG = longWavDataUrl(61);
    const out = buildUpstreamMessages([{ role: "user", content: "hi", images: [], audio: LONG }], 4, 0);
    const parts = out[0]!.content as { type: string }[];
    expect(parts.filter((p) => p.type === "input_audio").length).toBe(3);
  });

  it("audioIndex pointing at a message without audio is a no-op", () => {
    expect(buildUpstreamMessages([{ role: "user", content: "hi", images: [] }], 4, 0)).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});

describe("audioInputParts", () => {
  it("short or unsplittable audio yields a single part", () => {
    expect(audioInputParts(WAV)).toEqual([{ type: "input_audio", input_audio: { data: WAV, format: "wav" } }]);
    expect(audioInputParts(MP3).length).toBe(1);
  });

  it("splits a 61 s clip into 30 s segments (3 parts)", () => {
    const parts = audioInputParts(longWavDataUrl(61));
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.input_audio.format === "wav")).toBe(true);
  });
});
