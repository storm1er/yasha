// Lemonade provider adapter: OpenAI-compatible data plane + the full Lemonade
// control plane (registry/pull/downloads/system-info//internal/pin).
// Logic moved verbatim from the former lib/lemonade-stream.ts +
// lib/lemonade-admin.ts; base URL/key now come from the provider row.

import { ChatModelCache } from "./model-cache";
import { AiModelFactory } from "./language-model";
import { MutationsDisabledError, type ChatModel, type ChatProvider, type ControlPlane } from "./types";
import type { LanguageModelV4 } from "@ai-sdk/provider";

/** True only when ADMIN_ALLOW_BACKEND_MUTATIONS is the exact string "true". */
export function backendMutationsEnabled(): boolean {
  return process.env.ADMIN_ALLOW_BACKEND_MUTATIONS === "true";
}

/**
 * Lemonade does not tag audio-capable chat models, so this adapter owns the
 * compatibility heuristic (Q14 auto-seed): models whose GGUF ships an audio
 * encoder in the mmproj (Gemma 4 conformer, projector gemma4a/gemma4ua in
 * strix-llama.cpp). Token match against lowercased ids covers registry ids
 * (Gemma-4-E4B-it-GGUF), user variants (user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL)
 * and quants; 26B-A4B/31B are text+image only and must NOT match. Admins
 * override via the models table.
 */
const AUDIO_INPUT_COMPAT = ["gemma-4-e2b", "gemma-4-e4b", "gemma-4-12b"] as const;
export function lemonadeAudioCapable(modelId: string): boolean {
  const lc = modelId.toLowerCase();
  return AUDIO_INPUT_COMPAT.some((token) => lc.includes(token));
}

async function assertMutationsAllowed(action: string): Promise<void> {
  if (!backendMutationsEnabled()) throw new MutationsDisabledError(action);
}

const GET_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 120_000;

/** Lemonade backend adapter (OpenAI-compatible data plane + control plane). */
export class LemonadeProvider implements ChatProvider, ControlPlane {
  readonly type = "lemonade" as const;

