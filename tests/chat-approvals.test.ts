// MCP-tool approvals end-to-end (issue #32): with `mcp.requireToolApprovals`,
// an MCP call pauses — the model gets the PENDING placeholder, the client gets
// a synthetic `mcp_approval` tool part (standard tool-input-* chunks) and a
// kind:"approval" pending row is born with the assistant row. The answer
// resumes like an ask; the RESUME request executes the deferred call (or
// overlays deny/expired/tool-gone) onto the stored round, so the model sees a
// single clean tool exchange.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import { buildToolset, runToolCall, type ToolHandle } from "@/lib/mcp/bridge";
import { ensureReady } from "@/lib/db";
import { messages, pendingActions, threads } from "@/lib/db/schema";
import { setUserMcpEnabled } from "@/lib/mcp/prefs";
import {
  DENIED_RESULT,
  EXPIRED_ANSWER,
  TOOL_GONE_RESULT,
} from "@/lib/chat/interactive";
import { adminUser, callRoute, sessionId, signUp, type TestUser } from "./support/app";
import { db, setFastModel, setSetting } from "./support/db";
import { mockLemonade, modelsResponse, sseChatCompletion, type LemonadeMock } from "./support/lemonade";
import { drainUi, uiData, uiErrorCode, uiText } from "./support/ui-stream";

vi.mock("@/lib/mcp/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/bridge")>();
  return { ...actual, buildToolset: vi.fn(), runToolCall: vi.fn() };
});
const mockedBuild = vi.mocked(buildToolset);
const mockedRun = vi.mocked(runToolCall);

const CHAT = "/v1/chat/completions";
let user: TestUser & { userId: string };

beforeAll(async () => {
  await ensureReady();
  await adminUser();
  const u = await signUp("approvuser");
  user = Object.assign(u, { userId: await sessionId(u.cookie) });
});

beforeEach(() => {
  db.delete(pendingActions).run();
  db.delete(messages).run();
  db.delete(threads).run();
  setFastModel("default:fast-model.test");
  setSetting("mcp.enabled", "true");
  setSetting("mcp.requireToolApprovals", "true");
  setUserMcpEnabled(user.userId, true);
  mockedBuild.mockReset();
  mockedBuild.mockResolvedValue(toolset());
  mockedRun.mockReset();
});

// The gated tool: qualified name mirrors buildToolset's real mcp__<srv>__<tool>.
const HANDLE: ToolHandle = { serverId: "ketch", tool: "send", title: "send", userId: "owner" };
const QUALIFIED = "mcp__ketch__send";
const CALL_ARGS = '{"to":"mom"}';

function toolset() {
  return {
    specs: [
      {
        type: "function" as const,
        function: { name: QUALIFIED, description: "send", parameters: { type: "object" } },
      },
    ],
    handles: new Map<string, ToolHandle>([[QUALIFIED, HANDLE]]),
  };
}

const env = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
const sseLine = (p: Record<string, unknown>) => `data: ${JSON.stringify({ ...env, ...p })}\n\n`;
const sseRes = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

/** One fragmented tool call + finish_reason tool_calls (SDK parser shape). */
function sseToolCall(id: string, args: string): Response {
  return sseRes(
    sseLine({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: QUALIFIED, arguments: args } }] } },
      ],
    }) +
      sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n",
  );
}

/** Two calls of the same tool in ONE round (dedupe check). */
function sseToolCallTwice(id1: string, id2: string): Response {
  return sseRes(
    sseLine({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: id1, type: "function", function: { name: QUALIFIED, arguments: CALL_ARGS } },
              { index: 1, id: id2, type: "function", function: { name: QUALIFIED, arguments: CALL_ARGS } },
            ],
          },
        },
      ],
    }) +
      sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n",
  );
}

function scripted(...handlers: (() => Response)[]): () => Response {
  let i = 0;
  return () => handlers[i++]();
}

function mockRoute(handler: () => Response): LemonadeMock {
  const mock = mockLemonade();
  mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
  mock.route(CHAT, handler);
  return mock;
}

async function post(json: unknown) {
  return callRoute(chatRoute.POST, { method: "POST", path: "/api/chat", cookie: user.cookie, json });
}

/** Seed a paused turn: assistant row carrying the approval record + its
 *  pending row (what persist() produced). */
