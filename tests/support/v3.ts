// Protocol v3 request bodies for route tests (docs/protocol-v3.md). A real
// client echoes the ids of the history it loaded; the route reconciles those
// against stored rows, so the helper hydrates them from the DB at call time.

import { eq } from "drizzle-orm";
import { messages } from "@/lib/db/schema";
import { db } from "./db";

export function v3Body(
  opts: {
    /** Target thread; omit (or null) for the new-thread flow. */
    threadId?: string | null;
    /** Text of the trailing user turn (non-strings arrive as ""). */
    message?: unknown;
    /** Override the client-generated trailing id (idempotency tests). */
    id?: string;
    /** Extra top-level fields passed through: model, attachments, interactive… */
    [extra: string]: unknown;
  } = {}
): Record<string, unknown> {
  const { threadId, message, id, ...extra } = opts;
  const history = threadId
    ? db
        .select({ id: messages.id, role: messages.role })
        .from(messages)
        .where(eq(messages.threadId, threadId))
        .all()
    : [];
  return {
    id: threadId ?? "new",
    messages: [
      ...history.map((r) => ({ id: r.id, role: r.role, parts: [] })),
      {
        id: id ?? crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: typeof message === "string" ? message : "" }],
      },
    ],
    ...extra,
  };
}