  /** Per-instance chat-model allowlist cache (shared TTL/in-flight semantics). */
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

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      cache: "no-store",
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`upstream_status_${res.status}`);
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new Error(`upstream_status_${res.status}`);
    return json as T;
  }

  // ── data plane ─────────────────────────────────────────────────────────────

  completion(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    // Completions carry no auth header (matches the historical behavior: the
    // Lemonade data plane is keyless even when the admin plane has a key).
    return fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  private aiModels: AiModelFactory | null = null;

  /** AI SDK model over the keyless data plane (M1); memoized per upstream id. */
  languageModel(upstreamModelId: string): LanguageModelV4 {
    this.aiModels ??= new AiModelFactory(this.id, this.baseUrl, null);
    return this.aiModels.model(upstreamModelId);
  }

  /**
   * GET ${baseUrl}/v1/models (no key) filtered to chat-capable entries:
   * labels contain "chat" AND (downloaded === true OR id starts with "openrouter").
   * Cached 60s; concurrent callers share one upstream fetch. Throws on failure.
   */
  listChatModels(): Promise<ChatModel[]> {
    return this.modelCache.list();
  }

  private async fetchChatModels(): Promise<ChatModel[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`);
    if (!res.ok) throw new Error(`upstream_models_status_${res.status}`);
    const json = (await res.json()) as { data?: unknown };
    const models: ChatModel[] = [];
    for (const entryRaw of Array.isArray(json.data) ? json.data : []) {
      if (!entryRaw || typeof entryRaw !== "object") continue;
      const entry = entryRaw as { id?: unknown; labels?: unknown; downloaded?: unknown };
      if (typeof entry.id !== "string" || !entry.id) continue;
      if (!Array.isArray(entry.labels) || !entry.labels.includes("chat")) continue;
      if (entry.downloaded !== true && !entry.id.startsWith("openrouter")) continue;
      models.push({
        id: entry.id,
        providerId: this.id,
        vision: entry.labels.includes("vision"),
        audioInput: lemonadeAudioCapable(entry.id),
      });
    }
    return models;
  }

  // ── control plane: GET-only helpers (never mutate) ─────────────────────────

  asControlPlane(): ControlPlane {
    return this;
  }

  health(): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>("/v1/health");
  }

  systemInfo(): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>("/v1/system-info");
  }

  systemStats(): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>("/v1/system-stats");
  }

  models(): Promise<{ data?: Record<string, unknown>[] } & Record<string, unknown>> {
    return this.getJson<{ data?: Record<string, unknown>[]} & Record<string, unknown>>("/v1/models");
  }

  downloads(): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>("/v1/downloads");
  }

  registrySearch(q: string): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>(`/v1/registry/search?q=${encodeURIComponent(q)}`);
  }

  /** Upstream expects the registry `checkpoint` (e.g. "unsloth/Qwen3-1.7B-GGUF"). */
  pullVariants(checkpoint: string): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>(
      `/v1/pull/variants?checkpoint=${encodeURIComponent(checkpoint)}`
    );
  }

  stats(): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>("/v1/stats");
  }

  loadedModels(): Promise<{ model_name?: string; pinned?: boolean }[]> {
    return this.getJson<{ all_models_loaded?: unknown }>("/v1/health").then((h) =>
      Array.isArray(h.all_models_loaded)
        ? (h.all_models_loaded as { model_name?: string; pinned?: boolean }[])
        : []
    );
  }

  /** GET /v1/models/{id}/options (read-only; available regardless of the mutation flag). */
  modelOptions(name: string): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>(
      `/v1/models/${encodeURIComponent(name)}/options`
    );
  }

  // ── control plane: mutating helpers (flag-gated; refuse unless
  //    ADMIN_ALLOW_BACKEND_MUTATIONS=true) ────────────────────────────────────
  // pull(model, opts) starts a streaming install and returns the job
  // snapshot; load/unload/del keep their model-only bodies.

  async pull(
    model: string,
    opts: {
      recipe?: string;
      checkpoint?: string;
      source?: string;
      mmproj?: string;
      vision?: boolean;
      embedding?: boolean;
      reranking?: boolean;
    } = {}
  ): Promise<Record<string, unknown>> {
    await assertMutationsAllowed("pull");
    const defined = Object.fromEntries(
      Object.entries(opts).filter(([, value]) => value !== undefined)
    );
    const result = await this.postJson<Record<string, unknown>>("/v1/pull", {
      model_name: model,
      stream: true,
      subscribe: false,
      do_not_upgrade: true,
      ...defined,
    });
    if (result.status === "error") {
      const message = result.message;
      throw new Error(typeof message === "string" && message ? message : "pull_failed");
    }
    return result;
  }

  async load(
    model: string,
    options: {
      ctx_size?: number;
      llamacpp_backend?: string;
      llamacpp_args?: string;
      merge_args?: boolean;
      pinned?: boolean;
    } = {}
  ): Promise<Record<string, unknown>> {
    await assertMutationsAllowed("load");
    return this.postJson<Record<string, unknown>>("/v1/load", { model_name: model, ...options });
  }

  async unload(model: string): Promise<Record<string, unknown>> {
    await assertMutationsAllowed("unload");
    return this.postJson<Record<string, unknown>>("/v1/unload", { model_name: model });
  }

  async del(model: string): Promise<Record<string, unknown>> {
    await assertMutationsAllowed("delete");
    return this.postJson<Record<string, unknown>>("/v1/delete", { model_name: model });
  }

  /** Persist per-model options server-side; null values clear a saved key. */
  async setModelOptions(
    name: string,
    options: Record<string, string | number | boolean | null>
  ): Promise<Record<string, unknown>> {
    await assertMutationsAllowed("set_model_options");
    return this.postJson<Record<string, unknown>>(
      `/v1/models/${encodeURIComponent(name)}/options`,
      options
    );
  }

  /** Toggle auto-evict protection for a currently loaded model (non-OpenAI endpoint). */
  async pin(name: string, pinned: boolean): Promise<Record<string, unknown>> {
    await assertMutationsAllowed("pin_model");
    return this.postJson<Record<string, unknown>>("/internal/pin", {
      model_name: name,
      pinned,
    });
  }

  async downloadsControl(
    id: string,
    action: "pause" | "cancel" | "remove"
  ): Promise<Record<string, unknown>> {
    await assertMutationsAllowed(`downloads_control_${action}`);
    return this.postJson<Record<string, unknown>>("/v1/downloads/control", { id, action });
  }
}
