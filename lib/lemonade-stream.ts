// Shared Lemonade upstream plumbing:
// - per-user in-flight generation gate (shared by /api/chat + /v1/chat/completions)
// - SSE `data:` payload iteration for upstream chat streams
// - recursive stripping of `reasoning`/`reasoning_details` upstream fields
// - cached chat-model allowlist derived from GET /v1/models

const rawBaseUrl = process.env.LEMONADE_BASE_URL;
if (!rawBaseUrl) {
  throw new Error(
    "LEMONADE_BASE_URL is not set — define it in .env (see .env.example) to point Yasha at your Lemonade instance."
  );
}
export const BASE_URL = rawBaseUrl.replace(/\/+$/, "");

// Naive rate limit: 1 in-flight generation per user. Module-scope Map is
// per-process only (single Next dev/prod instance); resets on server restart.
// Keyed by userId and shared across the session route (/api/chat) and the
// API-key route (/v1/chat/completions), so a user cannot double-book upstream.
const inFlight = new Map<string, AbortController>();

/** Claims the per-user generation slot, or returns null if one is already in flight. */
export function tryAcquireGeneration(userId: string): AbortController | null {
  if (inFlight.has(userId)) return null;
  const controller = new AbortController();
  inFlight.set(userId, controller);
  return controller;
}

export function releaseGeneration(userId: string): void {
  inFlight.delete(userId);
}

export function hasInFlightGeneration(userId: string): boolean {
  return inFlight.has(userId);
}

/**
 * Recursively removes every key whose name contains "reasoning" (in place):
 * upstream `reasoning`/`reasoning_details` deltas plus `reasoning_tokens` and
 * any other reasoning-derived usage metadata. Ensures no reasoning trace,
 * counter, or field name ever reaches /v1 clients.
 */
export function stripReasoningFields<T>(value: unknown): T {
  if (Array.isArray(value)) {
    for (const item of value) stripReasoningFields(item);
    return value as T;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase().includes("reasoning")) delete obj[key];
    }
    for (const nested of Object.values(obj)) stripReasoningFields(nested);
  }
  return value as T;
}

/**
 * Iterates `data:` payloads of an upstream SSE body, including the final
 * "[DONE]" sentinel. Throws if the underlying read fails mid-stream.
 */
export async function forEachSseData(
  body: ReadableStream<Uint8Array>,
  onData: (payload: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail.startsWith("data:")) onData(tail.slice(5).trim());
}

export type ChatModel = { id: string; ownedBy: "lemonade" | "openrouter"; vision: boolean };

const MODELS_CACHE_TTL_MS = 60_000;
let modelsCache: { at: number; models: ChatModel[] } | null = null;
let modelsFetch: Promise<ChatModel[]> | null = null;

/**
 * GET ${BASE_URL}/v1/models (no key) filtered to chat-capable entries:
 * labels contain "chat" AND (downloaded === true OR id starts with "openrouter").
 * Cached module-level for 60s; concurrent callers share one upstream fetch.
 * Throws on upstream failure.
 */
export function fetchChatModels(): Promise<ChatModel[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) {
    return Promise.resolve(modelsCache.models);
  }
  if (!modelsFetch) {
    modelsFetch = (async () => {
      const res = await fetch(`${BASE_URL}/v1/models`);
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
          ownedBy: entry.downloaded === true ? "lemonade" : "openrouter",
          vision: entry.labels.includes("vision"),
        });
      }
      modelsCache = { at: Date.now(), models };
      return models;
    })().finally(() => {
      modelsFetch = null;
    });
  }
  return modelsFetch;
}
