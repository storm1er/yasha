// MEMORY-ENHANCEMENT-PLAN P3/P4 coverage: insight extraction pass (topics →
// FTS evidence → validated insights), insight-aware consolidation, and the
// typed-card modes (incremental vs periodic rebuild).

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ensureReady } from "@/lib/db";
import { db, setSetting } from "./support/db";
import { settings } from "@/lib/db/schema";
import { invalidateSettingsCache } from "@/lib/settings";
import { adminUser, type AdminUser } from "./support/app";
import { mockLemonade, sseCompletion, type LemonadeMock } from "./support/lemonade";
import { jobCheckpoints, memories, messages, threads, userSettings } from "@/lib/db/schema";
import { handleDreaming } from "@/lib/memory/dream";
import { TOOL_OUTPUT_PLACEHOLDER } from "@/lib/memory/transcript";
import type { EventConfig } from "@/lib/settings";
import type { JobTx } from "@/lib/jobs/worker";

const COMPLETIONS = "/v1/chat/completions";
let admin: AdminUser;
const userId = () => admin.userId;

const cfg: EventConfig = {
  schedule: "cron",
  idleMinutes: 0,
  cronExpr: "",
  model: "smart-model.test",
  timeoutMs: 30_000,
  maxAttempts: 1,
  backoffMs: 1000,
  enabled: true,
};

function ctx() {
  const ac = new AbortController();
  return {
    ctx: {
      job: { id: "job-d", dedupeKey: "k", type: "memory.dreaming", threadId: null, userId: userId(), status: "running", attempts: 0, payloadJson: null },
      payload: {},
      cfg,
      signal: ac.signal,
      heartbeat: () => {},
      setCheckpoint: () => {},
      addCommit: (fn: (tx: JobTx) => void) => fn(db as unknown as JobTx),
    } as unknown as Parameters<typeof handleDreaming>[0],
    ac,
  };
}

function mockCompletions(...texts: (string | Error | Response)[]): LemonadeMock {
  const mock = mockLemonade();
  let i = 0;
  mock.route(COMPLETIONS, () => {
    const t = texts[Math.min(i, texts.length - 1)];
    i += 1;
    if (t instanceof Error) throw t;
    if (t instanceof Response) return t;
    return sseCompletion(t);
  });
  return mock;
}

function seed(over: Partial<typeof memories.$inferInsert> & { id: string; kind?: string }): void {
  const now = new Date();
  db.insert(memories)
    .values({
      userId: userId(),
      kind: "fact",
      text: `The user fact ${over.id}`,
      source: "derived",
      pinned: false,
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run();
}

function activeKinds() {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId()), isNull(memories.supersededById)))
    .all();
}

const insightsOf = () => activeKinds().filter((m) => m.kind === "insight");

const dreamCursor = () => {
  const row = db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId()), eq(userSettings.key, "memory.dreamCursor")))
    .get();
  return row ? (JSON.parse(row.value).chunkIndex as number) : undefined;
};

beforeAll(async () => {
  await ensureReady();
  admin = await adminUser();
});

beforeEach(() => {
  db.delete(messages).run();
  db.delete(memories).run();
  db.delete(jobCheckpoints).run();
  db.delete(userSettings).run();
  db.delete(threads).run();
  db.delete(settings).run(); // no setting leaks between tests
  invalidateSettingsCache();
  setSetting("memory.enabled", "true");
  setSetting("memory.transcript.msgTruncChars", "800");
  setSetting("memory.transcript.capChars", "12000");
});

function seedStore(count: number, prefix = "g"): void {
  for (let i = 1; i <= count; i++) seed({ id: `${prefix}${i}` });
}

function seedThreadWithMessages(spec: { id: string; role: string; content: string; metaJson?: string | null }[]): void {
  const now = new Date("2026-07-01T10:00:00Z");
  db.insert(threads).values({ id: "dt", userId: userId(), model: "m", title: "", createdAt: now, updatedAt: now }).run();
  let i = 0;
  for (const m of spec) {
    db.insert(messages)
      .values({ id: `${m.id}-${++i}`, threadId: "dt", role: m.role, content: m.content, metaJson: m.metaJson ?? null, createdAt: now })
      .run();
  }
}

