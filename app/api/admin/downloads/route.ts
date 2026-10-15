import { NextResponse } from "next/server";
import { requireAdmin, upstreamErrorResponse } from "@/lib/admin-auth";
import { downloads } from "@/lib/lemonade-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/downloads → Lemonade download-queue passthrough (admin only). */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  try {
    const json = await downloads();
    return NextResponse.json(json);
  } catch {
    return upstreamErrorResponse();
  }
}
