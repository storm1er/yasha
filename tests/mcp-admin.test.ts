import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GET, POST } from "@/app/api/admin/mcp/route";
import { adminUser, callRoute, jsonOf, sessionId, signUp } from "./support/app";
import { db, rawSqlite, setSetting } from "./support/db";
import { mcpServers, user } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { invalidateCatalog } from "@/lib/mcp/registry";
import { closeAllClients, setTransportFactory } from "@/lib/mcp/client";

let admin: Awaited<ReturnType<typeof adminUser>>;
let basic: Awaited<ReturnType<typeof signUp>>;

beforeAll(async () => {
  admin = await adminUser();
  basic = await signUp("mcp");
});

afterEach(() => {
  setTransportFactory(null);
  closeAllClients();
  invalidateCatalog();
  rawSqlite.prepare("DELETE FROM mcp_servers WHERE id != 'ketch'").run();
  delete process.env.MCP_ALLOW_PRIVATE_URLS;
  setSetting("mcp.enabled", "true");
});

function removeRow(id: string) {
  db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
}

function insertRow(id: string, patch: Partial<typeof mcpServers.$inferInsert> = {}) {
  removeRow(id);
  db.insert(mcpServers)
    .values({ id, builtin: false, name: id, url: "https://x.test/mcp", headersJson: null, enabled: true, disabledToolsJson: null, createdAt: new Date(), updatedAt: new Date(), ...patch })
    .run();
}

const post = (body: unknown, cookie: string | null = admin.cookie) =>
  callRoute(POST, { method: "POST", path: "/mcp", cookie, json: body });

describe("auth", () => {
  it("401 anonymous, 403 basic", async () => {
    expect((await callRoute(GET)).status).toBe(401);
    expect((await callRoute(GET, { cookie: basic.cookie })).status).toBe(403);
    expect((await post({ action: "toggle", id: "ketch" }, basic.cookie)).status).toBe(403);
    expect((await post({ action: "toggle", id: "ketch" }, null)).status).toBe(401);
  });
});

describe("GET", () => {
  it("lists seeded builtin with masked headers + health snapshot", async () => {
    setTransportFactory(() => {
      throw new Error("offline");
    });
    insertRow("rem", { headersJson: JSON.stringify({ Authorization: "secret-token" }) });
    const res = await callRoute(GET, { cookie: admin.cookie });
    const body = await jsonOf<{
      ok: boolean;
      mcpEnabled: boolean;
      userServersEnabled: boolean;
      userPrivateUrls: boolean;
      servers: { id: string; builtin: boolean; headers: Record<string, string> | null; health: { ok: boolean } }[];
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.mcpEnabled).toBe(true);
    expect(body.userServersEnabled).toBe(false);
    expect(body.userPrivateUrls).toBe(false);
    const ketch = body.servers.find((s) => s.id === "ketch")!;
    expect(ketch.builtin).toBe(true);
    const rem = body.servers.find((s) => s.id === "rem")!;
    expect(rem.headers).toEqual({ Authorization: "••••" });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });
});

describe("POST add", () => {
  it("adds a remote server", async () => {
    const res = await post({ action: "add", name: "My Server", url: "https://example.com/mcp" });
    const body = await jsonOf<{ ok: boolean; id: string }>(res);
    expect(res.status).toBe(200);
    expect(body.id).toMatch(/^my-server-[0-9a-f]{8}$/);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, body.id)).get()!;
    expect(row.url).toBe("https://example.com/mcp");
    expect(row.builtin).toBe(false);
    removeRow(body.id);
  });

  it("slug fallback for symbol-only names; empty disabledTools clears", async () => {
    const res = await post({ action: "add", name: "!!!", url: "https://x.test", disabledTools: [] });
    const { id } = await jsonOf<{ ok: boolean; id: string }>(res);
    expect(id).toMatch(/^server-[0-9a-f]{8}$/);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()!;
    expect(row.disabledToolsJson).toBeNull();
    removeRow(id);
  });

  it("stores headers + disabled tools", async () => {
    const res = await post({
      action: "add",
      name: "hdr",
      url: "http://example.com:8080/sse",
      headers: { "X-Key": "v" },
      disabledTools: ["drop"],
    });
    const { id } = await jsonOf<{ id: string }>(res);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()!;
    expect(row.headersJson).toBe(JSON.stringify({ "X-Key": "v" }));
    expect(row.disabledToolsJson).toBe(JSON.stringify(["drop"]));
    removeRow(id);
  });

  it("rejects malformed payloads", async () => {
    expect((await callRoute(POST, { method: "POST", path: "/m", cookie: admin.cookie, body: "{oops" })).status).toBe(400);
    expect((await post("not-object")).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post({})).status).toBe(400); // no action
    expect((await post({ action: 5 })).status).toBe(400);
    expect((await post({ action: "add", url: "https://x.test" })).status).toBe(400); // no name
    expect((await post({ action: "add", name: 3, url: "https://x.test" })).status).toBe(400);
    expect((await post({ action: "add", name: "", url: "https://x.test" })).status).toBe(400);
    expect((await post({ action: "add", name: "n" })).status).toBe(400); // no url
    expect((await post({ action: "add", name: "n", url: "ftp://x.test" })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "not a url" })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", headers: "x" })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", headers: ["a"] })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", headers: { "bad header": "v" } })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", headers: { A: 3 } })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`K${i}`, "v"])) })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", disabledTools: "x" })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", disabledTools: ["", 3] })).status).toBe(400);
    expect((await post({ action: "add", name: "n", url: "https://x.test", disabledTools: ["x".repeat(201)] })).status).toBe(400);
  });

  it("SSRF: private URLs allowed by default, blocked by env", async () => {
    expect((await post({ action: "add", name: "p", url: "http://192.168.1.5:9000/mcp" })).status).toBe(200);
    process.env.MCP_ALLOW_PRIVATE_URLS = "false";
    for (const u of ["http://192.168.1.5:9000/mcp", "http://127.0.0.1/x", "http://10.0.0.1/x", "http://172.16.0.1/x", "http://169.254.1.1/x", "http://localhost/x", "http://[::1]/x", "http://[fd00::1]/x", "http://0.0.0.0/x", "http://svc.localhost/x"]) {
      const res = await post({ action: "add", name: "p", url: u });
      expect(res.status, u).toBe(400);
    }
    const ok = await post({ action: "add", name: "pub", url: "https://example.com/mcp" });
    expect(ok.status).toBe(200);
  });
});

