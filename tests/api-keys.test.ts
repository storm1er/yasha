import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { DELETE as keyDelete } from "@/app/api/api-keys/[id]/route";
import { GET as keysGet, POST as keysPost } from "@/app/api/api-keys/route";
import { GET as v1Models } from "@/app/v1/models/route";
import { API_KEY_PREFIX, MAX_ACTIVE_API_KEYS } from "@/lib/api-keys";
import { apiKeys } from "@/lib/db/schema";
import { callRoute, jsonOf, sessionId, signUp, type TestUser } from "./support/app";
import { db, rawSqlite } from "./support/db";

let user: TestUser & { userId: string };

beforeAll(async () => {
  user = Object.assign(await signUp("keys"), { userId: "" });
  user.userId = await sessionId(user.cookie);
});

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

async function createKey(name = "cli"): Promise<{ id: string; key: string }> {
  const res = await callRoute(keysPost, { cookie: user.cookie, json: { name } });
  expect(res.status).toBe(201);
  return (await jsonOf<{ id: string; key: string }>(res)) as { id: string; key: string };
}

describe("/api/api-keys", () => {
  it("requires a session", async () => {
    expect((await callRoute(keysGet)).status).toBe(401);
    expect((await callRoute(keysPost, { json: { name: "x" } })).status).toBe(401);
    expect((await callRoute(keyDelete, { method: "DELETE", path: "/x" }, ctxFor("x"))).status).toBe(401);
  });

  it("creates a key shown once, lists it masked", async () => {
    const badJson = await callRoute(keysPost, { cookie: user.cookie, body: "{" });
    expect(badJson.status).toBe(400);
    expect((await callRoute(keysPost, { cookie: user.cookie, json: { name: "  " } })).status).toBe(400);
    expect((await callRoute(keysPost, { cookie: user.cookie, json: { name: "n".repeat(51) } })).status).toBe(400);
    expect((await callRoute(keysPost, { cookie: user.cookie, json: {} })).status).toBe(400);

    const { id, key } = await createKey("laptop");
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(API_KEY_PREFIX.length + 32);

    const listed = await jsonOf<{ keys: { id: string; name: string; masked: string; revokedAt: string | null }[]; activeCount: number; maxActive: number }>(
      await callRoute(keysGet, { cookie: user.cookie })
    );
    const row = listed.keys.find((k) => k.id === id)!;
    expect(row.name).toBe("laptop");
    expect(row.masked).toBe(`****${key.slice(-4)}`);
    expect(row.revokedAt).toBeNull();
    expect(listed.activeCount).toBeGreaterThanOrEqual(1);
    expect(listed.maxActive).toBe(MAX_ACTIVE_API_KEYS);

    // only the SHA-256 digest is stored
    const stored = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()!;
    expect(stored.keyHash).not.toContain(key);
    expect(stored.keyHash).toHaveLength(64);
  });

  it("revokes once (DELETE), then 404", async () => {
    const { id, key } = await createKey("temp");
    const ok = await callRoute(keyDelete, { method: "DELETE", path: `/api/api-keys/${id}`, cookie: user.cookie }, ctxFor(id));
    expect(await jsonOf(ok)).toEqual({ ok: true });
    const again = await callRoute(keyDelete, { method: "DELETE", path: "/x", cookie: user.cookie }, ctxFor(id));
    expect(again.status).toBe(404);
    const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()!;
    expect(row.revokedAt).toBeTruthy();

    // revoked key cannot authenticate on /v1
    const res = await callRoute(v1Models, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(401);
  });

  it("enforces the active-key cap", async () => {
    const active = db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, user.userId))
      .all()
      .filter((k) => !k.revokedAt).length;
    for (let i = active; i < MAX_ACTIVE_API_KEYS; i++) await createKey(`cap-${i}`);
    const res = await callRoute(keysPost, { cookie: user.cookie, json: { name: "one-too-many" } });
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: "key_limit_reached", maxActive: MAX_ACTIVE_API_KEYS });

    // freeing one reopens the gate
    const some = db.select().from(apiKeys).where(eq(apiKeys.userId, user.userId)).all().find((k) => !k.revokedAt)!;
    await callRoute(keyDelete, { method: "DELETE", path: "/x", cookie: user.cookie }, ctxFor(some.id));
    expect((await createKey("after-free")).key.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it("lists in creation order", async () => {
    const listed = await jsonOf<{ keys: { createdAt: string; revokedAt: string | null }[] }>(
      await callRoute(keysGet, { cookie: user.cookie })
    );
    const dates = listed.keys.map((k) => Date.parse(k.createdAt));
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
    expect(listed.keys.some((k) => k.revokedAt)).toBe(true);
  });

  it("rethrows unexpected createKey failures", async () => {
    rawSqlite.exec("DROP TABLE api_keys");
    const call = callRoute(keysPost, { cookie: user.cookie, json: { name: "boom" } });
    await expect(call).rejects.toThrow();
  });
});
