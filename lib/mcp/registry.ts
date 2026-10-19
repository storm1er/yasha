// Effective MCP server list + tool catalog with a short-TTL cache (like the
// settings cache) and explicit invalidation on admin/user CRUD. Servers are
// either global (`ownerUserId` NULL, everyone) or user-owned (owner only).

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpServers, type McpServer } from "@/lib/db/schema";
import { mcpEnabled, mcpUserServersEnabled } from "@/lib/settings";
import { isNeedsAuthError, listTools } from "./client";

const CATALOG_TTL_MS = 60_000;

export type CatalogTool = {
  name: string;
  description: string;
  /** Tool arguments as JSON Schema (MCP `inputSchema`, required by the spec —
   *  the SDK's response parse enforces it). Advertised to the model as the
   *  OpenAI function `parameters`; dropping it would force `{}`-only calls. */
  inputSchema: Record<string, unknown>;
};
export type ServerHealth = {
  ok: boolean;
  toolCount: number;
  error: string | null;
  /** "needs_auth": OAuth authorization required (admin connect flow). */
  code?: "needs_auth";
  at: number;
};
export type CatalogEntry = { server: McpServer; tools: CatalogTool[]; health: ServerHealth };

const catalogCache = new Map<string, { at: number; tools: CatalogTool[] }>();
const health = new Map<string, ServerHealth>();

export function invalidateCatalog(id?: string): void {
  if (id === undefined) {
    catalogCache.clear();
    health.clear();
  } else {
    catalogCache.delete(id);
    health.delete(id);
  }
}

/** Enabled GLOBAL rows (builtin + admin-registered; kill-switch on top). */
export function enabledServers(): McpServer[] {
  if (!mcpEnabled()) return [];
  return db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.enabled, true), isNull(mcpServers.ownerUserId)))
    .all();
}

/**
 * Enabled servers visible to one user: global rows + (when
 * `mcp.userServersEnabled`) the user's own rows. Global rows sort first so
 * they win tool-name collisions.
 */
export function serversForUser(userId: string): McpServer[] {
  if (!mcpEnabled()) return [];
  const scope = mcpUserServersEnabled()
    ? or(isNull(mcpServers.ownerUserId), eq(mcpServers.ownerUserId, userId))
    : isNull(mcpServers.ownerUserId);
  return db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.enabled, true), scope))
    .orderBy(sql`${mcpServers.ownerUserId} is not null`)
    .all();
}

/** The user's own rows (incl. disabled) for the personal card. */
export function ownedServers(userId: string): McpServer[] {
  return db.select().from(mcpServers).where(eq(mcpServers.ownerUserId, userId)).all();
}

export function disabledToolsOf(server: McpServer): Set<string> {
  if (!server.disabledToolsJson) return new Set();
  try {
    const parsed: unknown = JSON.parse(server.disabledToolsJson);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((t): t is string => typeof t === "string"));
    }
  } catch {
    /* garbage row → no denylist */
  }
  return new Set();
}

/** Catalog for one server (TTL cache; failures cached briefly as health errors).
 * `oauth` forces the OAuth provider for this probe (admin connect action). */
export async function serverCatalog(
  server: McpServer,
  force = false,
  now = Date.now(),
  oauth = false,
): Promise<CatalogEntry> {
  const deny = disabledToolsOf(server);
  const cached = catalogCache.get(server.id);
  if (!force && cached && now - cached.at < CATALOG_TTL_MS) {
    const tools = cached.tools.filter((t) => !deny.has(t.name));
    // Invariant: cache entries are only written on success paths, which always
    // write a health snapshot in the same tick (and invalidation clears both).
    return { server, tools, health: health.get(server.id)! };
  }
  try {
    const res = await listTools({ ...server, oauth });
    const tools = res.tools
      .filter((t) => !deny.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    catalogCache.set(server.id, { at: now, tools });
    const h: ServerHealth = { ok: true, toolCount: tools.length, error: null, at: now };
    health.set(server.id, h);
    return { server, tools, health: h };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const needsAuth = isNeedsAuthError(err);
    const h: ServerHealth = {
      ok: false,
      toolCount: 0,
      error: needsAuth ? "authorization_required" : message,
      code: needsAuth ? "needs_auth" : undefined,
      at: now,
    };
    health.set(server.id, h);
    return { server, tools: [], health: h };
  }
}

/** Catalog for one user (global + own servers); per-server failures degrade
 * to empty lists. */
export async function effectiveCatalogForUser(userId: string, now = Date.now()): Promise<CatalogEntry[]> {
  const servers = serversForUser(userId);
  const out: CatalogEntry[] = [];
  for (const server of servers) {
    out.push(await serverCatalog(server, false, now));
  }
  return out;
}

/** The user's own servers with health snapshots (personal card). */
export async function userCatalog(userId: string, now = Date.now()): Promise<CatalogEntry[]> {
  const out: CatalogEntry[] = [];
  for (const server of ownedServers(userId)) {
    if (!server.enabled) {
      out.push({ server, tools: [], health: { ok: false, toolCount: 0, error: "disabled", at: now } });
      continue;
    }
    out.push(await serverCatalog(server, false, now));
  }
  return out;
}

/** All rows (incl. disabled) with health snapshot for the admin UI. */
export async function adminCatalog(now = Date.now()): Promise<CatalogEntry[]> {
  const rows = db.select().from(mcpServers).all();
  const out: CatalogEntry[] = [];
  for (const server of rows) {
    if (!server.enabled) {
      out.push({ server, tools: [], health: { ok: false, toolCount: 0, error: "disabled", at: now } });
      continue;
    }
    out.push(await serverCatalog(server, false, now));
  }
  return out;
}

export function getServer(id: string): McpServer | undefined {
  return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
}
