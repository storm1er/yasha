// DB-backed OAuthClientProvider (MCP auth spec: RFC 9728 discovery, RFC 7591
// DCR, authorization code + PKCE, refresh). The SDK's auth() does the dance;
// this class only persists its state so flows survive across requests
// (connect → browser consent → callback) and across process restarts.

import { randomBytes } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import * as store from "./store";

export const OAUTH_CALLBACK_PATH = "/api/admin/mcp/oauth/callback";

/** Public origin (first trusted origin — same trusted-origins stance as the
 * APK bake: never derive from a request Host header). */
export function oauthCallbackUrl(): string {
  const first = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .find(Boolean);
  if (!first) throw new Error("trusted_origins_unset");
  return `${first}${OAUTH_CALLBACK_PATH}`;
}

function parseJson<T>(json: string | null | undefined): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

class StoreOAuthProvider implements OAuthClientProvider {
  constructor(private readonly serverId: string) {}

  get redirectUrl(): string {
    return oauthCallbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Yasha",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  state(): string {
    const state = randomBytes(16).toString("hex");
    store.setState(this.serverId, state);
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return parseJson<OAuthClientInformationMixed>(store.getOauthRow(this.serverId)?.clientJson);
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    store.saveClient(this.serverId, JSON.stringify(clientInformation), clientInformation.issuer ?? null);
  }

  tokens(): OAuthTokens | undefined {
    return parseJson<OAuthTokens>(store.getOauthRow(this.serverId)?.tokensJson);
  }

  saveTokens(tokens: OAuthTokens): void {
    store.saveTokens(this.serverId, JSON.stringify(tokens), tokens.issuer ?? null);
    store.clearPending(this.serverId);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    store.saveAuthorizationUrl(this.serverId, authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    store.saveVerifier(this.serverId, codeVerifier);
  }

  codeVerifier(): string {
    const verifier = store.getOauthRow(this.serverId)?.pendingVerifier;
    if (!verifier) throw new Error("no_pending_code_verifier");
    return verifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return parseJson<OAuthDiscoveryState>(store.getOauthRow(this.serverId)?.discoveryJson);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    store.saveDiscovery(this.serverId, JSON.stringify(state));
  }

  invalidateCredentials(scope: store.CredentialScope): void {
    store.clearCredentials(this.serverId, scope);
  }
}

export function oauthProvider(serverId: string): OAuthClientProvider {
  return new StoreOAuthProvider(serverId);
}

/** Callback-side completion: exchanges the authorization code for tokens via
 * the SDK (restores discovery state + verifier from the store). Throws on any
 * exchange failure; pending state is cleared by the caller. */
export async function completeAuthorization(serverId: string, serverUrl: string, code: string): Promise<void> {
  await auth(oauthProvider(serverId), { serverUrl, authorizationCode: code });
}
