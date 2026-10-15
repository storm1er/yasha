// Generic jobs queue: EVERY trigger funnels through enqueueJob() — one
// dedupe-keyed upsert (PLAN §3). Terminal rows fully reset on re-enqueue;
// running rows are never disturbed.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, type JobStatus } from "@/lib/db/schema";
import { getSettingInt, type QueueJobType } from "@/lib/settings";

let echoSeq = 0;

export type EnqueueInput = {
  type: QueueJobType;
  userId: string;
  threadId?: string | null;
  runAfter?: Date;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  // Manual "Run now": allowed even when the schedule is `never` (PLAN §3.4).
  force?: boolean;
  // Per-row dedupe discriminator (e.g. messageId for audio captions — one
  // job per message instead of one per thread).
  keySuffix?: string;
};

export function dedupeKeyFor(
  type: QueueJobType,
  threadId?: string | null,
  userId?: string,
  keySuffix?: string
): string {
  if (type === "debug.echo") return `debug.echo:${++echoSeq}:${Date.now()}`;
  const base = threadId ? `${type}:${threadId}` : `${type}:${userId ?? ""}`;
  return keySuffix ? `${base}:${keySuffix}` : base;
}

/** Returns the row id when the row is pending/enqueued, or null if left running/absent. */
export async function enqueueJob(input: EnqueueInput): Promise<string | null> {
  const now = new Date();
  const values = {
    id: crypto.randomUUID(),
    dedupeKey: dedupeKeyFor(input.type, input.threadId, input.userId, input.keySuffix),
    type: input.type,
    threadId: input.threadId ?? null,
    userId: input.userId,
    status: "pending" as JobStatus,
    runAfter: input.runAfter ?? now,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? getSettingInt("memory.queue.defaultMaxAttempts"),
    lockedAt: null,
    heartbeatAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    lastError: null,
    payloadJson: input.payload ? JSON.stringify({ ...input.payload, ...(input.force ? { force: true } : {}) }) : input.force ? JSON.stringify({ force: true }) : null,
    resultJson: null,
  };
  // better-sqlite3 is synchronous: the upsert+RETURNING is a single atomic write.
  const result = db
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: jobs.dedupeKey,
      set: {
        status: "pending",
        runAfter: values.runAfter,
        payloadJson: values.payloadJson,
        attempts: 0,
        maxAttempts: values.maxAttempts,
        lastError: null,
        resultJson: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        lockedAt: null,
        heartbeatAt: null,
      },
      // Never disturb an in-flight run (its handler advances the checkpoint;
      // the next event re-arms the row).
      setWhere: sql`${jobs.status} != 'running'`,
    })
    .returning({ id: jobs.id, status: jobs.status })
    .get();
  // Empty result → a `running` row was left untouched.
  return result?.status === "pending" ? result.id : null;
}

export type JobPatch = Partial<{
  status: JobStatus;
  runAfter: Date;
  attempts: number;
  lockedAt: Date | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  lastError: string | null;
  resultJson: string | null;
}>;

export function patchJob(id: string, patch: JobPatch): void {
  db.update(jobs).set(patch).where(eq(jobs.id, id)).run();
}
