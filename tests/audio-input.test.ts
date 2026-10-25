import { describe, expect, it } from "vitest";
import { VOICE_MESSAGE_MARKER, audioInputConfig } from "@/lib/audio-input";

describe("audioInputConfig", () => {
  it("enables on an audio-capable fast model and exposes the catalog ids", () => {
    const cfg = audioInputConfig({
      fastModel: "user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL",
      smartModel: "Qwen3-8B-it-GGUF",
      maxAudioBytes: 8_388_608,
      audioCapableModels: ["Gemma-4-E4B-it-GGUF", "user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL"],
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe("user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL");
    expect(cfg.smartModel).toBe("Qwen3-8B-it-GGUF");
    expect(cfg.compatibleModels).toEqual([
      "Gemma-4-E4B-it-GGUF",
      "user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL",
    ]);
    expect(cfg.smartAudioCapable).toBe(false);
    expect(cfg.maxAudioBytes).toBe(8_388_608);
  });

  it("disabled for an audio-incapable fast model, flags smart capability", () => {
    const cfg = audioInputConfig({
      fastModel: "Qwen3-8B-it-GGUF",
      smartModel: "Gemma-4-12B-it-GGUF",
      maxAudioBytes: 1,
      audioCapableModels: ["Gemma-4-12B-it-GGUF"],
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.smartAudioCapable).toBe(true);
  });

  it("unconfigured fast model -> disabled even when the catalog has candidates", () => {
    const cfg = audioInputConfig({
      fastModel: null,
      smartModel: null,
      maxAudioBytes: 0,
      audioCapableModels: ["Gemma-4-E4B-it-GGUF"],
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.model).toBeNull();
    expect(cfg.smartAudioCapable).toBe(false);
  });
});

describe("constants", () => {
  it("marker is a single bracketed line", () => {
    expect(VOICE_MESSAGE_MARKER).toBe("[voice message]");
  });
});
