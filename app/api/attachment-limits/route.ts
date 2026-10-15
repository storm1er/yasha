import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { getSettingInt } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/attachment-limits (any authed user) → effective attachment caps,
 * so the composer mirrors the admin-configured server-side limits.
 */
export async function GET() {
  await ensureReady();
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({
    maxImagesPerMessage: getSettingInt("chat.maxImagesPerMessage"),
    maxWindowImages: getSettingInt("chat.maxWindowImages"),
    maxUploadBytes: getSettingInt("chat.maxUploadBytes"),
  });
}
