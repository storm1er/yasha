import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ensureReady, rawSqlite } from "@/lib/db";
import { memories, messages, threads, user } from "@/lib/db/schema";
import { buildFtsQuery, ensureFts, searchMemoryIds, searchMessagesText } from "@/lib/search/fts";
import { adminUser, type AdminUser } from "./support/app";
import { db } from "./support/db";

let admin: AdminUser;
let other: string;

function addMemory(userId: string, text: string, id = randomUUID()): string {
  const now = new Date();
  db.insert(memories)
    .values({ id, userId, text, createdAt: now, updatedAt: now })
    .run();
  return id;
}

beforeAll(async () => {
  await ensureReady();
  admin = await adminUser();
  other = `u-fts-${Date.now().toString(36)}`;
  db.insert(user)
    .values({ id: other, name: "FTS Other", email: `${other}@example.test`, username: other.slice(0, 30) })
    .run();
  db.insert(memories).values({
    id: "dummy-anchor",
    userId: admin.userId,
    text: "anchor row",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).run();
});

afterAll(() => {
  db.delete(messages).run();
  db.delete(threads).run();
  db.delete(memories).run();
});

afterEach(() => {
  db.delete(messages).run();
  db.delete(threads).run();
});

describe("ensureFts", () => {
  it("is idempotent (second call keeps the index in sync)", () => {
    expect(() => ensureFts()).not.toThrow();
    expect(() => ensureFts()).not.toThrow();
    const id = addMemory(admin.userId, "idempotent probe unicornz");
    expect(searchMemoryIds("unicornz", admin.userId, 5)).toEqual([id]);
  });

  it("triggers keep the index in sync on UPDATE and DELETE", () => {
    const id = addMemory(admin.userId, "mutable text wagtailbird");
    expect(searchMemoryIds("wagtailbird", admin.userId, 5)).toEqual([id]);
    db.update(memories).set({ text: "changed wording" }).where(eq(memories.id, id)).run();
    expect(searchMemoryIds("wagtailbird", admin.userId, 5)).toEqual([]);
    expect(searchMemoryIds("wording", admin.userId, 5)).toEqual([id]);
    db.delete(memories).where(eq(memories.id, id)).run();
    expect(searchMemoryIds("wording", admin.userId, 5)).toEqual([]);
  });
});

describe("buildFtsQuery", () => {
  it("returns null when nothing survives tokenizing", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("ab cd !? .3")).toBeNull(); // short tokens dropped
  });

  it("quotes terms, lowercases, dedupes, OR-joins", () => {
    expect(buildFtsQuery("Cat cat DOG!")).toBe('"cat" OR "dog"');
  });

  it("neutralizes operators / quotes / unicode punctuation", () => {
    const q = buildFtsQuery('col:"neu*ral" OR (evil) — dash');
    expect(q).toBe('"col" OR "neu" OR "ral" OR "evil" OR "dash"');
    // the produced string is a valid MATCH expression:
    expect(searchMemoryIds(q!, admin.userId, 5)).toEqual([]);
  });

  it("caps the term list at 12", () => {
    const raw = Array.from({ length: 16 }, (_, i) => `tok${i}`).join(" ");
    const q = buildFtsQuery(raw)!;
    const terms = q.split(" OR ");
    expect(terms).toHaveLength(12);
    expect(terms[0]).toBe('"tok0"');
    expect(terms[11]).toBe('"tok11"');
  });
});

describe("searchMemoryIds", () => {
  it("returns [] immediately when the query yields no terms", () => {
    expect(searchMemoryIds("no go !!", admin.userId, 10)).toEqual([]); // no token survives
  });

  it("ranks matches best-first, scopes by user, filters superseded, honours limit", () => {
    const u = admin.userId;
    const id1 = addMemory(u, "kangaroo hops high");
    const id2 = addMemory(u, "kangaroo kangaroo kangaroo");
    const otherId = addMemory(other, "kangaroo in another account");
    const superseded = addMemory(u, "kangaroo retired fact");
    db.update(memories).set({ supersededById: "winner-x" }).where(eq(memories.id, superseded)).run();

    const hits = searchMemoryIds("kangaroo", u, 10);
    expect(hits).toContain(id2);
    expect(hits).toContain(id1);
    expect(hits.indexOf(id2)).toBeLessThan(hits.indexOf(id1)); // more matches → better bm25
    expect(hits).not.toContain(otherId);
    expect(hits).not.toContain(superseded);
    expect(searchMemoryIds("kangaroo", u, 1)).toHaveLength(1);
    expect(searchMemoryIds("nothingmatcheszzz", u, 10)).toEqual([]);
  });

  it("returns [] when the FTS lookup itself fails (prepared-statement hiccup)", () => {
    const spy = vi.spyOn(rawSqlite, "prepare").mockImplementation(() => {
      throw new Error("index corrupt");
    });
    try {
      expect(searchMemoryIds("kangaroo", admin.userId, 10)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("searchMessagesText", () => {
  const now = new Date("2026-06-01T10:00:00Z");

  function addThread(id: string, userId: string): void {
    db.insert(threads).values({ id, userId, model: "m", title: "", createdAt: now, updatedAt: now }).run();
  }

  function addMessage(id: string, threadId: string, role: string, content: string, metaJson: string | null = null): void {
    db.insert(messages).values({ id, threadId, role, content, metaJson, createdAt: now }).run();
  }

  beforeEach(() => {
    db.delete(messages).run();
    db.delete(threads).run();
  });

  it("scopes to the owning user and honours the limit", () => {
    addThread("t-own", admin.userId);
    addThread("t-other", other);
    addMessage("m-own-1", "t-own", "user", "peloton rides every sunday");
    addMessage("m-own-2", "t-own", "assistant", "nice peloton habit");
    addMessage("m-other", "t-other", "user", "peloton in another account");
    const hits = searchMessagesText(admin.userId, "peloton", 10);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.role).sort()).toEqual(["assistant", "user"]);
    expect(searchMessagesText(admin.userId, "peloton", 1)).toHaveLength(1);
  });

  it("drops rows whose thread was deleted", () => {
    addThread("t-drop", admin.userId);
    addMessage("m-drop", "t-drop", "user", "windmill climbing gear");
    expect(searchMessagesText(admin.userId, "windmill", 10)).toHaveLength(1);
    db.delete(threads).where(eq(threads.id, "t-drop")).run();
    expect(searchMessagesText(admin.userId, "windmill", 10)).toEqual([]);
  });

  it("returns [] when the query yields no terms", () => {
    expect(searchMessagesText(admin.userId, "no go", 10)).toEqual([]);
  });

  it("returns [] when the FTS lookup itself fails", () => {
    const spy = vi.spyOn(rawSqlite, "prepare").mockImplementation(() => {
      throw new Error("index corrupt");
    });
    try {
      expect(searchMessagesText(admin.userId, "kangaroo", 10)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
