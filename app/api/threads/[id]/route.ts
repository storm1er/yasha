import { NextResponse, type NextRequest } from "next/server";
import { sql, and, eq } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { messages, threads } from "@/lib/db/schema";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function ownedThreadId(req: NextRequest, params: Promise<{ id: string }>): Promise<string | null> {
  await ensureReady();
  const userId = await getAuthedUserId();
  if (!userId) return null;
  const { id } = await params;
  const owned = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, id), eq(threads.userId, userId)))
    .get();
  return owned?.id ?? null;
}

export async function GET(req: NextRequest, { params }: Params) {
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const threadId = await ownedThreadId(req, params);
  if (!threadId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(sql`rowid ASC`);

  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));

  return NextResponse.json({
    thread: {
      threadId: thread.id,
      title: thread.title,
      model: thread.model,
      updatedAt: thread.updatedAt.toISOString(),
    },
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      meta: m.metaJson ? (JSON.parse(m.metaJson) as Record<string, unknown>) : null,
    })),
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const threadId = await ownedThreadId(req, params);
  if (!threadId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await db.delete(threads).where(eq(threads.id, threadId));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const threadId = await ownedThreadId(req, params);
  if (!threadId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const title =
    typeof (body as { title?: unknown })?.title === "string"
      ? (body as { title: string }).title.trim()
      : "";
  if (!title || title.length > 200) return NextResponse.json({ error: "invalid_title" }, { status: 400 });

  await db.update(threads).set({ title, updatedAt: new Date() }).where(eq(threads.id, threadId));
  return NextResponse.json({ ok: true, title });
}
