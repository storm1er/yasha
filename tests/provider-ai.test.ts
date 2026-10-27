// M1 (AI-SDK-MIGRATION-PLAN): the AI SDK data-plane seam per provider type.
// Auth split + the AGENTS rule-1 endpoint policy expressed against SDK-driven
// traffic (the fetch guard in setup.ts already rejects any other host; this
// pins WHICH endpoints the SDK itself may touch).

import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { LemonadeProvider } from "@/lib/provider/lemonade";
import { OpenAICompatProvider } from "@/lib/provider/openai-compatible";
import { mockLemonade, sseChatCompletion, type LemonadeMock } from "./support/lemonade";

const BASE = "http://aisdk.invalid.test";

function endpointsOf(mock: LemonadeMock): string[] {
  return mock.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
}

describe("AI SDK data plane — auth per provider type", () => {
  it("Lemonade stays keyless through the SDK even when the row has a key", async () => {
    const provider = new LemonadeProvider("l", BASE, "admin-key");
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("ok"));
    await streamText({ model: provider.languageModel("gemma"), prompt: "hi", maxRetries: 0 }).consumeStream();
    const call = mock.lastCall("/v1/chat/completions")!;
    expect(call.headers.authorization).toBeUndefined();
  });

  it("openai_compatible sends the Bearer key through the SDK", async () => {
    const provider = new OpenAICompatProvider("c", BASE, "sk-test");
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("ok"));
    await streamText({ model: provider.languageModel("m"), prompt: "hi", maxRetries: 0 }).consumeStream();
    expect(mock.lastCall("/v1/chat/completions")!.headers.authorization).toBe("Bearer sk-test");
  });
});

describe("AI SDK data plane — endpoint policy (AGENTS rule 1)", () => {
  it("openai_compatible: SDK traffic is POST /v1/chat/completions only", async () => {
    const provider = new OpenAICompatProvider("c", BASE, null);
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("ok"));
    const res = streamText({ model: provider.languageModel("m"), prompt: "hi", maxRetries: 0 });
    await res.consumeStream();
    await res.text;
    expect(endpointsOf(mock)).toEqual(["POST /v1/chat/completions"]);
  });

  it("lemonade: SDK chat traffic only (control plane never crossed into the SDK)", async () => {
    const provider = new LemonadeProvider("l", BASE, null);
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("ok"));
    const res = streamText({ model: provider.languageModel("gemma"), prompt: "hi", maxRetries: 0 });
    await res.consumeStream();
    await res.text;
    expect(endpointsOf(mock)).toEqual(["POST /v1/chat/completions"]);
  });
});