describe("dreaming: insight extraction", () => {
  it("topics → FTS evidence → validated insights with code-computed confidence", async () => {
    seedStore(15, "h");
    seedThreadWithMessages([
      { id: "u1", role: "user", content: "I redeployed my kubernetes homelab again" },
      { id: "a1", role: "assistant", content: "Applying kubernetes addons from the web", metaJson: JSON.stringify({ tools: [{ name: "x" }] }) },
    ]);
    const mock = mockCompletions(
      "[]", // consolidation
      '["kubernetes homelab", 42, "   "]', // topics (junk filtered)
      JSON.stringify([
        { text: "The user enjoys hands-on infrastructure work", evidenceIds: ["h1", "h2"] },
        { text: "single evidence must be rejected", evidenceIds: ["h1"] },
        { text: "citing unknown ids rejected", evidenceIds: ["h1", "ghost"] },
        { text: "no citations at all", evidenceIds: [] },
        { text: "The user string-not-array rejected", evidenceIds: "h1" },
        null,
        "plain string entry",
        { text: 42 },
      ]),
      '["identity: The user runs a homelab"]' // card
    );
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 1, cardUpdated: true });
    const [insight] = insightsOf();
    expect(insight.confidence).toBe("low"); // 2 cited → low
    expect(JSON.parse(insight.evidenceIds!)).toEqual(["h1", "h2"]);
    expect(insight.source).toBe("derived");
    expect(insight.threadId).toBeNull();

    const bodies = mock.bodies(COMPLETIONS) as { messages: { content: string }[] }[];
    const insightBody = bodies[2].messages[1].content;
    expect(insightBody).toContain("TOPIC: kubernetes homelab");
    expect(insightBody).toContain(TOOL_OUTPUT_PLACEHOLDER);
    expect(insightBody).not.toContain("Applying kubernetes addons from the web"); // tool output never feeds prompts
    expect(insightBody).toContain("h1 | fact");
  });

  it("confidence buckets from evidence count (2/3/5)", async () => {
    seedStore(15, "c");
    mockCompletions(
      "[]",
      '["habits"]',
      JSON.stringify([
        { text: "The user pattern A", evidenceIds: ["c1", "c2"] },
        { text: "The user pattern B", evidenceIds: ["c1", "c2", "c3"] },
        { text: "The user pattern C", evidenceIds: ["c1", "c2", "c3", "c4", "c5"] },
      ]),
      '["identity: ok"]'
    );
    // insightsPerNight default 3 → all three fit
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 3 });
    const byText = Object.fromEntries(insightsOf().map((m) => [m.text, m.confidence]));
    expect(byText["The user pattern A"]).toBe("low");
    expect(byText["The user pattern B"]).toBe("medium");
    expect(byText["The user pattern C"]).toBe("high");
  });

  it("per-night cap: stops creating at insightsPerNight, later topics never asked", async () => {
    setSetting("memory.dream.insightsPerNight", "2");
    seedStore(15, "p");
    const mock = mockCompletions(
      "[]",
      '["topic one","topic two","topic three","topic four"]', // 4th dropped by TOPIC_MAX
      JSON.stringify([
        { text: "The user pattern one", evidenceIds: ["p1", "p2"] },
        { text: "The user pattern two", evidenceIds: ["p1", "p2", "p3"] },
        { text: "never created — budget spent", evidenceIds: ["p1", "p4"] },
      ]),
      '["identity: ok"]'
    );
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 2 });
    expect(mock.calls.length).toBe(4); // consolidation + topics + one insight pass (budget hit) + card
    const bodies = mock.bodies(COMPLETIONS) as { messages: { content: string }[] }[];
    const topicsBody = bodies[1].messages[1].content; // only used to confirm call count
    expect(topicsBody).toContain("MEMORY INDEX");
  });

  it("re-deriving an existing insight is skipped (normalized match)", async () => {
    seedStore(15, "q");
    seed({ id: "old-ins", kind: "insight", text: "The user already knows this pattern", confidence: "low", evidenceIds: JSON.stringify(["q1", "q2"]) });
    mockCompletions(
      "[]",
      '["patterns"]',
      JSON.stringify([
        { text: "The user already knows this pattern.", evidenceIds: ["q1", "q3"] }, // dup modulo punctuation
        { text: "The user genuinely new thing", evidenceIds: ["q1", "q3"] },
      ]),
      '["identity: ok"]'
    );
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 1 });
    expect(insightsOf()).toHaveLength(2); // the old one + the new one
  });

  it("store below the topic threshold: no topic/insight calls at all", async () => {
    seedStore(14);
    const mock = mockCompletions('["identity: small store"]');
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 0, cardUpdated: true });
    expect(mock.calls.length).toBe(2); // consolidation + card only
  });

  it("insightsPerNight=0 disables the insight phase even on a big store", async () => {
    setSetting("memory.dream.insightsPerNight", "0");
    seedStore(16);
    const mock = mockCompletions("[]", '["identity: ok"]');
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 0, cardUpdated: true });
    expect(mock.calls.length).toBe(2);
  });

  it("junk topics / empty evidence transcripts: insight pass still runs on the index alone", async () => {
    seedStore(15, "e");
    const mock = mockCompletions(
      "[]",
      '["nothing matches this zzz topic"]',
      JSON.stringify([{ text: "The user cross-domain pattern", evidenceIds: ["e1", "e7"] }]),
      '["identity: ok"]'
    );
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 1 });
    const bodies = mock.bodies(COMPLETIONS) as { messages: { content: string }[] }[];
    expect(bodies[2].messages[1].content).toContain("RECENT MESSAGES (context, not citable):\n(none)");
    expect(bodies[2].messages[1].content).toContain("EXISTING INSIGHTS (do not re-derive):\n(none)");
  });

  it("topics garbage → no insight pass; insight LLM failure reported as insightError, card still built", async () => {
    seedStore(15, "f");
    mockCompletions("[]", "not json at all", '["identity: after junk topics"]');
    let res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 0, cardUpdated: true });

    mockCompletions("[]", '["t1"]', new Error("insight-upstream-500"), '["identity: after insight error"]');
    res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 0, insightError: "insight-upstream-500", cardUpdated: true });
  });

  it("abort during the insight pass rethrows (night resumes from the chunk cursor)", async () => {
    seedStore(15, "x");
    const mock = mockLemonade();
    const h = ctx();
    let i = 0;
    mock.route(COMPLETIONS, () => {
      i += 1;
      if (i === 2) {
        h.ac.abort();
        throw new Error("insight-abort");
      }
      return sseCompletion(i === 1 ? "[]" : "[]");
    });
    await expect(handleDreaming(h.ctx)).rejects.toThrow("insight-abort");
    // consolidation chunk already committed its rotation cursor
    expect(dreamCursor()).toBe(0);
  });
});

