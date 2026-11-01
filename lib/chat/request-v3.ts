// Protocol v3 request contract (docs/protocol-v3.md, issue #21 P1): the stock
// `useChat` body { id, messages, model?, attachments?, interactive? }. This
// module is PURE shape validation + extraction — history is "transport, not
// truth": old-turn content is deliberately never read here (the route hydrates
// it from stored rows), and reconciliation of sent ids against the thread is
// the route's job (it owns the DB).

/** Client message ids double as DB primary keys — keep them bounded. */
const MAX_ID_LENGTH = 64;
/** Hard cap on the echoed history (clients only ever send a window). */
const MAX_HISTORY = 500;

export type V3Request = {
  ok: true;
  /** Resolved thread id; "" when the client asked for a brand-new thread. */
  threadId: string;
  newThread: boolean;
  /** Client-generated id of the trailing user turn (persisted verbatim). */
  clientMsgId: string;
  /** Concatenated text parts of the trailing user message (untrimmed). */
  text: string;
  /** User-role history ids, in order, deduped — the route requires each to be
   * a stored row of the thread. Assistant-role echoes are ghosts of failed or
   * aborted turns (never persisted server-side): shape-checked, then ignored. */
  historyIds: string[];
  /** Whether this surface can answer interactive tools (default true, P3). */
  interactive: boolean;
  /** Passthrough: validated by the route (catalog / attachment caps), not here. */
  model: unknown;
  attachments: unknown;
};

export type V3Error = { ok: false; error: "invalid_message" | "invalid_history"; status: number };

const historyError = (): V3Error => ({ ok: false, error: "invalid_history", status: 409 });

/** id + role sanity shared by history entries and the trailing turn. */
function idOf(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH ? id : null;
}

export function parseV3Request(body: unknown): V3Request | V3Error {
  if (!body || typeof body !== "object" || Array.isArray(body)) return historyError();
  const b = body as Record<string, unknown>;

  // Thread: absent / "" / "new" all mean "create one".
  let threadId = "";
  if (b.id !== undefined && b.id !== null && b.id !== "" && b.id !== "new") {
    if (typeof b.id !== "string" || b.id.length > MAX_ID_LENGTH) return historyError();
    threadId = b.id;
  }
  const newThread = threadId === "";

  if (!Array.isArray(b.messages) || b.messages.length === 0) return historyError();
  const list = b.messages as unknown[];
  if (list.length > MAX_HISTORY + 1) return historyError();
  // A brand-new conversation has no history to echo.
  if (newThread && list.length !== 1) return historyError();

  const historyIds: string[] = [];
  for (const entry of list.slice(0, -1)) {
    const id = idOf(entry);
    const role = (entry as { role?: unknown } | null)?.role;
    if (id === null || (role !== "user" && role !== "assistant")) return historyError();
    // Only user-role echoes are reconciled (assistant ghosts are expected);
    // dedup keeps the route's "all ids exist" count check honest.
    if (role === "user" && !historyIds.includes(id)) historyIds.push(id);
  }

  // Trigger "send": the trailing turn is the new user message. (P2 adds the
  // resume trigger — a trailing assistant carrying validated tool outputs.)
  const last = list[list.length - 1];
  if (!last || typeof last !== "object" || (last as { role?: unknown }).role !== "user") {
    return historyError();
  }
  const clientMsgId = idOf(last);
  if (clientMsgId === null || historyIds.includes(clientMsgId)) return historyError();
  if (!Array.isArray((last as { parts?: unknown }).parts)) return historyError();
  const text = ((last as { parts: unknown[] }).parts as Array<Record<string, unknown>>)
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");

  const interactive = b.interactive === undefined ? true : b.interactive;
  if (typeof interactive !== "boolean") {
    return { ok: false, error: "invalid_message", status: 400 };
  }

  return {
    ok: true,
    threadId,
    newThread,
    clientMsgId,
    text,
    historyIds,
    interactive,
    model: b.model,
    attachments: b.attachments,
  };
}
