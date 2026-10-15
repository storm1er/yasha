import { NextResponse, type NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { requireAdmin } from "@/lib/admin-auth";
import { ensureReady } from "@/lib/db";
import { db } from "@/lib/db";
import { mcpServers, user } from "@/lib/db/schema";
import { mcpEnabled, mcpUserPrivateUrls, mcpUserServersEnabled } from "@/lib/settings";
import { dropConnection } from "@/lib/mcp/client";
import {
  maskHeaders,
  parseHeaders,
  slugId,
  validateDisabledTools,
  validateHeaders,
  validateHeadersPatch,
  validateUrl,
} from "@/lib/mcp/validate";
import {
  clearOauthRow,
  ensureOauthRow,
  getPending,
  oauthStatus,
} from "@/lib/mcp/oauth/store";
import { adminCatalog, getServer, invalidateCatalog, serverCatalog } from "@/lib/mcp/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalid(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

type Body = {
  action?: unknown;
  id?: unknown;
  name?: unknown;
  url?: unknown;
  headers?: unknown;
  disabledTools?: unknown;
};

function parseBody(body: Body): { error: string } | { ok: true } {
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)) {
    return { error: "invalid_name" };
  }
  return { ok: true };
}

/**
 * GET /api/admin/mcp → { ok, mcpEnabled, servers } (masked headers + health +
 * cached tool list per server). `owner` = username for user-owned rows, else
 * null (global/builtin).
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  await ensureReady();
  const entries = await adminCatalog();
  const ownerIds = [...new Set(entries.map((e) => e.server.ownerUserId).filter((o): o is string => !!o))];
  const ownerNames = new Map<string, string>();
  if (ownerIds.length) {
    for (const u of db
      .select({ id: user.id, username: user.username })
      .from(user)
      .where(inArray(user.id, ownerIds))
      .all()) {
      ownerNames.set(u.id, u.username ?? u.id);
    }
  }
  return NextResponse.json({
    ok: true,
    mcpEnabled: mcpEnabled(),
    userServersEnabled: mcpUserServersEnabled(),
    userPrivateUrls: mcpUserPrivateUrls(),
    servers: entries.map((e) => ({
      id: e.server.id,
      builtin: e.server.builtin,
      name: e.server.name,
      url: e.server.url,
      enabled: e.server.enabled,
      // FK cascade guarantees every owner id resolves to a user row, so the
      // map lookup cannot miss.
      owner: e.server.ownerUserId ? ownerNames.get(e.server.ownerUserId)! : null,
      headers: maskHeaders(e.server.headersJson),
      disabledTools: e.server.disabledToolsJson ? (JSON.parse(e.server.disabledToolsJson) as string[]) : [],
      oauth: oauthStatus(e.server.id),
      health: e.health,
      tools: e.tools,
    })),
  });
}

/**
 * POST /api/admin/mcp — actions: add | update | delete | toggle | check.
 * Only remote servers can be added/updated/deleted; builtin rows toggle only.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  await ensureReady();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return invalid("invalid_payload");
  }
  const bad = parseBody(body);
  if ("error" in bad) return invalid(bad.error);
  const action = body.action;
  if (typeof action !== "string") return invalid("invalid_payload");

  if (action === "add") {
    if (typeof body.name !== "string" || !body.name.trim()) return invalid("invalid_name");
    const name = body.name.trim();
    const url = validateUrl(body.url);
    if (typeof url !== "string") return invalid(url.error);
    const headers = validateHeaders(body.headers);
    if (headers && typeof headers === "object" && "error" in headers) return invalid(headers.error);
    const disabled = validateDisabledTools(body.disabledTools);
    if (disabled && typeof disabled === "object" && "error" in disabled) return invalid(disabled.error);
    const id = slugId(name);
    const now = new Date();
    db.insert(mcpServers)
      .values({
        id,
        builtin: false,
        name,
        url,
        headersJson: (headers as string | null) ?? null,
        disabledToolsJson: (disabled as string | null) ?? null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    invalidateCatalog();
    return NextResponse.json({ ok: true, id });
  }

  if (typeof body.id !== "string") return invalid("invalid_payload");
  const row = getServer(body.id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (action === "toggle") {
    db.update(mcpServers)
      .set({ enabled: !row.enabled, updatedAt: new Date() })
      .where(eq(mcpServers.id, row.id))
      .run();
    invalidateCatalog(row.id);
    dropConnection(row.id);
    return NextResponse.json({ ok: true, enabled: !row.enabled });
  }

  if (action === "delete") {
    if (row.builtin) return invalid("builtin_undeletable");
    db.delete(mcpServers).where(eq(mcpServers.id, row.id)).run();
    invalidateCatalog(row.id);
    dropConnection(row.id);
    return NextResponse.json({ ok: true });
  }

  if (action === "update") {
    // User-owned rows are owner-editable only (admins keep check/toggle/delete
    // for moderation; secrets never round-trip through the admin UI).
    if (row.ownerUserId) return invalid("user_owned_readonly");
    // Builtin rows are read-only EXCEPT the per-tool denylist.
    if (row.builtin && body.disabledTools === undefined) return invalid("builtin_readonly");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    // name (if present) is already validated as a non-empty string by parseBody
    if (body.name !== undefined) {
      if (row.builtin) return invalid("builtin_readonly");
      patch.name = (body.name as string).trim();
    }
    if (body.url !== undefined) {
      if (row.builtin) return invalid("builtin_readonly");
      const url = validateUrl(body.url);
      if (typeof url !== "string") return invalid(url.error);
      patch.url = url;
    }
    if (body.headers !== undefined) {
      if (row.builtin) return invalid("builtin_readonly");
      // Merge-patch: string upserts, null deletes (masked reads can't round-trip).
      const hp = validateHeadersPatch(body.headers);
      if ("error" in hp) return invalid((hp as { error: string }).error);
      const merged = parseHeaders(row.headersJson);
      for (const [k, v] of Object.entries(hp)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      patch.headersJson = Object.keys(merged).length ? JSON.stringify(merged) : null;
    }
    if (body.disabledTools !== undefined) {
      const disabled = validateDisabledTools(body.disabledTools);
      if (disabled && typeof disabled === "object" && "error" in disabled) return invalid(disabled.error);
      patch.disabledToolsJson = disabled as string | null;
    }
    if (Object.keys(patch).length <= 1) return invalid("invalid_payload");
    db.update(mcpServers).set(patch).where(eq(mcpServers.id, row.id)).run();
    invalidateCatalog(row.id);
    dropConnection(row.id);
    return NextResponse.json({ ok: true });
  }

  if (action === "connect") {
    if (row.ownerUserId) return invalid("user_owned_readonly");
    if (!row.url) return invalid("oauth_url_required");
    ensureOauthRow(row.id);
    dropConnection(row.id);
    invalidateCatalog(row.id);
    const entry = await serverCatalog(row, true, Date.now(), true);
    if (entry.health.ok) return NextResponse.json({ ok: true, connected: true, toolCount: entry.tools.length });
    if (entry.health.code === "needs_auth") {
      const authorizationUrl = getPending(row.id)?.url;
      if (!authorizationUrl) return invalid("oauth_flow_failed");
      return NextResponse.json({ ok: true, needsAuth: true, authorizationUrl });
    }
    return NextResponse.json({ ok: true, connected: false, health: entry.health });
  }

  if (action === "disconnect") {
    if (row.ownerUserId) return invalid("user_owned_readonly");
    clearOauthRow(row.id);
    invalidateCatalog(row.id);
    dropConnection(row.id);
    return NextResponse.json({ ok: true });
  }

  if (action === "check") {
    invalidateCatalog(row.id);
    const entry = await serverCatalog(row, true);
    return NextResponse.json({ ok: true, health: entry.health, toolCount: entry.tools.length });
  }

  return invalid("invalid_payload");
}
