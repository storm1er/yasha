// AI SDK seam (docs/AI-SDK-MIGRATION-PLAN.MD M1): the one place a provider
// row's data plane becomes an AI SDK language model. Both adapter types share
// the OpenAI-compatible chat implementation — AGENTS rule 1 keeps the wired
// surface to POST /v1/chat/completions; nothing else in the SDK (embeddings,
// images, realtime…) is reachable from here. Auth stays per adapter type: the
// Lemonade data plane is keyless, generic OpenAI servers get the Bearer token.

import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";

export class AiModelFactory {
  private readonly compat: OpenAICompatibleProvider;
  private readonly models = new Map<string, LanguageModelV4>();

  constructor(name: string, baseUrl: string, apiKey: string | null) {
    this.compat = createOpenAICompatible({
      name,
      baseURL: `${baseUrl}/v1`,
      ...(apiKey ? { apiKey } : {}),
      includeUsage: true,
    });
  }

  /** Memoized per upstream model id — the instances are stateless config wrappers. */
  model(upstreamModelId: string): LanguageModelV4 {
    let model = this.models.get(upstreamModelId);
    if (!model) {
      model = this.compat.chatModel(upstreamModelId);
      this.models.set(upstreamModelId, model);
    }
    return model;
  }
}
