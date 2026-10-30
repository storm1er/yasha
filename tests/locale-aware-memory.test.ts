// Locale-aware memory: user.locale storage + seeding, PATCH /api/me/locale,
// per-account output language on every generating job prompt, and the UI
// resolution order (account locale > cookie > default).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ensureReady } from "@/lib/db";
import { db, setSetting } from "./support/db";
import { adminUser, callRoute, jsonOf, sessionId, signUp, type AdminUser } from "./support/app";
import { setCurrentHeaders } from "./support/request-context";
import { mockLemonade, sseChatCompletion, type LemonadeMock } from "./support/lemonade";
import { memories, messages, threads, user as userTable, jobCheckpoints, threadSummaries } from "@/lib/db/schema";
import { GET as getMe } from "@/app/api/me/route";
import { PATCH as patchLocale } from "@/app/api/me/locale/route";
import { languageNameFor, outputLanguageFor } from "@/lib/user-locale";
import { outputLanguageLine } from "@/lib/memory/transcript";
import { resolveLocale } from "@/i18n/request";
import { handleFactExtraction } from "@/lib/memory/extract";
import { handleThreadSummary } from "@/lib/memory/summarize";
import { handleDreaming } from "@/lib/memory/dream";
import { handleTitleGeneration } from "@/lib/jobs/handlers";
import type { EventConfig } from "@/lib/settings";
import type { JobTx } from "@/lib/jobs/worker";

const COMPLETIONS = "/v1/chat/completions";
let admin: AdminUser;
const userId = () => admin.userId;

const setAccountLocale = (locale: string | null) =>
  db.update(userTable).set({ locale }).where(eq(userTable.id, userId())).run();

function cfg(model: string | null): EventConfig {
  return {
    schedule: "idle",
    idleMinutes: 1,
    cronExpr: "",
    model,
    timeoutMs: 30_000,
    maxAttempts: 2,
    backoffMs: 1000,
    enabled: true,
  };
}

type Ctx = Parameters<typeof handleFactExtraction>[0];

function jobCtx(over: { userId: string; threadId?: string | null; type?: string }): Ctx {
  const ac = new AbortController();
  return {
    job: {
      id: `job-${Math.random().toString(36).slice(2)}`,
      dedupeKey: "k",
      type: over.type ?? "memory.fact_extraction",
      threadId: over.threadId ?? null,
      userId: over.userId,
      status: "running",
      attempts: 0,
      payloadJson: null,
    },
    payload: {},
    cfg: cfg("smart-model.test"),
    signal: ac.signal,
    heartbeat: () => {},
    setCheckpoint: () => {},
    addCommit: (fn: (tx: JobTx) => void) => fn(db as unknown as JobTx),
  } as unknown as Ctx;
}

function mockCompletions(...texts: string[]): LemonadeMock {
  const mock = mockLemonade();
  let i = 0;
  mock.route(COMPLETIONS, () => {
    const t = texts[Math.min(i, texts.length - 1)];
    i += 1;
    return sseChatCompletion(t);
  });
  return mock;
}

/** System-prompt contents of every chat-completions call captured by the mock. */
function systemPrompts(mock: LemonadeMock): string[] {
  return (mock.bodies(COMPLETIONS) as { messages: { role: string; content: string }[] }[]).map(
    (b) => b.messages[0].content
  );
}

