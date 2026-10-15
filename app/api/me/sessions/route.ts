// Session management (Settings → General): list the caller's active sessions
// (last-used derived from the auth-time activity bump) and revoke them.

import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { getAuthedContext } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { session } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET() {
  await ensureReady();
  const ctx = await getAuthedContext();
  if (!ctx) return unauthorized();
  const rows = await db
    .select({
      id: session.id,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      lastUsedAt: session.updatedAt,
      expiresAt: session.expiresAt,
    })
    .from(session)
    .where(and(eq(session.userId, ctx.userId), gt(session.expiresAt, new Date())))
    .orderBy(desc(session.updatedAt));
  return NextResponse.json({
    sessions: rows.map((r) => ({
      id: r.id,
      current: r.id === ctx.sessionId,
      userAgent: r.userAgent,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    })),
  });
}

type Body = { action?: unknown; sessionId?: unknown };

export async function POST(req: NextRequest) {
  await ensureReady();
  const ctx = await getAuthedContext();
  if (!ctx) return unauthorized();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.action === "revokeOthers") {
    const others = db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.userId, ctx.userId), ne(session.id, ctx.sessionId)))
      .all();
    db.delete(session)
      .where(and(eq(session.userId, ctx.userId), ne(session.id, ctx.sessionId)))
      .run();
    return NextResponse.json({ ok: true, revoked: others.length });
  }
  if (body.action === "revoke") {
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }
    if (body.sessionId === ctx.sessionId) {
      return NextResponse.json({ error: "cannot_revoke_current" }, { status: 400 });
    }
    const target = db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.id, body.sessionId), eq(session.userId, ctx.userId)))
      .get();
    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
    db.delete(session).where(eq(session.id, body.sessionId)).run();
    return NextResponse.json({ ok: true, revoked: 1 });
  }
  return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
}
