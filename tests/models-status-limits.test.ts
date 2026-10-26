import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as attachmentLimits } from "@/app/api/attachment-limits/route";
import { GET as modelsRoute } from "@/app/api/models/route";
import { GET as modelsCatalogRoute } from "@/app/api/models/catalog/route";
import { GET as statusRoute } from "@/app/api/backend/status/route";
import { resetHealthProbes } from "@/lib/provider/health";
import { GET as healthRoute } from "@/app/api/health/route";
import { callRoute, jsonOf, signUp, type TestUser } from "./support/app";
import { json, mockLemonade, modelsResponse } from "./support/lemonade";
import { clearModels } from "./support/catalog";
import { db, setSetting } from "./support/db";
import { invalidateSettingsCache } from "@/lib/settings";
import { providers, settings } from "@/lib/db/schema";
import { seedProvidersFromEnv } from "@/lib/provider/registry";
import { sql } from "drizzle-orm";

let user: TestUser;

beforeAll(async () => {
  user = await signUp("models");
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

// The synced catalog persists across cases in this file — start each with an
// empty table so every /api/models call re-syncs from its own mock.
beforeEach(() => {
  clearModels();
});

function clearModelSettings() {
  db.delete(settings).where(sql`${settings.key} IN ('fast_model', 'smart_model')`).run();
  invalidateSettingsCache();
}

async function models() {
  const res = await callRoute(modelsRoute, { cookie: user.cookie });
  expect(res.status).toBe(200);
  return jsonOf<{ models: Record<string, unknown>[]; default: string | null; noVision: boolean }>(res);
}

describe("GET /api/models", () => {
  it("requires a session", async () => {
    expect((await callRoute(modelsRoute)).status).toBe(401);
  });

  it("empty when no model is configured", async () => {
    clearModelSettings();
    mockLemonade().route("/v1/models", modelsResponse([]));
    expect(await models()).toEqual({ models: [], default: null, noVision: false });
  });

  it("lists only vision-tagged models, dedupes identical ids, default = first pick", async () => {
    await vi.advanceTimersByTimeAsync(61_000); // bust the cache of the previous case
    const mock = mockLemonade();
    // NB: Response bodies are single-use → reply with a factory for repeated fetches
    mock.route("/v1/models", () => modelsResponse([
      { id: "fast-model.test", downloaded: true, vision: true },
      { id: "smart-model.test", downloaded: true },
      { id: "openrouter.free" },
      { id: "not-chat", labels: ["embedding"], downloaded: true },
      { id: "not-downloaded", downloaded: false },
    ]));
    setSetting("fast_model", "default:fast-model.test");
    setSetting("smart_model", "default:fast-model.test");
    const deduped = await models();
    expect(deduped.models).toEqual([
      { id: "default:fast-model.test", name: "fast-model.test", label: "fast", vision: true },
    ]);
    expect(deduped.default).toBe("default:fast-model.test");
    expect(deduped.noVision).toBe(false);

    await vi.advanceTimersByTimeAsync(61_000); // bust the 60s models cache
    setSetting("smart_model", "default:smart-model.test");
    const both = await models();
    // the non-vision smart entry is filtered out of the list entirely
    expect(both.models).toEqual([
      { id: "default:fast-model.test", name: "fast-model.test", label: "fast", vision: true },
    ]);
    expect(both.default).toBe("default:fast-model.test");
    expect(both.noVision).toBe(false);
    void mock;
  });

  it("warns with noVision when configured models carry no vision tag", async () => {
    await vi.advanceTimersByTimeAsync(61_000);
    mockLemonade().route("/v1/models", () => modelsResponse([
      { id: "fast-model.test", downloaded: true },
      { id: "smart-model.test", downloaded: true },
    ]));
    const body = await models();
    expect(body).toEqual({ models: [], default: null, noVision: true });
  });

  it("omits vision info (optimistic list) when upstream is down", async () => {
    await vi.advanceTimersByTimeAsync(61_000);
    const mock = mockLemonade();
    mock.route("/v1/models", json({ error: "boom" }, 500));
    const body = await models();
    expect(body.models.map((m) => m.id)).toEqual(["default:fast-model.test", "default:smart-model.test"]);
    expect("vision" in body.models[0]).toBe(false);
    expect(body.noVision).toBe(false);
    expect(body.default).toBe("default:fast-model.test");
  });

  it("concurrent callers share a single upstream fetch", async () => {
    await vi.advanceTimersByTimeAsync(61_000);
    const mock = mockLemonade();
    mock.route("/v1/models", modelsResponse([{ id: "fast-model.test", downloaded: true, vision: true }]));
    const [a, b] = await Promise.all([models(), models()]);
    expect(a.default).toBe("default:fast-model.test");
    expect(b.default).toBe("default:fast-model.test");
    expect(mock.calls.filter((c) => c.url.includes("/v1/models"))).toHaveLength(1);
  });
});

describe("GET /api/backend/status", () => {
  beforeEach(() => {
    resetHealthProbes();
  });

  it("requires a session", async () => {
    expect((await callRoute(statusRoute)).status).toBe(401);
  });

  it("reports per-provider health + auth header", async () => {
    db.update(providers).set({ apiKey: "test-key-123" }).run();
    try {
      const mock = mockLemonade();
      mock.route("/v1/health", json({ status: "ok" }));
      const body = await jsonOf<Record<string, unknown>>(await callRoute(statusRoute, { cookie: user.cookie }));
      expect(body).toEqual({
        ok: true,
        providers: [
          {
            id: "default",
            label: "Default backend",
            type: "lemonade",
            baseUrl: "http://lemonade.invalid.test",
            ok: true,
            status: 200,
          },
        ],
      });
      expect(mock.lastCall("/v1/health")!.headers.authorization).toBe("Bearer test-key-123");
    } finally {
      db.update(providers).set({ apiKey: null }).run();
    }
  });

  it("reports not-ok upstream without the key header", async () => {
    const mock = mockLemonade();
    mock.route("/v1/health", json({ status: "busy" }, 503));
    const body = await jsonOf<{ ok: boolean; providers: { ok: boolean; status: number }[] }>(
      await callRoute(statusRoute, { cookie: user.cookie })
    );
    expect(body).toEqual({ ok: false, providers: [{ ok: false, status: 503, id: "default", label: "Default backend", type: "lemonade", baseUrl: "http://lemonade.invalid.test" }] });
    expect(mock.lastCall("/v1/health")!.headers.authorization).toBeUndefined();
  });

  it("survives transport failure", async () => {
    const mock = mockLemonade();
    mock.route("/v1/health", () => {
      throw new Error("ECONNREFUSED");
    });
    const body = await jsonOf<{ ok: boolean; providers: Record<string, unknown>[] }>(
      await callRoute(statusRoute, { cookie: user.cookie })
    );
    expect(body).toMatchObject({ ok: false, providers: [{ baseUrl: "http://lemonade.invalid.test", ok: false, status: null }] });
  });

  it("empty state when no provider is configured", async () => {
    db.delete(providers).run();
    try {
      expect(await jsonOf(await callRoute(statusRoute, { cookie: user.cookie }))).toEqual({
        ok: false,
        providers: [],
      });
    } finally {
      seedProvidersFromEnv();
      resetHealthProbes();
    }
  });
});

describe("GET /api/health", () => {
  it("is a public liveness probe (no session) exposing no details", async () => {
    const res = await callRoute(healthRoute);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
  });
});

describe("GET /api/attachment-limits", () => {
  it("requires a session", async () => {
    expect((await callRoute(attachmentLimits)).status).toBe(401);
  });

  it("exposes effective caps", async () => {
    const body = await jsonOf<Record<string, number>>(await callRoute(attachmentLimits, { cookie: user.cookie }));
    expect(body).toEqual({ maxImagesPerMessage: 4, maxWindowImages: 8, maxUploadBytes: 20971520 });
    setSetting("chat.maxImagesPerMessage", "2");
    const updated = await jsonOf<Record<string, number>>(await callRoute(attachmentLimits, { cookie: user.cookie }));
    expect(updated.maxImagesPerMessage).toBe(2);
  });
});

describe("GET /api/models/catalog", () => {
  it("requires a session", async () => {
    expect((await callRoute(modelsCatalogRoute)).status).toBe(401);
  });

  it("lists every synced model under its canonical id (M2c)", async () => {
    mockLemonade().route("/v1/models", () =>
      modelsResponse([
        { id: "fast-model.test", vision: true },
        { id: "user.gemma-4-e4b-it-GGUF" }, // audio heuristic (M2b) auto-seeds audioInput
        { id: "not-chat", labels: ["embedding"] }, // excluded: no chat label
      ]),
    );
    const res = await callRoute(modelsCatalogRoute, { cookie: user.cookie });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ models: Record<string, unknown>[] }>(res);
    expect(body.models).toEqual([
      { id: "default:fast-model.test", name: "fast-model.test", providerId: "default", vision: true, audioInput: false },
      { id: "default:user.gemma-4-e4b-it-GGUF", name: "user.gemma-4-e4b-it-GGUF", providerId: "default", vision: false, audioInput: true },
    ]);
  });
});
