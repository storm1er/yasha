// User-owned MCP servers (personal card). Session-gated; every row is scoped
// to the caller (`owner_user_id`); global/builtin rows are 404 here. Remote
// streamable-HTTP only; private/LAN hosts are always blocked for user rows.

import { NextResponse, type NextRequest } from "next/server";
import { count, eq } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { mcpMaxUserServers, mcpUserPrivateUrls, mcpUserServersEnabled } from "@/lib/settings";
import { dropConnection } from "@/lib/mcp/client";
import { clearOauthRow, ensureOauthRow, getPending, oauthStatus } from "@/lib/mcp/oauth/store";
import { getServer, invalidateCatalog, serverCatalog, userCatalog } from "@/lib/mcp/registry";
import {
  maskHeaders,
  parseHeaders,
  slugId,
  validateDisabledTools,
  validateHeaders,
  validateHeadersPatch,
  validateUrl,
} from "@/lib/mcp/validate";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalid(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

type Body = {
  action?: unknown;
  id?: unknown;
  name?: unknown;
  url?: unknown;
  headers?: unknown;
  disabledTools?: unknown;
};

/** Name validation shared by add/update (admin card clone minus builtin). */
function parseName(body: Body): string | { error: string } {
  if (body.name === undefined) return { error: "invalid_name" };
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100) {
    return { error: "invalid_name" };
  }
  return body.name.trim();
}

/**
 * GET /api/mcp/servers → caller's own servers (masked headers + health +
 * cached tool list) + the `mcp.userServersEnabled` / quota context the card
 * needs.
 */
export async function GET(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return invalid("unauthorized", 401);
  const entries = await userCatalog(userId);
  return NextResponse.json({
    ok: true,
    serversEnabled: mcpUserServersEnabled(),
    privateUrlsAllowed: mcpUserPrivateUrls(),
    maxServers: mcpMaxUserServers(),
    servers: entries.map((e) => ({
      id: e.server.id,
      name: e.server.name,
      url: e.server.url,
      enabled: e.server.enabled,
      headers: maskHeaders(e.server.headersJson),
      disabledTools: e.server.disabledToolsJson ? (JSON.parse(e.server.disabledToolsJson) as string[]) : [],
      oauth: oauthStatus(e.server.id),
      health: e.health,
      tools: e.tools,
    })),
  });
}

/**
 * POST /api/mcp/servers — actions: add | update | delete | toggle | check.
 * Foreign/builtin/global rows are indistinguishable from missing (404).
 */
export async function POST(req: NextRequest) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return invalid("unauthorized", 401);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return invalid("invalid_payload");
  }
  const action = body.action;
  if (typeof action !== "string") return invalid("invalid_payload");

  if (action === "add") {
    if (!mcpUserServersEnabled()) return invalid("user_servers_disabled", 403);
    const name = parseName(body);
    if (typeof name !== "string") return invalid(name.error);
    // User rows: private/LAN hosts blocked unless the admin opened the guard
    // (mcp.userPrivateUrls). Best-effort literal-address check either way.
    const blockPrivate = !mcpUserPrivateUrls();
    const url = validateUrl(body.url, blockPrivate);
    if (typeof url !== "string") return invalid(url.error);
    const headers = validateHeaders(body.headers);
    if (headers && typeof headers === "object" && "error" in headers) return invalid(headers.error);
    const disabled = validateDisabledTools(body.disabledTools);
    if (disabled && typeof disabled === "object" && "error" in disabled) return invalid(disabled.error);
    // Aggregates always return a row (and `??` on .get() has no coverable
    // false side under FK invariants), so the non-null assertion holds.
    const ownedCount = db.select({ value: count() }).from(mcpServers).where(eq(mcpServers.ownerUserId, userId)).get()!.value;
    if (ownedCount >= mcpMaxUserServers()) return invalid("quota_exceeded", 409);
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
        ownerUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    invalidateCatalog(id);
    return NextResponse.json({ ok: true, id });
  }

  if (typeof body.id !== "string") return invalid("invalid_payload");
  const row = getServer(body.id);
  if (!row || row.ownerUserId !== userId) return invalid("not_found", 404);

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
    db.delete(mcpServers).where(eq(mcpServers.id, row.id)).run();
    invalidateCatalog(row.id);
    dropConnection(row.id);
    return NextResponse.json({ ok: true });
  }

  if (action === "update") {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      const name = parseName(body);
      if (typeof name !== "string") return invalid(name.error);
      patch.name = name;
    }
    if (body.url !== undefined) {
      const url = validateUrl(body.url, !mcpUserPrivateUrls());
      if (typeof url !== "string") return invalid(url.error);
      patch.url = url;
    }
    if (body.headers !== undefined) {
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

  if (action === "check") {
    invalidateCatalog(row.id);
    const entry = await serverCatalog(row, true);
    return NextResponse.json({ ok: true, health: entry.health, toolCount: entry.tools.length });
  }

  // OAuth connect/disconnect on the caller's own row. Same flow as the admin
  // card; the callback route is session-free (one-shot `state`), so it works
  // for user-owned servers unchanged.
  if (action === "connect") {
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
    clearOauthRow(row.id);
    invalidateCatalog(row.id);
    dropConnection(row.id);
    return NextResponse.json({ ok: true });
  }

  return invalid("invalid_payload");
}
