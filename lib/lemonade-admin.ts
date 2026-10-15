// Typed Lemonade admin helpers.
//
// GET-only endpoints (health/systemInfo/systemStats/models/downloads/
// registrySearch/pullVariants/stats) are always available.
//
// MUTATING helpers (pull/load/unload/del/downloadsControl) exist for a
// self-hosted Lemonade but REFUSE to run unless ADMIN_ALLOW_MUTATIONS ===
// "true" on the app process. The default (flag absent/false) throws
// MutationsDisabledError BEFORE any fetch, so a shared Lemonade server is
// never touched by mutating calls.

import { BASE_URL } from "./lemonade-stream";

export class MutationsDisabledError extends Error {
  constructor(action: string) {
    super(`mutations_disabled:${action}`);
    this.name = "MutationsDisabledError";
  }
}

/** True only when ADMIN_ALLOW_MUTATIONS is the exact string "true". */
export function mutationsEnabled(): boolean {
  return process.env.ADMIN_ALLOW_MUTATIONS === "true";
}

async function assertMutationsAllowed(action: string): Promise<void> {
  if (!mutationsEnabled()) throw new MutationsDisabledError(action);
}

// ── response shapes (lenient; upstream fields kept raw via passthrough) ──────

export type LemonadeHealth = {
  status?: string;
  version?: string;
  uptime?: number;
  [k: string]: unknown;
};

export type LemonadeSystemInfo = {
  platform?: string;
  arch?: string;
  cpus?: number;
  memory?: Record<string, unknown>;
  gpus?: unknown;
  server_version?: string;
  [k: string]: unknown;
};

export type LemonadeSystemStats = {
  memory?: Record<string, unknown>;
  gpu?: unknown;
  [k: string]: unknown;
};

export type LemonadeStats = {
  total_requests?: number;
  total_tokens?: number;
  [k: string]: unknown;
};

export type LemonadeModel = {
  id?: string;
  object?: string;
  recipe?: string;
  size?: number | string | null;
  downloaded?: boolean;
  labels?: string[];
  [k: string]: unknown;
};

export type LemonadeModelsResponse = {
  object?: string;
  data?: LemonadeModel[];
  [k: string]: unknown;
};

export type LemonadeDownload = {
  id?: string;
  model?: string;
  progress?: number;
  speed?: number;
  status?: string;
  [k: string]: unknown;
};

export type LemonadeDownloadsResponse = {
  downloads?: LemonadeDownload[];
  activeCount?: number;
  maxActive?: number;
  [k: string]: unknown;
};

export type LemonadeDownloadJob = {
  id?: string;
  model_name?: string;
  status?: string;
  running?: boolean;
  percent?: number;
  bytes_downloaded?: number;
  bytes_total?: number;
  total_download_size?: number;
  file?: string;
  file_index?: number;
  total_files?: number;
  complete?: boolean;
  error?: string;
  [k: string]: unknown;
};

export type LemonadeRegistryEntry = {
  name?: string;
  recipe?: string;
  size?: number | string | null;
  labels?: string[];
  [k: string]: unknown;
};

export type LemonadeRegistrySearchResponse = {
  results?: LemonadeRegistryEntry[];
  [k: string]: unknown;
};

export type LemonadePullVariant = {
  file?: string;
  size?: number | string | null;
  quant?: string;
  [k: string]: unknown;
};

export type LemonadePullVariantsResponse = {
  variants?: LemonadePullVariant[];
  [k: string]: unknown;
};

export type LemonadeMutationResult = { [k: string]: unknown };

// ── internals ─────────────────────────────────────────────────────────────────

const GET_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 120_000;

function lemonadeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = process.env.LEMONADE_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: lemonadeHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(GET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstream_status_${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...lemonadeHeaders() },
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

// ── GET-only helpers (never mutate) ──────────────────────────────────────────

export function health(): Promise<LemonadeHealth> {
  return getJson<LemonadeHealth>("/v1/health");
}

export function systemInfo(): Promise<LemonadeSystemInfo> {
  return getJson<LemonadeSystemInfo>("/v1/system-info");
}

export function systemStats(): Promise<LemonadeSystemStats> {
  return getJson<LemonadeSystemStats>("/v1/system-stats");
}

export function models(): Promise<LemonadeModelsResponse> {
  return getJson<LemonadeModelsResponse>("/v1/models");
}

export function downloads(): Promise<LemonadeDownloadsResponse> {
  return getJson<LemonadeDownloadsResponse>("/v1/downloads");
}

export function registrySearch(q: string): Promise<LemonadeRegistrySearchResponse> {
  return getJson<LemonadeRegistrySearchResponse>(
    `/v1/registry/search?q=${encodeURIComponent(q)}`
  );
}

/** Upstream expects the registry `checkpoint` (e.g. "unsloth/Qwen3-1.7B-GGUF"). */
export function pullVariants(name: string): Promise<LemonadePullVariantsResponse> {
  return getJson<LemonadePullVariantsResponse>(
    `/v1/pull/variants?checkpoint=${encodeURIComponent(name)}`
  );
}

export function stats(): Promise<LemonadeStats> {
  return getJson<LemonadeStats>("/v1/stats");
}

export type LemonadeModelOptions = {
  model_name?: string;
  recipe?: string;
  saved?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  effective?: Record<string, unknown>;
  resolved_ctx_size?: number;
  [k: string]: unknown;
};

export type LoadedModelEntry = {
  model_name?: string;
  checkpoint?: string;
  pinned?: boolean;
  device?: string;
  [k: string]: unknown;
};

export function loadedModels(): Promise<LoadedModelEntry[]> {
  return getJson<Partial<LemonadeHealth>>("/v1/health").then((h) =>
    Array.isArray(h.all_models_loaded) ? (h.all_models_loaded as LoadedModelEntry[]) : []
  );
}

/** GET /v1/models/{id}/options (read-only; available regardless of the mutation flag). */
export function modelOptions(name: string): Promise<LemonadeModelOptions> {
  return getJson<LemonadeModelOptions>(`/v1/models/${encodeURIComponent(name)}/options`);
}

// ── mutating helpers (flag-gated; refuse unless ADMIN_ALLOW_MUTATIONS=true) ──
// pull(model, PullOptions) starts a streaming install and returns the job
// snapshot; load/unload/del keep their model-only bodies.

export type PullOptions = {
  recipe?: string;
  checkpoint?: string;
  source?: string;
  mmproj?: string;
  vision?: boolean;
  embedding?: boolean;
  reranking?: boolean;
};

export async function pull(
  model: string,
  opts: PullOptions = {}
): Promise<LemonadeDownloadJob> {
  await assertMutationsAllowed("pull");
  const defined = Object.fromEntries(
    Object.entries(opts).filter(([, value]) => value !== undefined)
  );
  const result = await postJson<LemonadeDownloadJob>("/v1/pull", {
    model_name: model,
    stream: true,
    subscribe: false,
    do_not_upgrade: true,
    ...defined,
  });
  if ((result as object & { status?: unknown }).status === "error") {
    const message = (result as { message?: unknown }).message;
    throw new Error(typeof message === "string" && message ? message : "pull_failed");
  }
  return result;
}

export type LoadOptions = {
  ctx_size?: number;
  llamacpp_backend?: string;
  llamacpp_args?: string;
  merge_args?: boolean;
  pinned?: boolean;
};

export async function load(model: string, options: LoadOptions = {}): Promise<LemonadeMutationResult> {
  await assertMutationsAllowed("load");
  return postJson<LemonadeMutationResult>("/v1/load", { model_name: model, ...options });
}

export async function unload(model: string): Promise<LemonadeMutationResult> {
  await assertMutationsAllowed("unload");
  return postJson<LemonadeMutationResult>("/v1/unload", { model_name: model });
}

export async function del(model: string): Promise<LemonadeMutationResult> {
  await assertMutationsAllowed("delete");
  return postJson<LemonadeMutationResult>("/v1/delete", { model_name: model });
}

/** Persist per-model options server-side; null values clear a saved key. */
export async function setModelOptions(
  name: string,
  options: Record<string, string | number | boolean | null>
): Promise<LemonadeModelOptions> {
  await assertMutationsAllowed("set_model_options");
  return postJson<LemonadeModelOptions>(
    `/v1/models/${encodeURIComponent(name)}/options`,
    options
  );
}

/** Toggle auto-evict protection for a currently loaded model. */
export async function pinModel(
  name: string,
  pinned: boolean
): Promise<Record<string, unknown>> {
  await assertMutationsAllowed("pin_model");
  return postJson<Record<string, unknown>>("/internal/pin", {
    model_name: name,
    pinned,
  });
}

export async function downloadsControl(
  id: string,
  action: "pause" | "cancel" | "remove"
): Promise<Record<string, unknown>> {
  await assertMutationsAllowed(`downloads_control_${action}`);
  return postJson<Record<string, unknown>>("/v1/downloads/control", { id, action });
}
