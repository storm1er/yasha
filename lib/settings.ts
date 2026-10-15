// Instance-wide settings: typed reads over the `settings` key/value table with
// short-TTL caching (single web replica). Env vars act as hard caps only.

import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

export type ScheduleMode = "after_persist" | "idle" | "cron" | "never";

export const QUEUE_JOB_TYPES = [
  "chat.title_generation",
  "chat.audio_transcription",
  "memory.fact_extraction",
  "memory.thread_summary",
  "memory.dreaming",
  "import.gemini",
  "debug.echo",
] as const;
export type QueueJobType = (typeof QUEUE_JOB_TYPES)[number];

export const MEMORY_EVENT_TYPES: QueueJobType[] = [
  "memory.fact_extraction",
  "memory.thread_summary",
  "memory.dreaming",
];

// One settings row per job type holding the per-event config JSON.
export const EVENT_SETTING_KEY: Record<QueueJobType, string | null> = {
  "chat.title_generation": "chat.title_generation",
  "chat.audio_transcription": "chat.audio_transcription",
  "memory.fact_extraction": "memory.events.fact_extraction",
  "memory.thread_summary": "memory.events.thread_summary",
  "memory.dreaming": "memory.events.dreaming",
  // User-requested job without per-event admin config (fixed defaults below).
  "import.gemini": null,
  "debug.echo": null,
};

export const DEFAULTS = {
  "chat.windowMessages": 20,
  "chat.firstTokenTimeoutMs": 600000,
  "chat.maxImagesPerMessage": 4,
  "chat.maxWindowImages": 8,
  "chat.maxUploadBytes": 20971520,
  "chat.maxAudioBytes": 8388608,
  "api.firstTokenTimeoutMs": 15000,
  "api.maxTokensDefault": 512,
  "api.maxTokensCap": 1024,
  "memory.queue.concurrency": 1,
  "memory.queue.claimIntervalMs": 5000,
  "memory.queue.staleLeaseMs": 300000,
  "memory.queue.defaultMaxAttempts": 3,
  "memory.queue.defaultBackoffMs": 60000,
  "memory.queue.retentionDays": 7,
  "memory.recall.tokenBudget": 600,
  "memory.recall.topK": 12,
  "memory.transcript.msgTruncChars": 600,
  "memory.transcript.capChars": 12000,
  // Nightly dreaming (MEMORY-ENHANCEMENT-PLAN): soft deadline bounding the
  // chunked consolidation/insight loop (the job timeout is only a hung-call
  // watchdog), consolidation chunk size, insight budget, card rebuild cadence.
  "memory.dream.softDeadlineMs": 2400000,
  "memory.dream.chunkSize": 30,
  "memory.dream.insightsPerNight": 3,
  "memory.dream.cardRebuildEvery": 7,
  "mcp.maxToolRounds": 4,
  "mcp.toolTimeoutMs": 30000,
  "mcp.toolResultMaxChars": 8000,
  "mcp.maxUserServers": 5,
  // Chat imports (GEMINI-IMPORT-PLAN): upload cap, conversations per queue chunk,
  // per-message size cap, hard conversation stop, spool-file retention.
  "import.maxUploadBytes": 209715200,
  "import.chunkSize": 100,
  "import.maxMessageChars": 200000,
  "import.maxConversations": 50000,
  "import.spoolRetentionHours": 24,
} as const;

export type IntSettingKey = keyof typeof DEFAULTS;
export const INT_SETTING_KEYS = Object.keys(DEFAULTS) as IntSettingKey[];

// No model fallbacks by design: admins must pick fast/smart models in the
// Lemonade tab; background jobs stay unclaimed until one is configured.

const CACHE_TTL_MS = 3000;
let cache: { at: number; map: Map<string, string> } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

function rawMap(): Map<string, string> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  const map = new Map<string, string>();
  for (const row of db.select({ key: settings.key, value: settings.value }).from(settings).all()) {
    map.set(row.key, row.value);
  }
  cache = { at: Date.now(), map };
  return map;
}

export function getSetting(key: string): string | null {
  return rawMap().get(key) ?? null;
}

export function getSettingString(key: string, fallback = ""): string {
  const v = getSetting(key);
  return v && v.trim() ? v.trim() : fallback;
}

export function getSettingInt(key: IntSettingKey, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = getSetting(key);
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULTS[key];
  return Math.min(max, Math.max(min, n));
}

