import { NextResponse, type NextRequest } from "next/server";
import {
  controlPlaneErrorResponse,
  providerParam,
  requireAdmin,
  requireControlPlane,
  upstreamErrorResponse,
} from "@/lib/admin-auth";
import { controlPlaneForAdmin } from "@/lib/provider/registry";
import { MutationsDisabledError } from "@/lib/provider/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const OPTION_KEYS = ["ctx_size", "llamacpp_backend", "llamacpp_args", "merge_args"] as const;
type OptionKey = (typeof OPTION_KEYS)[number];

function validOptionValue(key: OptionKey, value: unknown): boolean {
  if (value === null) return true;
  switch (key) {
    case "ctx_size":
      return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 8_388_608;
    case "llamacpp_backend":
      return typeof value === "string" && value.length <= 60;
    case "llamacpp_args":
      return typeof value === "string" && value.length <= 2000;
    case "merge_args":
      return typeof value === "boolean";
  }
}

/**
 * GET /api/admin/models/{id}/options (admin only).
 * Proxies GET /v1/models/{id}/options and enriches the payload with the
 * runtime state of the model (loaded + pinned) from /v1/health.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireControlPlane(req);
  if (!guard.ok) return guard.response;
  const cp = guard.cp;

  const { id } = await params;
  if (!id || id.length > 200) return NextResponse.json({ error: "invalid_model" }, { status: 400 });

  let options;
  let loaded = false;
  let pinned = false;
  try {
    options = await cp.modelOptions(id);
    const entries = await cp.loadedModels();
    const entry = entries.find((e) => e.model_name === id);
    loaded = Boolean(entry);
    pinned = entry?.pinned === true;
  } catch {
    return upstreamErrorResponse();
  }

  return NextResponse.json({ ...options, loaded, pinned });
}

/**
 * POST /api/admin/models/{id}/options (admin only, mutation-flag gated).
 * {options?: {ctx_size?: int|null, llamacpp_backend?: string|null,
 *  llamacpp_args?: string|null, merge_args?: bool|null}, pin?: bool}
 * Non-null values persist the key server-side, null clears it. `pin` toggles
 * auto-evict protection via /internal/pin, but only while the model is loaded
 * (upstream rejects pinning idle models).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  if (!id || id.length > 200) return NextResponse.json({ error: "invalid_model" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const rawOptions = (body as { options?: unknown })?.options;
  const options: Record<string, string | number | boolean | null> = {};
  if (rawOptions !== undefined && (typeof rawOptions !== "object" || rawOptions === null || Array.isArray(rawOptions))) {
    return NextResponse.json({ error: "invalid_request", detail: "invalid_options" }, { status: 400 });
  }
  if (rawOptions) {
    for (const [key, value] of Object.entries(rawOptions as Record<string, unknown>)) {
      if (!(OPTION_KEYS as readonly string[]).includes(key)) {
        return NextResponse.json({ error: "invalid_request", detail: `unknown_option_${key}` }, { status: 400 });
      }
      if (!validOptionValue(key as OptionKey, value)) {
        return NextResponse.json({ error: "invalid_request", detail: `invalid_option_${key}` }, { status: 400 });
      }
      options[key] = value as string | number | boolean | null;
    }
  }

  const pin = (body as { pin?: unknown })?.pin;
  if (pin !== undefined && typeof pin !== "boolean") {
    return NextResponse.json({ error: "invalid_request", detail: "invalid_pin" }, { status: 400 });
  }
  if (Object.keys(options).length === 0 && pin === undefined) {
    return NextResponse.json({ error: "invalid_request", detail: "empty_patch" }, { status: 400 });
  }

  const lookup = controlPlaneForAdmin(providerParam(req));
  if (!lookup.ok) return controlPlaneErrorResponse(lookup);
  const cp = lookup.controlPlane;

  try {
    let savedOptions = null;
    if (Object.keys(options).length > 0) {
      savedOptions = await cp.setModelOptions(id, options);
    }
    let pinnedApplied = false;
    if (pin !== undefined) {
      const entry = (await cp.loadedModels()).find((e) => e.model_name === id);
      if (entry) {
        await cp.pin(id, pin);
        pinnedApplied = true;
      }
    }
    return NextResponse.json({ ok: true, options: savedOptions, pinnedApplied });
  } catch (err) {
    if (err instanceof MutationsDisabledError) {
      return NextResponse.json({ error: "mutations_disabled" }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "upstream_error";
    return NextResponse.json({ error: "upstream_error", detail: message }, { status: 502 });
  }
}
