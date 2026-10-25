import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { models, providers } from "@/lib/db/schema";
import { ensureCatalog } from "@/lib/provider/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/backend/models → every synced catalog row (admin only), joined
 * with the provider label. Includes hidden rows; this is the Backend tab's
 * model table (docs/provider-plan.md M3) — unlike GET /api/models/catalog
 * (user picker semantics), it never filters by chat labels. Reads run through
 * ensureCatalog first so a freshly added provider lists models immediately.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  await ensureCatalog();
  const rows = db
    .select({
      id: models.id,
      providerId: models.providerId,
      providerLabel: providers.label,
      remoteId: models.remoteId,
      vision: models.vision,
      audioInput: models.audioInput,
      hidden: models.hidden,
      lastSyncedAt: models.lastSyncedAt,
    })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .orderBy(asc(models.providerId), asc(models.remoteId))
    .all();
  return NextResponse.json({
    models: rows.map((r) => ({ ...r, lastSyncedAt: r.lastSyncedAt?.getTime() ?? null })),
  });
}
