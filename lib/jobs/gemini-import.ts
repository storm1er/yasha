// The `import.gemini` queue job (docs/GEMINI-IMPORT-PLAN.md §Pipeline.2).
//
// One job run = ONE chunk (`import.chunkSize` conversations) committed as a
// single transaction by `ingestGeminiChunk`, then the job re-enqueues itself
// (dedupe lane `import.gemini:<user>:<batchId>`) until the file is exhausted —
// so a 5 000-chat import interleaves politely with memory/title work instead of
// monopolising the worker. A crash or restart is just another resume: the next
// run picks up at the committed byte checkpoint.
//
// Unlike the memory/title jobs this type is user-requested data portability
// and needs no chat model, so it is always claimable (see `jobTypeAllowed`).
// The Settings → Memory switch affects this pipeline only through the opt-in
// learnFromImports step below: its fact_extraction jobs are memory types.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { importBatches, type ImportBatch, type ImportBatchStatus } from "@/lib/db/schema";
import { buildGeminiImportReport } from "@/lib/import/gemini-report";
import { ingestGeminiChunk, spoolDir, spoolPathFor } from "@/lib/import/gemini-ingest";
import { fastModel, getSettingInt, memoryEnabled, smartModel } from "@/lib/settings";
import { enqueueJob } from "./queue";
import type { JobHandler } from "./worker";

export const TERMINAL_STATUSES: readonly ImportBatchStatus[] = ["succeeded", "partial", "failed", "cancelled"];

/** Public batch projection for the API (counters without the report payload). */
export function batchView(row: ImportBatch): Record<string, unknown> {
  return {
    importId: row.id,
    status: row.status,
    filename: row.filename,
    bytes: row.bytes,
    sha256: row.sha256,
    error: row.error,
    options: { learnFromImports: parseImportOptions(row.optionsJson).learnFromImports },
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    checkpoint: { offset: row.checkpointOffset, lines: row.checkpointLines },
    counts: {
      lines: row.totalLines,
      imported: row.imported,
      skippedUnchanged: row.skippedUnchanged,
      skippedChanged: row.skippedChanged,
      failed: row.failedCount,
      malformed: row.malformedCount,
      flagged: row.flaggedCount,
    },
  };
}

/** Thread model for imported conversations: the instance default, resolved
 *  silently per run (a re-import never rewrites an existing thread's model). */
export function importModel(): string {
  return smartModel() || fastModel() || "imported";
}

/** `importBatches.optionsJson` → typed options; garbage defaults everything off. */
export function parseImportOptions(optionsJson: string | null): { learnFromImports: boolean } {
  if (!optionsJson) return { learnFromImports: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return { learnFromImports: false };
  }
  const v =
    parsed && typeof parsed === "object"
      ? (parsed as { learnFromImports?: unknown }).learnFromImports
      : undefined;
  return { learnFromImports: v === true };
}

function enqueueNextChunk(batchId: string, userId: string, cursor: number): void {
  // One dedupe lane per (batch, committed offset): the NEXT row's key can never
  // collide with the still-`running` current row (which would hit the upsert's
  // setWhere guard and silently kill the chain), while a retry of the same
  // chunk simply re-arms the already-pending row instead of duplicating.
  void enqueueJob({ type: "import.gemini", userId, keySuffix: `${batchId}:${cursor}`, payload: { batchId } });
}

