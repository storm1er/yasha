import { NextResponse } from "next/server";
import { requireAdmin, upstreamErrorResponse } from "@/lib/admin-auth";
import { health, systemInfo, systemStats } from "@/lib/lemonade-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/server → { health, systemInfo, systemStats } (admin only). */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [h, si, ss] = await Promise.allSettled([health(), systemInfo(), systemStats()]);
  if (h.status === "rejected" && si.status === "rejected" && ss.status === "rejected") {
    return upstreamErrorResponse();
  }
  return NextResponse.json({
    health: h.status === "fulfilled" ? h.value : null,
    systemInfo: si.status === "fulfilled" ? si.value : null,
    systemStats: ss.status === "fulfilled" ? ss.value : null,
  });
}
