import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { ensureCatalog } from "@/lib/provider/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models/catalog → the full effective model catalog (TTL-synced,
 * docs/provider-plan.md M2c): `id` is the canonical `provider:remote` id the
 * caller must store (fast/smart settings, per-task job models), `name` is the
 * provider's own id for display. Unlike GET /api/models (the user's Fast/Smart
 * picker) this lists every visible model of every enabled provider.
 */
export async function GET() {
  await ensureReady();
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { models } = await ensureCatalog();
  return NextResponse.json({
    models: models.map((m) => ({
      id: m.id,
      name: m.remoteId,
      providerId: m.providerId,
      vision: m.vision,
      audioInput: m.audioInput,
    })),
  });
}
