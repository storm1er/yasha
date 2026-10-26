import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, controlPlaneErrorResponse, providerParam, upstreamErrorResponse } from "@/lib/admin-auth";
import { controlPlaneForAdmin } from "@/lib/provider/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/variants?name= → control-plane pull-variants passthrough (admin only). */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const name = req.nextUrl.searchParams.get("name")?.trim() ?? "";
  if (!name || name.length > 200) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  const lookup = controlPlaneForAdmin(providerParam(req));
  if (!lookup.ok) return controlPlaneErrorResponse(lookup);

  try {
    const json = await lookup.controlPlane.pullVariants(name);
    return NextResponse.json(json);
  } catch {
    return upstreamErrorResponse();
  }
}
