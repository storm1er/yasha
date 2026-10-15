// Proactive OAuth access-token refresh. The MCP SDK only refreshes after a
// 401 (and on refresh failure it starts a NEW authorization flow, which is
// what surfaced "authorization_required" long after a working connect). We
// refresh ahead of expiry here, single-flight per server, so pooled/re-used
// connections keep rotating refresh tokens and sessions stay alive.

import { InvalidClientError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { getOauthRow, saveTokens, clearCredentials } from "./store";

/** Refresh when the access token expires within this window. */
export const REFRESH_SKEW_MS = 60_000;

function parseJson<T>(json: string | null | undefined): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

const inflight = new Map<string, Promise<void>>();

/** True when the stored access token is missing an expiry or expires within
 * the skew window and a refresh token exists. */
export function refreshTokenNeeded(serverId: string, now = Date.now()): boolean {
  const row = getOauthRow(serverId);
  const tokens = parseJson<OAuthTokens>(row?.tokensJson);
  if (!tokens?.refresh_token) return false;
  const expiresAt = row?.tokensExpiresAt?.getTime();
  return expiresAt === undefined || expiresAt - now < REFRESH_SKEW_MS;
}

async function doRefresh(serverId: string): Promise<void> {
  const row = getOauthRow(serverId);
  const tokens = parseJson<OAuthTokens>(row?.tokensJson);
  const client = parseJson<OAuthClientInformationMixed>(row?.clientJson);
  const discovery = parseJson<OAuthDiscoveryState>(row?.discoveryJson);
  // Nothing to refresh against (never happened mid-flow, or legacy row):
  // the SDK's 401 path owns those cases.
  if (!tokens?.refresh_token || !client || !discovery?.authorizationServerUrl) return;
  try {
    const newTokens = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation: client,
      refreshToken: tokens.refresh_token,
      resource: discovery.resourceMetadata?.resource,
    });
    saveTokens(
      serverId,
      JSON.stringify({ ...newTokens, issuer: discovery.authorizationServerUrl }),
      discovery.authorizationServerUrl,
    );
  } catch (err) {
    // The refresh token is dead (revoked/rotated away): drop just the tokens
    // so the cards show "Connect" again instead of a permanent error.
    if (err instanceof InvalidGrantError || err instanceof InvalidClientError) {
      clearCredentials(serverId, "tokens");
    }
    // Transient (network/5xx): leave everything — the SDK 401 path retries.
  }
}

/** Refresh soon-to-expire tokens for `serverId` (no-op otherwise). Concurrent
 * callers share one in-flight refresh (rotating refresh tokens are single-use;
 * racing refreshes would invalidate each other). */
export function ensureFreshToken(serverId: string): Promise<void> {
  if (!refreshTokenNeeded(serverId)) return Promise.resolve();
  let running = inflight.get(serverId);
  if (!running) {
    running = doRefresh(serverId).finally(() => inflight.delete(serverId));
    inflight.set(serverId, running);
  }
  return running;
}
