import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  DEFAULTS,
  defaultEventConfig,
  fastModel,
  getSetting,
  getSettingBool,
  getSettingInt,
  getSettingString,
  invalidateSettingsCache,
  jobTypeAllowed,
  memoryEnabled,
  resolveEventConfig,
  smartModel,
} from "@/lib/settings";
import {
  account,
  apiKeys,
  apkBuilds,
  importBatches,
  jobCheckpoints,
  jobs,
  memories,
  messages,
  pendingActions,
  session,
  threadImports,
  settings,
  threadSummaries,
  threads,
  user,
  userSettings,
  verification,
} from "@/lib/db/schema";
import { adminUser, type AdminUser } from "./support/app";
import { db, setFastModel, setSetting } from "./support/db";

let admin: AdminUser;

beforeAll(async () => {
  admin = await adminUser();
});

describe("lib/settings typed getters", () => {
  it("getSetting returns null for unknown keys", () => {
    expect(getSetting("nope.unknown")).toBeNull();
  });

  it("getSettingString trims and falls back", () => {
    expect(getSettingString("nope.unknown")).toBe("");
    expect(getSettingString("nope.unknown", "fb")).toBe("fb");
    setSetting("probe.str", "   ");
    expect(getSettingString("probe.str", "fb")).toBe("fb");
    setSetting("probe.str", "  ok  ");
    expect(getSettingString("probe.str")).toBe("ok");
  });

  it("getSettingInt reads raw stored values through the cache", () => {
    setSetting("chat.windowMessages", "20");
    expect(getSettingInt("chat.windowMessages")).toBe(20); // served from the populated cache
    expect(getSetting("chat.windowMessages")).toBe("20");
  });

  it("getSettingInt falls back on garbage and clamps to [min,max]", () => {
    setSetting("chat.windowMessages", "abc");
    expect(getSettingInt("chat.windowMessages")).toBe(DEFAULTS["chat.windowMessages"]);
    setSetting("chat.windowMessages", "10.5");
    expect(getSettingInt("chat.windowMessages")).toBe(DEFAULTS["chat.windowMessages"]);
    setSetting("chat.windowMessages", "1000");
    expect(getSettingInt("chat.windowMessages", 1, 50)).toBe(50);
    setSetting("chat.windowMessages", "0");
    expect(getSettingInt("chat.windowMessages")).toBe(1);
    setSetting("chat.windowMessages", "-4");
    expect(getSettingInt("chat.windowMessages", 1, 50)).toBe(1);
  });

  it("getSettingBool accepts true/1/false/0 with fallbacks", () => {
    expect(getSettingBool("flag.x", true)).toBe(true);
    expect(getSettingBool("flag.x", false)).toBe(false);
    setSetting("flag.x", " TRUE ");
    expect(getSettingBool("flag.x", false)).toBe(true);
    setSetting("flag.x", "1");
    expect(getSettingBool("flag.x", false)).toBe(true);
    setSetting("flag.x", "False");
    expect(getSettingBool("flag.x", true)).toBe(false);
    setSetting("flag.x", "0");
    expect(getSettingBool("flag.x", true)).toBe(false);
    setSetting("flag.x", "maybe");
    expect(getSettingBool("flag.x", true)).toBe(true);
    expect(getSettingBool("flag.x", false)).toBe(false);
  });

  it("memoryEnabled follows memory.enabled", () => {
    expect(memoryEnabled()).toBe(true); // default when unset
    setSetting("memory.enabled", "false");
    expect(memoryEnabled()).toBe(false);
  });

  it("fastModel/smartModel trim to null when blank", () => {
    expect(fastModel()).toBeNull();
    expect(smartModel()).toBeNull();
    setSetting("fast_model", "  fast-model.test  ");
    setSetting("smart_model", "smart-model.test");
    expect(fastModel()).toBe("fast-model.test");
    expect(smartModel()).toBe("smart-model.test");
    setSetting("fast_model", "   ");
    expect(fastModel()).toBeNull();
  });

  it("invalidateSettingsCache forces a re-read of the table", () => {
    // bypass the cache-aware helper to prove TTL/clear behaviour
    db.insert(settings).values({ key: "probe.raw", value: "v1" }).run();
    expect(getSetting("probe.raw")).toBeNull(); // stale cache
    invalidateSettingsCache();
    expect(getSetting("probe.raw")).toBe("v1");
  });
});

