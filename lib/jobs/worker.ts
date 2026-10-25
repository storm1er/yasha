// In-process queue worker (PLAN §4). Single-replica assumption; SQLite WAL.
// Lifecycle guards are non-negotiable: register() also runs during `next build`
// and on every dev HMR recompile → build-phase skip + globalThis singleton.

import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "@/lib/db";
import { jobCheckpoints, jobs, messages, threads, user, type Job } from "@/lib/db/schema";
import { dedupeKeyFor, patchJob } from "./queue";
import {
  MEMORY_EVENT_TYPES,
  getSettingInt,
  jobTypeAllowed,
  memoryEnabled,
  resolveEventConfig,
  type EventConfig,
  type QueueJobType,
} from "@/lib/settings";
import { forEachSseData } from "@/lib/provider/http";
import { routeModel } from "@/lib/provider/catalog";
import { handleTitleGeneration } from "./handlers";
import { handleGeminiImport, sweepGeminiSpools } from "./gemini-import";
import { handleAudioTranscription } from "./audio-transcribe";
import { handleFactExtraction } from "@/lib/memory/extract";
import { handleThreadSummary } from "@/lib/memory/summarize";
import { handleDreaming } from "@/lib/memory/dream";
import { getUserMemoryEnabled } from "@/lib/memory/prefs";

export type JobTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type JobHandler = (ctx: {
  job: Job;
  payload: Record<string, unknown>;
  cfg: EventConfig;
  signal: AbortSignal;
  heartbeat: () => void;
  // Advance the durable watermark (advanced in the SAME txn that marks the
  // row succeeded — PLAN §1 `job_checkpoints`).
  setCheckpoint: (throughMessageId: string) => void;
  // Writes deferred into the succeeded-transaction (keeps LLM work outside
  // the write txn while staying atomic with the checkpoint advance).
  addCommit: (fn: (tx: JobTx) => void) => void;
}) => Promise<Record<string, unknown>>;

export const HANDLERS: Partial<Record<QueueJobType, JobHandler>> = {
  "debug.echo": async ({ payload }) => ({ echoed: String(payload.text ?? "") }),
  "chat.title_generation": handleTitleGeneration,
  "chat.audio_transcription": handleAudioTranscription,
  "memory.fact_extraction": handleFactExtraction,
  "memory.thread_summary": handleThreadSummary,
  "memory.dreaming": handleDreaming,
  "import.gemini": handleGeminiImport,
};

// Event types the idle/cron sweepers consider (must have a handler registered).
const SCHEDULED_EVENT_TYPES = MEMORY_EVENT_TYPES.filter((t) => HANDLERS[t] !== undefined).concat(
  HANDLERS["chat.title_generation"] ? ["chat.title_generation"] : []
);

type ActiveRun = { type: QueueJobType; controller: AbortController; heart: NodeJS.Timeout };
const active = new Map<string, ActiveRun>();

const HEARTBEAT_MS = 15_000;
const PRUNE_INTERVAL_MS = 60_000;
const SWEEP_MAX = 20;

interface WorkerGlobalHandle {
  interval?: ReturnType<typeof setInterval>;
  started?: boolean;
  lastPruneAt?: number;
  lastTickAt?: number;
  cronEnqueued?: Map<string, string>;
  importSpoolsSwept?: boolean;
}

declare global {
  var __yashaWorker: WorkerGlobalHandle | undefined;
}

export function startWorker(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const g = (globalThis as { __yashaWorker?: WorkerGlobalHandle }).__yashaWorker ?? {};
  (globalThis as { __yashaWorker?: WorkerGlobalHandle }).__yashaWorker = g;
  if (!g.importSpoolsSwept) {
    g.importSpoolsSwept = true;
    const removed = sweepGeminiSpools();
    if (removed > 0) console.log(`[jobs] swept ${removed} expired import spool(s)`);
  }
  if (g.interval) clearInterval(g.interval);
  g.cronEnqueued ??= new Map();
  const tickMs = Math.min(60_000, Math.max(1000, getSettingInt("memory.queue.claimIntervalMs")));
  g.interval = setInterval(() => {
    void tick().catch((err) => console.error("[jobs] tick failed:", err));
  }, tickMs);
  // Never keep a process alive on the worker loop (build/dev safety).
  g.interval.unref?.();
  if (!g.started) {
    g.started = true;
    console.log("[jobs] worker started");
  }
}

