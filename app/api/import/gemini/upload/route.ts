// POST /api/import/gemini/upload — streaming spool of a raw Gemini NDJSON
// export (docs/GEMINI-IMPORT-PLAN.md §Pipeline.1). The request body is streamed
// straight to the spool file (no FileReader/base64 anywhere): bytes are hashed
// and counted on the fly, `import.maxUploadBytes` is enforced *while* reading,
// and the first line gets a JSON sanity check. Line counting and everything
// else belong to the queue job (P2), which owns the authoritative counters.

import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, lt, notInArray } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { importBatches } from "@/lib/db/schema";
import { spoolPathFor } from "@/lib/import/gemini-ingest";
import { TERMINAL_STATUSES } from "@/lib/jobs/gemini-import";
import { enqueueJob } from "@/lib/jobs/queue";
import { getSettingInt } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The first line of our format is one conversation object; anything larger
// before the first newline is not this exporter's output.
const HEAD_MAX_BYTES = 1_000_000;
// An `uploading` row older than this belongs to a dead request (process died
// mid-stream), not a live upload — free the user's single-active-batch slot.
const STALE_UPLOADING_MS = 6 * 3_600_000;

export function safeFileName(header: string | null): string {
  if (!header) return "gemini_chats.ndjson";
  const base = header.replace(/\\/g, "/").split("/").pop()?.trim().slice(0, 200);
  return base && base.length > 0 ? base : "gemini_chats.ndjson";
}

/**
 * First-line tracker step: `null` head = first line already closed (mid-file
 * chunk); otherwise accumulate until a newline closes it (validated) or the
 * sanity cap proves this is not our NDJSON. Pure → unit-testable; the route's
 * own chunks arrive pre-buffered under Next, so multi-chunk flows only exist
 * for real streaming clients.
 */
export function scanHead(head: string | null, text: string): { head: string | null; ok: boolean } {
  if (head === null) return { head: null, ok: true };
  const cut = text.indexOf("\n");
  if (cut >= 0) return { head: null, ok: isFirstLineObject(head + text.slice(0, cut)) };
  if (head.length + text.length > HEAD_MAX_BYTES) return { head, ok: false };
  return { head: head + text, ok: true };
}

export function isFirstLineObject(head: string): boolean {
  try {
    const parsed: unknown = JSON.parse(head);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // One active batch per user; stale dead uploads are failed first so a
  // crashed request can never block the user forever.
  db.update(importBatches)
    .set({ status: "failed", finishedAt: new Date(), error: "upload_stale" })
    .where(
      and(
        eq(importBatches.userId, userId),
        eq(importBatches.status, "uploading"),
        lt(importBatches.createdAt, new Date(Date.now() - STALE_UPLOADING_MS))
      )
    )
    .run();
  const busy = db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.userId, userId), notInArray(importBatches.status, [...TERMINAL_STATUSES])))
    .get();
  if (busy) {
    return NextResponse.json({ error: "import_in_progress", importId: busy.id }, { status: 409 });
  }

  const maxBytes = getSettingInt("import.maxUploadBytes", 1024, 5_368_709_120);
  const batchId = randomUUID();
  const path = spoolPathFor(batchId);
  // `?learn=1` (the card's "learn from imported chats" checkbox) must reach the
  // queue job through the batch row — the job re-reads `optionsJson` per chunk.
  const learn = ["1", "true"].includes(req.nextUrl.searchParams.get("learn") ?? "");
  db.insert(importBatches)
    .values({
      id: batchId,
      userId,
      filename: safeFileName(req.headers.get("x-file-name")),
      bytes: 0,
      status: "uploading",
      optionsJson: learn ? JSON.stringify({ learnFromImports: true }) : null,
    })
    .run();

  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let fd: number | null = null;
  let bytes = 0;
  // First-line tracker: accumulates until the first newline closes it out
  // (null); still a string at end-of-stream means the file is one lone line.
  let head: string | null = "";
  let failure: { error: string; http: number } | null = null;

  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, "w");
    if (req.body) {
      for await (const chunk of Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>)) {
        if (req.signal.aborted) {
          failure = { error: "upload_aborted", http: 499 };
          break;
        }
        bytes += chunk.length;
        if (bytes > maxBytes) {
          failure = { error: "upload_too_large", http: 413 };
          break;
        }
        hash.update(chunk);
        const scanned = scanHead(head, decoder.write(chunk));
        if (!scanned.ok) {
          failure = { error: "not_ndjson", http: 400 };
          break;
        }
        head = scanned.head;
        writeSync(fd, chunk);
      }
    }
  } catch {
    failure = { error: "upload_failed", http: 500 };
  } finally {
    if (fd !== null) closeSync(fd);
  }

  if (!failure && bytes === 0) failure = { error: "empty_upload", http: 400 };
  if (!failure && head !== null && head !== "" && !isFirstLineObject(head)) {
    failure = { error: "not_ndjson", http: 400 };
  }

  if (failure) {
    // Best-effort reap; a broken spool dir (e.g. ENOTDIR) must not turn the
    // honest failure code into a 500 — the retention sweep is the backstop.
    try {
      rmSync(path, { force: true });
    } catch {
      /* keep the real error below */
    }
    db.update(importBatches)
      .set({ status: "failed", finishedAt: new Date(), error: failure.error })
      .where(eq(importBatches.id, batchId))
      .run();
    return NextResponse.json({ error: failure.error, importId: batchId }, { status: failure.http });
  }

  db.update(importBatches)
    .set({ bytes, sha256: hash.digest("hex"), status: "queued" })
    .where(eq(importBatches.id, batchId))
    .run();
  await enqueueJob({ type: "import.gemini", userId, keySuffix: batchId, payload: { batchId } });
  return NextResponse.json({ importId: batchId, bytes }, { status: 202 });
}