describe("resolveEventConfig / defaultEventConfig", () => {
  beforeAll(() => {
    setFastModel(); // "default:fast-model.test"
    setSetting("memory.queue.defaultMaxAttempts", "5");
    setSetting("memory.queue.defaultBackoffMs", "9000");
  });

  it("debug.echo has no settings row: pure defaults", () => {
    expect(resolveEventConfig("debug.echo")).toEqual({
      schedule: "after_persist",
      idleMinutes: 30,
      cronExpr: "0 4 * * *",
      model: "default:fast-model.test",
      timeoutMs: 10000,
      maxAttempts: 5,
      backoffMs: 9000,
      enabled: true,
    });
    expect(defaultEventConfig("memory.thread_summary")).toMatchObject({ schedule: "idle", idleMinutes: 30 });
    expect(defaultEventConfig("memory.dreaming")).toMatchObject({
      schedule: "cron",
      cronExpr: "0 4 * * *",
      timeoutMs: 3600000, // two LLM passes, each retriable on a reasoning-only reply
    });
    expect(defaultEventConfig("chat.title_generation").timeoutMs).toBe(180000);
  });

  it("falls back to defaults on broken rows", () => {
    for (const bad of ["{bad json", "42", "[1,2]", ""]) {
      setSetting("chat.title_generation", bad);
      expect(resolveEventConfig("chat.title_generation").model).toBe("default:fast-model.test");
    }
  });

  it("clamps garbage fields and honours explicit overrides", () => {
    setSetting(
      "chat.title_generation",
      JSON.stringify({
        schedule: "nope",
        enabled: "false",
        idleMinutes: 5000,
        cronExpr: "  a  ",
        model: 42,
        timeoutMs: 1,
        maxAttempts: 99,
        backoffMs: 9_999_999,
      })
    );
    expect(resolveEventConfig("chat.title_generation")).toEqual({
      schedule: "after_persist", // invalid -> default
      idleMinutes: 1440,
      cronExpr: "a",
      model: "default:fast-model.test", // non-string -> default
      timeoutMs: 1000,
      maxAttempts: 10,
      backoffMs: 3_600_000,
      enabled: false,
    });

    setSetting(
      "chat.title_generation",
      JSON.stringify({
        schedule: "idle",
        enabled: true,
        idleMinutes: 10,
        model: "custom-m",
        cronExpr: "30 2 * * *",
        timeoutMs: 5000,
        maxAttempts: 2,
        backoffMs: 1500,
      })
    );
    expect(resolveEventConfig("chat.title_generation")).toEqual({
      schedule: "idle",
      idleMinutes: 10,
      cronExpr: "30 2 * * *",
      model: "custom-m",
      timeoutMs: 5000,
      maxAttempts: 2,
      backoffMs: 1500,
      enabled: true,
    });

    setSetting("chat.title_generation", JSON.stringify({ enabled: "true" }));
    expect(resolveEventConfig("chat.title_generation").enabled).toBe(true);
  });
});

describe("jobTypeAllowed — memory-derivation switch OFF gates ONLY memory types", () => {
  it("blocks memory types (forced too); imports/titles/debug unaffected", () => {
    setSetting("memory.enabled", "false");
    invalidateSettingsCache();
    expect(jobTypeAllowed("memory.fact_extraction")).toBe(false);
    expect(jobTypeAllowed("memory.fact_extraction", true)).toBe(false); // force cannot override
    // import ingestion is user-requested data portability — never gated by memory:
    expect(jobTypeAllowed("import.gemini")).toBe(true);
    setFastModel();
    expect(jobTypeAllowed("chat.title_generation")).toBe(true);
    expect(jobTypeAllowed("debug.echo")).toBe(true);
  });
});

describe("jobTypeAllowed — memory switch ON gate matrix", () => {
  it("allows memory/imports; titles obey the per-event model/schedule gate", () => {
    setSetting("memory.enabled", "true");
    setSetting("chat.title_generation", ""); // clear any prior event-config row
    invalidateSettingsCache();

    expect(jobTypeAllowed("memory.fact_extraction")).toBe(true);
    // forced run short-circuits the per-event gate
    expect(jobTypeAllowed("chat.title_generation", true)).toBe(true);
    // imports need no chat model
    expect(jobTypeAllowed("import.gemini")).toBe(true);
    // debug echo is always allowed (manual admin tool)
    expect(jobTypeAllowed("debug.echo")).toBe(true);

    // per-event gate for chat.title_generation
    setSetting("fast_model", ""); // no model configured
    invalidateSettingsCache();
    expect(jobTypeAllowed("chat.title_generation")).toBe(false);
    setFastModel(); // "default:fast-model.test"
    expect(jobTypeAllowed("chat.title_generation")).toBe(true);
    setSetting("chat.title_generation", JSON.stringify({ schedule: "never" }));
    expect(jobTypeAllowed("chat.title_generation")).toBe(false);
    setSetting("chat.title_generation", JSON.stringify({ enabled: "false" }));
    expect(jobTypeAllowed("chat.title_generation")).toBe(false);
  });
});