export const handleGeminiImport: JobHandler = async ({ job, payload, signal, heartbeat }) => {
  const batchId = typeof payload.batchId === "string" ? payload.batchId : "";
  const batch = batchId
    ? db
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.id, batchId), eq(importBatches.userId, job.userId)))
        .get()
    : undefined;
  if (!batch) return { stop: "no-batch" };
  // A cancel (or a finished chain) can beat this queued row to the batch.
  if (TERMINAL_STATUSES.includes(batch.status)) return { stop: `already-${batch.status}` };

  const options = parseImportOptions(batch.optionsJson);
  const outcome = await ingestGeminiChunk({
    userId: batch.userId,
    batchId: batch.id,
    model: typeof payload.model === "string" && payload.model !== "" ? payload.model : importModel(),
    chunkSize: getSettingInt("import.chunkSize", 1, 1_000_000),
    maxMessageChars: getSettingInt("import.maxMessageChars", 1000, 10_000_000),
    maxConversations: getSettingInt("import.maxConversations", 1, 10_000_000),
    // Stable anchor across chunks → one synthetic monotonic timeline per batch.
    anchorMs: batch.createdAt.getTime(),
    // Timeout/shutdown mid-chunk: stop at a row boundary; the checkpoint has
    // already been committed by the previous chunks, so we just re-arm below.
    shouldStop: () => signal.aborted,
  });
  heartbeat();

  if (options.learnFromImports && memoryEnabled() && outcome.createdThreadIds.length > 0) {
    // Opt-in "learn from imports": memory extraction per imported thread,
    // debounced by the queue's own dedupe — never a per-message job. Skipped
    // entirely while the admin memory-derivation switch is off.
    for (const threadId of outcome.createdThreadIds) {
      void enqueueJob({ type: "memory.fact_extraction", userId: batch.userId, threadId });
    }
  }

  if (outcome.stop === "cancelled") {
    // Aborted mid-chunk (timeout or shutdown), not a user cancel — the user
    // cancel path sets the batch row itself (checked before the next chunk).
    enqueueNextChunk(batch.id, batch.userId, outcome.offset);
    return { stop: "retry", offset: outcome.offset };
  }

  if (outcome.stop === "chunk") {
    enqueueNextChunk(batch.id, batch.userId, outcome.offset);
    return { stop: "chunk", offset: outcome.offset, imported: outcome.imported };
  }

  // Terminal: eof (everything read) or max-conversations (hard cap hit).
  const capped = outcome.stop === "max-conversations";
  // Same batch row loaded at the top of the handler; nothing deletes batches.
  const report = buildGeminiImportReport({ batchId: batch.id, userId: batch.userId })!;
  // Cumulative counters (this chunk's `outcome` only sees itself).
  const status: ImportBatchStatus =
    capped || report.counts.failed > 0 || report.counts.malformed > 0 ? "partial" : "succeeded";
  db.update(importBatches)
    .set({
      status,
      finishedAt: new Date(),
      error: capped ? "max-conversations reached" : null,
      // Report built before the flip above → stamp the final status into it.
      countsJson: JSON.stringify({ ...report, status }),
    })
    .where(eq(importBatches.id, batch.id))
    .run();
  rmSync(spoolPathFor(batch.id), { force: true });
  return { stop: outcome.stop, status, imported: outcome.imported, duplicates: report.duplicateGroups.length };
};

/** Startup sweep: spool files older than `import.spoolRetentionHours` are dead
 *  weight (terminal batches delete theirs, live batches are always young).
 *  Returns the number of spools removed. */
export function sweepGeminiSpools(nowMs = Date.now()): number {
  const dir = spoolDir();
  const maxAgeMs = getSettingInt("import.spoolRetentionHours", 1, 8760) * 3_600_000;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no spool dir yet — normal on a fresh instance
  }
  for (const name of names) {
    const id = name.endsWith(".ndjson") ? name.slice(0, -".ndjson".length) : "";
    if (!id) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile() || stat.mtimeMs >= nowMs - maxAgeMs) continue;
    rmSync(path);
    removed += 1;
    const row = db.select({ status: importBatches.status }).from(importBatches).where(eq(importBatches.id, id)).get();
    if (row && !TERMINAL_STATUSES.includes(row.status)) {
      db.update(importBatches)
        .set({ status: "failed", finishedAt: new Date(), error: "spool_expired" })
        .where(eq(importBatches.id, id))
        .run();
    }
  }
  return removed;
}
