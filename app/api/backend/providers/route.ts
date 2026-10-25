import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import {
  normalizeBaseUrl,
  providerRowJson,
  validApiKey,
  validLabel,
  validProviderId,
  validProviderType,
} from "@/lib/provider/manage";
import { resetHealthProbes } from "@/lib/provider/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(detail: string) {
  return NextResponse.json({ error: "invalid_provider", detail }, { status: 400 });
}

/**
 * GET /api/backend/providers → all provider rows (admin only), API keys
 * masked (`hasKey`). Powers the Backend tab's provider list (M3).
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return NextResponse.json({ providers: db.select().from(providers).all().map(providerRowJson) });
}

/**
 * POST /api/backend/providers {id, type, label, baseUrl, apiKey?, enabled?}
 * → creates a provider row (admin only). Id is a slug (no `:`, Q6); new
 * providers pick up their model catalog on the next sync (empty table →
 * ensureCatalog re-syncs immediately).
 */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("body_not_object");
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("invalid_json");
  }

  const { id, type, label, baseUrl, apiKey } = body;
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (!validProviderId(id)) return bad("invalid_id");
  if (!validProviderType(type)) return bad("invalid_type");
  if (!validLabel(label)) return bad("invalid_label");
  const url = normalizeBaseUrl(baseUrl);
  if (!url) return bad("invalid_base_url");
  if (apiKey !== undefined && !validApiKey(apiKey)) return bad("invalid_api_key");
  if (typeof enabled !== "boolean") return bad("invalid_enabled");

  if (db.select({ id: providers.id }).from(providers).where(eq(providers.id, id)).get()) {
    return NextResponse.json({ error: "provider_exists" }, { status: 409 });
  }
  const now = new Date();
  const row = db
    .insert(providers)
    .values({ id, type, label: label.trim(), baseUrl: url, apiKey: apiKey ? String(apiKey).trim() : null, enabled, createdAt: now, updatedAt: now })
    .returning()
    .get();
  resetHealthProbes();
  return NextResponse.json({ provider: providerRowJson(row) }, { status: 201 });
}
