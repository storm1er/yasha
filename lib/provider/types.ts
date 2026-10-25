// Provider abstraction — shared types (docs/provider-plan.md).
// ChatProvider is the data-plane contract every backend adapter implements;
// ControlPlane is the OPTIONAL admin capability (Lemonade today). Adapters
// live in lib/provider/; consumers resolve them through lib/provider/registry.

export const PROVIDER_TYPES = ["lemonade", "openai_compatible"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Chat-capable model entry, normalized from the provider's model list. */
export type ChatModel = {
  id: string;
  /** Serving provider's id; becomes `owned_by` on the /v1 facade (Q20). */
  providerId: string;
  vision: boolean;
  audioInput: boolean;
};

/**
 * Data-plane contract: raw chat-completions passthrough + the normalized
 * chat-model allowlist. `completion` returns the raw upstream Response
 * (SSE or JSON body) so callers keep full control of streaming semantics.
 */
export interface ChatProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly baseUrl: string;
  /** POST {base}/v1/chat/completions with an assembled OpenAI body. */
  completion(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  /** Chat-capable model list (TTL-cached, deduped upstream fetch). */
  listChatModels(): Promise<ChatModel[]>;
  /**
   * Control plane when this provider offers one (Q10); null = "cannot manage
   * models" — the plain openai_compatible adapter answers null, the admin
   * console then hides these sections and routes answer 501.
   */
  asControlPlane(): ControlPlane | null;
}

/** Upstream rejected a mutating control-plane call while mutations are off. */
export class MutationsDisabledError extends Error {
  constructor(action: string) {
    super(`mutations_disabled:${action}`);
    this.name = "MutationsDisabledError";
  }
}

/**
 * Optional admin capability implemented only by providers with a management
 * surface (Lemonade). Absence is an answer: routes 501, UI hides the sections.
 * Response shapes stay raw (passthrough) — the admin UI renders them leniently.
 */
export interface ControlPlane {
  // ── GET-only (never mutate) ────────────────────────────────────────────────
  health(): Promise<Record<string, unknown>>;
  systemInfo(): Promise<Record<string, unknown>>;
  systemStats(): Promise<Record<string, unknown>>;
  models(): Promise<{ data?: Record<string, unknown>[] } & Record<string, unknown>>;
  downloads(): Promise<Record<string, unknown>>;
  registrySearch(q: string): Promise<Record<string, unknown>>;
  pullVariants(checkpoint: string): Promise<Record<string, unknown>>;
  stats(): Promise<Record<string, unknown>>;
  loadedModels(): Promise<{ model_name?: string; pinned?: boolean }[]>;
  modelOptions(name: string): Promise<Record<string, unknown>>;
  // ── mutating (gated by backendMutationsEnabled()) ─────────────────────────
  pull(
    model: string,
    opts: {
      recipe?: string;
      checkpoint?: string;
      source?: string;
      mmproj?: string;
      vision?: boolean;
      embedding?: boolean;
      reranking?: boolean;
    }
  ): Promise<Record<string, unknown>>;
  load(
    model: string,
    options?: {
      ctx_size?: number;
      llamacpp_backend?: string;
      llamacpp_args?: string;
      merge_args?: boolean;
      pinned?: boolean;
    }
  ): Promise<Record<string, unknown>>;
  unload(model: string): Promise<Record<string, unknown>>;
  del(model: string): Promise<Record<string, unknown>>;
  setModelOptions(
    name: string,
    options: Record<string, string | number | boolean | null>
  ): Promise<Record<string, unknown>>;
  /** Lemonade /internal/pin — auto-evict protection for a loaded model. */
  pin(name: string, pinned: boolean): Promise<Record<string, unknown>>;
  downloadsControl(
    id: string,
    action: "pause" | "cancel" | "remove"
  ): Promise<Record<string, unknown>>;
}
