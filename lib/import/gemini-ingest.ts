// Chunked, resumable, idempotent ingestion of a spooled Gemini NDJSON export
// (docs/GEMINI-IMPORT-PLAN.md §Pipeline). Called by the `import.gemini` queue job
// one chunk at a time: every chunk is ONE transaction that writes its rows and
// advances the byte/line checkpoint together, so a crash or restart resumes
// exactly where the file left off and never double-imports — re-runs are absorbed
// by the (userId, provider, externalId) unique key, first write wins.
//
// Memory is bounded by `chunkSize` conversations; the file itself is streamed.
// Timestamps are synthetic: the exporter's format carries none, so a thread gets
// `anchorMs + lineIndex` and its turns one millisecond apart — enough to keep the
// existing `ORDER BY created_at` correct without inventing plausible dates.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  importBatches,
  messages,
  threadImports,
  threads,
  type ImportBatch,
} from "@/lib/db/schema";
import { IMPORT_PROVIDER, readGeminiNdjson, type ParsedConversation } from "./gemini-ndjson";

const FAILURE_SAMPLES_KEPT = 50;
const MALFORMED_SAMPLES_KEPT = 20;
const SPOOL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bounded failure/malformed samples carried in `importBatches.countsJson`. */
export type ImportSamples = {
  failures: { externalId: string; reason: string }[];
  malformed: string[];
};

export function readSamples(countsJson: string | null): ImportSamples {
  if (!countsJson) return { failures: [], malformed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(countsJson);
  } catch {
    return { failures: [], malformed: [] };
  }
  const obj = (parsed ?? {}) as { failures?: unknown; malformed?: unknown };
  const failures = Array.isArray(obj.failures) ? obj.failures : [];
  const malformed = Array.isArray(obj.malformed) ? obj.malformed : [];
  return {
    failures: failures.filter(
      (f): f is { externalId: string; reason: string } =>
        !!f && typeof f === "object" &&
        typeof (f as { externalId?: unknown }).externalId === "string" &&
        typeof (f as { reason?: unknown }).reason === "string"
    ).slice(0, FAILURE_SAMPLES_KEPT),
    malformed: malformed.filter((m): m is string => typeof m === "string").slice(0, MALFORMED_SAMPLES_KEPT),
  };
}

/** Spool directory (same DATABASE_PATH convention as the APK build dir). */
export function spoolDir(): string {
  // DATABASE_PATH is always set in-container (dev + runtime images), like the APK build dir.
  return process.env.YASHA_IMPORT_DIR ?? join(dirname(process.env.DATABASE_PATH!), "imports");
}

/** Spool location for a batch (same convention as the APK build dir). */
export function spoolPathFor(batchId: string): string {
  if (!SPOOL_ID_RE.test(batchId)) throw new Error(`invalid import batch id: ${batchId}`);
  return join(spoolDir(), `${batchId}.ndjson`);
}

