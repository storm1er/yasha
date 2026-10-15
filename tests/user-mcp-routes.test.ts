import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GET, POST } from "@/app/api/mcp/servers/route";
import { callRoute, jsonOf, sessionId, signUp, type TestUser } from "./support/app";
import { db, rawSqlite, setSetting } from "./support/db";
import { mcpServers } from "@/lib/db/schema";
import { closeAllClients, setTransportFactory } from "@/lib/mcp/client";
import { invalidateCatalog } from "@/lib/mcp/registry";
import { mockAuthServer } from "./support/mcp-oauth";
import * as store from "@/lib/mcp/oauth/store";

let alice: TestUser & { userId: string };
let bob: TestUser & { userId: string };

beforeAll(async () => {
  alice = Object.assign(await signUp("umcprouteA"), { userId: "" });
  alice.userId = await sessionId(alice.cookie);
  bob = Object.assign(await signUp("umcprouteB"), { userId: "" });
  bob.userId = await sessionId(bob.cookie);
});

afterEach(() => {
  setTransportFactory(null);
  closeAllClients();
  invalidateCatalog();
  rawSqlite.prepare("DELETE FROM mcp_oauth").run();
  rawSqlite.prepare("DELETE FROM mcp_servers WHERE owner_user_id IS NOT NULL").run();
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "";
  setSetting("mcp.enabled", "true");
  setSetting("mcp.userServersEnabled", "true");
  setSetting("mcp.maxUserServers", "5");
  setSetting("mcp.userPrivateUrls", "false");
  delete process.env.MCP_ALLOW_PRIVATE_URLS;
});

function insertRow(id: string, patch: Partial<typeof mcpServers.$inferInsert> = {}) {
  db.insert(mcpServers)
    .values({
      id,
      builtin: false,
      name: id,
      url: "https://x.test/mcp",
      headersJson: null,
      enabled: true,
      disabledToolsJson: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...patch,
    })
    .run();
}

const get = (cookie: string | null) => callRoute(GET, { path: "/mcp/servers", cookie });
const post = (body: unknown, cookie: string | null = alice.cookie) =>
  callRoute(POST, { method: "POST", path: "/mcp/servers", cookie, json: body });