export function stopWorker(): void {
  const g = (globalThis as { __yashaWorker?: WorkerGlobalHandle }).__yashaWorker;
  if (g?.interval) clearInterval(g.interval);
  if (g) g.started = false;
}

function isForced(job: Job): boolean {
  if (!job.payloadJson) return false;
  try {
    const p: unknown = JSON.parse(job.payloadJson);
    return Boolean(p && typeof p === "object" && (p as { force?: unknown }).force === true);
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  const g = (globalThis as { __yashaWorker?: WorkerGlobalHandle }).__yashaWorker ?? {};
  const nowMs = Date.now();

  // 0. Prune succeeded rows past retention (once per minute; failed persist).
  if (nowMs - (g.lastPruneAt ?? 0) >= PRUNE_INTERVAL_MS) {
    g.lastPruneAt = nowMs;
    const retentionMs = getSettingInt("memory.queue.retentionDays", 1, 3650) * 86_400_000;
    db.delete(jobs)
      .where(and(eq(jobs.status, "succeeded"), lt(jobs.finishedAt, new Date(nowMs - retentionMs))))
      .run();
    // job_checkpoints has no FK (threadId '' would violate one) → orphan sweep.
    db.run(sql`DELETE FROM job_checkpoints WHERE thread_id <> '' AND thread_id NOT IN (SELECT id FROM threads)`);
  }

  // 1. Reclaim running rows whose lease went stale.
  const staleLeaseMs = getSettingInt("memory.queue.staleLeaseMs", 10_000, 86_400_000);
  const staleCutoff = new Date(nowMs - staleLeaseMs);
  const running = db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "running"))
    .all();
  for (const row of running) {
    const hb = row.heartbeatAt ?? row.lockedAt;
    if (hb && hb.getTime() >= staleCutoff.getTime()) continue;
    const attempts = row.attempts + 1;
    if (attempts >= Math.max(1, row.maxAttempts)) {
      patchJob(row.id, {
        status: "failed",
        attempts,
        finishedAt: new Date(),
        lastError: "lease_expired (worker died mid-run?)",
      });
    } else {
      patchJob(row.id, {
        status: "pending",
        attempts,
        lockedAt: null,
        heartbeatAt: null,
        runAfter: new Date(Date.now() + 10_000),
      });
    }
  }

  // Sweeps: idle + cron enqueues (minute-gated), only for enabled schedules.
  if (nowMs - (g.lastTickAt ?? 0) >= 60_000) {
    g.lastTickAt = nowMs;
    sweepSchedules(nowMs);
  }

  // 2. Claim up to (concurrency - inFlight) rows, at most one per type.
  const concurrency = getSettingInt("memory.queue.concurrency", 1, 8);
  const need = concurrency - active.size;
  if (need <= 0) return;
  const inflightTypes = new Set<QueueJobType>();
  for (const runInfo of active.values()) inflightTypes.add(runInfo.type);
  const candidates = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, new Date())))
    .orderBy(asc(jobs.runAfter))
    .limit(50)
    .all();
  const claimed: Job[] = [];
  const pickedTypes = new Set<QueueJobType>();
  for (const row of candidates) {
    if (claimed.length >= need) break;
    const type = row.type as QueueJobType;
    if (inflightTypes.has(type) || pickedTypes.has(type)) continue;
    pickedTypes.add(type);
    if (!HANDLERS[type]) {
      patchJob(row.id, { status: "cancelled", finishedAt: new Date(), lastError: "no_handler" });
      continue;
    }
    if (!jobTypeAllowed(type, isForced(row))) {
      patchJob(row.id, { status: "cancelled", finishedAt: new Date(), lastError: "disabled" });
      continue;
    }
    // Per-user privacy opt-out kills memory jobs even on manual force runs.
    if (MEMORY_EVENT_TYPES.includes(type) && !getUserMemoryEnabled(row.userId)) {
      patchJob(row.id, { status: "cancelled", finishedAt: new Date(), lastError: "user_disabled" });
      continue;
    }
    // Synchronous claim (better-sqlite3): atomic within the process.
    const got = db
      .update(jobs)
      .set({ status: "running", lockedAt: new Date(), heartbeatAt: new Date(), startedAt: new Date() })
      .where(and(eq(jobs.id, row.id), eq(jobs.status, "pending")))
      .returning()
      .get();
    if (got) claimed.push(got);
  }
  for (const job of claimed) void run(job);
}

