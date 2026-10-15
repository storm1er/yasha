import { NextResponse } from "next/server";
import { requireAdmin, upstreamErrorResponse } from "@/lib/admin-auth";
import { models, mutationsEnabled } from "@/lib/lemonade-admin";
import type { LemonadeModel } from "@/lib/lemonade-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/models → raw-ish list {id, recipe, size, downloaded, labels,
 * checkpoint, max_context_window} (admin only). Also carries
 * `mutations_enabled` (read-only env flag) so the admin UI can gate action
 * buttons without probing upstream mutating endpoints.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let json;
  try {
    json = await models();
  } catch {
    return upstreamErrorResponse();
  }

  const list = (Array.isArray(json.data) ? json.data : []).map((m: LemonadeModel) => ({
    id: typeof m.id === "string" ? m.id : null,
    recipe: typeof m.recipe === "string" ? m.recipe : null,
    size: typeof m.size === "number" || typeof m.size === "string" ? m.size : null,
    downloaded: m.downloaded === true,
    labels: Array.isArray(m.labels) ? m.labels.filter((l): l is string => typeof l === "string") : [],
    checkpoint: typeof m.checkpoint === "string" ? m.checkpoint : null,
    max_context_window: typeof m.max_context_window === "number" ? m.max_context_window : null,
  }));

  return NextResponse.json({
    models: list,
    count: list.length,
    mutations_enabled: mutationsEnabled(),
  });
}
