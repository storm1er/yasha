import { NextResponse } from "next/server";
import { requireControlPlane, upstreamErrorResponse } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/downloads → control-plane download-queue passthrough (admin only). */
export async function GET(req: Request) {
  const guard = await requireControlPlane(req);
  if (!guard.ok) return guard.response;

  try {
    const json = await guard.cp.downloads();
    return NextResponse.json(json);
  } catch {
    return upstreamErrorResponse();
  }
}