function fakeTransport() {
  const server = new McpServer({ name: "fake", version: "1.0.0" });
  server.registerTool(
    "ping",
    { description: "ping", inputSchema: { v: z.string().optional() } },
    async () => ({ content: [{ type: "text", text: "pong" }] })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return clientTransport;
}

describe("auth", () => {
  it("401 for anonymous on GET and POST", async () => {
    expect((await get(null)).status).toBe(401);
    expect((await post({ action: "check", id: "x" }, null)).status).toBe(401);
  });
});

describe("GET", () => {
  it("lists only the caller's rows with masked headers + health", async () => {
    insertRow("own", { ownerUserId: alice.userId, headersJson: JSON.stringify({ "X-Key": "s3cret" }) });
    insertRow("own2", { ownerUserId: alice.userId, disabledToolsJson: JSON.stringify(["x"]) });
    insertRow("off", { ownerUserId: alice.userId, enabled: false });
    insertRow("bob-own", { ownerUserId: bob.userId });
    insertRow("global", {}); // admin row → never listed here
    setTransportFactory(fakeTransport);
    const body = await jsonOf<{
      ok: boolean;
      serversEnabled: boolean;
      privateUrlsAllowed: boolean;
      maxServers: number;
      servers: { id: string; headers: Record<string, string> | null; disabledTools: string[]; health: { ok: boolean; error: string | null } }[];
    }>(await get(alice.cookie));
    expect(body.ok).toBe(true);
    expect(body.serversEnabled).toBe(true);
    expect(body.privateUrlsAllowed).toBe(false); // default: admin has not allowed LAN
    expect(body.maxServers).toBe(5);
    expect(body.servers.map((s) => s.id).sort()).toEqual(["off", "own", "own2"]);
    expect(body.servers.find((s) => s.id === "own2")!.disabledTools).toEqual(["x"]);
    const own = body.servers.find((s) => s.id === "own")!;
    expect(own.headers).toEqual({ "X-Key": "••••" });
    expect(own.health.ok).toBe(true);
    expect(body.servers.find((s) => s.id === "off")!.health.error).toBe("disabled");
    expect(JSON.stringify(body)).not.toContain("s3cret");
  });
});

describe("POST add", () => {
  it("adds an owned remote row", async () => {
    setSetting("mcp.userServersEnabled", "true");
    const res = await post({ action: "add", name: "Personal", url: "https://mcp.example.com/mcp" });
    const body = await jsonOf<{ ok: boolean; id: string }>(res);
    expect(res.status).toBe(200);
    expect(body.id).toMatch(/^personal-[0-9a-f]{8}$/);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, body.id)).get()!;
    expect(row.ownerUserId).toBe(alice.userId);
    expect(row.builtin).toBe(false);
  });

  it("403 while user servers are disabled instance-wide", async () => {
    setSetting("mcp.userServersEnabled", "false");
    const res = await post({ action: "add", name: "x", url: "https://x.test" });
    expect(res.status).toBe(403);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("user_servers_disabled");
  });

  it("enforces the per-user quota", async () => {
    setSetting("mcp.maxUserServers", "1");
    insertRow("q1", { ownerUserId: alice.userId });
    const res = await post({ action: "add", name: "second", url: "https://x.test" });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("quota_exceeded");
    // bob still has room (quota is per user)
    expect((await post({ action: "add", name: "ok", url: "https://x.test" }, bob.cookie)).status).toBe(200);
  });

  it("rejects invalid payloads", async () => {
    expect((await callRoute(POST, { method: "POST", path: "/m", cookie: alice.cookie, body: "{oops" })).status).toBe(400);
    expect((await post("nope")).status).toBe(400);
    expect((await post({})).status).toBe(400); // no action
    expect((await post({ action: 5 })).status).toBe(400);
    expect((await post({ action: "add", url: "https://x.test" })).status).toBe(400); // no name
    expect((await post({ action: "add", name: "", url: "https://x.test" })).status).toBe(400);
    expect((await post({ action: "add", name: 7, url: "https://x.test" })).status).toBe(400);
    expect((await post({ action: "add", name: "n" })).status).toBe(400); // no url
    expect((await post({ action: "add", name: "n", url: "ftp://x.test" })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "not a url" })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", headers: "x" })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", headers: { "bad key!": "v" } })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", disabledTools: [1] })).status).toBe(400);
    expect((await post({ action: "frobnicate" })).status).toBe(400);
  });

  it("always blocks private hosts, even when the admin env allows them", async () => {
    process.env.MCP_ALLOW_PRIVATE_URLS = "true";
    for (const url of [
      "http://localhost:9/mcp",
      "http://127.0.0.1/mcp",
      "https://10.1.2.3/mcp",
      "https://192.168.1.9/mcp",
      "http://172.16.0.1/mcp",
      "http://[::1]/mcp",
      "http://169.254.1.1/mcp",
      "http://[::1]/mcp",
    ]) {
      const res = await post({ action: "add", name: "p", url });
      expect(res.status, url).toBe(400);
      expect((await jsonOf<{ error: string }>(res)).error, url).toBe("private_url_blocked");
    }
    expect((await post({ action: "add", name: "ok", url: "http://9.9.9.9/mcp" })).status).toBe(200);
    const res2 = await post({ action: "add", name: "p2", url: "http://svc.localhost/mcp" });
    expect(res2.status).toBe(400);
  });

  it("allows private hosts once the admin setting is on; env veto re-blocks", async () => {
    setTransportFactory(fakeTransport);
    setSetting("mcp.userPrivateUrls", "true");
    const listBody = await jsonOf<{ privateUrlsAllowed: boolean }>(await get(alice.cookie));
    expect(listBody.privateUrlsAllowed).toBe(true);
    const res = await post({ action: "add", name: "lan", url: "http://192.168.1.100:8080/mcp" });
    expect(res.status).toBe(200);
    process.env.MCP_ALLOW_PRIVATE_URLS = "false";
    const offBody = await jsonOf<{ privateUrlsAllowed: boolean }>(await get(alice.cookie));
    expect(offBody.privateUrlsAllowed).toBe(false);
    const blocked = await post({ action: "add", name: "p", url: "http://10.0.0.1/mcp" });
    expect(blocked.status).toBe(400);
    expect((await jsonOf<{ error: string }>(blocked)).error).toBe("private_url_blocked");
  });
});

