// Plain-SQL reader/writer for thread_summaries — kept free of any import of
// lib/jobs/worker (the chat route must not pull the worker module graph in).

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { threadSummaries } from "@/lib/db/schema";

/** Latest rolling summary for a thread, or null. */
export function getThreadSummary(threadId: string): string | null {
  const row = db
    .select({ summary: threadSummaries.summary })
    .from(threadSummaries)
    .where(eq(threadSummaries.threadId, threadId))
    .get();
  return row?.summary?.trim() || null;
}
