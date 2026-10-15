// Audio-input feature flags for clients (AUDIO-REFACTO-PLAN §4). The mic shows
// only when the FAST model is on the hardcoded compatibility list; the notice
// text explains that the smart model is never used for audio input.

import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { audioInputConfig } from "@/lib/audio-input";
import { fastModel, getSettingInt, smartModel } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureReady();
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    audioInputConfig({
      fastModel: fastModel(),
      smartModel: smartModel(),
      maxAudioBytes: getSettingInt("chat.maxAudioBytes", 1024, 64 * 1024 * 1024),
    })
  );
}
