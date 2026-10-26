import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { providersHealth } from "@/lib/provider/health";
import { enabledProviderRows } from "@/lib/provider/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/backend/status → per-provider health for every enabled provider
 * (docs/provider-plan.md M3, Q19/Q23). Session-gated: provider base URLs are
 * disclosed to authenticated users only; keys never leave the server. The UI
 * badge shows the WORST status (`ok`); `providers` feeds the per-provider
 * tooltip / Backend tab. Zero enabled providers is a soft state: ok=false,
 * empty list (Q22).
 */
export async function GET() {
  if (!(await getAuthedUserId())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await ensureReady();
  const providers = await providersHealth(enabledProviderRows());
  return NextResponse.json({
    ok: providers.length > 0 && providers.every((p) => p.ok),
    providers,
  });
}
