// Protocol v3 interactive tools (docs/protocol-v3.md, issue #21 P2+P3):
// `ask_choice` / `confirm_action` are declared WITHOUT execute, so streamText
// emits the standard tool-input-* chunks and pauses; the client answers via
// useChat's addToolOutput, and the answer arrives on the NEXT request — which
// must pass the pending_actions gate (this user + thread, unconsumed,
// unexpired) before the output may reach the model. `kind` reserves the row
// shape for tool approvals (next slice).

import { and, eq, lt } from "drizzle-orm";
import { jsonSchema, tool, type ToolSet } from "ai";
import { db } from "@/lib/db";
import { messages, pendingActions } from "@/lib/db/schema";

/** How long the user has to answer before a pending action closes expired. */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** What the model sees for an interactive call that was never answered. */
export const NO_ANSWER = "[no answer]";
/** Overlaid when an answer arrives after the pending action expired. */
export const EXPIRED_ANSWER = "[no answer — the request expired]";

/** The interactive side is the "yasha" pseudo-server in meta.tools records
 *  (chips and history synthesis reuse the MCP record shape unchanged). */
export const INTERACTIVE_SERVER = "yasha";

export const INTERACTIVE_TOOLS = ["ask_choice", "confirm_action"] as const;
export type InteractiveToolName = (typeof INTERACTIVE_TOOLS)[number];

export function isInteractiveToolName(name: unknown): name is InteractiveToolName {
  return typeof name === "string" && (INTERACTIVE_TOOLS as readonly string[]).includes(name);
}

/** AI SDK tool definitions — no `execute`: the loop stops after
 *  tool-input-available and the answer comes from the client. */
export const INTERACTIVE_TOOL_DEFS: ToolSet = {
  ask_choice: tool({
    description:
      "Ask the user to pick one option when their request is ambiguous; never guess. The chosen option arrives as the tool result on the next turn.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        question: { type: "string", description: "Short question shown to the user" },
        options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
      },
      required: ["question", "options"],
    }),
  }),
  confirm_action: tool({
    description:
      "Ask the user to confirm or cancel before doing something with side effects. The answer ('confirmed' or 'cancelled') arrives as the tool result on the next turn.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        question: { type: "string", description: "What will happen if confirmed" },
        detail: { type: "string", description: "Optional extra context" },
      },
      required: ["question"],
    }),
  }),
};

export type InteractiveCall = { toolCallId: string; tool: InteractiveToolName; args: string };

/** Write one pending row per ask, when the asking assistant row is persisted.
 * Doubles as the table sweep: anything already expired is dropped per create,
 * so the table stays proportional to live conversations. */
export function createPendingActions(
  owner: { threadId: string; userId: string; messageId: string },
  calls: InteractiveCall[],
  now: Date,
): void {
  db.delete(pendingActions).where(lt(pendingActions.expiresAt, now)).run();
  for (const call of calls) {
    db.insert(pendingActions)
      .values({
        id: call.toolCallId,
        threadId: owner.threadId,
        userId: owner.userId,
        messageId: owner.messageId,
        kind: "tool",
        tool: call.tool,
        argsJson: call.args,
        createdAt: now,
        expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
      })
      .run();
  }
}

export type PendingVerdict =
  | { status: "valid"; messageId: string; tool: InteractiveToolName }
  | { status: "expired"; messageId: string }
  | { status: "invalid" };

/** Validate one echoed tool output and close its row. Closed either way —
 *  a replay of the same toolCallId can never re-inject a result. The lookup
 *  keys on user + thread as well as id: another user's row is `invalid`, not
 *  a 404-shaped leak. */
export function consumePendingAction(
  toolCallId: string,
  userId: string,
  threadId: string,
  now: Date,
): PendingVerdict {
  const row = db
    .select({
      messageId: pendingActions.messageId,
      tool: pendingActions.tool,
      consumedAt: pendingActions.consumedAt,
      expiresAt: pendingActions.expiresAt,
    })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.id, toolCallId),
        eq(pendingActions.userId, userId),
        eq(pendingActions.threadId, threadId),
      ),
    )
    .get();
  if (!row) return { status: "invalid" };
  db.update(pendingActions).set({ consumedAt: now }).where(eq(pendingActions.id, toolCallId)).run();
  if (row.consumedAt) return { status: "invalid" };
  if (row.expiresAt.getTime() <= now.getTime()) return { status: "expired", messageId: row.messageId };
  return { status: "valid", messageId: row.messageId, tool: row.tool as InteractiveToolName };
}

/** Pure meta_json patcher: replaces the result of the tool records whose
 *  `callId` matches an update and flags them answered — history converges so
 *  later turns replay the REAL exchange (byte-stable from then on). Records
 *  without an interactive call ride along untouched. */
export function patchToolResults(
  metaJson: string,
  updates: { callId: string; result: string }[],
): string {
  const meta = JSON.parse(metaJson) as { tools?: { callId?: string; result?: string; answered?: boolean }[] };
  for (const rec of meta.tools ?? []) {
    const hit = rec.callId === undefined ? undefined : updates.find((u) => u.callId === rec.callId);
    if (hit) {
      rec.result = hit.result;
      rec.answered = true;
    }
  }
  return JSON.stringify(meta);
}

/** Overlay validated answers onto the stored assistant rows (one read/write
 *  per distinct row; the rows are guaranteed present — their FK-coupled
 *  pending rows just passed the gate in this same request). */
export function overlayToolResults(
  updates: { messageId: string; callId: string; result: string }[],
): void {
  const byMessage = new Map<string, { callId: string; result: string }[]>();
  for (const u of updates) {
    const list = byMessage.get(u.messageId);
    if (list) list.push({ callId: u.callId, result: u.result });
    else byMessage.set(u.messageId, [{ callId: u.callId, result: u.result }]);
  }
  for (const [messageId, list] of byMessage) {
    const row = db.select({ metaJson: messages.metaJson }).from(messages).where(eq(messages.id, messageId)).get();
    // row is non-null by the FK invariant above; metaJson is JSON written by
    // persist() with the matching callId records.
    db.update(messages)
      .set({ metaJson: patchToolResults(row!.metaJson!, list) })
      .where(eq(messages.id, messageId))
      .run();
  }
}
