import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ensureReady } from "@/lib/db";
import { models as modelsTable, providers, type ProviderType } from "@/lib/db/schema";
import { LemonadeProvider } from "@/lib/provider/lemonade";
import {
  chatProviders,
  controlPlaneForAdmin,
  resetProviderInstances,
  seedProvidersFromEnv,
} from "@/lib/provider/registry";
import { forEachSseData } from "@/lib/provider/http";
import { db } from "./support/db";
import { json } from "./support/lemonade";

const URL_BASE = "http://lmtd.example";
const modelsJson = (data: unknown) => json({ data });

const MODELS_PAYLOAD = {
  data: [
    null,
    7,
    { id: "", labels: ["chat"] },
    { id: "no-labels" },
    { id: "embed-only", labels: ["embeddings"] },
    { id: "not-downloaded", labels: ["chat"] },
    { id: "openrouter/llama", labels: ["chat"] },
    { id: "vision-model", labels: ["chat", "vision"], downloaded: true },
    { id: "chat-ok", labels: ["chat"], downloaded: true },
  ],
};

function insertProvider(id: string, type: ProviderType, baseUrl = URL_BASE) {
  const now = new Date();
  db.insert(providers)
    .values({ id, type, label: id, baseUrl, apiKey: null, enabled: true, createdAt: now, updatedAt: now })
    .run();
}

beforeAll(async () => {
  await ensureReady();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetProviderInstances();
  db.delete(providers).run(); // cascades to models rows
  db.delete(modelsTable).run();
});

describe("LemonadeProvider.listChatModels (per-instance cache)", () => {
  it("filters entries to chat-capable and maps providerId/vision/audioInput", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return modelsJson((MODELS_PAYLOAD.data as unknown[]).slice());
      })
    );
    const provider = new LemonadeProvider("p", `${URL_BASE}/`, null);
    const models = await provider.listChatModels();
    expect(calls[0]).toBe(`${URL_BASE}//v1/models`); // raw baseUrl: trailing-slash trim happens at seeding
    expect(models).toEqual([
      { id: "openrouter/llama", providerId: "p", vision: false, audioInput: false },
      { id: "vision-model", providerId: "p", vision: true, audioInput: false },
      { id: "chat-ok", providerId: "p", vision: false, audioInput: false },
    ]);
    // second call → cache hit, no new fetch
    const again = await provider.listChatModels();
    expect(calls.length).toBe(1);
    expect(again).toBe(models);
  });

  it("upstream failure not cached; data absent → empty list; expiry refetches", async () => {
    vi.useFakeTimers();
    const provider = new LemonadeProvider("p", URL_BASE, null);
    let mode = "fail";
    vi.stubGlobal("fetch", vi.fn(async () =>
      mode === "fail"
        ? new Response("x", { status: 503 })
        : mode === "empty"
          ? new Response(JSON.stringify({}), { status: 200 })
          : new Response(JSON.stringify({ data: [{ id: "late", labels: ["chat"], downloaded: true }] }), { status: 200 })
    ));
    await expect(provider.listChatModels()).rejects.toThrow("upstream_models_status_503"); // not cached
    mode = "empty";
    expect(await provider.listChatModels()).toEqual([]);
    vi.setSystemTime(Date.now() + 61_000);
    mode = "ok";
    expect((await provider.listChatModels()).map((m) => m.id)).toEqual(["late"]);
    vi.useRealTimers();
  });

  it("concurrent callers share the in-flight fetch; expiry refetches", async () => {
    vi.useFakeTimers();
    const provider = new LemonadeProvider("p", URL_BASE, null);
    let hits = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", vi.fn(async () => {
      hits += 1;
      await gate;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const p1 = provider.listChatModels();
    const p2 = provider.listChatModels();
    expect(hits).toBe(1); // shared in-flight fetch
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(hits).toBe(1);
    expect(a).toBe(b);
    vi.setSystemTime(Date.now() + 61_000); // cache TTL expired
    await expect(provider.listChatModels()).resolves.toEqual(a);
    expect(hits).toBe(2);
    vi.useRealTimers();
  });
});