describe("dreaming: insights in consolidation", () => {
  it("merging insights unions their evidence and keeps kind + recomputed confidence", async () => {
    seed({ id: "f1", text: "The user runs a homelab" });
    seed({ id: "f2", text: "The user streams media" });
    seed({ id: "f3", text: "The user self-hosts backups" });
    seed({ id: "i1", kind: "insight", text: "The user self-hosts everything", confidence: "low", evidenceIds: JSON.stringify(["f1", "f2"]) });
    seed({ id: "i2", kind: "insight", text: "The user distrusts the cloud", confidence: "low", evidenceIds: JSON.stringify(["f2", "f3"]) });
    mockCompletions(
      JSON.stringify([
        { op: "merge", ids: ["i1", "i2"], kind: "insight", text: "The user is a committed self-hoster" },
      ]),
      '["identity: homelab owner"]'
    );
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ opsApplied: 1, retired: 2, cardUpdated: true });
    const merged = insightsOf().find((m) => m.text === "The user is a committed self-hoster")!;
    expect(merged.confidence).toBe("medium"); // 3-evidence union
    expect(new Set(JSON.parse(merged.evidenceIds!) as string[])).toEqual(new Set(["f1", "f2", "f3"]));
    expect(db.select().from(memories).where(eq(memories.id, "i1")).get()!.supersededById).toBe(merged.id);
  });

  it("insight merge whose union falls below 2 evidence degrades to a plain fact", async () => {
    seed({ id: "f1", text: "The user fact one" });
    seed({ id: "i1", kind: "insight", text: "The user insight with no real evidence", confidence: "low", evidenceIds: "not-json" });
    seed({ id: "i2", kind: "insight", text: "The user second empty insight", confidence: "low", evidenceIds: JSON.stringify(["ghost1"]) });
    mockCompletions(
      JSON.stringify([{ op: "merge", ids: ["i1", "i2"], kind: "insight", text: "The user merged hollow insights" }]),
      '["identity: ok"]'
    );
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ opsApplied: 1 });
    const merged = activeKinds().find((m) => m.text === "The user merged hollow insights")!;
    expect(merged.kind).toBe("fact");
    expect(merged.confidence).toBeNull();
    expect(merged.evidenceIds).toBeNull();
  });
});

