import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { CronExpressionParser } from "cron-parser";
import {
  DEFAULTS,
  EVENT_SETTING_KEY,
  INT_SETTING_KEYS,
  QUEUE_JOB_TYPES,
  invalidateSettingsCache,
  resolveEventConfig,
  type IntSettingKey,
  type QueueJobType,
} from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Model ids + instance-wide limits + per-event job configs (JSON values).
// memory.enabled + memory.events.* rows are written by M1 UI but already typed.
const STRING_KEYS = ["fast_model", "smart_model"] as const;
const BOOL_KEYS = ["memory.enabled", "mcp.enabled", "mcp.userServersEnabled", "mcp.userPrivateUrls", "auth.allowRegistration"] as const;
const EVENT_KEYS = QUEUE_JOB_TYPES.filter((t) => EVENT_SETTING_KEY[t] !== null) as Exclude<
  QueueJobType,
  "debug.echo"
>[];
// Settings rows are keyed by EVENT_SETTING_KEY values, not by job-type names.
const EVENT_SETTING_KEYS = EVENT_KEYS.map((t) => EVENT_SETTING_KEY[t]!) as string[];
const KEYS = [...STRING_KEYS, ...BOOL_KEYS, ...INT_SETTING_KEYS, ...EVENT_SETTING_KEYS] as const;
type Key = (typeof KEYS)[number];

const MAX_LEN = 200;
const INT_BOUNDS: Partial<Record<(typeof INT_SETTING_KEYS)[number], [number, number]>> = {
  "chat.windowMessages": [1, 200],
  "chat.firstTokenTimeoutMs": [1000, 3_600_000],
  "chat.sseHeartbeatMs": [100, 600_000],
  "chat.maxImagesPerMessage": [1, 10],
  "chat.maxWindowImages": [1, 40],
  "chat.maxUploadBytes": [1_048_576, 104_857_600],
  "chat.maxAudioBytes": [65_536, 33_554_432],
  "api.firstTokenTimeoutMs": [1, 3_600_000],
  "api.maxTokensDefault": [1, 32_768],
  "api.maxTokensCap": [1, 32_768],
  "memory.queue.concurrency": [1, 8],
  "memory.queue.claimIntervalMs": [1000, 60_000],
  "memory.queue.staleLeaseMs": [10_000, 86_400_000],
  "memory.queue.defaultMaxAttempts": [1, 10],
  "memory.queue.defaultBackoffMs": [1000, 3_600_000],
  "memory.queue.retentionDays": [1, 365],
  "memory.recall.tokenBudget": [50, 8000],
  "memory.recall.topK": [1, 50],
  "memory.transcript.msgTruncChars": [100, 4000],
  "memory.transcript.capChars": [2000, 200_000],
  "memory.dream.softDeadlineMs": [5_000, 3_600_000],
  "memory.dream.chunkSize": [5, 500],
  "memory.dream.insightsPerNight": [0, 20],
  "memory.dream.cardRebuildEvery": [2, 100],
  "mcp.maxToolRounds": [0, 16],
  "mcp.toolTimeoutMs": [1000, 300_000],
  "mcp.toolResultMaxChars": [500, 100_000],
  "mcp.maxUserServers": [1, 50],
};

function invalid() {
  return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
}

function validateEventConfig(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const allowed = new Set([
    "schedule",
    "idleMinutes",
    "cronExpr",
    "model",
    "timeoutMs",
    "maxAttempts",
    "backoffMs",
    "enabled",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!allowed.has(k)) return null;
    switch (k) {
      case "schedule":
        if (!["after_persist", "idle", "cron", "never"].includes(String(v))) return null;
        break;
      case "idleMinutes":
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1440) return null;
        break;
      case "cronExpr": {
        if (typeof v !== "string" || !v.trim() || v.length > 100) return null;
        try {
          CronExpressionParser.parse(v.trim());
        } catch {
          return null;
        }
        break;
      }
      case "model":
        if (typeof v !== "string" || !v.trim() || v.trim().length > MAX_LEN) return null;
        break;
      case "timeoutMs":
        if (!Number.isInteger(v) || (v as number) < 1000 || (v as number) > 3_600_000) return null;
        break;
      case "maxAttempts":
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 10) return null;
        break;
      case "backoffMs":
        if (!Number.isInteger(v) || (v as number) < 1000 || (v as number) > 3_600_000) return null;
        break;
      case "enabled":
        if (typeof v !== "boolean") return null;
        break;
    }
    out[k] = k === "cronExpr" || k === "model" ? String(v).trim() : v;
  }
  if (!("schedule" in out)) return null;
  return JSON.stringify(out);
}

