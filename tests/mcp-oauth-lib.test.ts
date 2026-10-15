import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { eq } from "drizzle-orm";
import { db, rawSqlite } from "./support/db";
import { mcpServers } from "@/lib/db/schema";
import { mockAuthServer, MCP_URL } from "./support/mcp-oauth";
import { closeAllClients, defaultTransport, isNeedsAuthError, setTransportFactory } from "@/lib/mcp/client";
import { invalidateCatalog, serverCatalog } from "@/lib/mcp/registry";
import * as store from "@/lib/mcp/oauth/store";
import { completeAuthorization, oauthCallbackUrl, oauthProvider } from "@/lib/mcp/oauth/provider";

const ORIGINS = "https://yasha.test";

function addServerRow(id: string, url: string | null): void {
  rawSqlite.prepare("DELETE FROM mcp_oauth WHERE server_id = ?").run(id);
  db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
  db.insert(mcpServers)
    .values({ id, builtin: false, name: id, url, headersJson: null, enabled: true, disabledToolsJson: null, createdAt: new Date(), updatedAt: new Date() })
    .run();
  invalidateCatalog(id);
}

beforeAll(async () => {
  const { ensureReady } = await import("@/lib/db");
  await ensureReady();
});

afterEach(() => {
  closeAllClients();
  setTransportFactory(null);
  invalidateCatalog();
  rawSqlite.prepare("DELETE FROM mcp_oauth").run();
  rawSqlite.prepare("DELETE FROM mcp_servers WHERE id != 'ketch'").run();
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "";
});

