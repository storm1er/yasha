// M3 API surface: backend status (multi-provider health, Q19/Q23), provider
// CRUD + masking, catalog capability overrides (Q14) and the ?provider=
// control-plane selection (Q10).

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as backendStatus } from "@/app/api/backend/status/route";
import { GET as providersGet, POST as providersPost } from "@/app/api/backend/providers/route";
import { DELETE as providerDelete, PATCH as providerPatch } from "@/app/api/backend/providers/[id]/route";
import { GET as backendModelsGet } from "@/app/api/backend/models/route";
import { PATCH as modelPatch } from "@/app/api/backend/models/[id]/route";
import { GET as adminModels } from "@/app/api/admin/models/route";
import { GET as adminRegistry } from "@/app/api/admin/registry/route";
import { adminUser, callRoute, jsonOf, signUp, type AdminUser, type RouteHandler, type TestUser } from "./support/app";
import { eq } from "drizzle-orm";
import { db } from "./support/db";
import { json, mockLemonade, modelsResponse, type LemonadeMock } from "./support/lemonade";
import { models, providers, type Provider } from "@/lib/db/schema";
import { resetHealthProbes } from "@/lib/provider/health";

let admin: AdminUser;
let user: TestUser;
let mock: LemonadeMock;

function insertProvider(id: string, over: Partial<Provider> = {}): void {
  const now = new Date();
  db.insert(providers)
    .values({
      id,
      type: "openai_compatible",
      label: `Provider ${id}`,
      baseUrl: `http://${id}.invalid.test`,
      apiKey: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run();
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  admin = await adminUser();
  user = await signUp("backend_admin");
});

beforeEach(() => {
  mock = mockLemonade();
  resetHealthProbes();
  db.delete(models).run();
  db.delete(providers).run();
  insertProvider("default", { type: "lemonade", label: "Default backend", baseUrl: "http://lemonade.invalid.test" });
});

describe("GET /api/backend/status — multi-provider aggregation (Q19/Q23)", () => {
  it("401 without a session", async () => {
    expect((await callRoute(backendStatus)).status).toBe(401);
  });

  it("probes each type on its own path and aggregates the worst status", async () => {
    insertProvider("compat");
    let modelsFail = false; // mock route table is first-match-wins
    mock.route("/v1/health", () => json({ status: "ok" }));
    mock.route("/v1/models", () => (modelsFail ? json({}, 500) : modelsResponse([{ id: "m" }])));
    const body = await jsonOf<{ ok: boolean; providers: Record<string, unknown>[] }>(
      await callRoute(backendStatus, { cookie: user.cookie })
    );
    expect(body.ok).toBe(true);
    expect(body.providers.map((p) => p.id)).toEqual(["default", "compat"]);
    // lemonade probed /v1/health; openai_compatible probed /v1/models
    expect(mock.calls.filter((c) => c.url.includes("/v1/health"))).toHaveLength(1);
    expect(mock.calls.filter((c) => c.url.includes("/v1/models"))).toHaveLength(1);

    modelsFail = true;
    resetHealthProbes();
    const down = await jsonOf<{ ok: boolean; providers: { id: string; ok: boolean; status: number }[] }>(
      await callRoute(backendStatus, { cookie: user.cookie })
    );
    expect(down.ok).toBe(false);
    expect(down.providers.find((p) => p.id === "compat")).toMatchObject({ ok: false, status: 500 });
  });

  it("caches probes until the TTL expires", async () => {
    mock.route("/v1/health", () => json({ status: "ok" }));
    await callRoute(backendStatus, { cookie: user.cookie });
    await callRoute(backendStatus, { cookie: user.cookie });
    expect(mock.calls.filter((c) => c.url.includes("/v1/health"))).toHaveLength(1);
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      await callRoute(backendStatus, { cookie: user.cookie });
      expect(mock.calls.filter((c) => c.url.includes("/v1/health"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/api/backend/providers — list + create", () => {
  it("401 anon, 403 non-admin on both verbs", async () => {
    expect((await callRoute(providersGet)).status).toBe(401);
    expect((await callRoute(providersGet, { cookie: user.cookie })).status).toBe(403);
    expect((await callRoute(providersPost, { cookie: user.cookie, json: {} })).status).toBe(403);
  });

  it("lists rows with the secret masked as hasKey", async () => {
    db.update(providers).set({ apiKey: "sk-secret" }).where(eq(providers.id, "default")).run();
    const body = await jsonOf<{ providers: Record<string, unknown>[] }>(
      await callRoute(providersGet, { cookie: admin.cookie })
    );
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({ id: "default", type: "lemonade", hasKey: true });
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });

  it("rejects malformed bodies and fields", async () => {
    const bad = (body: unknown) => callRoute(providersPost, { cookie: admin.cookie, json: body });
    expect(((await jsonOf(await bad([1, 2]))) as { detail: string }).detail).toBe("body_not_object");
    const raw = await callRoute(providersPost, {
      cookie: admin.cookie,
      body: "{oops",
      headers: { "content-type": "application/json" },
    });
    expect(((await jsonOf(raw)) as { detail: string }).detail).toBe("invalid_json");
    const base = { type: "openai_compatible", label: "X", baseUrl: "http://x.test" };
    expect(((await jsonOf(await bad({ ...base, id: "has space" }))) as { detail: string }).detail).toBe("invalid_id");
    expect(((await jsonOf(await bad({ ...base, id: "x", type: "carrier_pigeon" }))) as { detail: string }).detail).toBe("invalid_type");
    expect(((await jsonOf(await bad({ ...base, id: "x", type: "lemonade", label: "  " }))) as { detail: string }).detail).toBe("invalid_label");
    expect(((await jsonOf(await bad({ ...base, id: "x", baseUrl: "ftp://x.test" }))) as { detail: string }).detail).toBe("invalid_base_url");
    expect(((await jsonOf(await bad({ ...base, id: "x", baseUrl: 42 }))) as { detail: string }).detail).toBe("invalid_base_url");
    expect(((await jsonOf(await bad({ ...base, id: "x", baseUrl: "   " }))) as { detail: string }).detail).toBe("invalid_base_url");
    expect(((await jsonOf(await bad({ ...base, id: "x", baseUrl: `http://x.test/${"p".repeat(250)}` }))) as { detail: string }).detail).toBe("invalid_base_url");
    expect(((await jsonOf(await bad({ ...base, id: "x", baseUrl: "http://x.test/?a=1" }))) as { detail: string }).detail).toBe("invalid_base_url");
    expect(((await jsonOf(await bad({ ...base, id: "x", baseUrl: "http://x.test/#frag" }))) as { detail: string }).detail).toBe("invalid_base_url");
    expect(((await jsonOf(await bad({ ...base, id: "x", apiKey: 42 }))) as { detail: string }).detail).toBe("invalid_api_key");
    expect(((await jsonOf(await bad({ ...base, id: "x", enabled: "yes" }))) as { detail: string }).detail).toBe("invalid_enabled");
  });

  it("409 on duplicate id, 201 with trimmed values + defaults", async () => {
    const dup = await callRoute(providersPost, {
      cookie: admin.cookie,
      json: { id: "default", type: "lemonade", label: "X", baseUrl: "http://x.test/" },
    });
    expect(dup.status).toBe(409);
    const created = await callRoute(providersPost, {
      cookie: admin.cookie,
      json: { id: "compat2", type: "openai_compatible", label: " Compat 2 ", baseUrl: "http://compat2.test/v1/ ", apiKey: " sk-1 ", enabled: false },
    });
    expect(created.status).toBe(201);
    const body = await jsonOf<{ provider: Record<string, unknown> }>(created);
    expect(body.provider).toMatchObject({ id: "compat2", label: "Compat 2", baseUrl: "http://compat2.test/v1", hasKey: true, enabled: false });
    const bare = await callRoute(providersPost, {
      cookie: admin.cookie,
      json: { id: "compat3", type: "openai_compatible", label: "Compat 3", baseUrl: "http://compat3.test" },
    });
    expect((await jsonOf<{ provider: Record<string, unknown> }>(bare)).provider).toMatchObject({ enabled: true, hasKey: false });
  });
});

describe("/api/backend/providers/[id] — patch + delete", () => {
  const patch = (id: string, jsonBody: unknown, cookie = admin.cookie) =>
    callRoute(providerPatch as RouteHandler, { method: "PATCH", cookie, json: jsonBody }, ctx(id));

  it("401/403/404 arms", async () => {
    expect((await callRoute(providerDelete as RouteHandler, { method: "DELETE" }, ctx("default"))).status).toBe(401);
    expect((await patch("default", { label: "X" }, user.cookie)).status).toBe(403);
    expect((await patch("nope", { label: "X" })).status).toBe(404);
    expect((await callRoute(providerDelete as RouteHandler, { method: "DELETE", cookie: admin.cookie }, ctx("nope"))).status).toBe(404);
  });

  it("rejects malformed bodies and values, keeps rows untouched", async () => {
    expect(((await jsonOf(await patch("default", [1])))).detail).toBe("body_not_object");
    const raw = await callRoute(
      providerPatch as RouteHandler,
      { method: "PATCH", cookie: admin.cookie, body: "nope", headers: { "content-type": "application/json" } },
      ctx("default")
    );
    expect(((await jsonOf(raw)) as { detail: string }).detail).toBe("invalid_json");
    expect(((await jsonOf(await patch("default", {}))).detail)).toBe("empty_patch");
    expect(((await jsonOf(await patch("default", { label: "" }))).detail)).toBe("invalid_label");
    expect(((await jsonOf(await patch("default", { type: "carrier_pigeon" }))).detail)).toBe("invalid_type");
    expect(((await jsonOf(await patch("default", { baseUrl: "not a url" }))).detail)).toBe("invalid_base_url");
    expect(((await jsonOf(await patch("default", { apiKey: {} }))).detail)).toBe("invalid_api_key");
    expect(((await jsonOf(await patch("default", { enabled: 1 }))).detail)).toBe("invalid_enabled");
    expect(db.select().from(providers).where(eq(providers.id, "default")).get()!.label).toBe("Default backend");
  });

  it("label-only patch keeps catalog rows; endpoint changes drop them (re-sync)", async () => {
    db.insert(models).values({ id: "default:m", providerId: "default", remoteId: "m", vision: null, audioInput: null, hidden: false, lastSyncedAt: new Date() }).run();

    const renamed = await patch("default", { label: "Primary GPU box" });
    expect((await jsonOf<{ provider: { label: string } }>(renamed)).provider.label).toBe("Primary GPU box");
    expect(db.select().from(models).all()).toHaveLength(1); // metadata-only: rows kept

    const moved = await patch("default", { baseUrl: "http://lemonade2.invalid.test" });
    expect((await jsonOf<{ provider: { baseUrl: string } }>(moved)).provider.baseUrl).toBe("http://lemonade2.invalid.test");
    expect(db.select().from(models).all()).toHaveLength(0); // material → re-sync on next read
  });

  it("apiKey patch is material; null clears it; setting null on a keyless row is not", async () => {
    db.insert(models).values({ id: "default:m", providerId: "default", remoteId: "m", vision: null, audioInput: null, hidden: false, lastSyncedAt: new Date() }).run();
    const set = await patch("default", { apiKey: "sk-abc" });
    expect((await jsonOf<{ provider: { hasKey: boolean } }>(set)).provider.hasKey).toBe(true);
    expect(db.select().from(models).all()).toHaveLength(0); // material

    const keepNull = await patch("default", { apiKey: null });
    expect((await jsonOf<{ provider: { hasKey: boolean } }>(keepNull)).provider.hasKey).toBe(false);

    const keyless = await patch("default", { apiKey: null }); // still null → metadata-only
    expect(keyless.status).toBe(200);
  });

  it("type flip is material and rebuilds the adapter", async () => {
    db.insert(models).values({ id: "default:m", providerId: "default", remoteId: "m", vision: null, audioInput: null, hidden: false, lastSyncedAt: new Date() }).run();
    const res = await patch("default", { type: "openai_compatible" });
    expect((await jsonOf<{ provider: { type: string } }>(res)).provider.type).toBe("openai_compatible");
    expect(db.select().from(models).all()).toHaveLength(0);
  });

  it("enabled toggle is metadata-only; blank apiKey stores null", async () => {
    db.insert(models).values({ id: "default:m", providerId: "default", remoteId: "m", vision: null, audioInput: null, hidden: false, lastSyncedAt: new Date() }).run();
    const off = await patch("default", { enabled: false });
    expect((await jsonOf<{ provider: { enabled: boolean } }>(off)).provider.enabled).toBe(false);
    expect(db.select().from(models).all()).toHaveLength(1); // metadata-only

    db.update(providers).set({ apiKey: "sk-keep" }).where(eq(providers.id, "default")).run();
    const blank = await patch("default", { apiKey: "   " });
    expect((await jsonOf<{ provider: { hasKey: boolean } }>(blank)).provider.hasKey).toBe(false);
  });

  it("delete cascades catalog rows", async () => {
    insertProvider("compat");
    db.insert(models).values({ id: "compat:m", providerId: "compat", remoteId: "m", vision: null, audioInput: null, hidden: false, lastSyncedAt: new Date() }).run();
    const res = await callRoute(providerDelete as RouteHandler, { method: "DELETE", cookie: admin.cookie }, ctx("compat"));
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect(db.select().from(models).all()).toHaveLength(0);
  });
});

describe("/api/backend/models — table + overrides (Q14)", () => {
  it("401/403 on list and override", async () => {
    expect((await callRoute(backendModelsGet)).status).toBe(401);
    expect((await callRoute(backendModelsGet, { cookie: user.cookie })).status).toBe(403);
    expect((await callRoute(modelPatch as RouteHandler, { method: "PATCH", cookie: user.cookie, json: { hidden: true } }, ctx("m"))).status).toBe(403);
  });

  it("lists synced rows joined with the provider label", async () => {
    db.insert(models).values({ id: "default:m", providerId: "default", remoteId: "m", vision: true, audioInput: null, hidden: false, lastSyncedAt: new Date(1700000000000) }).run();
    db.insert(models).values({ id: "default:never", providerId: "default", remoteId: "never", vision: null, audioInput: null, hidden: false, lastSyncedAt: null }).run();
    const body = await jsonOf<{ models: Record<string, unknown>[] }>(await callRoute(backendModelsGet, { cookie: admin.cookie }));
    expect(body.models).toEqual([
      { id: "default:m", providerId: "default", providerLabel: "Default backend", remoteId: "m", vision: true, audioInput: null, hidden: false, lastSyncedAt: 1700000000000 },
      { id: "default:never", providerId: "default", providerLabel: "Default backend", remoteId: "never", vision: null, audioInput: null, hidden: false, lastSyncedAt: null },
    ]);
  });

  it("overrides flags; rejects garbage and unknown ids", async () => {
    db.insert(models).values({ id: "default:m", providerId: "default", remoteId: "m", vision: false, audioInput: false, hidden: false, lastSyncedAt: null }).run();
    const patch = (jsonBody: unknown) => callRoute(modelPatch as RouteHandler, { method: "PATCH", cookie: admin.cookie, json: jsonBody }, ctx("default:m"));
    expect(((await jsonOf(await patch({}))).detail)).toBe("empty_patch");
    expect(((await jsonOf(await patch({ vision: "yes" }))).detail)).toBe("invalid_vision");
    expect(((await jsonOf(await patch({ audioInput: 1 }))).detail)).toBe("invalid_audioInput");
    expect(((await jsonOf(await callRoute(modelPatch as RouteHandler, { method: "PATCH", cookie: admin.cookie, json: [1] }, ctx("default:m")))).detail)).toBe("body_not_object");
    const raw = await callRoute(modelPatch as RouteHandler, { method: "PATCH", cookie: admin.cookie, body: "x", headers: { "content-type": "application/json" } }, ctx("default:m"));
    expect(((await jsonOf(raw)) as { detail: string }).detail).toBe("invalid_json");
    const ghost = await callRoute(modelPatch as RouteHandler, { method: "PATCH", cookie: admin.cookie, json: { hidden: true } }, ctx("nope:m"));
    expect(ghost.status).toBe(404);

    const ok = await patch({ vision: true, audioInput: true, hidden: true });
    expect(ok.status).toBe(200);
    const row = db.select().from(models).where(eq(models.id, "default:m")).get()!;
    expect({ vision: row.vision, audioInput: row.audioInput, hidden: row.hidden }).toEqual({ vision: true, audioInput: true, hidden: true });
  });
});

describe("?provider= control-plane selection (Q10)", () => {
  beforeEach(() => {
    insertProvider("compat");
  });

  it("unknown id → 404; plain provider → 501; lemonade id → its control plane", async () => {
    const unknown = await callRoute(adminModels as RouteHandler, { query: { provider: "nope" }, cookie: admin.cookie });
    expect(unknown.status).toBe(404);
    expect(await jsonOf(unknown)).toEqual({ error: "provider_not_found" });

    // direct-lookup routes map through controlPlaneErrorResponse too
    const registry404 = await callRoute(adminRegistry as RouteHandler, { query: { provider: "nope", q: "x" }, cookie: admin.cookie });
    expect(registry404.status).toBe(404);
    const registry501 = await callRoute(adminRegistry as RouteHandler, { query: { provider: "compat", q: "x" }, cookie: admin.cookie });
    expect(registry501.status).toBe(501);

    const plain = await callRoute(adminModels as RouteHandler, { query: { provider: "compat" }, cookie: admin.cookie });
    expect(plain.status).toBe(501);

    mock.route("/v1/models", () => json({ data: [{ id: "m", recipe: "llamacpp", downloaded: true, labels: ["chat"] }] }));
    const hit = await callRoute(adminModels as RouteHandler, { query: { provider: "default" }, cookie: admin.cookie });
    expect(hit.status).toBe(200);
    const body = await jsonOf<{ models: { id: string }[] }>(hit);
    expect(body.models[0]!.id).toBe("m");
  });
});

