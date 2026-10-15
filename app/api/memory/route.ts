// User-scoped memory CRUD (session auth). GET lists ACTIVE memories
// (superseded rows are history), paginated via ?limit=1..100&offset=0
// (defaults 50/0) with `total`/`hasMore` for the clients' load-more UI;
// POST adds an explicit memory.

import { NextResponse, type NextRequest } from "next/server";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { memories, MEMORY_KINDS, type MemoryKind } from "@/lib/db/schema";
import { getUserMemoryOverride } from "@/lib/memory/prefs";
import { getMemoryCard } from "@/lib/memory/card";
import { memoryEnabled } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(sp.get("limit")) || PAGE_SIZE));
  const offset = Math.max(0, Math.trunc(Number(sp.get("offset")) || 0));
  const active = and(eq(memories.userId, userId), isNull(memories.supersededById));
  const rows = await db
    .select({
      id: memories.id,
      kind: memories.kind,
      text: memories.text,
      source: memories.source,
      confidence: memories.confidence,
      pinned: memories.pinned,
      threadId: memories.threadId,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(active)
    .orderBy(desc(memories.pinned), desc(memories.updatedAt))
    .limit(limit)
    .offset(offset)
    .all();
  // Count query with no GROUP BY always yields exactly one row.
  const total = db.select({ c: count() }).from(memories).where(active).get()!.c;
  return NextResponse.json({
    ok: true,
    memories: rows,
    total,
    hasMore: offset + rows.length < total,
    userEnabled: getUserMemoryOverride(userId) ?? null,
    instanceEnabled: memoryEnabled(),
    card: getMemoryCard(userId),
  });
}

export async function POST(req: NextRequest) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = typeof obj.text === "string" ? obj.text.trim() : "";
  if (!text || text.length > 500) return NextResponse.json({ error: "invalid_text" }, { status: 400 });
  const kind = (MEMORY_KINDS as readonly string[]).includes(String(obj.kind)) ? (obj.kind as MemoryKind) : "fact";
  const now = new Date();
  const id = crypto.randomUUID();
  await db
    .insert(memories)
    .values({ id, userId, kind, text: text.slice(0, 500), source: "explicit", pinned: false, createdAt: now, updatedAt: now })
    .run();
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
