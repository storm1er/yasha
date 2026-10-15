import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, upstreamErrorResponse } from "@/lib/admin-auth";
import { pullVariants } from "@/lib/lemonade-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/variants?name= → Lemonade pull-variants passthrough (admin only). */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const name = req.nextUrl.searchParams.get("name")?.trim() ?? "";
  if (!name || name.length > 200) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  try {
    const json = await pullVariants(name);
    return NextResponse.json(json);
  } catch {
    return upstreamErrorResponse();
  }
}
