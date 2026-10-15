// Every rate-limited route handler: limiter ON with a budget of 1 → the first
// call passes the gate, the second 429s (exercises the `if (limited)` arm in
// each wrapped handler). One fresh identity (user or IP) per handler pair so
// same-kind buckets never clash.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, ensureReady, rawSqlite } from "@/lib/db";
import { apiKeys, importBatches, memories, threads } from "@/lib/db/schema";
import { callRoute, signUp } from "./support/app";

import { GET as apiKeysGet, POST as apiKeysPost } from "@/app/api/api-keys/route";
import { DELETE as apiKeyDelete } from "@/app/api/api-keys/[id]/route";
import { GET as appDlGet, POST as appDlPost } from "@/app/api/app-download/route";
import { GET as usersGet, PATCH as usersPatch } from "@/app/api/admin/users/route";
import { POST as chatPost } from "@/app/api/chat/route";
import { GET as mcpPrefsGet, POST as mcpPrefsPost } from "@/app/api/mcp/prefs/route";
import { GET as mcpServersGet, POST as mcpServersPost } from "@/app/api/mcp/servers/route";
import { GET as memoryGet, POST as memoryPost } from "@/app/api/memory/route";
import { PATCH as memoryPatch, DELETE as memoryDelete } from "@/app/api/memory/[id]/route";
import { POST as memPrefsPost } from "@/app/api/memory/prefs/route";
import { POST as transcribePost } from "@/app/api/chat/messages/[id]/transcribe/route";
import { GET as importGeminiGet } from "@/app/api/import/gemini/route";
import { GET as importGeminiByIdGet, POST as importGeminiByIdPost } from "@/app/api/import/gemini/[id]/route";
import { POST as importGeminiUpload } from "@/app/api/import/gemini/upload/route";
import { GET as threadsGet } from "@/app/api/threads/route";
import { GET as threadGet, PATCH as threadPatch, DELETE as threadDelete } from "@/app/api/threads/[id]/route";
import { POST as v1Post } from "@/app/v1/chat/completions/route";

beforeAll(async () => {
  await ensureReady();
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "http://localhost:3000";
});

beforeEach(() => {
  process.env.YASHA_RATE_LIMIT = "";
  process.env.RATE_LIMIT_API_PER_MIN = "1";
  process.env.RATE_LIMIT_AUTH_PER_MIN = "1";
  process.env.RATE_LIMIT_WRITE_PER_MIN = "1";
  process.env.RATE_LIMIT_HEAVY_PER_MIN = "1";
});

afterEach(() => {
  process.env.YASHA_RATE_LIMIT = "off";
  delete process.env.RATE_LIMIT_API_PER_MIN;
  delete process.env.RATE_LIMIT_AUTH_PER_MIN;
  delete process.env.RATE_LIMIT_WRITE_PER_MIN;
  delete process.env.RATE_LIMIT_HEAVY_PER_MIN;
});