describe("POST row actions", () => {
  it("404 for unknown, foreign, global and builtin rows (no id probing)", async () => {
    insertRow("bobpriv", { ownerUserId: bob.userId });
    insertRow("globalrow", {});
    expect((await post({ action: "check", id: "nope" })).status).toBe(404);
    expect((await post({ action: "check", id: "bobpriv" })).status).toBe(404);
    expect((await post({ action: "check", id: "globalrow" })).status).toBe(404);
    expect((await post({ action: "toggle", id: "ketch" })).status).toBe(404);
    expect((await post({ action: "check" })).status).toBe(400); // id not a string
  });

  it("toggle flips + reports state; delete removes", async () => {
    insertRow("t1", { ownerUserId: alice.userId });
    const t = await jsonOf<{ ok: boolean; enabled: boolean }>(await post({ action: "toggle", id: "t1" }));
    expect(t.enabled).toBe(false);
    const t2 = await jsonOf<{ enabled: boolean }>(await post({ action: "toggle", id: "t1" }));
    expect(t2.enabled).toBe(true);
    expect((await post({ action: "delete", id: "t1" })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "t1")).get()).toBeUndefined();
    insertRow("t2", { ownerUserId: alice.userId });
    expect((await post({ action: "frobnicate", id: "t2" })).status).toBe(400); // unknown action w/ owned row
  });

  it("update patches fields, validates each, rejects no-op", async () => {
    insertRow("u1", { ownerUserId: alice.userId });
    expect((await post({ action: "update", id: "u1" })).status).toBe(400); // nothing to set
    expect((await post({ action: "update", id: "u1", name: "" })).status).toBe(400);
    expect((await post({ action: "update", id: "u1", url: "ftp://x" })).status).toBe(400);
    expect((await post({ action: "update", id: "u1", url: "http://127.0.0.2/x" })).status).toBe(400);
    expect((await post({ action: "update", id: "u1", headers: [] })).status).toBe(400);
    expect((await post({ action: "update", id: "u1", headers: { "X-T": 2 } })).status).toBe(400);
    expect((await post({ action: "update", id: "u1", disabledTools: ["ok", 2] })).status).toBe(400);
    const res = await post({
      action: "update",
      id: "u1",
      name: "renamed",
      url: "https://new.example/mcp",
      headers: { "X-T": "1" },
      disabledTools: ["a"],
    });
    expect(res.status).toBe(200);
    let row = db.select().from(mcpServers).where(eq(mcpServers.id, "u1")).get()!;
    expect(row.name).toBe("renamed");
    expect(row.url).toBe("https://new.example/mcp");
    expect(row.headersJson).toBe(JSON.stringify({ "X-T": "1" }));
    expect(row.disabledToolsJson).toBe(JSON.stringify(["a"]));
    // headers merge-patch: string upserts keep other headers…
    expect((await post({ action: "update", id: "u1", headers: { "X-B": "2" } })).status).toBe(200);
    row = db.select().from(mcpServers).where(eq(mcpServers.id, "u1")).get()!;
    expect(row.headersJson).toBe(JSON.stringify({ "X-T": "1", "X-B": "2" }));
    // …null deletes one key…
    expect((await post({ action: "update", id: "u1", headers: { "X-B": null } })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "u1")).get()!.headersJson).toBe(JSON.stringify({ "X-T": "1" }));
    // …and deleting the last header stores null
    expect((await post({ action: "update", id: "u1", headers: { "X-T": null } })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "u1")).get()!.headersJson).toBeNull();
  });

  it("check probes with the fake transport and returns health", async () => {
    insertRow("c1", { ownerUserId: alice.userId });
    setTransportFactory(fakeTransport);
    const body = await jsonOf<{ ok: boolean; health: { ok: boolean }; toolCount: number }>(
      await post({ action: "check", id: "c1" })
    );
    expect(body.health.ok).toBe(true);
    expect(body.toolCount).toBe(1);
    setTransportFactory(() => {
      throw new Error("offline");
    });
    closeAllClients();
    invalidateCatalog("c1");
    const bad = await jsonOf<{ health: { ok: boolean; error: string } }>(await post({ action: "check", id: "c1" }));
    expect(bad.health.ok).toBe(false);
    expect(bad.health.error).toContain("offline");
  });
});