describe("seedProvidersFromEnv", () => {
  afterEach(() => {
    process.env.BACKEND_BASE_URL = "http://lemonade.invalid.test";
    delete process.env.BACKEND_TYPE;
    delete process.env.BACKEND_API_KEY;
  });

  it("seeds nothing without BACKEND_BASE_URL, and never when the table already has rows", () => {
    delete process.env.BACKEND_BASE_URL;
    seedProvidersFromEnv();
    expect(db.select().from(providers).all()).toEqual([]);

    process.env.BACKEND_BASE_URL = "http://a.example/"; // trailing slash trimmed
    seedProvidersFromEnv();
    const [row] = db.select().from(providers).all();
    expect(row).toMatchObject({ id: "default", type: "lemonade", baseUrl: "http://a.example", enabled: true });

    // table non-empty → env is NOT re-applied (Q5)
    db.delete(providers).run();
    db.insert(providers)
      .values({
        id: "existing", type: "openai_compatible", label: "kept", baseUrl: "http://b.example",
        apiKey: null, enabled: true, createdAt: new Date(), updatedAt: new Date(),
      })
      .run();
    seedProvidersFromEnv();
    const rows = db.select().from(providers).all();
    expect(rows.map((r) => r.id)).toEqual(["existing"]);
  });

  it("honors BACKEND_TYPE=openai_compatible and trims BACKEND_API_KEY", () => {
    process.env.BACKEND_TYPE = "openai_compatible";
    process.env.BACKEND_API_KEY = "  secret-k  ";
    seedProvidersFromEnv();
    const [row] = db.select().from(providers).all();
    expect(row?.type).toBe("openai_compatible");
    expect(row?.apiKey).toBe("secret-k");
  });
});

describe("registry: instance cache, catalog merge, routing", () => {
  it("wires every provider type and rebuilds instances on row change", () => {
    insertProvider("lemon", "lemonade");
    insertProvider("compat", "openai_compatible");
    const first = chatProviders();
    expect(first.map((p) => p.id)).toEqual(["lemon", "compat"]);
    expect(first.map((p) => p.type)).toEqual(["lemonade", "openai_compatible"]);
    expect(chatProviders()[0]).toBe(first[0]); // instance cache hit

    db.update(providers).set({ baseUrl: "http://moved.example" }).where(eq(providers.id, "lemon")).run();
    const after = chatProviders();
    expect(after[0]).not.toBe(first[0]); // row changed → fresh instance
    expect(after[0].baseUrl).toBe("http://moved.example");
  });

  it("controlPlaneForAdmin: ok / 501 without plane / 503 without backend", () => {
    expect(controlPlaneForAdmin()).toEqual({ ok: false, error: "no_backend" });
    insertProvider("compat", "openai_compatible");
    expect(controlPlaneForAdmin()).toEqual({ ok: false, error: "provider_lacks_control_plane" });
    insertProvider("lemon", "lemonade");
    const lookup = controlPlaneForAdmin();
    expect(lookup.ok).toBe(true);
  });
});

describe("forEachSseData mid-stream errors", () => {
  it("rethrows mid-stream read errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: half\n"));
        c.error(new Error("pipe died"));
      },
    });
    await expect(forEachSseData(body, () => {})).rejects.toThrow("pipe died");
  });
});

describe("models catalog table (M2 cache; wiring verified now)", () => {
  it("rows belong to a provider and cascade on provider delete", () => {
    insertProvider("withmodels", "lemonade");
    db.insert(modelsTable)
      .values({ id: "withmodels:llama-mini", providerId: "withmodels", remoteId: "llama-mini", hidden: false })
      .run();
    expect(db.select().from(modelsTable).all().length).toBe(1);
    db.delete(providers).where(eq(providers.id, "withmodels")).run();
    expect(db.select().from(modelsTable).all()).toEqual([]);
  });
});
