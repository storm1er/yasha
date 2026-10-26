// Re-queue the caption job for one voice message (AUDIO-REFACTO-PLAN §6).
// Used by the "retry" caption action; `force` bypasses the already-done guard.

import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { messages, threads } from "@/lib/db/schema";
import { resolveEventConfig, smartModel } from "@/lib/settings";
import { ensureCatalog, isAudioInputModel } from "@/lib/provider/catalog";
import { parseStoredAudio } from "@/lib/chat-attachments";
import { enqueueJob } from "@/lib/jobs/queue";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const row = await db
    .select({ id: messages.id, metaJson: messages.metaJson, threadId: messages.threadId })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(and(eq(messages.id, id), eq(threads.userId, userId)))
    .get();
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!parseStoredAudio(row.metaJson)) {
    return NextResponse.json({ error: "no_audio" }, { status: 400 });
  }

  await ensureCatalog(); // caption capability comes from the synced rows
  const cfg = resolveEventConfig("chat.audio_transcription");
  const smart = smartModel();
  if (!cfg.enabled || cfg.schedule === "never" || !cfg.model || !isAudioInputModel(cfg.model) || cfg.model === smart) {
    return NextResponse.json({ error: "audio_not_supported" }, { status: 400 });
  }

  const jobId = await enqueueJob({
    type: "chat.audio_transcription",
    threadId: row.threadId,
    userId,
    keySuffix: row.id,
    payload: { messageId: row.id },
    force: true,
  }).catch(() => null);
  return NextResponse.json({ queued: jobId !== null });
}