describe("dreaming: typed card modes", () => {
  it("incremental update includes the prior typed card", async () => {
    seed({ id: "t1", text: "The user fact" });
    db.insert(userSettings)
      .values({ userId: userId(), key: "memory.userCard", value: JSON.stringify({ entries: ["identity: Ada"], version: 1, updatedAt: "old" }), updatedAt: new Date() })
      .run();
    const mock = mockCompletions('["identity: Ada", "rule: Answer in French"]');
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ cardUpdated: true });
    const bodies = mock.bodies(COMPLETIONS) as { messages: { content: string }[] }[];
    expect(bodies[0].messages[1].content).toContain("PRIOR CARD");
    expect(bodies[0].messages[1].content).toContain("identity: Ada");
    expect(getMemoryCard()).toMatchObject({ version: 2 });
  });

  it("every 7th update rebuilds blind from the memories only", async () => {
    seed({ id: "t2", text: "The user fact" });
    db.insert(userSettings)
      .values({ userId: userId(), key: "memory.userCard", value: JSON.stringify({ entries: ["identity: Stale entry"], version: 6, updatedAt: "old" }), updatedAt: new Date() })
      .run();
    const mock = mockCompletions('["identity: Fresh from memories"]');
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ cardUpdated: true });
    const bodies = mock.bodies(COMPLETIONS) as { messages: { content: string }[] }[];
    expect(bodies[0].messages[1].content).toContain("REBUILD MODE");
    expect(bodies[0].messages[1].content).not.toContain("Stale entry");
    expect(getMemoryCard()).toMatchObject({ version: 7, entries: ["identity: Fresh from memories"] });
  });

  it("legacy prose card migrates: its text rides along as the prior card", async () => {
    seed({ id: "t3", text: "The user fact" });
    db.insert(userSettings)
      .values({ userId: userId(), key: "memory.userCard", value: JSON.stringify({ text: "Legacy prose card", version: 2, updatedAt: "old" }), updatedAt: new Date() })
      .run();
    const mock = mockCompletions('["identity: Typed now"]');
    await handleDreaming(ctx().ctx);
    const bodies = mock.bodies(COMPLETIONS) as { messages: { content: string }[] }[];
    expect(bodies[0].messages[1].content).toContain("Legacy prose card");
    expect(getMemoryCard()).toMatchObject({ version: 3, entries: ["identity: Typed now"] });
  });

  it("insights render as inferred in the card prompt and are never card material", async () => {
    seed({ id: "t4", text: "The user fact" });
    seed({ id: "t5", kind: "insight", text: "The user inferred thing", confidence: "medium", evidenceIds: JSON.stringify(["t4", "t6"]) });
    seed({ id: "t6", text: "The user second fact" });
    const mock = mockCompletions("[]", '["identity: ok"]');
    await handleDreaming(ctx().ctx);
    const bodies = mock.bodies(COMPLETIONS) as { messages: { content: string }[] }[];
    expect(bodies[1].messages[1].content).toContain("- (derived,inferred) The user inferred thing");
  });
});

function getMemoryCard() {
  const row = db
    .select()
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId()), eq(userSettings.key, "memory.userCard")))
    .get();
  return row ? JSON.parse(row.value) : null;
}

