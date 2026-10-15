import { describe, expect, it } from "vitest";
import {
  AUDIO_COMPAT_LABELS,
  AUDIO_INPUT_COMPAT,
  VOICE_MESSAGE_MARKER,
  audioInputConfig,
  isAudioInputModel,
} from "@/lib/audio-input";

describe("isAudioInputModel", () => {
  it("matches registry ids, user variants and quants", () => {
    expect(isAudioInputModel("Gemma-4-E4B-it-GGUF")).toBe(true);
    expect(isAudioInputModel("user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL")).toBe(true);
    expect(isAudioInputModel("Gemma-4-E2B-it-GGUF")).toBe(true);
    expect(isAudioInputModel("Gemma-4-12B-it-MTP-GGUF")).toBe(true);
  });

  it("rejects text-only siblings, other families and empties", () => {
    expect(isAudioInputModel("Gemma-4-26B-A4B-it-GGUF")).toBe(false);
    expect(isAudioInputModel("Gemma-4-31B-it-GGUF")).toBe(false);
    expect(isAudioInputModel("Qwen3-8B-it-GGUF")).toBe(false);
    expect(isAudioInputModel("whisper-large-v3-GGUF")).toBe(false);
    expect(isAudioInputModel("")).toBe(false);
    expect(isAudioInputModel(null)).toBe(false);
    expect(isAudioInputModel(undefined)).toBe(false);
  });
});

describe("audioInputConfig", () => {
  it("enables on an audio-capable fast model and exposes labels", () => {
    const cfg = audioInputConfig({
      fastModel: "user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL",
      smartModel: "Qwen3-8B-it-GGUF",
      maxAudioBytes: 8_388_608,
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe("user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL");
    expect(cfg.smartModel).toBe("Qwen3-8B-it-GGUF");
    expect(cfg.compatibleModels).toEqual([...AUDIO_COMPAT_LABELS]);
    expect(cfg.smartAudioCapable).toBe(false);
    expect(cfg.maxAudioBytes).toBe(8_388_608);
  });

  it("disabled for an incompatible fast model, flags smart capability", () => {
    const cfg = audioInputConfig({
      fastModel: "Qwen3-8B-it-GGUF",
      smartModel: "Gemma-4-12B-it-GGUF",
      maxAudioBytes: 1,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.smartAudioCapable).toBe(true);
  });

  it("unconfigured fast model -> disabled", () => {
    const cfg = audioInputConfig({ fastModel: null, smartModel: null, maxAudioBytes: 0 });
    expect(cfg.enabled).toBe(false);
    expect(cfg.model).toBeNull();
  });
});

describe("compat list sanity", () => {
  it("every compat token matches itself and never the 26B/31B ids", () => {
    for (const token of AUDIO_INPUT_COMPAT) {
      expect(isAudioInputModel(`some.${token}-it-GGUF`)).toBe(true);
    }
    expect(AUDIO_INPUT_COMPAT.some((t) => "gemma-4-26b-a4b-it-gguf".includes(t))).toBe(false);
    expect(AUDIO_INPUT_COMPAT.some((t) => "gemma-4-31b-it-gguf".includes(t))).toBe(false);
  });

  it("marker is a single bracketed line", () => {
    expect(VOICE_MESSAGE_MARKER).toBe("[voice message]");
  });
});