async function blockedTwice(
  handler: Parameters<typeof callRoute>[0],
  opts: Parameters<typeof callRoute>[1],
  ctx?: unknown
): Promise<void> {
  const first = await callRoute(handler, opts, ctx);
  expect(first.status).not.toBe(429);
  const second = await callRoute(handler, opts, ctx);
  expect(second.status).toBe(429);
  expect(Number(second.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
}

let seq = 0;
async function freshCookie(): Promise<string> {
  return (await signUp(`rlr${(seq += 1)}`)).cookie;
}

function uidOf(email: string): string {
  return (rawSqlite.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string }).id;
}

describe("auth budget (RATE_LIMIT_AUTH_PER_MIN)", () => {
  it("GET /api/app-download", async () => {
    await blockedTwice(appDlGet, { cookie: await freshCookie() });
  });
  it("POST /api/app-download", async () => {
    await blockedTwice(appDlPost, { cookie: await freshCookie(), method: "POST" });
  });
  it("GET /api/admin/users", async () => {
    await blockedTwice(usersGet, { cookie: await freshCookie() });
  });
  it("PATCH /api/admin/users", async () => {
    const u = await signUp("rlrpatch");
    await blockedTwice(usersPatch, { cookie: u.cookie, json: { userId: uidOf(u.email), username: "rlr_renamed" } });
  });
  it("GET /api/api-keys", async () => {
    await blockedTwice(apiKeysGet, { cookie: await freshCookie() });
  });
  it("POST /api/api-keys", async () => {
    await blockedTwice(apiKeysPost, { cookie: await freshCookie(), json: { name: "rlr" } });
  });
  it("DELETE /api/api-keys/[id]", async () => {
    const cookie = await freshCookie();
    const owner = await signUp("rlrkeyowner");
    const kid = crypto.randomUUID();
    db.insert(apiKeys)
      .values({ id: kid, userId: uidOf(owner.email), name: "rlr", keyHash: `hash-${kid}`, last4: "1234", createdAt: new Date() })
      .run();
    await blockedTwice(apiKeyDelete, { cookie, method: "DELETE" }, { params: Promise.resolve({ id: kid }) });
  });
});

describe("write budget (RATE_LIMIT_WRITE_PER_MIN)", () => {
  it("GET /api/threads", async () => {
    await blockedTwice(threadsGet, { cookie: await freshCookie() });
  });

  it("GET /api/threads/[id]", async () => {
    const u = await signUp("rlrthget");
    const threadId = crypto.randomUUID();
    const now = new Date();
    db.insert(threads)
      .values({ id: threadId, userId: uidOf(u.email), model: "m", title: "t", createdAt: now, updatedAt: now })
      .run();
    await blockedTwice(threadGet, { cookie: u.cookie }, { params: Promise.resolve({ id: threadId }) });
  });

  it("PATCH /api/threads/[id]", async () => {
    const u = await signUp("rlrthpatch");
    const threadId = crypto.randomUUID();
    const now = new Date();
    db.insert(threads)
      .values({ id: threadId, userId: uidOf(u.email), model: "m", title: "t", createdAt: now, updatedAt: now })
      .run();
    await blockedTwice(
      threadPatch,
      { cookie: u.cookie, json: { title: "rlr" } },
      { params: Promise.resolve({ id: threadId }) }
    );
  });

  it("DELETE /api/threads/[id]", async () => {
    const u = await signUp("rlrthdel");
    const threadId = crypto.randomUUID();
    const now = new Date();
    db.insert(threads)
      .values({ id: threadId, userId: uidOf(u.email), model: "m", title: "t", createdAt: now, updatedAt: now })
      .run();
    await blockedTwice(
      threadDelete,
      { cookie: u.cookie, method: "DELETE" },
      { params: Promise.resolve({ id: threadId }) }
    );
  });

  it("GET /api/memory", async () => {
    await blockedTwice(memoryGet, { cookie: await freshCookie() });
  });
  it("POST /api/memory", async () => {
    await blockedTwice(memoryPost, { cookie: await freshCookie(), json: { text: "rlr fact" } });
  });

  it("PATCH /api/memory/[id]", async () => {
    const u = await signUp("rlrmempatch");
    const mid = crypto.randomUUID();
    const now = new Date();
    db.insert(memories)
      .values({ id: mid, userId: uidOf(u.email), kind: "fact", text: "t", source: "explicit", pinned: false, createdAt: now, updatedAt: now })
      .run();
    await blockedTwice(memoryPatch, { cookie: u.cookie, json: { text: "rlr" } }, { params: Promise.resolve({ id: mid }) });
  });

  it("DELETE /api/memory/[id]", async () => {
    const u = await signUp("rlrmemdel");
    const mid = crypto.randomUUID();
    const now = new Date();
    db.insert(memories)
      .values({ id: mid, userId: uidOf(u.email), kind: "fact", text: "t", source: "explicit", pinned: false, createdAt: now, updatedAt: now })
      .run();
    await blockedTwice(memoryDelete, { cookie: u.cookie, method: "DELETE" }, { params: Promise.resolve({ id: mid }) });
  });

  it("POST /api/memory/prefs", async () => {
    await blockedTwice(memPrefsPost, { cookie: await freshCookie(), json: { userEnabled: true } });
  });
  it("POST /api/chat/messages/[id]/transcribe", async () => {
    await blockedTwice(
      transcribePost,
      { cookie: await freshCookie(), method: "POST" },
      { params: Promise.resolve({ id: crypto.randomUUID() }) }
    );
  });
  it("GET /api/mcp/prefs", async () => {
    await blockedTwice(mcpPrefsGet, { cookie: await freshCookie() });
  });
  it("POST /api/import/gemini/upload", async () => {
    await blockedTwice(importGeminiUpload, {
      cookie: await freshCookie(),
      method: "POST",
      body: JSON.stringify({ id: "rl1", turns: [{ role: "user", text: "x" }] }) + "\n",
      headers: { "content-type": "application/x-ndjson" },
    });
  });

  it("POST /api/import/gemini/[id] (cancel)", async () => {
    const u = await signUp("rlrcancel");
    const id = crypto.randomUUID();
    db.insert(importBatches)
      .values({ id, userId: uidOf(u.email), filename: "x.ndjson", bytes: 1, status: "queued" })
      .run();
    await blockedTwice(
      importGeminiByIdPost,
      { cookie: u.cookie, method: "POST", json: { action: "cancel" } },
      { params: Promise.resolve({ id }) }
    );
  });

  it("POST /api/mcp/prefs", async () => {
    await blockedTwice(mcpPrefsPost, { cookie: await freshCookie(), json: { userEnabled: true } });
  });
  it("GET /api/mcp/servers", async () => {
    await blockedTwice(mcpServersGet, { cookie: await freshCookie() });
  });
  it("POST /api/mcp/servers", async () => {
    await blockedTwice(mcpServersPost, { cookie: await freshCookie(), json: { action: "check", id: "rlr-x" } });
  });
});

describe("api budget (RATE_LIMIT_API_PER_MIN)", () => {
  it("GET /api/import/gemini", async () => {
    await blockedTwice(importGeminiGet, { cookie: await freshCookie() });
  });

  it("GET /api/import/gemini/[id]", async () => {
    const u = await signUp("rlriget");
    const id = crypto.randomUUID();
    db.insert(importBatches)
      .values({ id, userId: uidOf(u.email), filename: "x.ndjson", bytes: 1, status: "queued" })
      .run();
    await blockedTwice(importGeminiByIdGet, { cookie: u.cookie }, { params: Promise.resolve({ id }) });
  });
});

describe("heavy budget (RATE_LIMIT_HEAVY_PER_MIN, IP identity when unauthenticated)", () => {
  let n = 0;
  const headersOf = (): Record<string, string> => ({ "x-forwarded-for": `203.0.118.${++n}` });

  it("POST /api/chat", async () => {
    await blockedTwice(chatPost, { json: { message: "rlr" }, headers: headersOf() });
  });
  it("POST /api/v1/chat/completions", async () => {
    await blockedTwice(v1Post, { json: { model: "x", messages: [{ role: "user", content: "hi" }] }, headers: headersOf() });
  });
});
