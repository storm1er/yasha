import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { models } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function bad(detail: string) {
  return NextResponse.json({ error: "invalid_model_override", detail }, { status: 400 });
}

/**
 * PATCH /api/backend/models/[id] {vision?, audioInput?, hidden?} (admin only)
 * — capability overrides on a catalog row (Q14): explicit booleans win over
 * sync/auto-seed, and later syncs never overwrite them. `hidden` removes the
 * model from every picker without deleting the row.
 */
export async function PATCH(req: Request, { params }: Params) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("body_not_object");
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("invalid_json");
  }

  const patch: { vision?: boolean; audioInput?: boolean; hidden?: boolean } = {};
  for (const key of ["vision", "audioInput", "hidden"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") return bad(`invalid_${key}`);
      patch[key] = body[key];
    }
  }
  if (Object.keys(patch).length === 0) return bad("empty_patch");

  const updated = db
    .update(models)
    .set(patch)
    .where(eq(models.id, id))
    .returning({ id: models.id, vision: models.vision, audioInput: models.audioInput, hidden: models.hidden })
    .get();
  if (!updated) return NextResponse.json({ error: "model_not_found" }, { status: 404 });
  return NextResponse.json({ model: updated });
}