describe("dreaming: defensive branches", () => {
  it("insight rows without confidence/evidence render with defaults; malformed evidence json parses empty", async () => {
    seed({ id: "n1", text: "The user fact one" });
    seed({ id: "ni1", kind: "insight", text: "The user bare insight", confidence: null, evidenceIds: null });
    seed({ id: "ni2", kind: "insight", text: "The user malformed evidence insight", confidence: "high", evidenceIds: "5" });
    const mock = mockCompletions("[]", '["identity: ok"]');
    const res = await handleDreaming(mock && ctx().ctx);
    expect(res).toMatchObject({ chunksProcessed: 1, opsApplied: 0 });
    const bodies = mock.bodies(COMPLETIONS) as { messages: { content: string }[] }[];
    const consol = bodies[0].messages[1].content;
    expect(consol).toContain("ni1 | insight | confidence=low | evidence=[]");
    expect(consol).toContain("ni2 | insight | confidence=high | evidence=[]");
  });

  it("non-numeric chunkIndex in the checkpoint falls back to 0", async () => {
    seed({ id: "nc1", text: "The user fact A" });
    seed({ id: "nc2", text: "The user fact B" });
    db.insert(userSettings)
      .values({ userId: userId(), key: "memory.dreamCursor", value: JSON.stringify({ chunkIndex: "nope" }), updatedAt: new Date() })
      .run();
    mockCompletions("[]", '["identity: ok"]');
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ chunksProcessed: 1, cardUpdated: true });
    expect(dreamCursor()).toBe(0);
  });

  it("explicit/pinned-only store: no chunks, no checkpoint, card still built", async () => {
    seed({ id: "xp1", text: "Explicit one", source: "explicit" });
    seed({ id: "xp2", text: "Pinned two", pinned: true, source: "explicit" });
    const mock = mockCompletions('["identity: ok"]');
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ chunksProcessed: 0, opsApplied: 0, cardUpdated: true });
    expect(dreamCursor()).toBeUndefined();
    expect(mock.calls.length).toBe(1);
  });

  it("per-item budget break: extra valid insights in the same reply are not created", async () => {
    setSetting("memory.dream.insightsPerNight", "1");
    seedStore(15, "b");
    mockCompletions(
      "[]",
      '["budget"]',
      JSON.stringify([
        { text: "The user first insight", evidenceIds: ["b1", "b2"] },
        { text: "The user second insight — past the budget", evidenceIds: ["b1", "b3"] },
      ]),
      '["identity: ok"]'
    );
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 1 });
    expect(insightsOf().map((m) => m.text)).toEqual(["The user first insight"]);
  });

  it("non-Error throw in the insight phase stringifies into insightError", async () => {
    seedStore(15, "e2");
    const mock = mockLemonade();
    let i = 0;
    mock.route(COMPLETIONS, () => {
      i += 1;
      if (i === 1) return sseCompletion("[]");
      if (i === 2) return sseCompletion('["t"]');
      if (i === 3) throw { code: 9 };
      return sseCompletion('["identity: ok"]');
    });
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 0, insightError: "[object Object]", cardUpdated: true });
  });
});

describe("dreaming: insight evidence integrity", () => {
  it("insights can never cite other insights (citations pruned to facts/preferences)", async () => {
    seedStore(15, "q");
    seed({ id: "qi1", kind: "insight", text: "The user existing insight", confidence: "low", evidenceIds: JSON.stringify(["q1", "q2"]) });
    mockCompletions(
      "[]", // consolidation
      '["pat"]', // topics
      JSON.stringify([
        { text: "The user cites only the insight", evidenceIds: ["qi1"] },
        { text: "The user mixes insight and one fact", evidenceIds: ["qi1", "q1"] },
      ]),
      '["identity: ok"]' // card
    );
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 0, insightsRepaired: 0, insightsDropped: 0 });
  });

  it("repair prunes dead/insight citations + recomputes confidence; <2 live citations drops the insight", async () => {
    seedStore(15, "r");
    seed({ id: "ri1", kind: "insight", text: "The user still valid insight", confidence: "high", evidenceIds: JSON.stringify(["r1", "ghost", "ri3", "r2"]) });
    seed({ id: "ri2", kind: "insight", text: "The user collapsing insight", confidence: "medium", evidenceIds: JSON.stringify(["r1", "ri1"]) });
    seed({ id: "ri3", kind: "insight", text: "The user chain insight", confidence: "low", evidenceIds: JSON.stringify(["r1", "r2"]) });
    mockCompletions("[]", "[]", '["identity: ok"]'); // consolidation, topics(none), card
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsRepaired: 1, insightsDropped: 1 });
    const byId = Object.fromEntries(activeKinds().map((m) => [m.id, m]));
    expect(byId["ri2"]).toBeUndefined(); // only r1 left after pruning ri1 (insight) → dropped
    expect(JSON.parse(byId["ri1"].evidenceIds!)).toEqual(["r1", "r2"]); // ghost + insight pruned
    expect(byId["ri1"].confidence).toBe("low"); // recomputed 3→2 evidence
    expect(JSON.parse(byId["ri3"].evidenceIds!)).toEqual(["r1", "r2"]);
  });

  it("repair also runs when insight creation is disabled", async () => {
    setSetting("memory.dream.insightsPerNight", "0");
    seedStore(15, "s");
    seed({ id: "si1", kind: "insight", text: "The user repaired insight", confidence: "high", evidenceIds: JSON.stringify(["s1", "gone", "s2"]) });
    mockCompletions("[]", '["identity: ok"]'); // consolidation, card (no topic/insight calls)
    const res = await handleDreaming(ctx().ctx);
    expect(res).toMatchObject({ insightsCreated: 0, insightsRepaired: 1, insightsDropped: 0 });
    const row = activeKinds().find((m) => m.id === "si1")!;
    expect(JSON.parse(row.evidenceIds!)).toEqual(["s1", "s2"]);
    expect(row.confidence).toBe("low");
  });
});