export function ensureSpoolDir(batchId: string): string {
  const path = spoolPathFor(batchId);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export type GeminiChunkOptions = {
  userId: string;
  batchId: string;
  model: string;
  chunkSize: number;
  maxMessageChars: number;
  /** Hard stop once this many conversations are imported *or* known-skipped. */
  maxConversations: number;
  /** Anchor of the synthetic timeline (normally the run start). */
  anchorMs: number;
  /** Checked between rows: batch cancelled, request aborted, shutdown. */
  shouldStop?: () => boolean;
};

export type ChunkOutcome = {
  stop: "eof" | "chunk" | "max-conversations" | "cancelled" | "no-batch";
  offset: number;
  lines: number;
  imported: number;
  skippedUnchanged: number;
  skippedChanged: number;
  failed: number;
  empty: number;
  malformed: number;
  flagged: number;
  createdThreadIds: string[];
};

type PendingConv = { conv: ParsedConversation; lineIndex: number };

type ThreadRow = typeof threads.$inferInsert;
type MessageRow = typeof messages.$inferInsert;
type ProvenanceRow = typeof threadImports.$inferInsert;

export async function ingestGeminiChunk(opts: GeminiChunkOptions): Promise<ChunkOutcome> {
  const batch = db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, opts.batchId), eq(importBatches.userId, opts.userId)))
    .get();
  if (!batch) {
    return {
      stop: "no-batch", offset: 0, lines: 0, imported: 0, skippedUnchanged: 0,
      skippedChanged: 0, failed: 0, empty: 0, malformed: 0, flagged: 0, createdThreadIds: [],
    };
  }

  const outcome: ChunkOutcome = {
    stop: "eof", offset: batch.checkpointOffset, lines: 0, imported: 0, skippedUnchanged: 0,
    skippedChanged: 0, failed: 0, empty: 0, malformed: 0, flagged: 0, createdThreadIds: [],
  };
  const samples = readSamples(batch.countsJson);
  const pending: PendingConv[] = [];
  const seen = new Set<string>();
  const known = batch.imported + batch.skippedUnchanged + batch.skippedChanged;

  try {
  for await (const row of readGeminiNdjson(spoolPathFor(batch.id), {
    maxMessageChars: opts.maxMessageChars,
    startOffset: batch.checkpointOffset,
  })) {
    outcome.offset = row.offsetAfter;
    outcome.lines += 1;
    if (row.kind === "conversation") {
      // The same id twice in one file: last line would win in a replace world,
      // first-write-wins keeps the first and the rest count as unchanged.
      if (seen.has(row.conv.externalId)) {
        outcome.skippedUnchanged += 1;
      } else {
        seen.add(row.conv.externalId);
        pending.push({ conv: row.conv, lineIndex: batch.checkpointLines + outcome.lines });
      }
    } else if (row.kind === "failed") {
      outcome.failed += 1;
      if (samples.failures.length < FAILURE_SAMPLES_KEPT) {
        samples.failures.push({ externalId: row.externalId, reason: row.reason });
      }
    } else if (row.kind === "empty") {
      outcome.empty += 1;
    } else {
      outcome.malformed += 1;
      if (samples.malformed.length < MALFORMED_SAMPLES_KEPT) samples.malformed.push(row.reason);
    }

    if (outcome.lines >= opts.chunkSize) {
      outcome.stop = "chunk";
      break;
    }
    if (known + pending.length >= opts.maxConversations) {
      outcome.stop = "max-conversations";
      break;
    }
    if (opts.shouldStop?.()) {
      outcome.stop = "cancelled";
      break;
    }
  }
  } catch (err) {
    // Cancel race: the cancel route deletes the spool while a claimed chunk
    // job was starting. A vanished spool on a cancelled batch is a clean
    // stop; anything else (or another failure mode) must surface as a job
    // failure, not silence.
    const gone =
      (err as NodeJS.ErrnoException).code === "ENOENT" &&
      db
        .select({ status: importBatches.status })
        .from(importBatches)
        .where(eq(importBatches.id, batch.id))
        .get()?.status === "cancelled";
    if (!gone) throw err;
    outcome.stop = "cancelled";
  }

  const toInsert = filterExisting(opts.userId, pending, outcome, samples);
  applyChunk(opts, batch, outcome, toInsert, samples);
  return outcome;
}

