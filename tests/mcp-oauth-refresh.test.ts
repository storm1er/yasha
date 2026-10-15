// Proactive OAuth access-token refresh (lib/mcp/oauth/refresh.ts): the 401
// after expiry must be a token refresh, not a fresh authorization prompt.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { json, mockLemonade, type LemonadeMock } from "./support/lemonade";
import { db, rawSqlite } from "./support/db";
import { mcpServers } from "@/lib/db/schema";
import {
  ensureOauthRow,
  getOauthRow,
  oauthStatus,
  saveClient,
  saveDiscovery,
  saveTokens,
} from "@/lib/mcp/oauth/store";
import { ensureFreshToken, refreshTokenNeeded, REFRESH_SKEW_MS } from "@/lib/mcp/oauth/refresh";
import { closeAllClients, listTools, setTransportFactory } from "@/lib/mcp/client";

const AUTH_SERVER = "https://auth.test";
const TOKEN_URL = "https://auth.test/token";
const now = () => Date.now();

let mock: LemonadeMock;
let refreshCalls: number;
let tokenMode: "ok" | "grant" | "down" = "ok";

function seedServer(id: string) {
  db.insert(mcpServers)
    .values({
      id,
      builtin: false,
      name: id,
      url: "https://mcp.test/mcp",
      headersJson: null,
      enabled: true,
      disabledToolsJson: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  ensureOauthRow(id);
  saveClient(id, JSON.stringify({ client_id: "cid-1" }), AUTH_SERVER);
  saveDiscovery(
    id,
    JSON.stringify({
      authorizationServerUrl: AUTH_SERVER,
      authorizationServerMetadata: {
        issuer: AUTH_SERVER,
        authorization_endpoint: "https://auth.test/authorize",
        token_endpoint: TOKEN_URL,
      },
      resourceMetadata: { resource: "https://mcp.test/mcp" },
    }),
  );
}

beforeAll(async () => {
  await ensureReady();
});

beforeEach(() => {
  refreshCalls = 0;
  tokenMode = "ok";
  mock = mockLemonade();
  mock.route(TOKEN_URL, () => {
    refreshCalls += 1;
    if (tokenMode === "grant") return json({ error: "invalid_grant", error_description: "expired" }, 400);
    if (tokenMode === "down") return json({ error: "server_error" }, 500);
    return json({ access_token: "at-new", refresh_token: "rt-new", token_type: "Bearer", expires_in: 3600 });
  });
});

afterEach(() => {
  setTransportFactory(null);
  closeAllClients();
  rawSqlite.prepare("DELETE FROM mcp_oauth").run();
  rawSqlite.prepare("DELETE FROM mcp_servers WHERE id LIKE 'rt\\_%'").run();
});

describe("refreshTokenNeeded", () => {
  it("false without a row, tokens, or refresh token", () => {
    expect(refreshTokenNeeded("rt_missing")).toBe(false);
    seedServer("rt_a");
    expect(refreshTokenNeeded("rt_a")).toBe(false);
    saveTokens("rt_a", JSON.stringify({ access_token: "a", expires_in: 10 }), AUTH_SERVER);
    expect(refreshTokenNeeded("rt_a")).toBe(false);
  });

  it("true when the token expires within the skew (or expiry unknown)", () => {
    seedServer("rt_b");
    saveTokens("rt_b", JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 30 }), AUTH_SERVER);
    expect(refreshTokenNeeded("rt_b", now())).toBe(true);
    saveTokens("rt_b", JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), AUTH_SERVER);
    expect(refreshTokenNeeded("rt_b", now())).toBe(false);
    // No expiry recorded → refresh defensively.
    saveTokens("rt_b", JSON.stringify({ access_token: "a", refresh_token: "r" }), AUTH_SERVER);
    expect(refreshTokenNeeded("rt_b", now())).toBe(true);
    // Just outside the skew → no refresh.
    saveTokens(
      "rt_b",
      JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
      AUTH_SERVER,
      now() - 3600_000 + REFRESH_SKEW_MS + 1000,
    );
    expect(refreshTokenNeeded("rt_b", now())).toBe(false);
  });
});

