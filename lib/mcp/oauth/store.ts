// Persistence for per-MCP-server OAuth state: DCR client info, tokens, cached
// discovery metadata, and the single pending authorization (state/PKCE/URL).
// One row per remote server; the row's existence is what opts a server into
// the OAuth provider on connect (see lib/mcp/client.ts).

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpOauth, mcpServers } from "@/lib/db/schema";

export const PENDING_TTL_MS = 10 * 60_000;

export function getOauthRow(serverId: string) {
  return db.select().from(mcpOauth).where(eq(mcpOauth.serverId, serverId)).get();
}

export function hasOauthRow(serverId: string): boolean {
  return (
    db
      .select({ serverId: mcpOauth.serverId })
      .from(mcpOauth)
      .where(eq(mcpOauth.serverId, serverId))
      .get() !== undefined
  );
}

export function ensureOauthRow(serverId: string): void {
  db.insert(mcpOauth).values({ serverId }).onConflictDoNothing().run();
}

export function clearOauthRow(serverId: string): void {
  db.delete(mcpOauth).where(eq(mcpOauth.serverId, serverId)).run();
}

export function saveClient(serverId: string, clientJson: string, issuer: string | null): void {
  db.update(mcpOauth)
    .set({ clientJson, issuer, updatedAt: new Date() })
    .where(eq(mcpOauth.serverId, serverId))
    .run();
}

/** Epoch-ms expiry from an OAuth token payload's `expires_in` (seconds). */
function expiresAtFrom(tokensJson: string, now = Date.now()): Date | null {
  let expiresIn: unknown;
  try {
    const parsed = JSON.parse(tokensJson) as { expires_in?: unknown };
    expiresIn = parsed.expires_in;
  } catch {
    return null;
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(now + expiresIn * 1000);
}

export function saveTokens(
  serverId: string,
  tokensJson: string,
  issuer: string | null,
  now = Date.now(),
): void {
  db.update(mcpOauth)
    .set({ tokensJson, issuer, tokensExpiresAt: expiresAtFrom(tokensJson, now), updatedAt: new Date() })
    .where(eq(mcpOauth.serverId, serverId))
    .run();
}

export function saveDiscovery(serverId: string, discoveryJson: string): void {
  db.update(mcpOauth)
    .set({ discoveryJson, updatedAt: new Date() })
    .where(eq(mcpOauth.serverId, serverId))
    .run();
}

export type CredentialScope = "all" | "client" | "tokens" | "verifier" | "discovery";

export function clearCredentials(serverId: string, scope: CredentialScope): void {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (scope === "all" || scope === "client") {
    patch.clientJson = null;
    patch.issuer = null;
  }
  if (scope === "all" || scope === "tokens") {
    patch.tokensJson = null;
    patch.tokensExpiresAt = null;
  }
  if (scope === "all" || scope === "discovery") patch.discoveryJson = null;
  if (scope === "all" || scope === "verifier") {
    patch.pendingState = null;
    patch.pendingVerifier = null;
    patch.pendingUrl = null;
    patch.pendingAt = null;
  }
  db.update(mcpOauth).set(patch).where(eq(mcpOauth.serverId, serverId)).run();
}

// ── pending authorization (one active flow per server; latest wins) ─────────

export type PendingAuth = {
  serverId: string;
  serverUrl: string;
  verifier: string | null;
  url: string | null;
};

export function setState(serverId: string, state: string): void {
  db.update(mcpOauth)
    .set({ pendingState: state, pendingVerifier: null, pendingUrl: null, pendingAt: new Date(), updatedAt: new Date() })
    .where(eq(mcpOauth.serverId, serverId))
    .run();
}

export function saveVerifier(serverId: string, verifier: string): void {
  db.update(mcpOauth)
    .set({ pendingVerifier: verifier, updatedAt: new Date() })
    .where(eq(mcpOauth.serverId, serverId))
    .run();
}

export function saveAuthorizationUrl(serverId: string, url: string): void {
  db.update(mcpOauth)
    .set({ pendingUrl: url, updatedAt: new Date() })
    .where(eq(mcpOauth.serverId, serverId))
    .run();
}

export function getPending(serverId: string): { url: string | null } | undefined {
  const row = getOauthRow(serverId);
  if (!row?.pendingState) return undefined;
  return { url: row.pendingUrl };
}

/** One-shot consume: returns the matching pending flow (joined with the
 * server url) or undefined (unknown / expired — expired rows get cleared).
 * Servers without a url never match (OAuth needs one; invariant of `connect`). */
export function consumePendingByState(state: string, now = Date.now()): PendingAuth | undefined {
  const rows = db
    .select({ pending: mcpOauth, serverUrl: mcpServers.url })
    .from(mcpOauth)
    .innerJoin(mcpServers, eq(mcpOauth.serverId, mcpServers.id))
    .where(and(eq(mcpOauth.pendingState, state), isNotNull(mcpServers.url)))
    .all();
  const row = rows[0];
  if (!row) return undefined;
  const at = row.pending.pendingAt?.getTime() ?? 0;
  if (now - at > PENDING_TTL_MS) {
    clearPending(row.pending.serverId);
    return undefined;
  }
  clearPending(row.pending.serverId);
  return {
    serverId: row.pending.serverId,
    // Non-null: the WHERE clause filters out servers without a url.
    serverUrl: row.serverUrl as string,
    verifier: row.pending.pendingVerifier,
    url: row.pending.pendingUrl,
  };
}

export function clearPending(serverId: string): void {
  db.update(mcpOauth)
    .set({ pendingState: null, pendingVerifier: null, pendingUrl: null, pendingAt: null, updatedAt: new Date() })
    .where(eq(mcpOauth.serverId, serverId))
    .run();
}

export function oauthStatus(serverId: string): { configured: boolean; authorized: boolean } {
  const row = getOauthRow(serverId);
  return { configured: row !== undefined, authorized: row?.tokensJson != null };
}