/** First-write-wins: drop conversations already on record, counting them. */
function filterExisting(
  userId: string,
  pending: PendingConv[],
  outcome: ChunkOutcome,
  samples: ImportSamples
): PendingConv[] {
  if (pending.length === 0) return [];
  // One lookup per chunk for the whole chunk's ids (no per-row N+1).
  const existing = db
    .select({ externalId: threadImports.externalId, bodyHash: threadImports.bodyHash })
    .from(threadImports)
    .where(
      and(
        eq(threadImports.userId, userId),
        eq(threadImports.provider, IMPORT_PROVIDER),
        inArray(threadImports.externalId, pending.map((p) => p.conv.externalId))
      )
    )
    .all();
  const hashes = new Map(existing.map((e) => [e.externalId, e.bodyHash]));
  const fresh: PendingConv[] = [];
  for (const p of pending) {
    const knownHash = hashes.get(p.conv.externalId);
    if (knownHash === undefined) {
      fresh.push(p);
    } else if (knownHash === p.conv.bodyHash) {
      outcome.skippedUnchanged += 1;
    } else {
      outcome.skippedChanged += 1;
      if (samples.failures.length < FAILURE_SAMPLES_KEPT) {
        samples.failures.push({ externalId: p.conv.externalId, reason: "already-imported" });
      }
    }
  }
  return fresh;
}

function applyChunk(
  opts: GeminiChunkOptions,
  batch: ImportBatch,
  outcome: ChunkOutcome,
  toInsert: PendingConv[],
  samples: ImportSamples
): void {
  const now = new Date();
  db.transaction((tx) => {
    if (toInsert.length > 0) {
      const threadRows: ThreadRow[] = [];
      const messageRows: MessageRow[] = [];
      const provenance: ProvenanceRow[] = [];
      for (const { conv, lineIndex } of toInsert) {
        const threadId = randomUUID();
        // Synthetic timeline: one millisecond per conversation and per turn, so
        // ordering is deterministic and monotonic without faking real dates.
        const base = opts.anchorMs + lineIndex;
        const flags = [...conv.upstreamFlags, ...conv.flags];
        if (flags.length > 0) outcome.flagged += 1;
        threadRows.push({
          id: threadId,
          userId: opts.userId,
          model: opts.model,
          title: conv.title || conv.turns[0].text.slice(0, 60).trim(),
          createdAt: new Date(base),
          updatedAt: new Date(base),
        });
        conv.turns.forEach((turn, i) => {
          messageRows.push({
            id: randomUUID(),
            threadId,
            role: turn.role,
            content: turn.text,
            metaJson: JSON.stringify({
              imported: { provider: IMPORT_PROVIDER, externalId: conv.externalId, turnIndex: i },
            }),
            createdAt: new Date(base + i + 1),
          });
        });
        provenance.push({
          threadId,
          userId: opts.userId,
          importId: batch.id,
          provider: IMPORT_PROVIDER,
          externalId: conv.externalId,
          bodyHash: conv.bodyHash,
          turnCount: conv.turns.length,
          lineIndex,
          flagsJson: flags.length > 0 ? JSON.stringify(flags) : null,
          importedAt: now,
        });
        outcome.createdThreadIds.push(threadId);
      }
      tx.insert(threads).values(threadRows).run();
      tx.insert(messages).values(messageRows).run();
      tx.insert(threadImports).values(provenance).run();
      outcome.imported = threadRows.length;
    }

    const lines = batch.checkpointLines + outcome.lines;
    tx.update(importBatches)
      .set({
        // A user cancel that lands while this chunk runs is NOT overwritten:
        // the chain stops after this chunk (the cancel is re-asserted here).
        status: sql`case when ${importBatches.status} = 'cancelled' then 'cancelled' else 'running' end`,
        startedAt: batch.startedAt ?? now,
        checkpointOffset: outcome.offset,
        checkpointLines: lines,
        totalLines: lines,
        imported: batch.imported + outcome.imported,
        skippedUnchanged: batch.skippedUnchanged + outcome.skippedUnchanged,
        skippedChanged: batch.skippedChanged + outcome.skippedChanged,
        failedCount: batch.failedCount + outcome.failed,
        malformedCount: batch.malformedCount + outcome.malformed,
        flaggedCount: batch.flaggedCount + outcome.flagged,
        countsJson: JSON.stringify(samples),
      })
      .where(eq(importBatches.id, batch.id))
      .run();
  });
}