export function getSettingBool(key: string, fallback: boolean): boolean {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

export function memoryEnabled(): boolean {
  return getSettingBool("memory.enabled", true);
}

/** Public account creation — off-switch lives in Settings → Security (admin). */
export function registrationAllowed(): boolean {
  return getSettingBool("auth.allowRegistration", true);
}

// ── MCP (tools) ───────────────────────────────────────────────────────────────
// Bundled-out-of-the-box: default true; the admin kill-switch is
// Settings → Admin → Tools (MCP).

export function mcpEnabled(): boolean {
  return getSettingBool("mcp.enabled", true);
}

export function mcpMaxToolRounds(): number {
  return getSettingInt("mcp.maxToolRounds", 0, 16);
}

export function mcpToolTimeoutMs(): number {
  return getSettingInt("mcp.toolTimeoutMs", 1000, 300000);
}

export function mcpToolResultMaxChars(): number {
  return getSettingInt("mcp.toolResultMaxChars", 500, 100_000);
}

/** Users registering their own (remote-only) MCP servers — off by default. */
export function mcpUserServersEnabled(): boolean {
  return getSettingBool("mcp.userServersEnabled", false);
}

/** Allow user-owned MCP rows to point at private/LAN hosts (off = SSRF guard). */
export function mcpUserPrivateUrls(): boolean {
  return getSettingBool("mcp.userPrivateUrls", false) && process.env.MCP_ALLOW_PRIVATE_URLS !== "false";
}

export function mcpMaxUserServers(): number {
  return getSettingInt("mcp.maxUserServers", 1, 50);
}

// ── Models ───────────────────────────────────────────────────────────────────

export function fastModel(): string | null {
  return getSettingString("fast_model") || null;
}

export function smartModel(): string | null {
  return getSettingString("smart_model") || null;
}

export type EventConfig = {
  schedule: ScheduleMode;
  idleMinutes: number;
  cronExpr: string;
  /** null while no fast model is configured — jobs of that type stay unclaimed. */
  model: string | null;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  enabled: boolean;
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function clampString(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Read + normalize the per-event config row; missing/garbage rows fall back to defaults. */
export function resolveEventConfig(type: QueueJobType): EventConfig {
  const settingKey = EVENT_SETTING_KEY[type];
  const defaults = defaultEventConfig(type);
  if (!settingKey) return defaults;
  const raw = getSetting(settingKey);
  if (!raw) return defaults;
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    return defaults;
  }
  if (!obj) return defaults;
  const scheduleRaw = obj.schedule;
  const schedule: ScheduleMode =
    scheduleRaw === "after_persist" || scheduleRaw === "idle" || scheduleRaw === "cron" || scheduleRaw === "never"
      ? scheduleRaw
      : defaults.schedule;
  const enabled =
    obj.enabled === "false" ? false : obj.enabled === "true" || obj.enabled === true ? true : defaults.enabled;
  return {
    schedule,
    idleMinutes: clampInt(obj.idleMinutes, 1, 1440, defaults.idleMinutes),
    cronExpr: clampString(obj.cronExpr, 100) || defaults.cronExpr,
    model: clampString(obj.model, 200) || defaults.model,
    timeoutMs: clampInt(obj.timeoutMs, 1000, 3600000, defaults.timeoutMs),
    maxAttempts: clampInt(obj.maxAttempts, 1, 10, defaults.maxAttempts),
    backoffMs: clampInt(obj.backoffMs, 1000, 3600000, defaults.backoffMs),
    enabled,
  };
}

export function defaultEventConfig(type: QueueJobType): EventConfig {
  const base: EventConfig = {
    schedule: "after_persist",
    idleMinutes: 30,
    cronExpr: "0 4 * * *",
    model: fastModel(),
    // Local engines: these background jobs are expected to outlive a chat turn
    // (thinking aliases + long prompts), so give them room instead of racing.
    timeoutMs: 180000,
    maxAttempts: getSettingInt("memory.queue.defaultMaxAttempts"),
    backoffMs: getSettingInt("memory.queue.defaultBackoffMs"),
    enabled: true,
  };
  if (type === "memory.thread_summary") return { ...base, schedule: "idle", idleMinutes: 30 };
  // Dreaming = chunked consolidation + insight pass + card pass, bounded inside
  // the handler by memory.dream.softDeadlineMs; timeoutMs here is ONLY a
  // hung-call watchdog (D5) — overrunning it requeues with backoff and the
  // dream resumes from its rotation checkpoint.
  if (type === "memory.dreaming") return { ...base, schedule: "cron", cronExpr: "0 4 * * *", timeoutMs: 3600000 };
  // Chunked file import: one chunk per run on slow media, but chunks are short
  // (100 conversations); the 15 min only guards a wedged read.
  if (type === "import.gemini") return { ...base, timeoutMs: 900000 };
  if (type === "debug.echo") return { ...base, timeoutMs: 10000 };
  return base;
}

/**
 * Whether the worker may claim/execute rows of this type (force bypasses the
 * per-event schedule/model gate for manual runs).
 *
 * The instance memory-derivation switch (Settings → Memory) gates ONLY the
 * memory event types — off they are never claimed, manual `force` included.
 * Gemini import ingestion is user-requested data portability and always runs;
 * the switch affects it only through the opt-in learnFromImports chain, whose
 * fact_extraction jobs are memory types and gate out here. Titles, audio
 * transcription and debug jobs keep their OWN per-event config / `force`.
 */
export function jobTypeAllowed(type: QueueJobType, force = false): boolean {
  if (MEMORY_EVENT_TYPES.includes(type)) return memoryEnabled();
  // import.gemini has no per-event row: user-requested, needs no chat model.
  if (force || type === "import.gemini") return true;
  if (type === "debug.echo") return true;
  const cfg = resolveEventConfig(type);
  if (!cfg.enabled || cfg.schedule === "never") return false;
  if (!cfg.model) return false;
  return true;
}
