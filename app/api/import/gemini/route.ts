// GET /api/import/gemini — the user's import batches, newest first (poll
// endpoint for the settings card while non-terminal; no SSE by design).

import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { importBatches } from "@/lib/db/schema";
import { batchView } from "@/lib/jobs/gemini-import";
import { rateLimit } from "@/lib/rate-limit";
import { memoryEnabled } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 25;

export async function GET(req: NextRequest) {
  await ensureReady();
  const limited = await rateLimit(req, "api");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = db
    .select()
    .from(importBatches)
    .where(eq(importBatches.userId, userId))
    .orderBy(desc(importBatches.createdAt), desc(importBatches.id))
    .limit(PAGE)
    .all();

  // learnEnabled lets the card hide the learnFromImports option while the
  // admin memory-derivation switch is off (import itself always works).
  return NextResponse.json({ imports: rows.map(batchView), learnEnabled: memoryEnabled() });
}