// Idle + cron enqueue sweeps (PLAN §2 schedule semantics, §3 triggers 2–3).
function sweepSchedules(nowMs: number): void {
  const g = (globalThis as { __yashaWorker?: WorkerGlobalHandle }).__yashaWorker ?? {};
  for (const type of SCHEDULED_EVENT_TYPES) {
    const cfg = resolveEventConfig(type);
    if (!cfg.enabled || !cfg.model) continue;
    if (MEMORY_EVENT_TYPES.includes(type) && !memoryEnabled()) continue;
    if (cfg.schedule === "idle") sweepIdle(type, cfg, nowMs);
    else if (cfg.schedule === "cron") sweepCron(type, cfg, g, nowMs);
  }
}

/** True when an existing row already covers this dedupe key (pending/running,
 * or a terminal run that finished after the thread's last activity). */
function rowAlreadyCovers(dedupe: string, sinceMs: number): boolean {
  const row = db
    .select({ status: jobs.status, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(eq(jobs.dedupeKey, dedupe))
    .get();
  if (!row) return false;
  if (row.status === "pending" || row.status === "running") return true;
  if (row.status === "cancelled") return false;
  const finished = row.finishedAt?.getTime() ?? 0;
  return finished >= sinceMs;
}

function sweepIdle(type: QueueJobType, cfg: EventConfig, nowMs: number): void {
  const cutoff = new Date(nowMs - cfg.idleMinutes * 60_000);
  const rows = db
    .select({ id: threads.id, userId: threads.userId, updatedAt: threads.updatedAt })
    .from(threads)
    .where(lt(threads.updatedAt, cutoff))
    .orderBy(asc(threads.updatedAt))
    .limit(SWEEP_MAX)
    .all();
  const gated = MEMORY_EVENT_TYPES.includes(type);
  for (const t of rows) {
    if (gated && !getUserMemoryEnabled(t.userId)) continue;
    const dedupe = dedupeKeyFor(type, t.id, t.userId);
    if (rowAlreadyCovers(dedupe, t.updatedAt.getTime())) continue;
    void enqueueSwept(type, t.id, t.userId);
  }
}

function sweepCron(type: QueueJobType, cfg: EventConfig, g: WorkerGlobalHandle, nowMs: number): void {
  let prev: Date;
  try {
    const it = CronExpressionParser.parse(cfg.cronExpr, { currentDate: new Date(nowMs) });
    // cron-parser's prev() is always <= currentDate (the guard would be dead code).
    prev = new Date(it.prev().toDate());
  } catch {
    return; // invalid expression → no fire
  }
  const prevKey = prev.toISOString();
  // Dreaming is per-user, not per-thread (threadId null → per-user dedupe key).
  const rows: { id: string | null; userId: string; updatedAt: Date }[] =
    type === "memory.dreaming"
      ? db
          .select({ userId: user.id, updatedAt: user.createdAt })
          .from(user)
          .orderBy(asc(user.createdAt))
          .limit(SWEEP_MAX)
          .all()
          .map((u) => ({ id: null, userId: u.userId, updatedAt: u.updatedAt }))
      : db
          .select({ id: threads.id, userId: threads.userId, updatedAt: threads.updatedAt })
          .from(threads)
          .where(lte(threads.updatedAt, prev))
          .orderBy(asc(threads.updatedAt))
          .limit(SWEEP_MAX)
          .all();
  const cronScoped = type === "chat.title_generation";
  const gated = MEMORY_EVENT_TYPES.includes(type);
  for (const t of rows) {
    if (gated && !getUserMemoryEnabled(t.userId)) continue;
    const dedupe = dedupeKeyFor(type, t.id, t.userId);
    const enqKey = `${type}|${dedupe}`;
    if (g.cronEnqueued?.get(enqKey) === prevKey) continue;
    if (cronScoped) {
      // Title rows always carry a thread id (only dreaming rows have none).
      const threadId = t.id as string;
      // Titles only make sense with an exchange; skip already-titled-after-fire.
      const msgs = db
        .select({ c: messages.id })
        .from(messages)
        .where(eq(messages.threadId, threadId))
        .limit(2)
        .all();
      if (msgs.length < 2) continue;
      if (rowAlreadyCovers(dedupe, prev.getTime())) continue;
    } else if (rowAlreadyCovers(dedupe, prev.getTime())) {
      continue;
    }
    g.cronEnqueued?.set(enqKey, prevKey);
    void enqueueSwept(type, t.id, t.userId);
  }
}

async function enqueueSwept(type: QueueJobType, threadId: string | null, userId: string): Promise<void> {
  const { enqueueJob } = await import("./queue");
  try {
    await enqueueJob({ type, threadId, userId });
  } catch (err) {
    console.error(`[jobs] sweeper enqueue failed for ${type}:`, err);
  }
}

async function run(job: Job): Promise<void> {
  const g = (globalThis as { __yashaWorker?: WorkerGlobalHandle }).__yashaWorker ?? {};
  const type = job.type as QueueJobType;
  const handler = HANDLERS[type];
  if (!handler) {
    patchJob(job.id, { status: "cancelled", finishedAt: new Date(), lastError: "no_handler" });
    return;
  }
  const cfg = resolveEventConfig(type);
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, cfg.timeoutMs);
  const heart = setInterval(() => patchJob(job.id, { heartbeatAt: new Date() }), HEARTBEAT_MS);
  active.set(job.id, { type, controller, heart });
  g.cronEnqueued ??= new Map();
  let checkpointId: string | null = null;
  const deferred: ((tx: JobTx) => void)[] = [];
  let payload: Record<string, unknown> = {};
  try {
    const p: unknown = job.payloadJson ? JSON.parse(job.payloadJson) : {};
    if (p && typeof p === "object" && !Array.isArray(p)) payload = p as Record<string, unknown>;
  } catch {
    /* payload stays empty */
  }
  try {
    const result = await handler({
      job,
      payload,
      cfg,
      signal: controller.signal,
      heartbeat: () => patchJob(job.id, { heartbeatAt: new Date() }),
      setCheckpoint: (id) => {
        checkpointId = id;
      },
      addCommit: (fn) => {
        deferred.push(fn);
      },
    });
    finishSucceeded(job, started, result, checkpointId, deferred);
  } catch (err) {
    finishFailed(job, cfg, started, timedOut ? `timeout after ${cfg.timeoutMs}ms` : errMessage(err));
  } finally {
    clearTimeout(timeout);
    clearInterval(heart);
    active.delete(job.id);
    // Drop the dedupe key from the cron guard so the next fire can re-arm.
    for (const key of [...g.cronEnqueued!.keys()]) {
      if (key.endsWith(`|${job.dedupeKey}`)) g.cronEnqueued!.delete(key);
    }
  }
}

function finishSucceeded(
  job: Job,
  started: number,
  result: Record<string, unknown>,
  checkpointId: string | null,
  deferred: ((tx: JobTx) => void)[]
): void {
  const patch = {
    status: "succeeded" as const,
    finishedAt: new Date(),
    durationMs: Date.now() - started,
    resultJson: JSON.stringify(result ?? {}),
    lastError: null,
  };
  if (!checkpointId && deferred.length === 0) {
    patchJob(job.id, patch);
    return;
  }
  // Deferred writes + watermark advance + status flip: one atomic transaction
  // (crash before commit → lease reclaim replays from the old watermark).
  db.transaction((tx) => {
    for (const fn of deferred) fn(tx);
    if (checkpointId) {
      const now = new Date();
      const cpThread = job.threadId ?? "";
      const existing = tx
        .select({ jobType: jobCheckpoints.jobType })
        .from(jobCheckpoints)
        .where(and(eq(jobCheckpoints.jobType, job.type), eq(jobCheckpoints.threadId, cpThread)))
        .get();
      if (existing) {
        tx.update(jobCheckpoints)
          .set({ throughMessageId: checkpointId, updatedAt: now })
          .where(and(eq(jobCheckpoints.jobType, job.type), eq(jobCheckpoints.threadId, cpThread)))
          .run();
      } else {
        tx.insert(jobCheckpoints)
          .values({ jobType: job.type, threadId: cpThread, throughMessageId: checkpointId, updatedAt: now })
          .run();
      }
    }
    tx.update(jobs).set(patch).where(eq(jobs.id, job.id)).run();
  });
}

function finishFailed(job: Job, cfg: EventConfig, started: number, error: string): void {
  const attempts = job.attempts + 1;
  const max = Math.max(1, job.maxAttempts);
  if (attempts >= max) {
    patchJob(job.id, {
      status: "failed",
      attempts,
      finishedAt: new Date(),
      durationMs: Date.now() - started,
      lastError: error.slice(0, 2000),
    });
    return;
  }
  const backoff = Math.max(1000, cfg.backoffMs) * 2 ** (attempts - 1);
  patchJob(job.id, {
    status: "pending",
    attempts,
    runAfter: new Date(Date.now() + backoff),
    lockedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    durationMs: Date.now() - started,
    lastError: error.slice(0, 2000),
  });
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Internal jobs share one upstream call shape. Streaming + reading only
// delta.content: some upstream aliases (openrouter rotators) 500 on
// non-streaming calls, and reasoning* fields are dropped per AGENTS hard rule
// #1. Budgets must cover the hidden reasoning a thinking alias spends BEFORE it
// answers — max_tokens bills both, so a small budget yields an EMPTY content
// (finish_reason=length) and the handler would lose the row's output. Hence the
// floor below plus one wide retry when a first attempt comes back empty.
const MIN_COMPLETION_TOKENS = 2048;
const EMPTY_RETRY_TOKENS = 8192;

async function completeAttempt(
  opts: CompleteOnceOpts,
  maxTokens: number,
  temperature?: number,
): Promise<string> {
  const route = await routeModel(opts.model);
  if (!route) throw new Error("no_backend");
  const res = await route.provider.completion(
    {
      model: route.model,
      messages: opts.messages,
      stream: true,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
    },
    opts.signal,
  );
  if (!res.ok || !res.body) throw new Error(`upstream_status_${res.status}`);
  let text = "";
  await forEachSseData(res.body, (payload) => {
    if (!payload || payload === "[DONE]") return;
    let chunk: { choices?: { delta?: { content?: unknown } }[] };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string") text += delta.content;
  });
  return text.trim();
}

type CompleteOnceOpts = {
  model: string;
  /** String content (text-only) or OpenAI content parts (e.g. input_audio). */
  messages: { role: string; content: unknown }[];
  signal: AbortSignal;
  /** Minimum budget; raised to MIN_COMPLETION_TOKENS (see above). */
  maxTokens?: number;
  temperature?: number;
};

export async function completeOnce(opts: CompleteOnceOpts): Promise<string> {
  let text = await completeAttempt(opts, Math.max(opts.maxTokens ?? 0, MIN_COMPLETION_TOKENS), opts.temperature);
  if (!text) text = await completeAttempt(opts, EMPTY_RETRY_TOKENS, opts.temperature);
  if (!text) throw new Error("empty_completion");
  // Belt & braces: never let reasoning traces leak into persisted data.
  return text.replace(/[\s\S]*?<\/?think[^>]*>/gi, "").trim();
}

export function activeCount(): number {
  return active.size;
}

// Turbopack dev does not re-run module side effects on HMR, so the worker is
// also started lazily from request paths (idempotent — globalThis handle).
export function ensureWorker(): void {
  startWorker();
}
