import { NextResponse, type NextRequest } from "next/server";
import { controlPlaneErrorResponse, providerParam, requireAdmin } from "@/lib/admin-auth";
import { controlPlaneForAdmin } from "@/lib/provider/registry";
import { MutationsDisabledError } from "@/lib/provider/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOWNLOAD_ACTIONS = ["pause", "cancel", "remove"] as const;

type DownloadAction = (typeof DOWNLOAD_ACTIONS)[number];

/**
 * POST /api/admin/downloads-control {id, action: pause|cancel|remove} (admin only).
 * Passthrough to upstream /v1/downloads/control: pause/cancel return the latest
 * job snapshot for the download job id; remove returns {"status":"ok"}
 * (with "missing":true when the job is already gone).
 * Always 503 {"error":"mutations_disabled"} while ADMIN_ALLOW_BACKEND_MUTATIONS
 * !== "true" (default) — no upstream request is attempted. When the flag is on,
 * the control plane performs the call.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body as { id?: unknown })?.id;
  const action = (body as { action?: unknown })?.action;
  if (typeof id !== "string" || !id.trim() || id.trim().length > 300) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  if (typeof action !== "string" || !(DOWNLOAD_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: "invalid_action", allowed: DOWNLOAD_ACTIONS },
      { status: 400 }
    );
  }

  const lookup = controlPlaneForAdmin(providerParam(req));
  if (!lookup.ok) return controlPlaneErrorResponse(lookup);

  try {
    const result = await lookup.controlPlane.downloadsControl(id.trim(), action as DownloadAction);
    return NextResponse.json({ ok: true, action, result });
  } catch (err) {
    if (err instanceof MutationsDisabledError) {
      return NextResponse.json({ error: "mutations_disabled" }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "upstream_error";
    return NextResponse.json({ error: "upstream_error", detail: message }, { status: 502 });
  }
}
