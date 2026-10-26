// M2 provider contract suite (docs/provider-plan.md Q24): the shared
// ChatProvider semantics run against every adapter, plus the adapter-specific
// normalization rules.

import { describe, expect, it } from "vitest";
import { LemonadeProvider, lemonadeAudioCapable } from "@/lib/provider/lemonade";
import { OpenAICompatProvider } from "@/lib/provider/openai-compatible";
import { describeProviderContract } from "./support/provider-contract";
import { json, mockLemonade } from "./support/lemonade";

describeProviderContract("lemonade", (id, baseUrl, apiKey) => new LemonadeProvider(id, baseUrl, apiKey));
describeProviderContract("openai-compatible", (id, baseUrl, apiKey) => new OpenAICompatProvider(id, baseUrl, apiKey));

describe("openai_compatible adapter specifics", () => {
  const BASE = "http://compat.invalid.test";

  it("lists every entry with a string id — labels/downloaded are irrelevant", async () => {
    const provider = new OpenAICompatProvider("c", BASE, null);
    const mock = mockLemonade();
    mock.route("/v1/models", () =>
      json({
        data: [
          { id: "plain" },
          { id: "tagged", labels: ["chat", "vision"], downloaded: false },
        ],
      })
    );
    // Conservative capabilities (Q14): flags come from the models table, not tags.
    expect(await provider.listChatModels()).toEqual([
      { id: "plain", providerId: "c", vision: false, audioInput: false },
      { id: "tagged", providerId: "c", vision: false, audioInput: false },
    ]);
  });

  it("Bearer key rides every call (data plane included), unlike Lemonade", async () => {
    const provider = new OpenAICompatProvider("c", BASE, "sk-test");
    const mock = mockLemonade();
    mock.fallback(() => json({ data: [] }));
    await provider.listChatModels();
    expect(mock.lastCall("/v1/models")!.headers.authorization).toBe("Bearer sk-test");
    await provider.completion({ model: "m" }, new AbortController().signal);
    expect(mock.lastCall("/v1/chat/completions")!.headers.authorization).toBe("Bearer sk-test");
  });

  it("asControlPlane is null: no management surface on generic servers", () => {
    expect(new OpenAICompatProvider("c", BASE, null).asControlPlane()).toBeNull();
  });

  it("data-less model-list payload → empty list", async () => {
    const provider = new OpenAICompatProvider("c", BASE, null);
    const mock = mockLemonade();
    mock.route("/v1/models", () => json({ object: "list" }));
    expect(await provider.listChatModels()).toEqual([]);
  });
});

describe("lemonade adapter specifics", () => {
  it("asControlPlane returns the adapter itself", () => {
    const provider = new LemonadeProvider("l", "http://l.invalid.test", null);
    expect(provider.asControlPlane()).toBe(provider);
  });

  it("audio heuristic matches Gemma 4 E2B/E4B/12B ids, quants and never text-only siblings", () => {
    expect(lemonadeAudioCapable("Gemma-4-E4B-it-GGUF")).toBe(true);
    expect(lemonadeAudioCapable("user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL")).toBe(true);
    expect(lemonadeAudioCapable("Gemma-4-E2B-it-GGUF")).toBe(true);
    expect(lemonadeAudioCapable("Gemma-4-12B-it-MTP-GGUF")).toBe(true);
    expect(lemonadeAudioCapable("Gemma-4-26B-A4B-it-GGUF")).toBe(false);
    expect(lemonadeAudioCapable("Gemma-4-31B-it-GGUF")).toBe(false);
    expect(lemonadeAudioCapable("Qwen3-8B-it-GGUF")).toBe(false);
    expect(lemonadeAudioCapable("whisper-large-v3-GGUF")).toBe(false);
  });
});
