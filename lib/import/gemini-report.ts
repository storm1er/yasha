// Post-run quality report for a Gemini import batch (docs/GEMINI-IMPORT-PLAN.md
// §Pipeline, "verification ported from upstream's Python verifier"). The upstream
// README tells users to run a separate Python verifier before trusting an export,
// because a naive capture silently wrote one stale conversation body across ~280
// chats while reporting zero errors. Yasha runs the equivalent audit from the
// provenance rows, so the warning shows up in the UI and the user never has to
// open a file or run a script.
//
// Two checks:
//  • duplicate groups — one body shared by several conversations (scoped to the
//    user across batches: capture quality follows the user, not one upload);
//  • contiguous duplicate run — the stale-page fingerprint: N consecutive
//    conversations of one capture sharing a body. Those threads are KEPT and
//    flagged `suspect-duplicates`; nothing is dropped silently.

import { and, eq } from "drizzle-orm";
import { db, rawSqlite } from "@/lib/db";
import { importBatches, threadImports } from "@/lib/db/schema";
import { IMPORT_PROVIDER } from "./gemini-ndjson";
import { readSamples } from "./gemini-ingest";

/** Consecutive conversations sharing one body at which we call it a run. */
export const SUSPECT_RUN_MIN = 3;
const DUP_GROUPS_KEPT = 10;
const DUP_GROUP_SAMPLES = 3;
const SUSPECTS_MARKED_MAX = 500;
const SUSPECT_FLAG = "suspect-duplicates";

export type DuplicateGroup = { bodyHash: string; count: number; externalIds: string[] };

export type GeminiImportReport = {
  batchId: string;
  status: string;
  provider: string;
  filename: string | null;
  bytes: number;
  error: string | null;
  counts: {
    lines: number;
    imported: number;
    skippedUnchanged: number;
    skippedChanged: number;
    failed: number;
    malformed: number;
    flagged: number;
  };
  failures: { externalId: string; reason: string }[];
  malformedSamples: string[];
  duplicateGroups: DuplicateGroup[];
  /** Longest contiguous duplicate run of this batch, when there is one. */
  suspectRun: { startLine: number; length: number } | null;
  /** Conversations of that run flagged `suspect-duplicates`. */
  suspects: number;
};

type ProvenanceRow = {
  threadId: string;
  externalId: string;
  lineIndex: number;
  bodyHash: string;
  flagsJson: string | null;
};

type BestRun = { startLine: number; length: number; rows: ProvenanceRow[] };

export function buildGeminiImportReport(input: {
  batchId: string;
  userId: string;
  /** Default on: marking is how the UI gets its warning. Read it with false to
   *  preview a report without writing. */
  markSuspects?: boolean;
}): GeminiImportReport | null {
  const batch = db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, input.batchId), eq(importBatches.userId, input.userId)))
    .get();
  if (!batch) return null;
  const samples = readSamples(batch.countsJson);

  const groups = rawSqlite
    .prepare(
      `SELECT body_hash AS bodyHash, COUNT(*) AS count, GROUP_CONCAT(external_id, char(31)) AS ids
         FROM thread_imports
        WHERE user_id = ? AND provider = ?
        GROUP BY body_hash
       HAVING count > 1
        ORDER BY count DESC, body_hash ASC
        LIMIT ?`
    )
    .all(input.userId, IMPORT_PROVIDER, DUP_GROUPS_KEPT) as {
    bodyHash: string;
    count: number;
    ids: string;
  }[];

  const rows = rawSqlite
    .prepare(
      `SELECT thread_id AS threadId, external_id AS externalId, line_index AS lineIndex,
              body_hash AS bodyHash, flags_json AS flagsJson
         FROM thread_imports
        WHERE import_id = ?
        ORDER BY line_index ASC`
    )
    .all(batch.id) as ProvenanceRow[];

  // Consecutive groups of identical bodies, in capture order.
  const runs: { hash: string; rows: ProvenanceRow[] }[] = [];
  for (const row of rows) {
    const tail = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (tail && tail.hash === row.bodyHash) tail.rows.push(row);
    else runs.push({ hash: row.bodyHash, rows: [row] });
  }
  let best: BestRun | null = null;
  for (const run of runs) {
    if (run.rows.length >= SUSPECT_RUN_MIN && (!best || run.rows.length > best.length)) {
      best = { startLine: run.rows[0].lineIndex, length: run.rows.length, rows: run.rows };
    }
  }

  let suspects = 0;
  let marked = 0;
  const run: BestRun | null = best;
  if (run) {
    for (const row of run.rows) {
      suspects += 1;
      const flags: string[] = row.flagsJson ? (JSON.parse(row.flagsJson) as string[]) : [];
      if (flags.includes(SUSPECT_FLAG)) continue;
      if (input.markSuspects === false) continue;
      // Bounded work per report; a run longer than this is a catastrophically
      // broken capture and the report says so with its own length.
      if (marked >= SUSPECTS_MARKED_MAX) continue;
      marked += 1;
      flags.push(SUSPECT_FLAG);
      db.update(threadImports)
        .set({ flagsJson: JSON.stringify(flags) })
        .where(eq(threadImports.threadId, row.threadId))
        .run();
    }
  }

  return {
    batchId: batch.id,
    status: batch.status,
    provider: batch.provider,
    filename: batch.filename,
    bytes: batch.bytes,
    error: batch.error,
    counts: {
      lines: batch.totalLines,
      imported: batch.imported,
      skippedUnchanged: batch.skippedUnchanged,
      skippedChanged: batch.skippedChanged,
      failed: batch.failedCount,
      malformed: batch.malformedCount,
      flagged: batch.flaggedCount,
    },
    failures: samples.failures,
    malformedSamples: samples.malformed,
    duplicateGroups: groups.map((g) => ({
      bodyHash: g.bodyHash.slice(0, 12),
      count: g.count,
      externalIds: g.ids.split("\u001f").slice(0, DUP_GROUP_SAMPLES),
    })),
    suspectRun: run ? { startLine: run.startLine, length: run.length } : null,
    suspects,
  };
}
