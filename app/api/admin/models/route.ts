import { NextResponse } from "next/server";
import { requireControlPlane, upstreamErrorResponse } from "@/lib/admin-auth";
import { backendMutationsEnabled } from "@/lib/provider/lemonade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/models → raw-ish list {id, recipe, size, downloaded, labels,
 * checkpoint, max_context_window} from the provider's control plane (admin
 * only). Also carries `mutations_enabled` (read-only env flag) so the admin
 * UI can gate action buttons without probing upstream mutating endpoints.
 */
export async function GET(req: Request) {
  const guard = await requireControlPlane(req);
  if (!guard.ok) return guard.response;

  let json;
  try {
    json = await guard.cp.models();
  } catch {
    return upstreamErrorResponse();
  }

  const list = (Array.isArray(json.data) ? json.data : []).map((m) => ({
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
    mutations_enabled: backendMutationsEnabled(),
  });
}
