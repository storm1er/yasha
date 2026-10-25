import { NextResponse } from "next/server";
import { requireControlPlane, upstreamErrorResponse } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/server → { health, systemInfo, systemStats } (admin only). */
export async function GET(req: Request) {
  const guard = await requireControlPlane(req);
  if (!guard.ok) return guard.response;

  const [h, si, ss] = await Promise.allSettled([
    guard.cp.health(),
    guard.cp.systemInfo(),
    guard.cp.systemStats(),
  ]);
  if (h.status === "rejected" && si.status === "rejected" && ss.status === "rejected") {
    return upstreamErrorResponse();
  }
  return NextResponse.json({
    health: h.status === "fulfilled" ? h.value : null,
    systemInfo: si.status === "fulfilled" ? si.value : null,
    systemStats: ss.status === "fulfilled" ? ss.value : null,
  });
}