describe("POST toggle / delete / update / check", () => {
  it("404 unknown ids; non-string id", async () => {
    expect((await post({ action: "toggle" })).status).toBe(400);
    expect((await post({ action: "toggle", id: "ghost" })).status).toBe(404);
  });

  it("toggle builtin works; delete builtin rejected", async () => {
    const off = await jsonOf<{ enabled: boolean }>(await post({ action: "toggle", id: "ketch" }));
    expect(off.enabled).toBe(false);
    const on = await jsonOf<{ enabled: boolean }>(await post({ action: "toggle", id: "ketch" }));
    expect(on.enabled).toBe(true);
    expect((await post({ action: "delete", id: "ketch" })).status).toBe(400);
    expect((await post({ action: "update", id: "ketch", name: "x" })).status).toBe(400);
    expect((await post({ action: "update", id: "ketch", url: "https://x.test", disabledTools: ["a"] })).status).toBe(400);
    expect((await post({ action: "update", id: "ketch", headers: { A: "1" } })).status).toBe(400);
    expect((await post({ action: "update", id: "ketch", name: "x", disabledTools: ["a"] })).status).toBe(400);
    expect((await post({ action: "update", id: "ketch", headers: { A: "1" }, disabledTools: ["a"] })).status).toBe(400);
    expect((await post({ action: "update", id: "ketch", disabledTools: ["search"] })).status).toBe(200);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, "ketch")).get();
    expect(row?.disabledToolsJson).toBe(JSON.stringify(["search"]));
    expect((await post({ action: "update", id: "ketch", disabledTools: [] })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "ketch")).get()?.disabledToolsJson).toBeNull();
  });

  it("delete remote", async () => {
    insertRow("del");
    expect((await post({ action: "delete", id: "del" })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "del")).get()).toBeUndefined();
  });

  it("update name/url/headers/disabledTools + rejections", async () => {
    insertRow("upd", { headersJson: JSON.stringify({ A: "1" }) });
    expect((await post({ action: "update", id: "upd" })).status).toBe(400); // empty patch
    expect((await post({ action: "update", id: "upd", name: 42 })).status).toBe(400);
    expect((await post({ action: "update", id: "upd", name: "  " })).status).toBe(400);
    expect((await post({ action: "update", id: "upd", url: "ftp://x" })).status).toBe(400);
    expect((await post({ action: "update", id: "upd", headers: 5 })).status).toBe(400);
    expect((await post({ action: "update", id: "upd", headers: { A: 3 } })).status).toBe(400);
    expect((await post({ action: "update", id: "upd", headers: { "bad key": "v" } })).status).toBe(400);
    expect((await post({ action: "update", id: "upd", headers: { A: "x".repeat(1001) } })).status).toBe(400);
    expect((await post({ action: "update", id: "upd", headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`K${i}`, "v"])) })).status).toBe(400);
    expect((await post({ action: "update", id: "upd", disabledTools: [1] })).status).toBe(400);
    const res = await post({
      action: "update",
      id: "upd",
      name: "Renamed",
      url: "https://new.example/mcp",
      headers: { B: "2" },
      disabledTools: ["t"],
    });
    expect(res.status).toBe(200);
    let row = db.select().from(mcpServers).where(eq(mcpServers.id, "upd")).get()!;
    expect(row.name).toBe("Renamed");
    expect(row.url).toBe("https://new.example/mcp");
    // merge-patch: the untouched A header survives
    expect(row.headersJson).toBe(JSON.stringify({ A: "1", B: "2" }));
    expect(row.disabledToolsJson).toBe(JSON.stringify(["t"]));
    // null value deletes one key; empty patch is a no-op
    expect((await post({ action: "update", id: "upd", headers: { A: null } })).status).toBe(200);
    row = db.select().from(mcpServers).where(eq(mcpServers.id, "upd")).get()!;
    expect(row.headersJson).toBe(JSON.stringify({ B: "2" }));
    expect((await post({ action: "update", id: "upd", headers: {} })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "upd")).get()!.headersJson).toBe(JSON.stringify({ B: "2" }));
    // deleting the last header stores null
    expect((await post({ action: "update", id: "upd", headers: { B: null } })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "upd")).get()!.headersJson).toBeNull();
  });

  it("headers patch on garbage/base rows starts from an empty set", async () => {
    insertRow("garb-h", { headersJson: "{" });
    insertRow("null-h", { headersJson: "null" });
    insertRow("arr-h", { headersJson: JSON.stringify({ A: 3, B: "kept" }) });
    expect((await post({ action: "update", id: "garb-h", headers: { A: "1" } })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "garb-h")).get()!.headersJson).toBe(JSON.stringify({ A: "1" }));
    expect((await post({ action: "update", id: "null-h", headers: { A: "1" } })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "null-h")).get()!.headersJson).toBe(JSON.stringify({ A: "1" }));
    // non-string stored values are dropped while merging
    expect((await post({ action: "update", id: "arr-h", headers: { C: "3" } })).status).toBe(200);
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "arr-h")).get()!.headersJson).toBe(JSON.stringify({ B: "kept", C: "3" }));
  });

  it("check reconnects through the transport seam", async () => {
    insertRow("chk");
    setTransportFactory(() => {
      const server = new McpServer({ name: "chk", version: "1.0.0" });
      server.registerTool("one", { description: "d" }, async () => ({ content: [] }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      void server.connect(serverTransport);
      return clientTransport;
    });
    const res = await post({ action: "check", id: "chk" });
    const body = await jsonOf<{ ok: boolean; health: { ok: boolean; toolCount: number }; toolCount: number }>(res);
    expect(body.health.ok).toBe(true);
    expect(body.toolCount).toBe(1);
  });

  it("unknown action → 400", async () => {
    expect((await post({ action: "frobnicate", id: "ketch" })).status).toBe(400);
  });
});

