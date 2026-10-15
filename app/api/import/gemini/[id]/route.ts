// GET  /api/import/gemini/[id] — one batch + its (terminal) report, whose
// failure/malformed samples are capped by construction (≤50/≤20 rows).
// POST /api/import/gemini/[id] { action: "cancel" } — stop the chunk chain.
// What is already imported stays (re-uploading later is additive, first write
// wins); the spool is reclaimed immediately, the queue guard drops the chain.

import { rmSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { importBatches } from "@/lib/db/schema";
import { spoolPathFor } from "@/lib/import/gemini-ingest";
import { batchView, TERMINAL_STATUSES } from "@/lib/jobs/gemini-import";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function loadOwn(userId: string, id: string) {
  return db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, id), eq(importBatches.userId, userId)))
    .get();
}

export async function GET(req: NextRequest, { params }: Params) {
  await ensureReady();
  const limited = await rateLimit(req, "api");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const row = loadOwn(userId, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // countsJson holds the persisted report once terminal; garbage (should be
  // impossible) degrades to "no report yet" rather than a 500.
  let report: unknown = null;
  if (row.countsJson) {
    try {
      const parsed: unknown = JSON.parse(row.countsJson);
      report = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      report = null;
    }
  }
  return NextResponse.json({ import: batchView(row), report });
}

export async function POST(req: NextRequest, { params }: Params) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (body?.action !== "cancel") {
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }

  const row = loadOwn(userId, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (TERMINAL_STATUSES.includes(row.status)) {
    return NextResponse.json({ error: "batch_finished", status: row.status }, { status: 409 });
  }

  db.update(importBatches)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(importBatches.id, row.id))
    .run();
  // Best-effort space reclaim; a broken spool dir must not fail the cancel —
  // the retention sweep is the backstop.
  try {
    rmSync(spoolPathFor(row.id), { force: true });
  } catch {
    /* spool already gone or spool dir broken */
  }
  return NextResponse.json({ ok: true, importId: row.id });
}