let seq = 0;
function seedThread(id: string): void {
  const now = new Date();
  db.insert(threads).values({ id, userId: userId(), model: "m", title: "", createdAt: now, updatedAt: now }).run();
}
function seedMessage(threadId: string, role: string, content: string, at: Date): void {
  db.insert(messages).values({ id: `msg-${threadId}-${++seq}`, threadId, role, content, createdAt: at }).run();
}
function seedMemory(id: string): void {
  const now = new Date();
  db
    .insert(memories)
    .values({
      id,
      userId: userId(),
      kind: "fact",
      text: `The user fact ${id}`,
      source: "derived",
      pinned: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const savedDefaultLocale = process.env.DEFAULT_LOCALE;

beforeAll(async () => {
  await ensureReady();
  admin = await adminUser();
});

beforeEach(() => {
  process.env.DEFAULT_LOCALE = "en"; // deterministic default regardless of .env
  db.delete(messages).run();
  db.delete(memories).run();
  db.delete(jobCheckpoints).run();
  db.delete(threadSummaries).run();
  db.delete(threads).run();
  setAccountLocale(null);
  setSetting("memory.enabled", "true");
  setSetting("chat.windowMessages", "2");
  setSetting("memory.transcript.msgTruncChars", "800");
  setSetting("memory.transcript.capChars", "12000");
  setSetting("memory.dream.insightsPerNight", "3");
});

afterEach(() => {
  if (savedDefaultLocale === undefined) delete process.env.DEFAULT_LOCALE;
  else process.env.DEFAULT_LOCALE = savedDefaultLocale;
});

describe("lib/user-locale", () => {
  it("maps known tags to language names", () => {
    expect(languageNameFor("en")).toBe("English");
    expect(languageNameFor("fr")).toBe("French");
  });

  it("null / unknown tags and DEFAULT_LOCALE override fall back to the default language", () => {
    expect(languageNameFor(null)).toBe("English");
    expect(languageNameFor(undefined)).toBe("English");
    expect(languageNameFor("de")).toBe("English");
    process.env.DEFAULT_LOCALE = "fr";
    expect(languageNameFor(null)).toBe("French");
    expect(languageNameFor("zz")).toBe("French");
  });

  it("outputLanguageFor reads the account row (fr / null / missing user)", () => {
    expect(outputLanguageFor(userId())).toBe("English"); // locale null
    setAccountLocale("fr");
    expect(outputLanguageFor(userId())).toBe("French");
    expect(outputLanguageFor("no-such-user")).toBe("English");
  });
});

describe("transcript outputLanguageLine", () => {
  it("names the language in a standing line", () => {
    expect(outputLanguageLine("English")).toBe(
      "Write every output string (texts, titles, topics, card entries) in English."
    );
    expect(outputLanguageLine("French")).toContain("in French.");
  });
});

describe("PATCH /api/me/locale", () => {
  it("401 when anonymous", async () => {
    expect((await callRoute(patchLocale, { method: "PATCH", json: { locale: "fr" } })).status).toBe(401);
  });

  it("400 invalid_locale for bad payloads", async () => {
    const self = await signUp("loc1");
    for (const body of [{ locale: "de" }, {}, { locale: 3 }, null]) {
      const res = await callRoute(patchLocale, { method: "PATCH", json: body, cookie: self.cookie });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_locale" });
    }
    const bad = await callRoute(patchLocale, {
      method: "PATCH",
      body: "not-json",
      headers: { "content-type": "application/json" },
      cookie: self.cookie,
    });
    expect(bad.status).toBe(400);
  });

  it("writes the account locale and returns it", async () => {
    const self = await signUp("loc2");
    const res = await callRoute(patchLocale, { method: "PATCH", json: { locale: "fr" }, cookie: self.cookie });
    expect(res.status).toBe(200);
    expect(await jsonOf<{ locale: string }>(res)).toEqual({ locale: "fr" });
    const id = await sessionId(self.cookie);
    const row = db.select().from(userTable).where(eq(userTable.id, id)).get()!;
    expect(row.locale).toBe("fr");

    const me = await callRoute(getMe, { cookie: self.cookie });
    const { user } = await jsonOf<{ user: { locale: string | null } }>(me);
    expect(user.locale).toBe("fr");
  });

  it("GET /api/me exposes locale as null until set", async () => {
    const self = await signUp("loc3");
    const { user } = await jsonOf<{ user: { locale: string | null } }>(await callRoute(getMe, { cookie: self.cookie }));
    expect(user.locale).toBeNull();
  });
});

describe("registration seeds the UI locale", () => {
  it("persists locale on sign-up, null when omitted", async () => {
    const handler = (await import("@/app/api/auth/[...all]/route")).All;
    const withLocale = await callRoute(handler, {
      method: "POST",
      path: "/api/auth/sign-up/email",
      json: {
        name: "t9_loc_fr",
        username: `t9_loc_fr_${seq++}_${Date.now().toString(36)}`.slice(0, 30),
        email: `t9_loc_fr_${seq}@example.test`,
        password: "test-password-123",
        locale: "fr",
      },
    });
    expect(withLocale.status).toBe(200);
    const cookie = (withLocale.headers.getSetCookie() ?? []).find((c) =>
      c.startsWith("better-auth.session_token=")
    )!.split(";")[0];
    const id = await sessionId(cookie);
    expect(db.select().from(userTable).where(eq(userTable.id, id)).get()!.locale).toBe("fr");

    const plain = await signUp("loc_nolocale");
    const id2 = await sessionId(plain.cookie);
    expect(db.select().from(userTable).where(eq(userTable.id, id2)).get()!.locale).toBeNull();
  });
});

describe("UI locale resolution", () => {
  it("signed-in account locale wins over the cookie", async () => {
    setAccountLocale("fr");
    setCurrentHeaders(new Headers({ cookie: `${admin.cookie}; NEXT_LOCALE=en` }));
    expect(await resolveLocale()).toBe("fr");
  });

  it("cookie applies when the account locale is unset; default when both absent", async () => {
    setCurrentHeaders(new Headers({ cookie: `${admin.cookie}; NEXT_LOCALE=fr` }));
    expect(await resolveLocale()).toBe("fr"); // account null → cookie
    setCurrentHeaders(new Headers({ cookie: "NEXT_LOCALE=fr" }));
    expect(await resolveLocale()).toBe("fr"); // anonymous cookie path
    setCurrentHeaders(new Headers({ cookie: "" }));
    expect(await resolveLocale()).toBe("en"); // anonymous default
  });
});

describe("job prompts carry the account output language", () => {
  it("fact extraction + merge prompts", async () => {
    setAccountLocale("fr");
    seedThread("lt1");
    seedMessage("lt1", "user", "I love hiking in the Alps", new Date("2026-06-01T10:00:00Z"));
    seedMemory("m1");
    const mock = mockCompletions(
      JSON.stringify([{ kind: "fact", text: "The user loves hiking in the Alps" }]),
      JSON.stringify([{ action: "add" }])
    );
    const ctx = jobCtx({ userId: userId(), threadId: "lt1" });
    await handleFactExtraction(ctx);
    const prompts = systemPrompts(mock);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) expect(p).toContain("in French.");
  });

  it("thread summary prompt", async () => {
    setAccountLocale("fr");
    seedThread("lt2");
    const t0 = new Date("2026-06-01T10:00:00Z");
    seedMessage("lt2", "user", "first", t0);
    seedMessage("lt2", "assistant", "second", new Date(t0.getTime() + 1000));
    seedMessage("lt2", "user", "third", new Date(t0.getTime() + 2000));
    const mock = mockCompletions("Résumé du fil.");
    const ctx = jobCtx({ userId: userId(), threadId: "lt2", type: "memory.thread_summary" });
    await handleThreadSummary(ctx);
    expect(systemPrompts(mock).at(-1)).toContain("in French.");
  });

  it("title prompt states the language explicitly (no transcript heuristic)", async () => {
    seedThread("lt3");
    seedMessage("lt3", "user", "Que coute une baguette ?", new Date());
    const mock = mockCompletions("Prix de la baguette");
    const ctx = jobCtx({ userId: userId(), threadId: "lt3", type: "chat.title_generation" });
    await handleTitleGeneration(ctx);
    const prompt = systemPrompts(mock)[0];
    expect(prompt).toContain("in English.");
    expect(prompt).not.toContain("same language as the user");
    setAccountLocale("fr");
    const mock2 = mockCompletions("ok");
    const ctx2 = jobCtx({ userId: userId(), threadId: "lt3", type: "chat.title_generation" });
    await handleTitleGeneration(ctx2);
    expect(systemPrompts(mock2)[0]).toContain("in French.");
  });

  it("dreaming: consolidation, topics, insights and card prompts", async () => {
    setAccountLocale("fr");
    for (let i = 1; i <= 15; i++) seedMemory(`d${i}`);
    const mock = mockCompletions(
      "[]", // consolidation chunk
      '["habitudes"]', // topics
      JSON.stringify([{ text: "L'utilisateur aime randonner", evidenceIds: ["d1", "d2"] }]),
      '["identity: L’utilisateur est randonneur"]' // card
    );
    const ctx = jobCtx({ userId: userId(), type: "memory.dreaming" });
    const res = await handleDreaming(ctx);
    expect(res).toMatchObject({ insightsCreated: 1, cardUpdated: true });
    const prompts = systemPrompts(mock);
    expect(prompts.length).toBeGreaterThanOrEqual(4); // consolidate, topics, insights, card
    for (const p of prompts) expect(p).toContain("in French.");
  });
});
