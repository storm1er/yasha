import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { db, rawSqlite, setSetting } from "./support/db";
import { mcpServers, user } from "@/lib/db/schema";
import { seedMcpBuiltin } from "@/lib/db/bootstrap";
import {
  KETCH_HOME,
  callTool,
  closeAllClients,
  closeIdleClients,
  defaultTransport,
  dropConnection,
  getClient,
  installExitHooks,
  setTransportFactory,
  type McpTransportServer,
} from "@/lib/mcp/client";
import {
  adminCatalog,
  disabledToolsOf,
  effectiveCatalogForUser,
  enabledServers,
  getServer,
  invalidateCatalog,
  ownedServers,
  serverCatalog,
  serversForUser,
  userCatalog,
} from "@/lib/mcp/registry";
import { buildToolset, openAiToolName, runToolCall } from "@/lib/mcp/bridge";

function buildFakeServer(id: string, extraText?: string): { server: McpServer; clientTransport: InMemoryTransport } {
  const server = new McpServer({ name: id, version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "echoes", inputSchema: { value: z.string() } },
    async ({ value }) => ({ content: [{ type: "text", text: `echo:${value}` }] }),
  );
  server.registerTool("boom", { description: "fails" }, async () => ({
    content: [{ type: "text", text: "kaboom" }],
    isError: true,
  }));
  server.registerTool("mixed", { description: "has a blob" }, async () => ({
    content: [{ type: "image", data: "eHk=", mimeType: "image/png" }, { type: "text", text: "tail" }],
  }));
  server.registerTool("slow", { description: "hangs" }, async () => {
    await new Promise((r) => setTimeout(r, 3000));
    return { content: [{ type: "text", text: "late" }] };
  });
  server.registerTool("empty", { description: "empty" }, async () => ({ content: [] }));
  server.registerTool("nodesc", {}, async () => ({ content: [{ type: "text", text: "d" }] }));
  if (extraText === "big") {
    server.registerTool("big", { description: "big" }, async () => ({
      content: [{ type: "text", text: "z".repeat(2000) }],
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return { server, clientTransport };
}

function addServerRow(id: string, url: string | null, enabled = true, ownerUserId: string | null = null): void {
  db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
  db.insert(mcpServers)
    .values({ id, builtin: false, name: id, url, headersJson: null, enabled, disabledToolsJson: null, ownerUserId, createdAt: new Date(), updatedAt: new Date() })
    .run();
}

const ALICE = "u-alice-fk";

function seedFakeUser(id: string): void {
  db.insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      role: "user",
      username: id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

/** Fresh fake MCP server per connect attempt (in-memory pairs are single-use). */
function fakeFactory(extra?: string) {
  return (srv: McpTransportServer) => buildFakeServer(srv.id, extra).clientTransport;
}

beforeAll(async () => {
  const { ensureReady } = await import("@/lib/db");
  await ensureReady();
  seedMcpBuiltin();
  seedMcpBuiltin(); // idempotent
  seedFakeUser(ALICE);
});

afterEach(() => {
  closeAllClients();
  setTransportFactory(null);
  invalidateCatalog();
  rawSqlite.prepare("DELETE FROM mcp_servers WHERE id != 'ketch'").run();
  rawSqlite.prepare("UPDATE mcp_servers SET enabled = 1 WHERE id = 'ketch'").run();
  setSetting("mcp.enabled", "true");
  setSetting("mcp.userServersEnabled", "false");
  setSetting("mcp.maxUserServers", "5");
  setSetting("mcp.toolTimeoutMs", "30000");
  setSetting("mcp.toolResultMaxChars", "8000");
});

describe("client", () => {
  it("defaultTransport: stdio for ketch (HOME injected), http for remotes, throws url-less", () => {
    process.env.KETCH_TEST_VAR = "1";
    expect(defaultTransport({ id: "ketch", url: null, headersJson: null })).toBeDefined();
    expect(KETCH_HOME).toBe("/data/ketch");
    delete process.env.KETCH_TEST_VAR;
    expect(defaultTransport({ id: "r", url: "https://x.test/mcp", headersJson: JSON.stringify({ "X-Key": "v", bad: 3 }) })).toBeDefined();
    expect(defaultTransport({ id: "r", url: "https://x.test/mcp", headersJson: JSON.stringify(["not", "obj"]) })).toBeDefined();
    expect(defaultTransport({ id: "r", url: "https://x.test/mcp", headersJson: "null" })).toBeDefined();
    expect(defaultTransport({ id: "r", url: "https://x.test/mcp", headersJson: null })).toBeDefined();
    expect(() => defaultTransport({ id: "r", url: "https://x.test", headersJson: "garbage" })).toThrow();
    expect(() => defaultTransport({ id: "r", url: null, headersJson: null })).toThrow(/no url/);
  });

  it("connects lazily, reuses connections, respawns after failed calls", async () => {
    addServerRow("f1", "https://x.test");
    const srv = getServer("f1")!;
    setTransportFactory(fakeFactory());
    const c1 = await getClient(srv);
    expect(await getClient(srv)).toBe(c1);
    expect(c1 instanceof Client).toBe(true);
    const res = await callTool(srv, "echo", { value: "hi" });
    expect((res.content as { text: string }[])[0].text).toBe("echo:hi");
    setSetting("mcp.toolTimeoutMs", "100");
    await expect(callTool(srv, "slow", {})).rejects.toThrow();
    setSetting("mcp.toolTimeoutMs", "30000");
    const res2 = await callTool(srv, "echo", { value: "again" }); // fresh transport via factory
    expect((res2.content as { text: string }[])[0].text).toBe("echo:again");
  });

  it("closes idle connections; installExitHooks fires closeAll once (fake emitter)", async () => {
    addServerRow("f2", "https://x.test");
    const srv = getServer("f2")!;
    setTransportFactory(fakeFactory());
    await getClient(srv);
    closeIdleClients(0, Date.now() + 1000);
    const res = await callTool(srv, "echo", { value: "x" });
    expect((res.content as { text: string }[])[0].text).toBe("echo:x");

    const listeners: Array<() => void> = [];
    const emitter = { once: (_e: string, fn: () => void) => listeners.push(fn) };
    installExitHooks(emitter as unknown as NodeJS.Process);
    installExitHooks(emitter as unknown as NodeJS.Process); // no-op
    const before = listeners.length;
    listeners[listeners.length - 1]();
    expect(before).toBeGreaterThanOrEqual(1);
    await expect(callTool(srv, "echo", { value: "y" })).resolves.toBeDefined();
  });

  it("aborts connect when the signal fires before/during connect", async () => {
    addServerRow("f4", "https://x.test");
    const srv = getServer("f4")!;
    const slowTransport = {
      start: () => new Promise<void>((r) => setTimeout(r, 200)),
      send: async () => undefined,
      close: async () => undefined,
      set onclose(_v: unknown) {},
      set onerror(_v: unknown) {},
      set onmessage(_v: unknown) {},
    };
    setTransportFactory(() => slowTransport as never);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await expect(getClient(srv, ac.signal)).rejects.toThrow();
    const ac2 = new AbortController();
    ac2.abort();
    await expect(getClient(srv, ac2.signal)).rejects.toThrow();
  });
});

describe("registry", () => {
  it("enabledServers respects the kill-switch and per-server flags", () => {
    setSetting("mcp.enabled", "false");
    expect(enabledServers()).toEqual([]);
    setSetting("mcp.enabled", "true");
    expect(enabledServers().map((s) => s.id)).toContain("ketch");
    rawSqlite.prepare("UPDATE mcp_servers SET enabled = 0 WHERE id = 'ketch'").run();
    expect(enabledServers().map((s) => s.id)).not.toContain("ketch");
    expect(getServer("ketch")?.builtin).toBe(true);
    expect(getServer("nope")).toBeUndefined();
  });

  it("denylist parsing tolerates garbage rows", () => {
    const base = { id: "x", builtin: false, name: "x", url: null, headersJson: null, enabled: true, disabledToolsJson: null, ownerUserId: null, createdAt: new Date(), updatedAt: new Date() };
    expect(disabledToolsOf({ ...base, disabledToolsJson: JSON.stringify(["a", 5]) })).toEqual(new Set(["a"]));
    expect(disabledToolsOf({ ...base, disabledToolsJson: "{" })).toEqual(new Set());
    expect(disabledToolsOf({ ...base, disabledToolsJson: "42" })).toEqual(new Set());
    expect(disabledToolsOf(base)).toEqual(new Set());
  });

  it("catalogs tools with TTL cache, error health and invalidation", async () => {
    addServerRow("f5", "https://x.test");
    setTransportFactory(fakeFactory());
    const first = await serverCatalog(getServer("f5")!);
    expect(first.health.ok).toBe(true);
    expect(first.tools.map((t) => t.name)).toContain("echo");
    const cached = await serverCatalog(getServer("f5")!); // TTL hit
    expect(cached.tools).toEqual(first.tools);
    invalidateCatalog("f5");
    closeAllClients();
    setTransportFactory(() => {
      throw new Error("connect failed");
    });
    const err = await serverCatalog(getServer("f5")!);
    expect(err.health.ok).toBe(false);
    expect(err.health.error).toContain("connect failed");
    expect(err.tools).toEqual([]);
    const adm = await adminCatalog();
    expect(adm.find((e) => e.server.id === "f5")!.health.ok).toBe(false);
  });

  it("drops a connection for an id that never connected; swallows close() rejections", async () => {
    dropConnection("nobody"); // conn undefined → no-op
    addServerRow("fc", "https://x.test");
    setTransportFactory(() => {
      const t = buildFakeServer("fc").clientTransport;
      const orig = t.close.bind(t);
      t.close = async () => {
        await orig();
        throw new Error("close boom");
      };
      return t;
    });
    await getClient(getServer("fc")!);
    closeAllClients(); // rejection from the transport close must not escape
    expect(true).toBe(true);
  });

  it("serverCatalog records non-Error failures", async () => {
    addServerRow("fstr", "https://x.test");
    setTransportFactory(() => {
      throw "plain-string";
    });
    const entry = await serverCatalog(getServer("fstr")!);
    expect(entry.health.error).toBe("plain-string");
  });

  it("adminCatalog reports disabled rows without connecting", async () => {
    addServerRow("f6", "https://x.test", false);
    setTransportFactory(() => {
      throw new Error("should not connect");
    });
    const adm = await adminCatalog();
    const row = adm.find((e) => e.server.id === "f6")!;
    expect(row.health.error).toBe("disabled");
    expect(row.tools).toEqual([]);
  });

  it("effectiveCatalogForUser filters denied tools", async () => {
    addServerRow("f7", "https://x.test");
    rawSqlite.prepare("UPDATE mcp_servers SET disabled_tools_json = '[\"echo\"]' WHERE id = 'f7'").run();
    setTransportFactory(fakeFactory());
    const cat = await effectiveCatalogForUser(ALICE);
    const entry = cat.find((e) => e.server.id === "f7")!;
    expect(entry.tools.map((t) => t.name)).not.toContain("echo");
    expect(entry.tools.map((t) => t.name)).toContain("boom");
  });

  it("serversForUser scopes owned rows behind the instance flag", () => {
    addServerRow("g1", "https://x.test");
    addServerRow("own1", "https://x.test", true, ALICE);
    addServerRow("off1", "https://x.test", false, ALICE);
    // Off (default): global rows only.
    expect(serversForUser(ALICE).map((s) => s.id).sort()).toEqual(["g1", "ketch"]);
    setSetting("mcp.userServersEnabled", "true");
    const on = serversForUser(ALICE).map((s) => s.id);
    expect(on).toContain("own1");
    expect(on).not.toContain("off1"); // disabled rows stay hidden
    setSetting("mcp.enabled", "false");
    expect(serversForUser(ALICE)).toEqual([]);
  });

  it("effectiveCatalogForUser orders global rows first", async () => {
    addServerRow("zz-global", "https://x.test");
    addServerRow("aa-own", "https://x.test", true, ALICE);
    setSetting("mcp.userServersEnabled", "true");
    setTransportFactory(fakeFactory());
    const cat = await effectiveCatalogForUser(ALICE);
    const ids = cat.map((e) => e.server.id);
    expect(ids.indexOf("ketch")).toBeLessThan(ids.indexOf("aa-own"));
  });

  it("userCatalog + ownedServers cover only the caller's rows (incl. disabled)", async () => {
    addServerRow("uc-global", "https://x.test");
    addServerRow("uc-off", "https://x.test", false, ALICE);
    setTransportFactory(fakeFactory());
    const cat = await userCatalog(ALICE);
    expect(cat.map((e) => e.server.id)).toEqual(["uc-off"]);
    expect(cat[0].health.error).toBe("disabled"); // no connect attempted
    expect(ownedServers(ALICE).map((s) => s.id)).toEqual(["uc-off"]);
    expect(await userCatalog("u-nobody")).toEqual([]);
  });
});

describe("settings getters", () => {
  it("expose MCP knobs with clamping", async () => {
    const s = await import("@/lib/settings");
    setSetting("mcp.maxToolRounds", "3");
    expect(s.mcpMaxToolRounds()).toBe(3);
    setSetting("mcp.maxToolRounds", "99");
    expect(s.mcpMaxToolRounds()).toBe(16);
    setSetting("mcp.maxToolRounds", "garbage");
    expect(s.mcpMaxToolRounds()).toBe(4);
    expect(s.mcpToolTimeoutMs()).toBe(30000);
    expect(s.mcpToolResultMaxChars()).toBe(8000);
    expect(s.mcpUserServersEnabled()).toBe(false);
    setSetting("mcp.userServersEnabled", "true");
    expect(s.mcpUserServersEnabled()).toBe(true);
    expect(s.mcpMaxUserServers()).toBe(5);
    setSetting("mcp.maxUserServers", "999");
    expect(s.mcpMaxUserServers()).toBe(50);
    setSetting("mcp.maxUserServers", "-3");
    expect(s.mcpMaxUserServers()).toBe(1);
  });
});

describe("bridge", () => {
  it("sanitizes OpenAI tool names", () => {
    expect(openAiToolName("ketch", "search")).toBe("mcp__ketch__search");
    expect(openAiToolName("a.b", "c d")).toBe("mcp__a_b__c_d");
    expect(openAiToolName("s", "x".repeat(100))).toHaveLength(64);
  });

  it("builds the toolset gated by mcp.enabled; skips failed servers and name collisions", async () => {
    addServerRow("a_b", "https://a.test");
    addServerRow("a.b", "https://b.test"); // sanitizes to a_b too → collision
    setTransportFactory(fakeFactory());
    setSetting("mcp.enabled", "false");
    expect(await buildToolset("u-test")).toEqual({ specs: [], handles: new Map() });
    setSetting("mcp.enabled", "true");
    const ts = await buildToolset("u-test");
    const echoNames = ts.specs.filter((s) => s.function.name === "mcp__a_b__echo");
    expect(echoNames).toHaveLength(1); // first server wins
    expect(ts.handles.get("mcp__a_b__echo")!.serverId).toBe("a_b");
    // The MCP tool's real inputSchema is advertised as OpenAI `parameters`
    // (an empty schema would force the model to call with `{}` only).
    expect(echoNames[0]!.function.parameters).toMatchObject({
      type: "object",
      properties: { value: { type: "string" } },
    });
  });

  it("skips unhealthy servers", async () => {
    addServerRow("f8", "https://x.test");
    setTransportFactory(() => {
      throw new Error("down");
    });
    const ts = await buildToolset("u-test");
    expect(ts.specs.find((s) => s.function.name.includes("f8"))).toBeUndefined();
  });

  it("builds user-scoped toolsets: owned rows gated, global wins name collisions", async () => {
    addServerRow("a_b", "https://g.test"); // global
    addServerRow("a-b", "https://o.test", true, ALICE); // owner row, sanitizes to a_b
    setTransportFactory(fakeFactory());
    // Flag off: only the global row is in the toolset.
    let ts = await buildToolset(ALICE);
    expect(ts.handles.get("mcp__a_b__echo")!.serverId).toBe("a_b");
    setSetting("mcp.userServersEnabled", "true");
    ts = await buildToolset(ALICE);
    expect(ts.handles.get("mcp__a_b__echo")!.serverId).toBe("a_b"); // global-first order wins
    // A user with no owned servers sees only the global one.
    const other = await buildToolset("u-other");
    expect(other.specs.find((s) => s.function.name === "mcp__a_b__echo")).toBeDefined();
    // Handles carry the requesting user.
    expect(ts.handles.get("mcp__a_b__echo")!.userId).toBe(ALICE);
  });

  it("runToolCall enforces ownership on user-owned rows", async () => {
    addServerRow("own-x", "https://x.test", true, ALICE);
    setSetting("mcp.userServersEnabled", "true");
    setTransportFactory(fakeFactory());
    const thief = await runToolCall({ serverId: "own-x", tool: "echo", title: "t", userId: "u-thief" }, "{}");
    expect(thief.ok).toBe(false);
    expect(thief.content).toContain("unknown or disabled server");
    const owner = await runToolCall(
      { serverId: "own-x", tool: "echo", title: "t", userId: ALICE },
      JSON.stringify({ value: "mine" })
    );
    expect(owner.ok).toBe(true);
    expect(owner.content).toContain("echo:");
  });

  it("runs tool calls: ok text, isError results, non-text parts, empty, bad args, ghost/disabled servers", async () => {
    addServerRow("f9", "https://x.test");
    setTransportFactory(fakeFactory());
    const ok = await runToolCall({ serverId: "f9", tool: "echo", title: "t", userId: "u-test" }, JSON.stringify({ value: "yo" }));
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("echo:yo");
    expect(ok.content).toContain("quoted data");

    const errRes = await runToolCall({ serverId: "f9", tool: "boom", title: "t", userId: "u-test" }, "{}");
    expect(errRes.ok).toBe(false);
    expect(errRes.content).toContain("kaboom");

    const mixed = await runToolCall({ serverId: "f9", tool: "mixed", title: "t", userId: "u-test" }, "{}");
    expect(mixed.content).toContain("[non-text content]");
    expect(mixed.content).toContain("tail");

    const empty = await runToolCall({ serverId: "f9", tool: "empty", title: "t", userId: "u-test" }, "");
    expect(empty.content).toContain("(empty)");

    const badArgs = await runToolCall({ serverId: "f9", tool: "echo", title: "t", userId: "u-test" }, "not json");
    expect(badArgs.content).toContain("invalid arguments");

    const arrayArgs = await runToolCall({ serverId: "f9", tool: "empty", title: "t", userId: "u-test" }, "[1,2]");
    expect(arrayArgs.ok).toBe(true); // non-object JSON → args stay {}

    const ghost = await runToolCall({ serverId: "ghost", tool: "x", title: "t", userId: "u-test" }, "{}");
    expect(ghost.content).toContain("unknown or disabled server");

    rawSqlite.prepare("UPDATE mcp_servers SET enabled = 0 WHERE id = 'f9'").run();
    const disabled = await runToolCall({ serverId: "f9", tool: "echo", title: "t", userId: "u-test" }, "{}");
    expect(disabled.ok).toBe(false);
  });

  it("handles tools with no description and missing content", async () => {
    addServerRow("fd", "https://x.test");
    setTransportFactory(fakeFactory());
    const ts = await buildToolset("u-test");
    const spec = ts.specs.find((s) => s.function.name === "mcp__fd__nodesc")!;
    expect(spec.function.description).toBe("fd: ");
    // Schema-less MCP tool: the SDK still emits a bare object schema.
    expect(spec.function.parameters).toMatchObject({ type: "object" });
    const out = await runToolCall({ serverId: "fd", tool: "empty", title: "t", userId: "u-test" }, "{}");
    expect(out.content).toContain("(empty)");
  });

  it("truncates long results at mcp.toolResultMaxChars", async () => {
    addServerRow("fb", "https://x.test");
    setTransportFactory(fakeFactory("big"));
    setSetting("mcp.toolResultMaxChars", "500");
    const out = await runToolCall({ serverId: "fb", tool: "big", title: "t", userId: "u-test" }, "{}");
    expect(out.ok).toBe(true);
    expect(out.content).toContain("[truncated]");
  });

  it("maps timeouts and aborts to error outcomes", async () => {
    addServerRow("ft", "https://x.test");
    setTransportFactory(fakeFactory());
    setSetting("mcp.toolTimeoutMs", "100");
    const slow = await runToolCall({ serverId: "ft", tool: "slow", title: "t", userId: "u-test" }, "{}");
    expect(slow.ok).toBe(false);
    const ac = new AbortController();
    ac.abort();
    const aborted = await runToolCall({ serverId: "ft", tool: "echo", title: "t", userId: "u-test" }, JSON.stringify({ value: "x" }), ac.signal);
    expect(aborted.ok).toBe(false);
  });

  it("surfaces non-Error throws", async () => {
    addServerRow("fs", "https://x.test");
    setTransportFactory(() => {
      throw "string-fail";
    });
    const out = await runToolCall({ serverId: "fs", tool: "echo", title: "t", userId: "u-test" }, "{}");
    expect(out.ok).toBe(false);
    expect(out.content).toContain("string-fail");
  });
});
