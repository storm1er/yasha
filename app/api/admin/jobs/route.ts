import { NextResponse, type NextRequest } from "next/server";
import { and, asc, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { requireAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { jobs, threads, user } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { QUEUE_JOB_TYPES, memoryEnabled } from "@/lib/settings";
import { getUserMemoryEnabled } from "@/lib/memory/prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUNNABLE_TYPES = [
  "chat.title_generation",
  "memory.fact_extraction",
  "memory.thread_summary",
  "memory.dreaming",
  "debug.echo",
] as const;

// Page size for the `runNow all:true` keyset backfill.
const RUNNOW_PAGE_SIZE = 50;

function invalid() {
  return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
}

/**
 * GET /api/admin/jobs?status=pending|running|succeeded|failed|cancelled|active
 *   [&type=<jobType>][&q=<threadId|userId>][&limit=1..200]
 * Default view = pending + running (PLAN §5). Rows carry resolved thread/user labels.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? "active";
  const type = sp.get("type");
  const q = (sp.get("q") ?? "").trim();
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 100));

  const filters: SQL[] = [];
  if (status === "active") filters.push(inArray(jobs.status, ["pending", "running"]));
  else if ((["pending", "running", "succeeded", "failed", "cancelled"] as const).includes(status as never))
    filters.push(eq(jobs.status, status as never));
  else return invalid();

  if (type) {
    if (!(QUEUE_JOB_TYPES as readonly string[]).includes(type)) return invalid();
    filters.push(eq(jobs.type, type));
  }
  if (q) filters.push(or(eq(jobs.threadId, q), eq(jobs.userId, q))!);

  const rows = db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      threadId: jobs.threadId,
      userId: jobs.userId,
      runAfter: jobs.runAfter,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      durationMs: jobs.durationMs,
      lastError: jobs.lastError,
      resultJson: jobs.resultJson,
      threadTitle: threads.title,
      userName: user.name,
    })
    .from(jobs)
    .leftJoin(threads, eq(jobs.threadId, threads.id))
    .leftJoin(user, eq(jobs.userId, user.id))
    .where(and(...filters))
    .orderBy(asc(jobs.runAfter), desc(jobs.startedAt))
    .limit(limit)
    .all();

  return NextResponse.json({
    ok: true,
    jobs: rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      scope: {
        threadId: r.threadId,
        threadTitle: r.threadTitle,
        userId: r.userId,
        userName: r.userName,
      },
      runAfter: r.runAfter.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationMs: r.durationMs,
      lastError: r.lastError,
      resultJson: r.resultJson,
    })),
  });
}

/**
 * POST /api/admin/jobs — queue monitor actions (admin only):
 *  {action:"runNow", type:"debug.echo", text?}
 *  {action:"runNow", type:"chat.title_generation", threadId?|all:true}
 *  {action:"cancel", jobId}           (pending only)
 *  {action:"retry", jobId}            (failed only → reset attempts, requeue)
 *  {action:"retryAllFailed"}
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return invalid();
  }
  const action = body.action;

  if (action === "runNow") return runNow(body, guard.userId);
  if (action === "cancel") {
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    if (!jobId) return invalid();
    const changed = db
      .update(jobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending")))
      .returning({ id: jobs.id })
      .get();
    if (!changed) return NextResponse.json({ error: "not_cancellable" }, { status: 409 });
    return NextResponse.json({ ok: true });
  }
  if (action === "retry") {
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    if (!jobId) return invalid();
    if (!resetFailedToPending(eq(jobs.id, jobId))) {
      return NextResponse.json({ error: "not_retryable" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  }
  if (action === "retryAllFailed") {
    const ids = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, "failed")).all();
    for (const row of ids) {
      resetFailedToPending(eq(jobs.id, row.id));
    }
    return NextResponse.json({ ok: true, retried: ids.length });
  }
  return invalid();
}

function resetFailedToPending(scope: SQL): boolean {
  const changed = db
    .update(jobs)
    .set({
      status: "pending",
      attempts: 0,
      runAfter: new Date(),
      lastError: null,
      resultJson: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      lockedAt: null,
      heartbeatAt: null,
    })
    .where(and(scope, eq(jobs.status, "failed")))
    .returning({ id: jobs.id })
    .get();
  return Boolean(changed);
}

async function runNow(body: Record<string, unknown>, adminUserId: string): Promise<NextResponse> {
  const rawType = body.type;
  if (typeof rawType !== "string" || !(RUNNABLE_TYPES as readonly string[]).includes(rawType)) {
    return invalid();
  }
  const type = rawType as (typeof RUNNABLE_TYPES)[number];

  if (type === "debug.echo") {
    const text = typeof body.text === "string" ? body.text.slice(0, 500) : "ping";
    // debug.echo's dedupe key is unique per call → the row is always enqueued.
    await enqueueJob({
      type: "debug.echo",
      userId: adminUserId,
      payload: { text, force: true },
      force: true,
    });
    return NextResponse.json({ ok: true, enqueued: 1 });
  }

  // Dreaming is per-user: fan out to every opted-in user (no threads involved).
  if (type === "memory.dreaming") {
    if (!memoryEnabled()) return NextResponse.json({ ok: true, enqueued: 0, considered: 0, disabled: true });
    const users = db.select({ id: user.id }).from(user).all();
    let enqueued = 0;
    for (const u of users) {
      if (!getUserMemoryEnabled(u.id)) continue;
      const id = await enqueueJob({ type, userId: u.id, force: true });
      if (id) enqueued += 1;
    }
    return NextResponse.json({ ok: true, enqueued, considered: users.length });
  }

  // chat.title_generation / memory backfills: single thread, or all threads.
  const all = body.all === true;
  if (!all) {
    const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
    if (!threadId) return invalid();
    const owned = db
      .select({ id: threads.id, userId: threads.userId })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const id = await enqueueJob({ type, threadId: owned.id, userId: owned.userId, force: true });
    return NextResponse.json({ ok: true, enqueued: id ? 1 : 0, skippedRunning: !id });
  }

  // Keyset-paginated backfill over the WHOLE thread table (updatedAt,id desc):
  // each page is enqueued before the next is read, so a large library never
  // loads into memory at once and nothing is silently capped at one page.
  let enqueued = 0;
  let considered = 0;
  let cursor: { updatedAt: Date; id: string } | null = null;
  for (;;) {
    const page: { id: string; userId: string; updatedAt: Date }[] = db
      .select({ id: threads.id, userId: threads.userId, updatedAt: threads.updatedAt })
      .from(threads)
      .where(
        cursor
          ? or(
              lt(threads.updatedAt, cursor.updatedAt),
              and(eq(threads.updatedAt, cursor.updatedAt), lt(threads.id, cursor.id))
            )
          : undefined
      )
      .orderBy(desc(threads.updatedAt), desc(threads.id))
      .limit(RUNNOW_PAGE_SIZE)
      .all();
    if (page.length === 0) break;
    considered += page.length;
    for (const t of page) {
      const id = await enqueueJob({ type, threadId: t.id, userId: t.userId, force: true });
      if (id) enqueued += 1;
    }
    if (page.length < RUNNOW_PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = { updatedAt: last.updatedAt, id: last.id };
  }
  return NextResponse.json({ ok: true, enqueued, considered });
}