describe("user-owned rows", () => {
  it("exposes owner, blocks edit/connect, allows moderation", async () => {
    setTransportFactory(() => {
      throw new Error("offline");
    });
    insertRow("usr1", { ownerUserId: await sessionId(basic.cookie) });
    // Owner without a username → the id is displayed instead.
    db.insert(user)
      .values({ id: "usr-noname", name: "no name", email: "usr-noname@example.test", emailVerified: false, role: "user", username: null, createdAt: new Date(), updatedAt: new Date() })
      .run();
    insertRow("usr2", { ownerUserId: "usr-noname" });
    const res = await callRoute(GET, { cookie: admin.cookie });
    const body = await jsonOf<{ servers: { id: string; owner: string | null }[] }>(res);
    expect(body.servers.find((s) => s.id === "usr1")!.owner).toBe(basic.username);
    expect(body.servers.find((s) => s.id === "usr2")!.owner).toBe("usr-noname");
    expect(body.servers.find((s) => s.id === "ketch")!.owner).toBeNull();
    expect((await post({ action: "update", id: "usr1", name: "x" })).status).toBe(400);
    expect((await post({ action: "connect", id: "usr1" })).status).toBe(400);
    expect((await post({ action: "disconnect", id: "usr1" })).status).toBe(400);
    expect((await post({ action: "toggle", id: "usr1" })).status).toBe(200);
    expect((await post({ action: "delete", id: "usr1" })).status).toBe(200);
    db.delete(user).where(eq(user.id, "usr-noname")).run(); // cascade removes usr2 row too
    expect(db.select().from(mcpServers).where(eq(mcpServers.id, "usr2")).get()).toBeUndefined();
  });
});

describe("GET masking edge cases", () => {
  it("garbage headers rows mask to null without failing", async () => {
    setTransportFactory(() => {
      throw new Error("offline");
    });
    insertRow("garb", { headersJson: "{" });
    insertRow("garb2", { headersJson: JSON.stringify(["not", "obj"]) });
    insertRow("garb3", { disabledToolsJson: "[\"a\"]" });
    const res = await callRoute(GET, { cookie: admin.cookie });
    const body = await jsonOf<{ servers: Record<string, unknown>[] }>(res);
    const g = body.servers.find((s) => s.id === "garb")!;
    const g2 = body.servers.find((s) => s.id === "garb2")!;
    const g3 = body.servers.find((s) => s.id === "garb3")!;
    expect(g.headers).toBeNull();
    expect(g2.headers).toBeNull();
    expect(g3.disabledTools).toEqual(["a"]);
  });
});
