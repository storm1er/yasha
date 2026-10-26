import { NextResponse, type NextRequest } from "next/server";
import { controlPlaneErrorResponse, providerParam, requireAdmin } from "@/lib/admin-auth";
import { controlPlaneForAdmin } from "@/lib/provider/registry";
import { MutationsDisabledError, type ControlPlane } from "@/lib/provider/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_NAMES = ["pull", "load", "unload", "delete"] as const;
type Action = (typeof ACTION_NAMES)[number];

const PULL_SOURCES = ["huggingface", "modelscope"] as const;
const MODEL_NAME_RE = /^[A-Za-z0-9._-]+$/;

function trimmedField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Per-load overrides accepted alongside {action:"load", model}. */
function loadOptionsFrom(body: unknown): Parameters<ControlPlane["load"]>[1] {
  const b = body as Record<string, unknown>;
  const out: NonNullable<Parameters<ControlPlane["load"]>[1]> = {};
  const ctx = b.ctx_size;
  if (typeof ctx === "number" && Number.isInteger(ctx) && ctx > 0 && ctx <= 8_388_608) {
    out.ctx_size = ctx;
  }
  if (typeof b.llamacpp_backend === "string" && b.llamacpp_backend.length <= 60) {
    out.llamacpp_backend = b.llamacpp_backend;
  }
  if (typeof b.llamacpp_args === "string" && b.llamacpp_args.length <= 2000) {
    out.llamacpp_args = b.llamacpp_args;
  }
  if (typeof b.merge_args === "boolean") out.merge_args = b.merge_args;
  if (typeof b.pinned === "boolean") out.pinned = b.pinned;
  return out;
}

/**
 * POST /api/admin/actions (admin only).
 * {action: load|unload|delete, model} — model-only passthrough. `load` may
 *  also carry {ctx_size?, llamacpp_backend?, llamacpp_args?, merge_args?,
 *  pinned?} to apply the Model-Options popup settings on this load only.
 * {action: pull, model, recipe?, checkpoint?, source?, mmproj?, vision?,
 *  embedding?, reranking?} — install payload; checkpoint is "repo:QUANT",
 *  recipe is required whenever checkpoint is set, source must be
 *  "huggingface"|"modelscope", and model is restricted to [A-Za-z0-9._-].
 * Booleans are forwarded only when actually booleans.
 * Always 503 {"error":"mutations_disabled"} while ADMIN_ALLOW_BACKEND_MUTATIONS
 * !== "true" (default) — no upstream request is attempted. When the flag is on,
 * the provider's control plane performs the call.
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
  const action = (body as { action?: unknown })?.action;
  const model = (body as { model?: unknown })?.model;
  if (typeof action !== "string" || !(ACTION_NAMES as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "invalid_action", allowed: ACTION_NAMES }, { status: 400 });
  }
  if (typeof model !== "string" || !model.trim() || model.length > 200) {
    return NextResponse.json({ error: "invalid_model" }, { status: 400 });
  }
  if (action === "pull" && !MODEL_NAME_RE.test(model.trim())) {
    return NextResponse.json(
      { error: "invalid_request", detail: "invalid_model_name" },
      { status: 400 }
    );
  }

  const recipe = trimmedField((body as { recipe?: unknown })?.recipe);
  const checkpoint = trimmedField((body as { checkpoint?: unknown })?.checkpoint);
  const source = trimmedField((body as { source?: unknown })?.source);
  const mmproj = trimmedField((body as { mmproj?: unknown })?.mmproj);

  if (checkpoint !== undefined) {
    if (recipe === undefined) {
      return NextResponse.json(
        { error: "invalid_request", detail: "recipe_required_for_checkpoint" },
        { status: 400 }
      );
    }
    if (checkpoint.length > 300) {
      return NextResponse.json(
        { error: "invalid_request", detail: "checkpoint_too_long" },
        { status: 400 }
      );
    }
  }
  if (recipe !== undefined && recipe.length > 60) {
    return NextResponse.json(
      { error: "invalid_request", detail: "recipe_too_long" },
      { status: 400 }
    );
  }
  if (source !== undefined) {
    if (source.length > 30) {
      return NextResponse.json(
        { error: "invalid_request", detail: "source_too_long" },
        { status: 400 }
      );
    }
    if (!(PULL_SOURCES as readonly string[]).includes(source)) {
      return NextResponse.json(
        { error: "invalid_request", detail: "invalid_source" },
        { status: 400 }
      );
    }
  }
  if (mmproj !== undefined && mmproj.length > 200) {
    return NextResponse.json(
      { error: "invalid_request", detail: "mmproj_too_long" },
      { status: 400 }
    );
  }

  const lookup = controlPlaneForAdmin(providerParam(req));
  if (!lookup.ok) return controlPlaneErrorResponse(lookup);
  const cp = lookup.controlPlane;

  try {
    let result: unknown;
    if (action === "pull") {
      const options: Parameters<ControlPlane["pull"]>[1] = { recipe, checkpoint, source, mmproj };
      const vision = (body as { vision?: unknown })?.vision;
      const embedding = (body as { embedding?: unknown })?.embedding;
      const reranking = (body as { reranking?: unknown })?.reranking;
      if (typeof vision === "boolean") options.vision = vision;
      if (typeof embedding === "boolean") options.embedding = embedding;
      if (typeof reranking === "boolean") options.reranking = reranking;
      result = await cp.pull(model.trim(), options);
    } else if (action === "load") {
      result = await cp.load(model.trim(), loadOptionsFrom(body));
    } else if (action === "unload") {
      result = await cp.unload(model.trim());
    } else {
      result = await cp.del(model.trim());
    }
    return NextResponse.json({ ok: true, action, result });
  } catch (err) {
    if (err instanceof MutationsDisabledError) {
      return NextResponse.json({ error: "mutations_disabled" }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "upstream_error";
    return NextResponse.json({ error: "upstream_error", detail: message }, { status: 502 });
  }
}