function validate(key: Key, raw: unknown): string | null {
  if ((STRING_KEYS as readonly string[]).includes(key)) {
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (!value || value.length > MAX_LEN) return null;
    return value;
  }
  if ((BOOL_KEYS as readonly string[]).includes(key)) {
    if (typeof raw === "boolean") return String(raw);
    if (raw === "true" || raw === "false") return raw;
    return null;
  }
  if ((INT_SETTING_KEYS as readonly string[]).includes(key)) {
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isInteger(n)) return null;
    const [min, max] = INT_BOUNDS[key as (typeof INT_SETTING_KEYS)[number]]!; // bounds cover every int key
    if (n < min || n > max) return null;
    return String(n);
  }
  return validateEventConfig(raw); // remaining KEYS members are exactly the event keys
}

function readAll(): Record<string, unknown> {
  const stored = new Map<string, string>();
  for (const row of db.select({ key: settings.key, value: settings.value }).from(settings).all()) {
    stored.set(row.key, row.value);
  }
  const result: Record<string, unknown> = {};
  for (const key of KEYS) {
    const eventKey = EVENT_KEYS.find((t) => EVENT_SETTING_KEY[t] === key);
    if (eventKey) {
      // Always return the effective config (normalized defaults for absent/garbage rows)
      // so admin forms mirror what the worker actually applies.
      result[key] = resolveEventConfig(eventKey);
      continue;
    }
    const raw = stored.get(key);
    if (raw === undefined) {
      // Int keys expose the effective value (DEFAULTS) so forms mirror the server.
      result[key] = (INT_SETTING_KEYS as readonly string[]).includes(key)
        ? DEFAULTS[key as IntSettingKey]
        : null;
      continue;
    }
    if ((BOOL_KEYS as readonly string[]).includes(key)) {
      result[key] = raw === "true";
    } else if ((INT_SETTING_KEYS as readonly string[]).includes(key)) {
      const n = Number(raw);
      result[key] = Number.isFinite(n) ? n : null;
    } else {
      result[key] = raw;
    }
  }
  return result;
}

/**
 * GET /api/admin/settings (admin only) → { ok, values } for every typed key.
 * Absent rows are null (clients apply defaults), except per-event job configs
 * which always carry the effective (defaulted + normalized) config.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return NextResponse.json({ ok: true, values: readAll() });
}

/**
 * POST /api/admin/settings (admin only). At least one typed key must be
 * present; values are validated per-kind (strings, booleans, clamped ints,
 * per-event config JSON with cron validation). Unknown keys → 400.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalid();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();

  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) return invalid();
  const upserts: { key: Key; value: string }[] = [];
  const clears: Key[] = [];
  for (const [key, raw] of entries) {
    if (!(KEYS as readonly string[]).includes(key)) return invalid();
    // "" (or null) on a string key deletes the row → "unset" (e.g. empty fast_model).
    if ((STRING_KEYS as readonly string[]).includes(key) && (raw === "" || raw === null)) {
      clears.push(key as Key);
      continue;
    }
    const value = validate(key as Key, raw);
    if (value === null) return invalid();
    upserts.push({ key: key as Key, value });
  }

  for (const { key, value } of upserts) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }
  for (const key of clears) {
    await db.delete(settings).where(eq(settings.key, key)).run();
  }
  invalidateSettingsCache();

  return NextResponse.json({ ok: true, values: readAll() });
}
