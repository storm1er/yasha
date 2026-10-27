// Shared provider contract suite (docs/provider-plan.md Q24): every adapter —
// including the Lemonade fixture adapter — must satisfy the same ChatProvider
// data-plane semantics. Run it with describeProviderContract(name, factory).

import { describe, expect, it, vi } from "vitest";
import { streamText } from "ai";
import type { ChatProvider } from "@/lib/provider/types";
import { json, mockLemonade, sseChatCompletion } from "./lemonade";

export type ProviderFactory = (id: string, baseUrl: string, apiKey: string | null) => ChatProvider;

const BASE = "http://contract.invalid.test";

export function describeProviderContract(name: string, make: ProviderFactory): void {
  describe(`provider contract: ${name}`, () => {
    it("listChatModels normalizes valid entries and skips junk", async () => {
      const provider = make("px", BASE, null);
      const mock = mockLemonade();
      mock.route("/v1/models", () =>
        json({
          data: [
            null,
            7,
            {},
            { id: "" },
            { id: "good-model", labels: ["chat"], downloaded: true },
          ],
        })
      );
      expect(await provider.listChatModels()).toEqual([
        { id: "good-model", providerId: "px", vision: false, audioInput: false },
      ]);
    });

    it("upstream model-list failure throws upstream_models_status_N and is not cached", async () => {
      const provider = make("px", BASE, null);
      const mock = mockLemonade();
      let fail = true;
      mock.route("/v1/models", () => {
        if (fail) return new Response("x", { status: 503 });
        return json({ data: [{ id: "late", labels: ["chat"], downloaded: true }] });
      });
      await expect(provider.listChatModels()).rejects.toThrow("upstream_models_status_503");
      fail = false;
      expect((await provider.listChatModels()).map((m) => m.id)).toEqual(["late"]);
      expect(mock.calls.filter((c) => c.url.includes("/v1/models")).length).toBe(2);
    });

    it("concurrent callers share one in-flight list fetch; result cached until TTL expiry", async () => {
      vi.useFakeTimers();
      const provider = make("px", BASE, null);
      let hits = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      vi.stubGlobal("fetch", vi.fn(async () => {
        hits += 1;
        await gate;
        return json({ data: [{ id: "shared", labels: ["chat"], downloaded: true }] });
      }));
      const p1 = provider.listChatModels();
      const p2 = provider.listChatModels();
      expect(hits).toBe(1); // shared in-flight fetch
      release();
      const [a, b] = await Promise.all([p1, p2]);
      expect(a).toBe(b); // cache serves the identical array
      vi.setSystemTime(Date.now() + 61_000);
      await provider.listChatModels();
      expect(hits).toBe(2); // TTL expiry refetches
      vi.useRealTimers();
    });

    it("completion posts the assembled body and returns the raw Response", async () => {
      const provider = make("px", BASE, null);
      const mock = mockLemonade();
      mock.route("/v1/chat/completions", () => new Response("upstream says no", { status: 500 }));
      const controller = new AbortController();
      const res = await provider.completion({ model: "m", messages: [], stream: true }, controller.signal);
      expect(res.status).toBe(500); // raw passthrough: no throwing, callers map errors
      const call = mock.lastCall("/v1/chat/completions")!;
      expect(call.method).toBe("POST");
      expect(call.url).toBe(`${BASE}/v1/chat/completions`);
      expect(call.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(call.body!)).toEqual({ model: "m", messages: [], stream: true });
      expect(call.signal).toBe(controller.signal);
    });

    it("languageModel: memoized AI SDK model on the /v1 plane, usage included", async () => {
      const provider = make("px", BASE, null);
      const mock = mockLemonade();
      mock.route("/v1/chat/completions", () =>
        sseChatCompletion("sdk hi", { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
      );
      const model = provider.languageModel("m1");
      expect(provider.languageModel("m1")).toBe(model); // memoized per upstream id
      const result = streamText({ model, prompt: "hi", maxRetries: 0 });
      expect(await result.text).toBe("sdk hi");
      expect(await result.totalUsage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
      const call = mock.lastCall("/v1/chat/completions")!;
      expect(call.method).toBe("POST");
      expect(call.url).toBe(`${BASE}/v1/chat/completions`);
      const body = JSON.parse(call.body!) as Record<string, unknown>;
      expect(body.model).toBe("m1");
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    });
  });
}