function seedApprovalTurn(opts: { expiresAt?: Date } = {}): { threadId: string; toolCallId: string } {
  const t = Date.now() - 60_000;
  db.insert(threads)
    .values({ id: "th-ap", userId: user.userId, model: "default:fast-model.test", createdAt: new Date(t), updatedAt: new Date(t) })
    .run();
  db.insert(messages)
    .values({ id: "u-ap", threadId: "th-ap", role: "user", content: "send it", createdAt: new Date(t + 1) })
    .run();
  db.insert(messages)
    .values({
      id: "ap-row",
      threadId: "th-ap",
      role: "assistant",
      content: "",
      metaJson: JSON.stringify({
        model: "default:fast-model.test",
        tools: [
          {
            server: "ketch",
            name: "send",
            ms: 0,
            ok: true,
            args: CALL_ARGS,
            result: "[pending user approval — do not retry this call; the tool result follows once the user answers]",
            approval: true,
            callId: "call-ap-1",
          },
        ],
      }),
      createdAt: new Date(t + 2),
    })
    .run();
  db.insert(pendingActions)
    .values({
      id: "call-ap-1",
      threadId: "th-ap",
      userId: user.userId,
      messageId: "ap-row",
      kind: "approval",
      tool: QUALIFIED,
      argsJson: CALL_ARGS,
      createdAt: new Date(t),
      expiresAt: opts.expiresAt ?? new Date(t + 10_000_000),
      consumedAt: null,
    })
    .run();
  return { threadId: "th-ap", toolCallId: "call-ap-1" };
}

const resumeBody = (toolCallId: string, output: string) => ({
  id: "th-ap",
  messages: [
    { id: "client-echo", role: "assistant", parts: [{ type: "tool-mcp_approval", toolCallId, state: "output-available", output }] },
  ],
});

/** The approval meta record of a seeded pause row (or any explicit id). */
function readToolRecord(id = "ap-row"): { result: string; answered?: boolean } {
  const row = db.select().from(messages).where(eq(messages.id, id)).get()!;
  const meta = JSON.parse(row.metaJson!) as { tools: { result: string; answered?: boolean }[] };
  return meta.tools[0];
}

// ── the pause turn ───────────────────────────────────────────────────────────

describe("approval pause (route)", () => {
  it("gated call: placeholder to the model, mcp_approval tool chunks, approval row", async () => {
    const mock = mockRoute(scripted(() => sseToolCall("call-ap-1", CALL_ARGS), () => sseChatCompletion("Asking for approval.")));
    const res = await post({ id: "new", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] }] });
    const chunks = await drainUi(res);

    // Client got the synthetic tool part chunks…
    const avail = chunks.find((c) => c.type === "tool-input-available") as unknown as {
      toolCallId: string;
      toolName: string;
      input: Record<string, string>;
    };
    expect(avail).toMatchObject({
      toolCallId: "call-ap-1",
      toolName: "mcp_approval",
      input: { server: "ketch", tool: "send", args: CALL_ARGS },
    });
    expect(chunks.some((c) => c.type === "tool-input-start")).toBe(true);
    // …no data-tool chip (the pause is not an execution)…
    expect(uiData(chunks, "data-tool")).toHaveLength(0);
    // …the bridge was never called…
    expect(mockedRun).not.toHaveBeenCalled();
    // …the model received the placeholder and continued…
    expect(mock.bodies(CHAT).length).toBe(2);
    const second = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: { role: string; content: string }[] };
    const toolMsg = second.messages.filter((m) => m.role === "tool").at(-1)!;
    expect(toolMsg.content).toContain("[pending user approval");
    expect(uiText(chunks)).toContain("Asking for approval.");

    // …the record + pending row are as persist() wrote them.
    const genRow = db.select().from(messages).where(eq(messages.role, "assistant")).all().at(-1)!;
    const rec = readToolRecord(genRow.id);
    expect(rec.result).toContain("[pending user approval");
    const row = db.select().from(pendingActions).where(eq(pendingActions.id, "call-ap-1")).get()!;
    expect(row).toMatchObject({ kind: "approval", tool: QUALIFIED, argsJson: CALL_ARGS, userId: user.userId });
    expect(row.messageId).toBe(genRow.id);
  });

  it("an approval-only turn is output, not an empty_response", async () => {
    mockRoute(scripted(() => sseToolCall("call-ap-e", CALL_ARGS), () => sseChatCompletion("")));
    const res = await post({ id: "new", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] }] });
    const chunks = await drainUi(res);
    expect(uiErrorCode(chunks)).toBeUndefined();
    const rows = db.select().from(messages).where(eq(messages.role, "assistant")).all();
    expect(rows).toHaveLength(1);
    expect(db.select().from(pendingActions).all()).toHaveLength(1);
  });

  it("same-turn retry is deduped: one request, plain second record", async () => {
    const mock = mockRoute(scripted(() => sseToolCallTwice("call-a1", "call-a2"), () => sseChatCompletion("Waiting.")));
    const res = await post({ id: "new", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "send twice" }] }] });
    const chunks = await drainUi(res);
    expect(chunks.filter((c) => c.type === "tool-input-available")).toHaveLength(1);
    expect(db.select().from(pendingActions).all()).toHaveLength(1);
    const second = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: { role: string; content: string }[] };
    const toolMsgs = second.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.at(-2)?.content).toContain("[pending user approval");
    expect(toolMsgs.at(-1)?.content).toContain("already requested");
  });

  it("interactive:false → hard block, no chunks, no pending row", async () => {
    const mock = mockRoute(scripted(() => sseToolCall("call-ap-2", CALL_ARGS), () => sseChatCompletion("Could not run it.")));
    const res = await post({
      id: "new",
      interactive: false,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] }],
    });
    const chunks = await drainUi(res);
    expect(chunks.some((c) => c.type.startsWith("tool-input-"))).toBe(false);
    expect(mockedRun).not.toHaveBeenCalled();
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
    const second = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: { role: string; content: string }[] };
    expect(second.messages.filter((m) => m.role === "tool").at(-1)!.content).toContain("[blocked");
  });

  it("setting off → direct execution, no approval machinery", async () => {
    setSetting("mcp.requireToolApprovals", "false");
    mockedRun.mockResolvedValue({ content: "sent directly", ok: true, ms: 4 });
    const mock = mockRoute(scripted(() => sseToolCall("call-ap-3", CALL_ARGS), () => sseChatCompletion("Done.")));
    const res = await post({ id: "new", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] }] });
    const chunks = await drainUi(res);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(chunks.some((c) => c.type === "tool-input-available")).toBe(false);
    expect(mock.bodies(CHAT).length).toBe(2);
  });
});

