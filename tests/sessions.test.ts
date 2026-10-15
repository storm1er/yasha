// /api/me/sessions — list active sessions (last-used, current flag), revoke
// one / all others; + the auth-time activity bump on the session row.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureReady, rawSqlite } from "@/lib/db";
import { session } from "@/lib/db/schema";
import { callRoute, jsonOf, signUp } from "./support/app";
import { GET, POST } from "@/app/api/me/sessions/route";

type SessionView = {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
};

beforeAll(async () => {
  await ensureReady();
});

function insertSession(userId: string, over: Partial<typeof session.$inferInsert> = {}): string {
  const id = crypto.randomUUID();
  const now = new Date();
  db.insert(session)
    .values({
      id,
      token: `tok-${id}`,
      userId,
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      userAgent: "FakeDroid/1.0",
      ipAddress: "198.51.100.2",
      createdAt: new Date(now.getTime() - 3_600_000),
      updatedAt: new Date(now.getTime() - 3_600_000),
      ...over,
    })
    .run();
  return id;
}

async function list(cookie: string): Promise<SessionView[]> {
  const res = await callRoute(GET, { cookie });
  expect(res.status).toBe(200);
  return (await jsonOf<{ sessions: SessionView[] }>(res)).sessions;
}

function ownerOf(sessionId: string): string {
  const row = rawSqlite
    .prepare("SELECT user_id AS u FROM session WHERE id = ?")
    .get(sessionId) as { u: string };
  return row.u;
}

describe("GET /api/me/sessions", () => {
  it("requires a session", async () => {
    expect((await callRoute(GET)).status).toBe(401);
    expect((await callRoute(POST, { json: { action: "revokeOthers" } })).status).toBe(401);
  });

  it("lists active sessions newest-first, current flagged, expired hidden", async () => {
    const cookie = (await signUp("sesslist")).cookie;
    const mine = await list(cookie);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.current).toBe(true);
    expect(mine[0]!.lastUsedAt).toBeTruthy();
    const uid = ownerOf(mine[0]!.id);

    const other = insertSession(uid, { userAgent: "FakeDroid/1.0" });
    insertSession(uid, { expiresAt: new Date(Date.now() - 1000) }); // expired → hidden
    const rows = await list(cookie);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.current)).toEqual([true, false]);
    expect(rows[1]!.id).toBe(other);
    expect(rows[1]!.userAgent).toBe("FakeDroid/1.0");
    expect(rows[1]!.ipAddress).toBe("198.51.100.2");
  });

  it("bumps the current session's last-used on authenticated calls (throttled)", async () => {
    const cookie = (await signUp("sessbump")).cookie;
    vi.useFakeTimers();
    try {
      const T0 = Date.now();
      const me = (await list(cookie))[0]!; // first authenticated read → bump
      const readBump = () =>
        (rawSqlite.prepare("SELECT updated_at AS a FROM session WHERE id = ?").get(me.id) as { a: number }).a;
      expect(readBump()).toBe(T0);

      vi.setSystemTime(T0 + 30_000);
      await list(cookie); // within the 60 s throttle window → no re-bump
      expect(readBump()).toBe(T0);

      vi.setSystemTime(T0 + 91_000);
      await list(cookie); // past the window → bump lands again
      expect(readBump()).toBe(T0 + 91_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/me/sessions", () => {
  it("rejects malformed payloads", async () => {
    const cookie = (await signUp("sessbad")).cookie;
    const badJson = await callRoute(POST, { cookie, body: "not-json", headers: { "content-type": "application/json" } });
    expect(badJson.status).toBe(400);
    expect((await callRoute(POST, { cookie, json: { action: "nope" } })).status).toBe(400);
    expect((await callRoute(POST, { cookie, json: { action: "revoke" } })).status).toBe(400);
    expect((await callRoute(POST, { cookie, json: { action: "revoke", sessionId: "" } })).status).toBe(400);
  });

  it("revoke: current → 400, foreign/unknown → 404, own other session → gone", async () => {
    const cookie = (await signUp("sessrev")).cookie;
    const rows = await list(cookie);
    const currentId = rows.find((r) => r.current)!.id;
    const uid = ownerOf(currentId);
    expect((await callRoute(POST, { cookie, json: { action: "revoke", sessionId: currentId } })).status).toBe(400);

    const other = insertSession(uid);
    const foreignCookie = (await signUp("sessforeign")).cookie;
    const foreignId = insertSession(ownerOf((await list(foreignCookie))[0]!.id));
    expect((await callRoute(POST, { cookie, json: { action: "revoke", sessionId: "nope" } })).status).toBe(404);
    expect((await callRoute(POST, { cookie, json: { action: "revoke", sessionId: foreignId } })).status).toBe(404);

    const ok = await callRoute(POST, { cookie, json: { action: "revoke", sessionId: other } });
    expect(ok.status).toBe(200);
    expect((await jsonOf<{ revoked: number }>(ok)).revoked).toBe(1);
    expect((await list(cookie)).some((r) => r.id === other)).toBe(false);
  });

  it("revokeOthers removes everything but the current session (idempotent)", async () => {
    const cookie = (await signUp("sessothers")).cookie;
    const rows = await list(cookie);
    const uid = ownerOf(rows.find((r) => r.current)!.id);
    const currentId = rows.find((r) => r.current)!.id;
    insertSession(uid);
    insertSession(uid);
    const res = await callRoute(POST, { cookie, json: { action: "revokeOthers" } });
    expect((await jsonOf<{ revoked: number }>(res)).revoked).toBe(2);
    const after = await list(cookie);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(currentId);
    const again = await callRoute(POST, { cookie, json: { action: "revokeOthers" } });
    expect((await jsonOf<{ revoked: number }>(again)).revoked).toBe(0);
  });
});
