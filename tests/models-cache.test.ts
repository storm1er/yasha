import { afterEach, describe, expect, it, vi } from "vitest";
import { forEachSseData, stripReasoningFields } from "@/lib/lemonade-stream";

describe("fetchChatModels (isolated module state)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.LEMONADE_BASE_URL;
  });

  async function freshModule(baseUrl: string) {
    vi.resetModules();
    process.env.LEMONADE_BASE_URL = baseUrl;
    return await import("@/lib/lemonade-stream");
  }

  it("filters entries + owns base-url default branch", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    const mod = await freshModule("http://lmtd.example:9/"); // trailing slash stripped
    const models = await mod.fetchChatModels();
    expect(calls[0]).toBe("http://lmtd.example:9/v1/models");
    expect(models).toEqual([
      { id: "openrouter/llama", ownedBy: "openrouter", vision: false },
      { id: "vision-model", ownedBy: "lemonade", vision: true },
      { id: "chat-ok", ownedBy: "lemonade", vision: false },
    ]);
    // second call → cache hit, no new fetch
    const again = await mod.fetchChatModels();
    expect(calls.length).toBe(1);
    expect(again).toBe(models);
  });

  it("upstream failure not cached; data absent → empty list; expiry refetches", async () => {
    vi.useFakeTimers();
    const mod = await freshModule("http://lmtd.example");
    let mode = "fail";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mode === "fail"
          ? new Response("x", { status: 503 })
          : mode === "empty"
            ? new Response(JSON.stringify({}), { status: 200 })
            : new Response(JSON.stringify({ data: [{ id: "late", labels: ["chat"], downloaded: true }] }), { status: 200 })
      )
    );
    await expect(mod.fetchChatModels()).rejects.toThrow("upstream_models_status_503"); // not cached
    mode = "empty";
    expect(await mod.fetchChatModels()).toEqual([]);
    vi.setSystemTime(Date.now() + 61_000);
    mode = "ok";
    expect((await mod.fetchChatModels()).map((m) => m.id)).toEqual(["late"]);
    vi.useRealTimers();
  });

  it("concurrent callers share the in-flight fetch; expiry refetches", async () => {
    vi.useFakeTimers();
    const mod = await freshModule("http://lmtd.example");
    let hits = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", vi.fn(async () => {
      hits += 1;
      await gate;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const p1 = mod.fetchChatModels();
    const p2 = mod.fetchChatModels();
    expect(hits).toBe(1); // shared in-flight fetch
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(hits).toBe(1);
    expect(a).toBe(b);
    vi.setSystemTime(Date.now() + 61_000); // cache TTL expired
    const p3 = mod.fetchChatModels();
    await expect(p3).resolves.toEqual(a);
    expect(hits).toBe(2);
    vi.useRealTimers();
  });

  it("module load throws when LEMONADE_BASE_URL is missing", async () => {
    vi.resetModules();
    delete process.env.LEMONADE_BASE_URL;
    await expect(import("@/lib/lemonade-stream")).rejects.toThrow("LEMONADE_BASE_URL is not set");
  });

  it("forEachSseData rethrows mid-stream read errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: half\n"));
        c.error(new Error("pipe died"));
      },
    });
    await expect(forEachSseData(body, () => {})).rejects.toThrow("pipe died");
    void stripReasoningFields;
  });
});
