import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { fetchChatModels } from "@/lib/lemonade-stream";
import { fastModel, smartModel } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureReady();
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const fast = fastModel();
  const smart = smartModel();

  // Vision capability per model id; unknown when upstream is down.
  let visionById: Map<string, boolean> | null = null;
  try {
    visionById = new Map((await fetchChatModels()).map((m) => [m.id, m.vision]));
  } catch {
    /* capability display is best-effort */
  }

  const entries: { id: string; label?: string; vision?: boolean }[] = [];
  const visionOf = (id: string) => (visionById ? visionById.get(id) : undefined);
  if (fast) entries.push({ id: fast, label: "fast", vision: visionOf(fast) });
  // dedupe: identical smart id collapses into the single "fast" entry
  if (smart && smart !== fast) entries.push({ id: smart, label: "smart", vision: visionOf(smart) });

  // The picker only offers vision-capable models (Lemonade "vision" tag) so
  // image attachments always work; unknown capabilities (upstream down) are
  // kept optimistically. When the upstream is reachable and no configured
  // model is vision-tagged, the list is empty and `noVision` tells the UI to
  // warn the user.
  const models = visionById ? entries.filter((m) => m.vision === true) : entries;
  const noVision = visionById !== null && entries.length > 0 && models.length === 0;

  // Empty list + null default with noVision=false: the admin has not picked a
  // model yet; the UI shows a setup notice and /api/chat rejects sends with
  // "no_model_configured".
  return NextResponse.json({ models, default: models[0]?.id ?? null, noVision });
}