describe("store", () => {
  it("row lifecycle: ensure/has/get/clear + oauthStatus", () => {
    addServerRow("st1", "https://x.test/mcp");
    expect(store.hasOauthRow("st1")).toBe(false);
    expect(store.getOauthRow("st1")).toBeUndefined();
    expect(store.oauthStatus("st1")).toEqual({ configured: false, authorized: false });
    store.ensureOauthRow("st1");
    store.ensureOauthRow("st1"); // idempotent
    expect(store.hasOauthRow("st1")).toBe(true);
    expect(store.oauthStatus("st1")).toEqual({ configured: true, authorized: false });
    store.saveTokens("st1", JSON.stringify({ access_token: "a" }), "https://auth.test");
    expect(store.oauthStatus("st1")).toEqual({ configured: true, authorized: true });
    expect(store.getOauthRow("st1")?.issuer).toBe("https://auth.test");
    store.clearOauthRow("st1");
    expect(store.hasOauthRow("st1")).toBe(false);
  });

  it("clearCredentials per scope", () => {
    addServerRow("st2", "https://x.test/mcp");
    store.ensureOauthRow("st2");
    const seed = () => {
      store.saveClient("st2", "{}", "iss");
      store.saveTokens("st2", "{}", "iss");
      store.saveDiscovery("st2", "{}");
      store.setState("st2", "s");
      store.saveVerifier("st2", "v");
    };
    seed();
    store.clearCredentials("st2", "client");
    let r = store.getOauthRow("st2")!;
    expect(r.clientJson).toBeNull();
    expect(r.issuer).toBeNull();
    expect(r.tokensJson).not.toBeNull();
    seed();
    store.clearCredentials("st2", "tokens");
    r = store.getOauthRow("st2")!;
    expect(r.tokensJson).toBeNull();
    expect(r.clientJson).not.toBeNull();
    seed();
    store.clearCredentials("st2", "discovery");
    expect(store.getOauthRow("st2")!.discoveryJson).toBeNull();
    seed();
    store.clearCredentials("st2", "verifier");
    expect(store.getOauthRow("st2")!.pendingState).toBeNull();
    seed();
    store.clearCredentials("st2", "all");
    r = store.getOauthRow("st2")!;
    expect([r.clientJson, r.tokensJson, r.discoveryJson, r.pendingState, r.issuer]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("pending flow: state/verifier/url + getPending", () => {
    addServerRow("st3", "https://x.test/mcp");
    store.ensureOauthRow("st3");
    expect(store.getPending("st3")).toBeUndefined();
    store.setState("st3", "state-1");
    expect(store.getPending("st3")).toEqual({ url: null });
    store.saveVerifier("st3", "ver-1");
    store.saveAuthorizationUrl("st3", "https://auth.test/authorize?x=1");
    expect(store.getPending("st3")).toEqual({ url: "https://auth.test/authorize?x=1" });
    store.clearPending("st3");
    expect(store.getPending("st3")).toBeUndefined();
  });

  it("consumePendingByState: match is one-shot; unknown/expired/url-less miss", () => {
    addServerRow("st4", "https://x.test/mcp");
    store.ensureOauthRow("st4");
    store.setState("st4", "state-4");
    store.saveVerifier("st4", "ver-4");
    const hit = store.consumePendingByState("state-4");
    expect(hit).toMatchObject({ serverId: "st4", serverUrl: "https://x.test/mcp", verifier: "ver-4" });
    expect(store.consumePendingByState("state-4")).toBeUndefined(); // consumed
    expect(store.consumePendingByState("nope")).toBeUndefined();

    store.setState("st4", "state-old");
    rawSqlite.prepare("UPDATE mcp_oauth SET pending_at = ? WHERE server_id = 'st4'").run(
      Date.now() - store.PENDING_TTL_MS - 1000
    );
    expect(store.consumePendingByState("state-old")).toBeUndefined();
    expect(store.getOauthRow("st4")!.pendingState).toBeNull(); // swept

    store.setState("st4", "state-null-at");
    rawSqlite.prepare("UPDATE mcp_oauth SET pending_at = NULL WHERE server_id = 'st4'").run();
    expect(store.consumePendingByState("state-null-at")).toBeUndefined(); // null → treated expired
    expect(store.getOauthRow("st4")!.pendingState).toBeNull();

    addServerRow("st4b", null); // url-less server never matches
    store.ensureOauthRow("st4b");
    store.setState("st4b", "state-nourl");
    expect(store.consumePendingByState("state-nourl")).toBeUndefined();
    expect(store.getOauthRow("st4b")!.pendingState).toBe("state-nourl"); // not consumed, just unjoinable
  });
});

describe("provider", () => {
  it("oauthCallbackUrl: first trusted origin wins; unset throws", () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = ` ${ORIGINS}/ , https://other.test`;
    expect(oauthCallbackUrl()).toBe(`${ORIGINS}/api/admin/mcp/oauth/callback`);
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "";
    expect(() => oauthCallbackUrl()).toThrow(/trusted_origins_unset/);
    delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
    expect(() => oauthCallbackUrl()).toThrow(/trusted_origins_unset/);
  });

  it("clientMetadata + state + redirect + verifier", () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = ORIGINS;
    addServerRow("pv1", "https://x.test/mcp");
    store.ensureOauthRow("pv1");
    const p = oauthProvider("pv1");
    expect(p.clientMetadata.client_name).toBe("Yasha");
    expect(p.clientMetadata.redirect_uris).toEqual([`${ORIGINS}/api/admin/mcp/oauth/callback`]);
    const state = p.state!();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(store.getPending("pv1")).toEqual({ url: null });
    expect(() => p.codeVerifier()).toThrow(/no_pending_code_verifier/);
    p.saveCodeVerifier("ver-9");
    expect(p.codeVerifier()).toBe("ver-9");
    p.redirectToAuthorization(new URL("https://auth.test/authorize?a=1"));
    expect(store.getPending("pv1")!.url).toBe("https://auth.test/authorize?a=1");
  });

  it("client/tokens/discovery: empty, garbage, round-trip, issuer null arm", () => {
    addServerRow("pv2", "https://x.test/mcp");
    store.ensureOauthRow("pv2");
    const p = oauthProvider("pv2");
    expect(p.clientInformation()).toBeUndefined();
    expect(p.tokens()).toBeUndefined();
    expect(p.discoveryState!()).toBeUndefined();

    rawSqlite.prepare("UPDATE mcp_oauth SET client_json='{', tokens_json='{', discovery_json='{' WHERE server_id='pv2'").run();
    expect(p.clientInformation()).toBeUndefined();
    expect(p.tokens()).toBeUndefined();
    expect(p.discoveryState!()).toBeUndefined();

    p.saveClientInformation!({ client_id: "c1" } as never);
    expect(p.clientInformation()).toEqual({ client_id: "c1" });
    expect(store.getOauthRow("pv2")!.issuer).toBeNull(); // issuer undefined → null
    p.saveClientInformation!({ client_id: "c2", issuer: "iss-x" } as never);
    expect(store.getOauthRow("pv2")!.issuer).toBe("iss-x");

    store.setState("pv2", "s1");
    p.saveTokens({ access_token: "t1" } as never);
    expect(p.tokens()).toEqual({ access_token: "t1" });
    expect(store.getPending("pv2")).toBeUndefined(); // saveTokens clears pending
    p.saveTokens({ access_token: "t2", issuer: "iss-y" } as never);
    expect(store.getOauthRow("pv2")!.issuer).toBe("iss-y");

    p.saveDiscoveryState!({ authorizationServerUrl: "https://auth.test" } as never);
    expect(p.discoveryState!()).toEqual({ authorizationServerUrl: "https://auth.test" });

    p.invalidateCredentials!("tokens");
    expect(p.tokens()).toBeUndefined();
  });

  it("full SDK dance: discovery → DCR → REDIRECT, then code exchange, then refresh", async () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = ORIGINS;
    const auth = mockAuthServer();
    addServerRow("pv3", MCP_URL);
    store.ensureOauthRow("pv3");

    const { auth: sdkAuth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    const p = oauthProvider("pv3");
    expect(await sdkAuth(p, { serverUrl: MCP_URL })).toBe("REDIRECT");

    const pending = store.getPending("pv3")!;
    expect(pending.url).toContain("https://auth.test/authorize?");
    expect(pending.url).toContain("code_challenge=");
    expect(pending.url).toContain("code_challenge_method=S256");
    expect(pending.url).toContain("client_id=cid-123");
    expect(pending.url).toContain(encodeURIComponent(`${ORIGINS}/api/admin/mcp/oauth/callback`));
    expect(store.getOauthRow("pv3")!.clientJson).toContain("cid-123");
    expect(store.getOauthRow("pv3")!.discoveryJson).toContain("https://auth.test");
    expect(auth.mock.lastCall("auth.test/register")).toBeDefined();

    await completeAuthorization("pv3", MCP_URL, "the-code");
    const exchanged = auth.tokenCalls().find((c) => (c.body ?? "").includes("grant_type=authorization_code"));
    expect(exchanged?.body).toContain("code=the-code");
    expect(exchanged?.body).toContain("client_id=cid-123");
    const tokens = JSON.parse(store.getOauthRow("pv3")!.tokensJson!) as { access_token: string };
    expect(tokens.access_token).toBe("at-code");
    expect(store.getPending("pv3")).toBeUndefined();

    // refresh: auth() with saved refresh_token hits the token endpoint again
    expect(await sdkAuth(p, { serverUrl: MCP_URL })).toBe("AUTHORIZED");
    const refreshed = JSON.parse(store.getOauthRow("pv3")!.tokensJson!) as { access_token: string };
    expect(refreshed.access_token).toBe("at-refreshed");
  });
});

describe("client + registry wiring", () => {
  it("defaultTransport attaches the auth provider on force or saved tokens only", () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = ORIGINS;
    addServerRow("cw1", "https://x.test/mcp");
    const plain = defaultTransport({ id: "cw1", url: "https://x.test/mcp", headersJson: null }) as {
      _authProvider?: unknown;
    };
    expect(plain._authProvider).toBeUndefined();

    const forced = defaultTransport({ id: "cw1", url: "https://x.test/mcp", headersJson: null, oauth: true }) as {
      _authProvider?: unknown;
    };
    expect(forced._authProvider).toBeDefined();

    store.ensureOauthRow("cw1");
    store.saveTokens("cw1", "{}", null);
    const withTokens = defaultTransport({ id: "cw1", url: "https://x.test/mcp", headersJson: null }) as {
      _authProvider?: unknown;
    };
    expect(withTokens._authProvider).toBeDefined();
  });

  it("isNeedsAuthError discriminates UnauthorizedError", () => {
    expect(isNeedsAuthError(new UnauthorizedError())).toBe(true);
    expect(isNeedsAuthError(new Error("x"))).toBe(false);
  });

  it("registry maps UnauthorizedError to health code needs_auth", async () => {
    addServerRow("cw2", "https://x.test/mcp");
    setTransportFactory(() => {
      throw new UnauthorizedError();
    });
    const entry = await serverCatalog(db.select().from(mcpServers).where(eq(mcpServers.id, "cw2")).get()!, true);
    expect(entry.health.ok).toBe(false);
    expect(entry.health.code).toBe("needs_auth");
    expect(entry.health.error).toBe("authorization_required");
  });
});
