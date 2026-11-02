// Explicit stop for an in-flight generation (issue #33). Disconnecting no
// longer kills a turn — generation finishes server-side and reattaches are
// live — so the Stop button must tell the server: without this, closing the
// tab mid-turn would burn upstream tokens to completion. The kill hook aborts
// the turn exactly like the old disconnect path: the partial row persists as
// `aborted: true` and the busy gate releases.

import { NextResponse, type NextRequest } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { killReplay } from "@/lib/chat/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await ensureReady();
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id === "") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!killReplay(userId, id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