describe("POST connect / disconnect (own rows only)", () => {
  it("connected: server works without OAuth", async () => {
    insertRow("conn1", { ownerUserId: alice.userId });
    setTransportFactory(fakeTransport);
    const body = await jsonOf<{ ok: boolean; connected: boolean; toolCount: number }>(
      await post({ action: "connect", id: "conn1" })
    );
    expect(body).toEqual({ ok: true, connected: true, toolCount: 1 });
    expect(store.hasOauthRow("conn1")).toBe(true);
    expect(store.oauthStatus("conn1").authorized).toBe(false);
  });

  it("needs_auth: full dance returns authorizationUrl (pending captured)", async () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://yasha.test";
    mockAuthServer();
    insertRow("conn2", { ownerUserId: alice.userId, url: "https://mcp.test/mcp" });
    const body = await jsonOf<{ ok: boolean; needsAuth: boolean; authorizationUrl: string }>(
      await post({ action: "connect", id: "conn2" })
    );
    expect(body.needsAuth).toBe(true);
    expect(body.authorizationUrl).toContain("https://auth.test/authorize?");
    expect(store.getPending("conn2")!.url).toBe(body.authorizationUrl);
  });

  it("needs_auth without captured URL → oauth_flow_failed", async () => {
    insertRow("conn3", { ownerUserId: alice.userId });
    setTransportFactory(() => {
      throw new UnauthorizedError();
    });
    const res = await post({ action: "connect", id: "conn3" });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("oauth_flow_failed");
  });

  it("other failures surface the health", async () => {
    insertRow("conn4", { ownerUserId: alice.userId });
    setTransportFactory(() => {
      throw new Error("down");
    });
    const body = await jsonOf<{ ok: boolean; connected: boolean; health: { error: string } }>(
      await post({ action: "connect", id: "conn4" })
    );
    expect(body.connected).toBe(false);
    expect(body.health.error).toContain("down");
  });

  it("oauth_url_required when url missing", async () => {
    insertRow("conn5", { ownerUserId: alice.userId, url: null });
    const res = await post({ action: "connect", id: "conn5" });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("oauth_url_required");
  });

  it("disconnect clears the oauth row", async () => {
    insertRow("conn6", { ownerUserId: alice.userId });
    store.ensureOauthRow("conn6");
    store.saveTokens("conn6", JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }), "https://auth.test");
    expect(store.oauthStatus("conn6").authorized).toBe(true);
    const body = await jsonOf<{ ok: boolean }>(await post({ action: "disconnect", id: "conn6" }));
    expect(body.ok).toBe(true);
    expect(store.hasOauthRow("conn6")).toBe(false);
  });

  it("connect/disconnect on foreign rows → 404", async () => {
    insertRow("conn7", { ownerUserId: alice.userId });
    expect((await post({ action: "connect", id: "conn7" }, bob.cookie)).status).toBe(404);
    expect((await post({ action: "disconnect", id: "conn7" }, bob.cookie)).status).toBe(404);
  });
});
