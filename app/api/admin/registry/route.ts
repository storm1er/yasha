import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, controlPlaneErrorResponse, providerParam, upstreamErrorResponse } from "@/lib/admin-auth";
import { controlPlaneForAdmin } from "@/lib/provider/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/registry?q= → control-plane registry search passthrough (admin only). */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q || q.length > 200) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  const lookup = controlPlaneForAdmin(providerParam(req));
  if (!lookup.ok) return controlPlaneErrorResponse(lookup);

  try {
    const json = await lookup.controlPlane.registrySearch(q);
    return NextResponse.json(json);
  } catch {
    return upstreamErrorResponse();
  }
}
