// Shared TTL cache for provider chat-model catalogs (60s TTL; concurrent
// callers share one upstream fetch). Extracted from the Lemonade adapter so
// every adapter gets identical cache semantics — exercised through both via
// the shared contract suite (tests/support/provider-contract.ts).

import type { ChatModel } from "./types";

export const MODELS_CACHE_TTL_MS = 60_000;

export class ChatModelCache {
  private cache: { at: number; models: ChatModel[] } | null = null;
  private inflight: Promise<ChatModel[]> | null = null;

  constructor(private readonly fetchModels: () => Promise<ChatModel[]>) {}

  list(): Promise<ChatModel[]> {
    if (this.cache && Date.now() - this.cache.at < MODELS_CACHE_TTL_MS) {
      return Promise.resolve(this.cache.models);
    }
    if (!this.inflight) {
      this.inflight = (async () => {
        const models = await this.fetchModels();
        this.cache = { at: Date.now(), models };
        return models;
      })().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }
}