// ── the answer resume ────────────────────────────────────────────────────────

describe("approval answer (resume)", () => {
  it("approved: the deferred call runs and its real output is overlaid", async () => {
    seedApprovalTurn();
    mockedRun.mockResolvedValue({ content: "sent!", ok: true, ms: 5 });
    const mock = mockRoute(scripted(() => sseChatCompletion("It is done.")));
    const res = await post(resumeBody("call-ap-1", "approved"));
    await drainUi(res);

    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0][0]).toBe(HANDLE);
    expect(mockedRun.mock.calls[0][1]).toBe(CALL_ARGS);
    expect(readToolRecord()).toMatchObject({ result: "sent!", answered: true });
    const row = db.select().from(pendingActions).where(eq(pendingActions.id, "call-ap-1")).get()!;
    expect(row.consumedAt).not.toBeNull();
    // The continuation sees the real tool output under the qualified name.
    const body = JSON.parse(mock.lastCall(CHAT)!.body!) as {
      messages: { role: string; content: string; tool_calls?: { function: { name: string } }[] }[];
    };
    const toolMsg = body.messages.filter((m) => m.role === "tool").at(-1)!;
    expect(toolMsg.content).toBe("sent!");
    const callMsg = body.messages.filter((m) => m.tool_calls?.length).at(-1)!;
    expect(callMsg.tool_calls![0].function.name).toBe(QUALIFIED);
  });

  it("denied: no execution, fixed denial overlaid", async () => {
    seedApprovalTurn();
    mockRoute(scripted(() => sseChatCompletion("Cancelled.")));
    const res = await post(resumeBody("call-ap-1", "denied"));
    await drainUi(res);
    expect(mockedRun).not.toHaveBeenCalled();
    expect(readToolRecord()).toMatchObject({ result: DENIED_RESULT, answered: true });
  });

  it("anything but 'approved' is a denial", async () => {
    seedApprovalTurn();
    mockRoute(scripted(() => sseChatCompletion("Cancelled.")));
    const res = await post(resumeBody("call-ap-1", "maybe"));
    await drainUi(res);
    expect(mockedRun).not.toHaveBeenCalled();
    expect(readToolRecord().result).toBe(DENIED_RESULT);
  });

  it("expired approval: EXPIRED_ANSWER, never executed", async () => {
    seedApprovalTurn({ expiresAt: new Date(Date.now() - 1000) });
    mockRoute(scripted(() => sseChatCompletion("Too late.")));
    const res = await post(resumeBody("call-ap-1", "approved"));
    await drainUi(res);
    expect(mockedRun).not.toHaveBeenCalled();
    expect(readToolRecord().result).toBe(EXPIRED_ANSWER);
  });

  it("approved but the tool vanished: tool-gone result, no throw", async () => {
    seedApprovalTurn();
    mockedBuild.mockResolvedValue({ specs: [], handles: new Map() });
    mockRoute(scripted(() => sseChatCompletion("Unavailable.")));
    const res = await post(resumeBody("call-ap-1", "approved"));
    await drainUi(res);
    expect(mockedRun).not.toHaveBeenCalled();
    expect(readToolRecord().result).toBe(TOOL_GONE_RESULT);
  });

  it("short-circuited requests never build the toolset (lazy)", async () => {
    setSetting("mcp.enabled", "false");
    mockedBuild.mockResolvedValue({ specs: [], handles: new Map() });
    // Resume on a nonexistent thread: the ownership 404 fires before tools.
    const res = await post(resumeBody("call-nope", "approved"));
    expect(res.status).toBe(404);
    expect(mockedBuild).not.toHaveBeenCalled();
  });
});
