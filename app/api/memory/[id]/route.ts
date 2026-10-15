// PATCH { text?, pinned? } / DELETE a memory the caller owns. Deleting a row
// that supersedes others un-supersedes them (they become active again).

import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: Partial<{ text: string; pinned: boolean; updatedAt: Date }> = {};
  if (obj.text !== undefined) {
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text || text.length > 500) return NextResponse.json({ error: "invalid_text" }, { status: 400 });
    patch.text = text.slice(0, 500);
  }
  if (obj.pinned !== undefined) {
    if (typeof obj.pinned !== "boolean") return NextResponse.json({ error: "invalid_pinned" }, { status: 400 });
    patch.pinned = obj.pinned;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  patch.updatedAt = new Date();
  const updated = await db
    .update(memories)
    .set(patch)
    .where(and(eq(memories.id, id), eq(memories.userId, userId)))
    .returning({ id: memories.id })
    .get();
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const owned = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.userId, userId)))
    .get();
  if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });
  db.transaction((tx) => {
    tx.update(memories)
      .set({ supersededById: null, updatedAt: new Date() })
      .where(eq(memories.supersededById, id))
      .run();
    tx.delete(memories).where(eq(memories.id, id)).run();
  });
  return NextResponse.json({ ok: true });
}