describe("ensureFreshToken", () => {
  it("no-op when no refresh is due", async () => {
    seedServer("rt_c");
    saveTokens("rt_c", JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), AUTH_SERVER);
    await ensureFreshToken("rt_c");
    expect(refreshCalls).toBe(0);
  });

  it("refreshes near expiry and stores the new tokens with a fresh expiry", async () => {
    seedServer("rt_d");
    saveTokens("rt_d", JSON.stringify({ access_token: "old", refresh_token: "rt-old", expires_in: 20 }), AUTH_SERVER);
    await ensureFreshToken("rt_d");
    expect(refreshCalls).toBe(1);
    const row = getOauthRow("rt_d")!;
    const tokens = JSON.parse(row.tokensJson!) as Record<string, unknown>;
    expect(tokens.access_token).toBe("at-new");
    expect(tokens.refresh_token).toBe("rt-new");
    expect(tokens.issuer).toBe(AUTH_SERVER);
    expect(row.tokensExpiresAt!.getTime()).toBeGreaterThan(now() + 3_500_000);
    // No longer due → the next call does nothing.
    await ensureFreshToken("rt_d");
    expect(refreshCalls).toBe(1);
  });

  it("concurrent callers share one in-flight refresh", async () => {
    seedServer("rt_e");
    saveTokens("rt_e", JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 5 }), AUTH_SERVER);
    await Promise.all([ensureFreshToken("rt_e"), ensureFreshToken("rt_e")]);
    expect(refreshCalls).toBe(1);
  });

  it("drops only the tokens on invalid_grant (Connect must be redone)", async () => {
    seedServer("rt_f");
    saveTokens("rt_f", JSON.stringify({ access_token: "a", refresh_token: "dead", expires_in: 5 }), AUTH_SERVER);
    tokenMode = "grant";
    await ensureFreshToken("rt_f");
    const row = getOauthRow("rt_f")!;
    expect(row.tokensJson).toBeNull();
    expect(row.tokensExpiresAt).toBeNull();
    expect(oauthStatus("rt_f")).toEqual({ configured: true, authorized: false });
    // Client + discovery survive so the next connect can re-register the flow.
    expect(row.clientJson).not.toBeNull();
    expect(row.discoveryJson).not.toBeNull();
  });

  it("keeps tokens on transient failures (SDK 401 path retries)", async () => {
    seedServer("rt_g");
    saveTokens("rt_g", JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 5 }), AUTH_SERVER);
    tokenMode = "down";
    await ensureFreshToken("rt_g");
    const row = getOauthRow("rt_g")!;
    expect(row.tokensJson).not.toBeNull();
    expect(row.tokensExpiresAt).not.toBeNull();
  });

  it("gives up silently when client or discovery state is missing", async () => {
    seedServer("rt_h");
    saveTokens("rt_h", JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 5 }), AUTH_SERVER);
    rawSqlite.prepare("UPDATE mcp_oauth SET client_json = NULL WHERE server_id = 'rt_h'").run();
    await ensureFreshToken("rt_h");
    expect(refreshCalls).toBe(0);

    seedServer("rt_i");
    saveTokens("rt_i", JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 5 }), AUTH_SERVER);
    rawSqlite.prepare("UPDATE mcp_oauth SET discovery_json = NULL WHERE server_id = 'rt_i'").run();
    await ensureFreshToken("rt_i");
    expect(refreshCalls).toBe(0);
  });

  it("tolerates garbage persisted json", async () => {
    seedServer("rt_j");
    saveTokens("rt_j", "{bad", AUTH_SERVER); // unparseable payload → no expiry recorded
    expect(getOauthRow("rt_j")!.tokensExpiresAt).toBeNull();
    rawSqlite
      .prepare("UPDATE mcp_oauth SET tokens_json = '{bad', client_json = '{bad', discovery_json = '{bad' WHERE server_id = 'rt_j'")
      .run();
    expect(refreshTokenNeeded("rt_j", now())).toBe(false);
    await ensureFreshToken("rt_j");
    expect(refreshCalls).toBe(0);
  });
});

describe("connect path", () => {
  it("getClient refreshes an expiring token before connecting", async () => {
    seedServer("rt_k");
    saveTokens("rt_k", JSON.stringify({ access_token: "old", refresh_token: "r", expires_in: 10 }), AUTH_SERVER);
    setTransportFactory(() => {
      const server = new McpServer({ name: "rt_k", version: "1.0.0" });
      server.registerTool("one", { description: "d" }, async () => ({ content: [] }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      void server.connect(serverTransport);
      return clientTransport;
    });
    const res = await listTools({ id: "rt_k", url: "https://mcp.test/mcp", headersJson: null });
    expect(res.tools.map((t) => t.name)).toEqual(["one"]);
    expect(refreshCalls).toBe(1);
  });
});
