import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { models, providers } from "@/lib/db/schema";
import { resetHealthProbes } from "@/lib/provider/health";
import {
  normalizeBaseUrl,
  providerRowJson,
  validApiKey,
  validLabel,
  validProviderType,
} from "@/lib/provider/manage";
import { resetProviderInstances } from "@/lib/provider/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function bad(detail: string) {
  return NextResponse.json({ error: "invalid_provider", detail }, { status: 400 });
}

/**
 * PATCH /api/backend/providers/[id] (admin only) — partial update. Changing
 * type/baseUrl/apiKey rebuilds the adapter and drops the provider's catalog
 * rows so the next read re-syncs from the new endpoint; label/enabled are
 * metadata-only. `apiKey: null` clears the secret.
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

  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!row) return NextResponse.json({ error: "provider_not_found" }, { status: 404 });

  const patch: Partial<(typeof providers)["$inferInsert"]> = {};
  if (body.label !== undefined) {
    if (!validLabel(body.label)) return bad("invalid_label");
    patch.label = body.label.trim();
  }
  if (body.type !== undefined) {
    if (!validProviderType(body.type)) return bad("invalid_type");
    patch.type = body.type;
  }
  if (body.baseUrl !== undefined) {
    const url = normalizeBaseUrl(body.baseUrl);
    if (!url) return bad("invalid_base_url");
    patch.baseUrl = url;
  }
  if (body.apiKey !== undefined) {
    if (!validApiKey(body.apiKey)) return bad("invalid_api_key");
    patch.apiKey = body.apiKey === null ? null : String(body.apiKey).trim() || null;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return bad("invalid_enabled");
    patch.enabled = body.enabled;
  }
  if (Object.keys(patch).length === 0) return bad("empty_patch");

  const material =
    (patch.baseUrl !== undefined && patch.baseUrl !== row.baseUrl) ||
    (patch.type !== undefined && patch.type !== row.type) ||
    (patch.apiKey !== undefined && patch.apiKey !== row.apiKey);

  patch.updatedAt = new Date();
  const updated = db.update(providers).set(patch).where(eq(providers.id, id)).returning().get();
  if (material) db.delete(models).where(eq(models.providerId, id)).run();
  resetProviderInstances();
  resetHealthProbes();
  return NextResponse.json({ provider: providerRowJson(updated) });
}

/** DELETE /api/backend/providers/[id] (admin only) — cascades its catalog rows. */
export async function DELETE(_req: Request, { params }: Params) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!row) return NextResponse.json({ error: "provider_not_found" }, { status: 404 });

  db.delete(providers).where(eq(providers.id, id)).run();
  resetProviderInstances();
  resetHealthProbes();
  return NextResponse.json({ ok: true });
}
