import { NextResponse, type NextRequest } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { warmUser } from "@/lib/chat/warm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/backend/warm {model?, interactive?, cards?} — issue #67.
 *
 * Fires the discarded "warm" completion (model load + memory-prefix KV
 * prefill, see lib/chat/warm.ts) for the CALLING user; the trigger is client
 * side (app open / new chat / model switch). The response answers as soon as
 * the upstream call is dispatched — never block on model loads. Soft by
 * design: every skip (busy, recent, warm_in_flight, …) is a 200 with a
 * reason, since the only client is fire-and-forget.
 */
export async function POST(req: NextRequest) {
  await ensureReady();
  const limited = await rateLimit(req, "heavy");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const body = (raw ?? {}) as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : null;
  // Flags default to the web surface (interactive + cards); Android sends
  // interactive:false + cards:true so the warm prefix matches its sends.
  const interactive = typeof body.interactive === "boolean" ? body.interactive : undefined;
  const cards = typeof body.cards === "boolean" ? body.cards : undefined;

  const { scheduled, reason, done } = await warmUser({ userId, model, interactive, cards });
  // The response never waits for the upstream call itself (done always
  // settles — dispatchWarm swallows everything).
  void done;
  return NextResponse.json({ scheduled, reason });
}
