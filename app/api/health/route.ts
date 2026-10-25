import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public liveness probe (Docker HEALTHCHECK). Proves the web process is up and
 * serving — carries NO instance details (the authenticated
 * /api/backend/status route carries per-provider details including base URLs).
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}
