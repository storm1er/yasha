import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, upstreamErrorResponse } from "@/lib/admin-auth";
import { registrySearch } from "@/lib/lemonade-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/registry?q= → Lemonade registry search passthrough (admin only). */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q || q.length > 200) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  try {
    const json = await registrySearch(q);
    return NextResponse.json(json);
  } catch {
    return upstreamErrorResponse();
  }
}
