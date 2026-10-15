import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GET, POST } from "@/app/api/admin/mcp/route";
import { GET as CALLBACK } from "@/app/api/admin/mcp/oauth/callback/route";
import { adminUser, callRoute, jsonOf, signUp } from "./support/app";
import { db, rawSqlite, setSetting } from "./support/db";
import { mcpServers } from "@/lib/db/schema";
import { mockAuthServer, MCP_URL } from "./support/mcp-oauth";
import { closeAllClients, setTransportFactory } from "@/lib/mcp/client";
import { invalidateCatalog } from "@/lib/mcp/registry";
import * as store from "@/lib/mcp/oauth/store";

const ORIGINS = "https://yasha.test";
let admin: Awaited<ReturnType<typeof adminUser>>;
let basic: Awaited<ReturnType<typeof signUp>>;

beforeAll(async () => {
  admin = await adminUser();
  basic = await signUp("mcpoa");
});

afterEach(() => {
  setTransportFactory(null);
  closeAllClients();
  invalidateCatalog();
  rawSqlite.prepare("DELETE FROM mcp_oauth").run();
  rawSqlite.prepare("DELETE FROM mcp_servers WHERE id != 'ketch'").run();
  setSetting("mcp.enabled", "true");
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "";
});

function insertRow(id: string, url: string | null = MCP_URL) {
  rawSqlite.prepare("DELETE FROM mcp_oauth WHERE server_id = ?").run(id);
  db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
  db.insert(mcpServers)
    .values({ id, builtin: false, name: id, url, headersJson: null, enabled: true, disabledToolsJson: null, createdAt: new Date(), updatedAt: new Date() })
    .run();
}

const post = (body: unknown, cookie: string | null = admin.cookie) =>
  callRoute(POST, { method: "POST", path: "/mcp", cookie, json: body });

describe("auth", () => {
  it("connect/disconnect are admin-only", async () => {
    expect((await post({ action: "connect", id: "ketch" }, null)).status).toBe(401);
    expect((await post({ action: "disconnect", id: "ketch" }, basic.cookie)).status).toBe(403);
  });
});

describe("GET oauth fields", () => {
  it("reports configured/authorized per server", async () => {
    setTransportFactory(() => {
      throw new Error("offline");
    });
    insertRow("oa-get");
    let body = await jsonOf<{ servers: { id: string; oauth: { configured: boolean; authorized: boolean } }[] }>(
      await callRoute(GET, { cookie: admin.cookie }),
    );
    expect(body.servers.find((s) => s.id === "oa-get")!.oauth).toEqual({ configured: false, authorized: false });

    store.ensureOauthRow("oa-get");
    body = await jsonOf<{ servers: { id: string; oauth: { configured: boolean; authorized: boolean } }[] }>(
      await callRoute(GET, { cookie: admin.cookie }),
    );
    expect(body.servers.find((s) => s.id === "oa-get")!.oauth).toEqual({ configured: true, authorized: false });

    store.saveTokens("oa-get", "{}", null);
    body = await jsonOf<{ servers: { id: string; oauth: { configured: boolean; authorized: boolean } }[] }>(
      await callRoute(GET, { cookie: admin.cookie }),
    );
    expect(body.servers.find((s) => s.id === "oa-get")!.oauth).toEqual({ configured: true, authorized: true });
  });
});

