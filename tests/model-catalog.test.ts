// Synced model catalog (lib/provider/catalog.ts): TTL sync into the `models`
// table, capability overrides, stale-row eviction, effective reads and
// model→provider routing.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ensureReady } from "@/lib/db";
import { models, providers, type ProviderType } from "@/lib/db/schema";
import {
  audioCapableModelIds,
  ensureCatalog,
  isAudioInputModel,
  pickProvider,
  readCatalog,
  routeModel,
  syncProvider,
  upstreamModelId,
} from "@/lib/provider/catalog";
import { chatProviders, resetProviderInstances } from "@/lib/provider/registry";
import { clearModels, seedModel } from "./support/catalog";
import { db } from "./support/db";
import { json, mockLemonade } from "./support/lemonade";

function insertProvider(id: string, type: ProviderType = "lemonade") {
  const now = new Date();
  db.insert(providers)
    .values({ id, type, label: id, baseUrl: `http://${id}.example`, apiKey: null, enabled: true, createdAt: now, updatedAt: now })
    .run();
}

beforeAll(async () => {
  await ensureReady();
});

beforeEach(() => {
  db.delete(providers).run(); // cascades to models rows
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetProviderInstances();
});

describe("syncProvider", () => {
  it("inserts listed models under canonical ids and drops rows the upstream no longer lists", async () => {
    insertProvider("pp");
    seedModel({ id: "pp:gone", providerId: "pp", syncedAgoMs: 300_000 });
    const mock = mockLemonade();
    mock.route("pp.example", () =>
      json({
        data: [
          { id: "keep", labels: ["chat"], downloaded: true },
          { id: "Gemma-4-E4B-it-GGUF", labels: ["chat"], downloaded: true },
        ],
      })
    );
    expect(await syncProvider(chatProviders()[0])).toBe(true);
    const rows = db.select().from(models).all();
    expect(rows.map((r) => r.id).sort()).toEqual(["pp:Gemma-4-E4B-it-GGUF", "pp:keep"]);
    // Lemonade heuristic auto-seeds the audio flag (Q14)
    const gemma = rows.find((r) => r.id === "pp:Gemma-4-E4B-it-GGUF")!;
    expect(gemma.audioInput).toBe(true);
    expect(gemma.vision).toBe(false);
  });

  it("upsert preserves admin flags and hidden state; only the watermark advances", async () => {
    insertProvider("pp");
    seedModel({ id: "pp:keep", providerId: "pp", vision: false, audioInput: true, syncedAgoMs: 300_000 });
    seedModel({ id: "pp:quiet", providerId: "pp", hidden: true, syncedAgoMs: 300_000 });
    const mock = mockLemonade();
    mock.route("pp.example", () =>
      json({
        data: [
          { id: "keep", labels: ["chat", "vision"], downloaded: true },
          { id: "quiet", labels: ["chat"], downloaded: true },
        ],
      })
    );
    expect(await syncProvider(chatProviders()[0])).toBe(true);
    const keep = db.select().from(models).where(eq(models.id, "pp:keep")).get()!;
    expect(keep.vision).toBe(false); // admin override beats upstream re-tag
    expect(keep.audioInput).toBe(true);
    expect(keep.lastSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(db.select().from(models).where(eq(models.id, "pp:quiet")).get()).toBeDefined(); // hidden survives
  });

  it("upstream failure returns false and leaves rows untouched", async () => {
    insertProvider("pp");
    seedModel({ id: "pp:keep", providerId: "pp", syncedAgoMs: 300_000 });
    const mock = mockLemonade();
    mock.route("pp.example", () => new Response("down", { status: 503 }));
    expect(await syncProvider(chatProviders()[0])).toBe(false);
    expect(db.select().from(models).all().map((r) => r.id)).toEqual(["pp:keep"]);
  });
});

describe("ensureCatalog", () => {
  it("no wired providers → empty catalog, not unavailable", async () => {
    const state = await ensureCatalog();
    expect(state).toEqual({ models: [], allUnavailable: false });
  });

  it("fresh rows skip the sync entirely", async () => {
    insertProvider("pp");
    seedModel({ id: "pp:fresh", providerId: "pp" });
    const mock = mockLemonade();
    mock.fallback(() => {
      throw new Error("must not fetch while the catalog is fresh");
    });
    const state = await ensureCatalog();
    expect(state.models.map((m) => m.id)).toEqual(["pp:fresh"]);
    expect(state.allUnavailable).toBe(false);
  });

  it("stale rows re-sync and the watermark refreshes", async () => {
    insertProvider("pp");
    seedModel({ id: "pp:old", providerId: "pp", syncedAgoMs: 120_000 });
    const mock = mockLemonade();
    mock.route("pp.example", () => json({ data: [{ id: "old", labels: ["chat"], downloaded: true }] }));
    const state = await ensureCatalog();
    expect(state.models.map((m) => m.id)).toEqual(["pp:old"]);
    expect(db.select().from(models).all()[0]!.lastSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(mock.calls.filter((c) => c.url.includes("/v1/models")).length).toBe(1);
  });

  it("rows without a watermark count as unsynced (never-catalogued providers)", async () => {
    insertProvider("pp");
    db.insert(models)
      .values({ id: "pp:manual", providerId: "pp", remoteId: "manual", hidden: false, lastSyncedAt: null })
      .run();
    const mock = mockLemonade();
    mock.route("pp.example", () => json({ data: [{ id: "served", labels: ["chat"], downloaded: true }] }));
    const state = await ensureCatalog();
    // manual row survives (no watermark to evict) and the synced row lands
    expect(state.models.map((m) => m.id).sort()).toEqual(["pp:manual", "pp:served"]);
  });

  it("all providers failing → allUnavailable with the served rows kept", async () => {
    insertProvider("pp");
    seedModel({ id: "pp:old", providerId: "pp", syncedAgoMs: 120_000 });
    const mock = mockLemonade();
    mock.route("pp.example", () => new Response("down", { status: 503 }));
    const state = await ensureCatalog();
    expect(state.allUnavailable).toBe(true);
    expect(state.models.map((m) => m.id)).toEqual(["pp:old"]); // stale rows still served
  });

  it("partial failure is not allUnavailable", async () => {
    insertProvider("up");
    insertProvider("down");
    seedModel({ id: "down:old", providerId: "down", syncedAgoMs: 120_000 });
    seedModel({ id: "up:good", providerId: "up", syncedAgoMs: 120_000 });
    const mock = mockLemonade();
    mock.route("up.example", () => json({ data: [{ id: "good", labels: ["chat"], downloaded: true }] }));
    mock.route("down.example", () => new Response("down", { status: 503 }));
    const state = await ensureCatalog();
    expect(state.allUnavailable).toBe(false);
    expect(state.models.map((m) => m.id).sort()).toEqual(["down:old", "up:good"]);
  });

  it("merges catalogs of every wired provider under canonical ids", async () => {
    insertProvider("one");
    insertProvider("two");
    const mock = mockLemonade();
    mock.route("one.example", () =>
      json({ data: [{ id: "shared", labels: ["chat"], downloaded: true }, { id: "a", labels: ["chat"], downloaded: true }] })
    );
    mock.route("two.example", () =>
      json({ data: [{ id: "shared", labels: ["chat"], downloaded: true }, { id: "b", labels: ["chat"], downloaded: true }] })
    );
    const state = await ensureCatalog();
    expect(state.models.map((m) => m.id)).toEqual(["one:a", "one:shared", "two:b", "two:shared"]);
    expect(db.select().from(models).all().map((r) => r.id).sort()).toEqual([
      "one:a",
      "one:shared",
      "two:b",
      "two:shared",
    ]);
  });
});

describe("readCatalog", () => {
  it("hides hidden rows and rows of disabled providers; null flags read as false", () => {
    insertProvider("on");
    insertProvider("off");
    db.update(providers).set({ enabled: false }).where(eq(providers.id, "off")).run();
    seedModel({ id: "on:visible", providerId: "on" });
    seedModel({ id: "on:hidden", providerId: "on", hidden: true });
    seedModel({ id: "off:ghost", providerId: "off" });
    expect(readCatalog().map((m) => m.id)).toEqual(["on:visible"]);
    expect(readCatalog()[0]).toEqual({ id: "on:visible", providerId: "on", remoteId: "visible", vision: false, audioInput: false });
  });
});

describe("audio capability lookups", () => {
  beforeEach(() => {
    insertProvider("pp");
    seedModel({ id: "pp:mic", providerId: "pp", audioInput: true });
    seedModel({ id: "pp:plain", providerId: "pp", audioInput: false });
    seedModel({ id: "pp:unknown-flag", providerId: "pp", audioInput: null });
    seedModel({ id: "pp:hidden-mic", providerId: "pp", audioInput: true, hidden: true });
  });

  it("isAudioInputModel only true for visible flagged rows", () => {
    expect(isAudioInputModel("pp:mic")).toBe(true);
    expect(isAudioInputModel("pp:plain")).toBe(false);
    expect(isAudioInputModel("pp:unknown-flag")).toBe(false);
    expect(isAudioInputModel("pp:hidden-mic")).toBe(false); // hidden rows are out of the catalog
    expect(isAudioInputModel("mic")).toBe(false); // bare remote id is not the canonical public id
    expect(isAudioInputModel("absent")).toBe(false);
    expect(isAudioInputModel(null)).toBe(false);
    expect(isAudioInputModel(undefined)).toBe(false);
  });

  it("audioCapableModelIds lists visible capable ids only", () => {
    expect(audioCapableModelIds()).toEqual(["pp:mic"]);
  });
});

describe("pickProvider", () => {
  it("single provider short-circuits without consulting the catalog", () => {
    insertProvider("only");
    const providersIn = chatProviders();
    expect(pickProvider(providersIn, [], "anything")).toBe(providersIn[0]);
  });

  it("routes by catalog row, then first-provider fallback", () => {
    insertProvider("alpha");
    insertProvider("beta");
    insertProvider("gamma");
    const two = chatProviders();
    expect(pickProvider(two, [{ id: "beta:known-b", providerId: "beta", remoteId: "known-b", vision: false, audioInput: false }], "beta:known-b")).toBe(two[1]);
    expect(pickProvider(two, [], "unknown")).toBe(two[0]); // unknown id → first
    // row points at a provider outside the passed list → first
    expect(pickProvider([two[0], two[2]], [{ id: "beta:x", providerId: "beta", remoteId: "x", vision: false, audioInput: false }], "beta:x")).toBe(two[0]);
  });
});

describe("upstreamModelId", () => {
  it("strips the serving provider prefix to yield the remote id", () => {
    expect(upstreamModelId("beta:known-b", "beta")).toBe("known-b");
    expect(upstreamModelId("beta:vendor:nested", "beta")).toBe("vendor:nested"); // only the first segment
  });

  it("passes through ids from a DIFFERENT provider (unknown-id fallback)", () => {
    expect(upstreamModelId("beta:x", "alpha")).toBe("beta:x");
    expect(upstreamModelId("bare-legacy", "alpha")).toBe("bare-legacy");
  });
});

describe("routeModel", () => {
  it("null when no provider is enabled", async () => {
    expect(await routeModel("x")).toBeNull();
  });

  it("single provider short-circuits without any catalog sync, stripping its prefix", async () => {
    insertProvider("only");
    const mock = mockLemonade();
    mock.fallback(() => {
      throw new Error("must not fetch with a single provider");
    });
    const route = await routeModel("only:whatever");
    expect(route).toEqual({ provider: chatProviders()[0], model: "whatever" });
  });

  it("routes through a fresh ensureCatalog and returns the remote id", async () => {
    insertProvider("alpha");
    insertProvider("beta");
    const mock = mockLemonade();
    mock.route("alpha.example", () => json({ data: [{ id: "a-model", labels: ["chat"], downloaded: true }] }));
    mock.route("beta.example", () => json({ data: [{ id: "b-model", labels: ["chat"], downloaded: true }] }));
    const wired = chatProviders();
    expect(await routeModel("beta:b-model")).toEqual({ provider: wired[1], model: "b-model" });
    // unknown id → first provider, id passed through untouched
    expect(await routeModel("nope")).toEqual({ provider: wired[0], model: "nope" });
  });
});

describe("clearModels helper", () => {
  it("empties the catalog table", () => {
    insertProvider("pp");
    seedModel({ id: "pp:x", providerId: "pp" });
    clearModels();
    expect(db.select().from(models).all()).toEqual([]);
  });
});
