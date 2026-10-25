// Generic OpenAI-compatible provider adapter: the portable core of the
// provider abstraction (docs/provider-plan.md). Speaks only
// GET /v1/models + POST /v1/chat/completions with optional Bearer auth —
// every server in that family (Ollama, vLLM, llama.cpp server, LM Studio,
// OpenRouter, any LiteLLM proxy) answers those.
//
// Such servers do NOT advertise vision/audio capability, so models normalize
// to conservative defaults (Q14): capabilities come from the admin-set flags
// in the `models` table (M2b), never guessed from the name.

import { ChatModelCache } from "./model-cache";
import type { ChatModel, ChatProvider, ControlPlane } from "./types";

export class OpenAICompatProvider implements ChatProvider {
  readonly type = "openai_compatible" as const;

  private readonly modelCache = new ChatModelCache(() => this.fetchChatModels());

  constructor(
    readonly id: string,
    readonly baseUrl: string,
    private readonly apiKey: string | null
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  completion(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    // Unlike Lemonade's keyless data plane, generic OpenAI servers expect the
    // Bearer token on every request, completions included.
    return fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** GET /v1/models → every entry with a string id (no capability labels). */
  listChatModels(): Promise<ChatModel[]> {
    return this.modelCache.list();
  }

  private async fetchChatModels(): Promise<ChatModel[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: this.headers(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`upstream_models_status_${res.status}`);
    const json = (await res.json()) as { data?: unknown };
    const models: ChatModel[] = [];
    for (const entryRaw of Array.isArray(json.data) ? json.data : []) {
      if (!entryRaw || typeof entryRaw !== "object") continue;
      const entry = entryRaw as { id?: unknown };
      if (typeof entry.id !== "string" || !entry.id) continue;
      models.push({ id: entry.id, providerId: this.id, vision: false, audioInput: false });
    }
    return models;
  }

  /** This adapter manages nothing: no registry, no pull, no load/unload. */
  asControlPlane(): ControlPlane | null {
    return null;
  }
}