describe("POST connect", () => {
  it("rejects url-less (builtin) servers", async () => {
    const res = await post({ action: "connect", id: "ketch" });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("oauth_url_required");
  });

  it("connected: server works without OAuth", async () => {
    insertRow("oa-ok");
    setTransportFactory(() => {
      const server = new McpServer({ name: "oa-ok", version: "1.0.0" });
      server.registerTool("one", { description: "d" }, async () => ({ content: [] }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      void server.connect(serverTransport);
      return clientTransport;
    });
    const body = await jsonOf<{ ok: boolean; connected: boolean; toolCount: number }>(
      await post({ action: "connect", id: "oa-ok" }),
    );
    expect(body).toEqual({ ok: true, connected: true, toolCount: 1 });
    expect(store.hasOauthRow("oa-ok")).toBe(true);
  });

  it("needs_auth: full dance through the real transport returns authorizationUrl", async () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = ORIGINS;
    mockAuthServer();
    insertRow("oa-dance");
    const body = await jsonOf<{ ok: boolean; needsAuth: boolean; authorizationUrl: string }>(
      await post({ action: "connect", id: "oa-dance" }),
    );
    expect(body.needsAuth).toBe(true);
    expect(body.authorizationUrl).toContain("https://auth.test/authorize?");
    expect(store.getPending("oa-dance")!.url).toBe(body.authorizationUrl);
  });

  it("needs_auth without captured URL → oauth_flow_failed", async () => {
    insertRow("oa-nourl");
    setTransportFactory(() => {
      throw new UnauthorizedError();
    });
    const res = await post({ action: "connect", id: "oa-nourl" });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("oauth_flow_failed");
  });

  it("other failures surface the health", async () => {
    insertRow("oa-down");
    setTransportFactory(() => {
      throw new Error("down");
    });
    const body = await jsonOf<{ ok: boolean; connected: boolean; health: { error: string } }>(
      await post({ action: "connect", id: "oa-down" }),
    );
    expect(body).toMatchObject({ ok: true, connected: false, health: { error: "down" } });
  });
});

describe("POST disconnect", () => {
  it("clears the oauth row", async () => {
    insertRow("oa-disc");
    store.ensureOauthRow("oa-disc");
    store.saveTokens("oa-disc", "{}", null);
    expect((await post({ action: "disconnect", id: "oa-disc" })).status).toBe(200);
    expect(store.hasOauthRow("oa-disc")).toBe(false);
  });
});

describe("GET oauth callback", () => {
  function seedPending(id = "oa-cb", url: string | null = MCP_URL) {
    insertRow(id, url);
    store.ensureOauthRow(id);
    store.saveClient(id, JSON.stringify({ client_id: "cid-123", client_id_issued_at: 1 }), "https://auth.test");
    store.setState(id, "st-cb");
    store.saveVerifier(id, "verifier-cb");
  }

  const cb = (query?: Record<string, string>) =>
    callRoute(CALLBACK, { path: "/api/admin/mcp/oauth/callback", query });

  it("no state / unknown state → 400", async () => {
    expect((await cb()).status).toBe(400);
    expect((await cb({ state: "nope" })).status).toBe(400);
  });

  it("expired pending → 400 and swept", async () => {
    seedPending();
    rawSqlite.prepare("UPDATE mcp_oauth SET pending_at = ? WHERE server_id = 'oa-cb'").run(
      Date.now() - store.PENDING_TTL_MS - 1
    );
    expect((await cb({ state: "st-cb", code: "c" })).status).toBe(400);
    expect(store.getOauthRow("oa-cb")!.pendingState).toBeNull();
  });

  it("url-less server pending → 400 (not consumable)", async () => {
    seedPending("oa-cb-nourl", null);
    expect((await cb({ state: "st-cb", code: "c" })).status).toBe(400);
    expect(store.getOauthRow("oa-cb-nourl")!.pendingState).toBe("st-cb");
  });

  it("denied / code-less → 400, pending consumed", async () => {
    seedPending();
    expect((await cb({ state: "st-cb", error: "access_denied" })).status).toBe(400);
    expect(store.getPending("oa-cb")).toBeUndefined();
    seedPending();
    expect((await cb({ state: "st-cb" })).status).toBe(400);
  });

  it("token exchange failure → 502", async () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = ORIGINS;
    const auth = mockAuthServer();
    auth.tokenReplies.code = () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
    seedPending();
    expect((await cb({ state: "st-cb", code: "bad-code" })).status).toBe(502);
    expect(store.getPending("oa-cb")).toBeUndefined();
  });

  it("success → 200, tokens stored, pending consumed", async () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = ORIGINS;
    const auth = mockAuthServer();
    seedPending();
    const res = await cb({ state: "st-cb", code: "good-code" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connected");
    const row = store.getOauthRow("oa-cb")!;
    expect(JSON.parse(row.tokensJson!).access_token).toBe("at-code");
    expect(store.getPending("oa-cb")).toBeUndefined();
    expect(auth.tokenCalls()[0].body).toContain("code=good-code");
    expect(auth.tokenCalls()[0].body).toContain("code_verifier=verifier-cb");
  });
});
