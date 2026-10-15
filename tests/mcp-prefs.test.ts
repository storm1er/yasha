import { beforeAll, describe, expect, it } from "vitest";
import * as mcpPrefsRoute from "@/app/api/mcp/prefs/route";
import { ensureReady } from "@/lib/db";
import { userSettings } from "@/lib/db/schema";
import { db, setSetting } from "./support/db";
import { callRoute, jsonOf, sessionId, signUp, type TestUser } from "./support/app";
import { USER_MCP_KEY, getUserMcpEnabled, getUserMcpOverride, setUserMcpEnabled } from "@/lib/mcp/prefs";

let user: TestUser;
let userId: string;

beforeAll(async () => {
  await ensureReady();
  user = await signUp("t3_mcpprefs");
  userId = await sessionId(user.cookie);
});

describe("lib/mcp/prefs", () => {
  it("override round-trips true/false and delete, garbage ignored", () => {
    expect(getUserMcpOverride(userId)).toBeUndefined();
    setUserMcpEnabled(userId, true);
    setUserMcpEnabled(userId, false); // update branch
    expect(getUserMcpOverride(userId)).toBe(false);
    setUserMcpEnabled(userId, null); // delete branch
    expect(getUserMcpOverride(userId)).toBeUndefined();
    db.insert(userSettings).values({ userId, key: USER_MCP_KEY, value: " TRUE ", updatedAt: new Date() }).run();
    expect(getUserMcpOverride(userId)).toBe(true);
    db.delete(userSettings).run();
    db.insert(userSettings).values({ userId, key: USER_MCP_KEY, value: "maybe", updatedAt: new Date() }).run();
    expect(getUserMcpOverride(userId)).toBeUndefined();
    db.delete(userSettings).run();
  });

  it("effective value falls back to the mcp.enabled instance default", () => {
    setSetting("mcp.enabled", "true");
    expect(getUserMcpEnabled(userId)).toBe(true);
    setUserMcpEnabled(userId, false);
    expect(getUserMcpEnabled(userId)).toBe(false);
    setSetting("mcp.enabled", "false");
    setUserMcpEnabled(userId, null);
    expect(getUserMcpEnabled(userId)).toBe(false);
    setUserMcpEnabled(userId, true); // personal override beats a disabled instance
    expect(getUserMcpEnabled(userId)).toBe(true);
    setUserMcpEnabled(userId, null);
    setSetting("mcp.enabled", "true");
    db.delete(userSettings).run();
  });
});

describe("GET/POST /api/mcp/prefs", () => {
  it("requires a session on both verbs", async () => {
    expect((await callRoute(mcpPrefsRoute.GET, { path: "/p" })).status).toBe(401);
    expect((await callRoute(mcpPrefsRoute.POST, { method: "POST", path: "/p", json: { userEnabled: true } })).status).toBe(401);
  });

  it("validates payload and round-trips tri-state", async () => {
    let res = await callRoute(mcpPrefsRoute.GET, { path: "/p", cookie: user.cookie });
    expect(await jsonOf(res)).toEqual({ userEnabled: null, instanceEnabled: true });

    res = await callRoute(mcpPrefsRoute.POST, { method: "POST", path: "/p", cookie: user.cookie, body: "[" });
    expect((await jsonOf(res)).error).toBe("invalid_json");
    res = await callRoute(mcpPrefsRoute.POST, { method: "POST", path: "/p", cookie: user.cookie, json: 5 });
    expect((await jsonOf(res)).error).toBe("invalid_payload");
    res = await callRoute(mcpPrefsRoute.POST, { method: "POST", path: "/p", cookie: user.cookie, json: {} });
    expect((await jsonOf(res)).error).toBe("invalid_payload");
    res = await callRoute(mcpPrefsRoute.POST, { method: "POST", path: "/p", cookie: user.cookie, json: { userEnabled: "yes" } });
    expect(res.status).toBe(400);

    res = await callRoute(mcpPrefsRoute.POST, { method: "POST", path: "/p", cookie: user.cookie, json: { userEnabled: false } });
    expect(await jsonOf(res)).toEqual({ ok: true, userEnabled: false });
    res = await callRoute(mcpPrefsRoute.POST, { method: "POST", path: "/p", cookie: user.cookie, json: { userEnabled: null } });
    expect(await jsonOf(res)).toEqual({ ok: true, userEnabled: null });

    setSetting("mcp.enabled", "false");
    res = await callRoute(mcpPrefsRoute.GET, { path: "/p", cookie: user.cookie });
    expect(await jsonOf(res)).toEqual({ userEnabled: null, instanceEnabled: false });
  });
});
