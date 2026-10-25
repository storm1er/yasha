import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as keysGet } from "@/app/api/api-keys/route";
import { DELETE as threadDelete } from "@/app/api/threads/[id]/route";
import { GET as statusRoute } from "@/app/api/backend/status/route";
import { createKey, listKeys, resolveKeyOwner, revokeKey } from "@/lib/api-keys";
import { userCount } from "@/lib/db";
import { apiKeys, providers, user as userTable } from "@/lib/db/schema";
import { seedProvidersFromEnv } from "@/lib/provider/registry";
import { resetHealthProbes } from "@/lib/provider/health";
import { adminUser, callRoute, jsonOf, type AdminUser } from "./support/app";
import { db } from "./support/db";

let admin: AdminUser;

beforeAll(async () => {
  admin = await adminUser();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The count lookups end in `get()?.value ?? 0` / `result.changes ?? 0`. SQL
// aggregates always return a row, so the right-hand side of `??` is reachable
// only when the query layer yields nothing — drive that with a scoped spy that
// blanks api_keys queries (every other table, incl. auth session lookups,
// keeps hitting the real database).
function blindApiKeysQueries(): void {
  type AnyDb = {
    select: (...args: unknown[]) => Record<string, unknown>;
    update: (table: unknown) => Record<string, unknown>;
  };
  const dbAny = db as unknown as AnyDb;
  const originalSelect = dbAny.select.bind(dbAny);
  const originalUpdate = dbAny.update.bind(dbAny);

  vi.spyOn(dbAny, "select").mockImplementation((fields?: unknown) => {
    const builder = originalSelect(fields);
    return new Proxy(builder, {
      get(target, prop) {
        if (prop === "from") {
          return (table: unknown) => {
            if (table === apiKeys) {
              return {
                where: () => ({
                  get: () => undefined,
                  orderBy: async () => [],
                  limit: async () => [],
                }),
              };
            }
            return (target as { from: (t: unknown) => unknown }).from(table);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  });

  vi.spyOn(dbAny, "update").mockImplementation((table) =>
    table === apiKeys
      ? { set: () => ({ where: () => ({ run: async () => ({}) }) }) }
      : originalUpdate(table)
  );
}

describe("api-keys empty-result fallbacks", () => {
  it("treats a missing count row as 0 (route GET + createKey)", async () => {
    blindApiKeysQueries();
    const res = await callRoute(keysGet, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await jsonOf<{ keys: unknown[]; activeCount: number }>(res)).toMatchObject({
      keys: [],
      activeCount: 0,
    });
    const created = await createKey(admin.userId, "blind-count");
    expect(created.key).toMatch(/^ysk_[0-9a-f]{32}$/);
    // spied update(): run() resolves without `changes` -> `?? 0` -> false
    expect(await revokeKey(created.id, admin.userId)).toBe(false);
  });
});

describe("lib/api-keys resolveKeyOwner + revokeKey misses", () => {
  it("lists active and revoked keys masked, in creation order", async () => {
    const active = await createKey(admin.userId, "list-a");
    const revoked = await createKey(admin.userId, "list-b");
    expect(await revokeKey(revoked.id, admin.userId)).toBe(true);
    const rows = await listKeys(admin.userId);
    const a = rows.find((r) => r.id === active.id)!;
    const b = rows.find((r) => r.id === revoked.id)!;
    expect(a.masked).toBe(`****${active.key.slice(-4)}`);
    expect(a.revokedAt).toBeNull();
    expect(b.masked).toBe(`****${revoked.key.slice(-4)}`);
    expect(b.revokedAt).toBeTruthy();
  });

  it("resolves active keys only", async () => {
    expect(await resolveKeyOwner("ysk_deadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
    const created = await createKey(admin.userId, "owner");
    expect(await resolveKeyOwner(created.key)).toBe(admin.userId);
    expect(await revokeKey(created.id, admin.userId)).toBe(true);
    expect(await resolveKeyOwner(created.key)).toBeNull();
  });

  it("revokeKey returns false for unknown ids (0 changes)", async () => {
    expect(await revokeKey("no-such-id", admin.userId)).toBe(false);
  });
});

describe("remaining single branches", () => {
  it("userCount falls back to 0 when the count row is missing", () => {
    type AnyDb = { select: (...args: unknown[]) => Record<string, unknown> };
    const dbAny = db as unknown as AnyDb;
    const originalSelect = dbAny.select.bind(dbAny);
    vi.spyOn(dbAny, "select").mockImplementation((fields?: unknown) => {
      const builder = originalSelect(fields);
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === "from") {
            return (table: unknown) => {
              if (table === userTable) return { get: () => undefined };
              return (target as { from: (t: unknown) => unknown }).from(table);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    });
    expect(userCount()).toBe(0);
  });

  it("DELETE /api/threads/[id] anonymous -> 404 (ownedThreadId null-user path)", async () => {
    const res = await callRoute(threadDelete, { method: "DELETE", path: "/api/threads/x" }, {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("backend status treats an empty providers table as unconfigured", async () => {
    db.delete(providers).run();
    resetHealthProbes();
    try {
      expect(await jsonOf(await callRoute(statusRoute, { cookie: admin.cookie }))).toEqual({ ok: false, providers: [] });
    } finally {
      seedProvidersFromEnv();
      resetHealthProbes();
    }
  });
});