describe("schema column defaults fire on INSERT", () => {
  it("stamps timestamps and SQL defaults across tables", () => {
    db.insert(user)
      .values({ id: "u-def", name: "Def", email: "u-def@example.test", username: "u_def" })
      .run();
    const u = db.select().from(user).where(eq(user.id, "u-def")).get()!;
    expect(u.createdAt).toBeInstanceOf(Date);
    expect(u.updatedAt).toBeInstanceOf(Date);
    expect(u.role).toBe("user");
    expect(u.emailVerified).toBe(false);

    db.insert(session)
      .values({ id: "s-def", token: "tok-def", userId: "u-def", expiresAt: new Date(Date.now() + 60_000) })
      .run();
    expect(db.select().from(session).where(eq(session.id, "s-def")).get()!.createdAt).toBeInstanceOf(Date);

    db.insert(account)
      .values({ id: "acc-def", accountId: "a1", providerId: "credentials", userId: "u-def" })
      .run();
    expect(db.select().from(account).where(eq(account.id, "acc-def")).get()!.updatedAt).toBeInstanceOf(Date);

    db.insert(verification).values({ id: "v-def", identifier: "i", value: "v" }).run();
    const v = db.select().from(verification).where(eq(verification.id, "v-def")).get()!;
    expect(v.expiresAt).toBeInstanceOf(Date);
    expect(v.createdAt).toBeInstanceOf(Date);

    db.insert(threads).values({ id: "th-def", userId: "u-def", model: "m" }).run();
    const th = db.select().from(threads).where(eq(threads.id, "th-def")).get()!;
    expect(th.title).toBe("");
    expect(th.createdAt).toBeInstanceOf(Date);
    expect(th.updatedAt).toBeInstanceOf(Date);

    db.insert(messages).values({ id: "msg-def", threadId: "th-def", role: "user" }).run();
    const msg = db.select().from(messages).where(eq(messages.id, "msg-def")).get()!;
    expect(msg.content).toBe("");
    expect(msg.createdAt).toBeInstanceOf(Date);

    db.insert(apiKeys)
      .values({ id: "ak-def", userId: "u-def", name: "k", keyHash: "hash-def" })
      .run();
    const ak = db.select().from(apiKeys).where(eq(apiKeys.id, "ak-def")).get()!;
    expect(ak.last4).toBe("");
    expect(ak.revokedAt).toBeNull();
    expect(ak.createdAt).toBeInstanceOf(Date);

    db.insert(memories).values({ id: "mem-def", userId: "u-def", text: "t" }).run();
    const mem = db.select().from(memories).where(eq(memories.id, "mem-def")).get()!;
    expect(mem.kind).toBe("fact");
    expect(mem.source).toBe("derived");
    expect(mem.pinned).toBe(false);
    expect(mem.createdAt).toBeInstanceOf(Date);
    expect(mem.updatedAt).toBeInstanceOf(Date);

    db.insert(jobs)
      .values({ id: "job-def", dedupeKey: "k:def", type: "debug.echo", userId: "u-def" })
      .run();
    const job = db.select().from(jobs).where(eq(jobs.id, "job-def")).get()!;
    expect(job.status).toBe("pending");
    expect(job.runAfter).toBeInstanceOf(Date);
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);

    db.insert(jobCheckpoints).values({ jobType: "memory.fact_extraction", throughMessageId: "m1" }).run();
    const cp = db.select().from(jobCheckpoints).where(eq(jobCheckpoints.jobType, "memory.fact_extraction")).get()!;
    expect(cp.threadId).toBe("");
    expect(cp.updatedAt).toBeInstanceOf(Date);

    db.insert(userSettings).values({ userId: "u-def", key: "k", value: "v" }).run();
    const us = db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, "u-def"))
      .get()!;
    expect(us.updatedAt).toBeInstanceOf(Date);

    // thread_summaries.updatedAt default: plain INSERT without updatedAt (the
    // app's upsert always passes it explicitly, so drive the default directly).
    db.insert(threadSummaries)
      .values({ threadId: "th-def", userId: admin.userId, summary: "s", throughMessageId: "m9" })
      .run();
    const tsRow = db.select().from(threadSummaries).where(eq(threadSummaries.threadId, "th-def")).get()!;
    expect(tsRow.version).toBe(1);
    expect(tsRow.updatedAt).toBeInstanceOf(Date);
    db.delete(threadSummaries).where(eq(threadSummaries.threadId, "th-def")).run();
  });

  it("resolves every column references() callback when FK constraints are built", () => {
    // drizzle stores inline FK builders on the table; their getName() is what
    // invokes the `references(() => …)` callbacks (only migration tooling
    // normally does it, so trigger it here to cover the schema definitions).
    const fksOf = (table: object) =>
      (table as unknown as Record<symbol, { getName(): string }[]>)[
        Symbol.for("drizzle:SQLiteInlineForeignKeys")
      ] ?? [];
    const tables: object[] = [
      session,
      account,
      threads,
      messages,
      // Protocol v3 pending actions (FKs to threads/user/messages):
      pendingActions,
      apiKeys,
      jobs,
      memories,
      threadSummaries,
      userSettings,
      apkBuilds,
      importBatches,
      threadImports,
    ];
    let total = 0;
    for (const table of tables) {
      const fks = fksOf(table);
      expect(fks.length).toBeGreaterThan(0);
      for (const fk of fks) {
        expect(fk.getName()).toMatch(/_fk$/);
        total += 1;
      }
    }
    expect(total).toBe(19);
  });
});
