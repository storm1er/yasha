// memory.thread_summary handler (PLAN §4): roll messages older than the chat
// window into a rolling `thread_summaries` row. The checkpoint lives in
// `thread_summaries.throughMessageId` (not job_checkpoints) and advances in the
// same transaction that flips the job to succeeded.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, threadSummaries, threads } from "@/lib/db/schema";
import { getSettingInt } from "@/lib/settings";
import { completeOnce, type JobHandler } from "@/lib/jobs/worker";
import { outputLanguageFor } from "@/lib/user-locale";
import { QUOTED_DATA_LINE, buildDatedTranscript, neutralizedBlock, outputLanguageLine } from "./transcript";

const MAX_PER_RUN = 80;

const SUMMARIZE_SYSTEM =
  "You maintain a rolling summary of a chat thread. Merge the EXISTING SUMMARY with the NEW " +
  "MESSAGES into one concise summary (max 250 words) of the thread so far: participants' " +
  "intent, decisions, entities (names, projects, files), open questions and current state. " +
  "Messages carry dates ([YYYY-MM-DD] prefixes); rewrite relative references (\"yesterday\", \"next week\") as absolute dates in every output. " +
  "Drop small talk. Reply with the summary text only — no preamble, no headings. " +
  QUOTED_DATA_LINE;

export const handleThreadSummary: JobHandler = async ({ job, cfg, signal, addCommit }) => {
  if (!cfg.model) return { skipped: "no_model_configured" };
  if (!job.threadId) return { skipped: "no_thread" };
  const thread = db
    .select({ id: threads.id, userId: threads.userId })
    .from(threads)
    .where(eq(threads.id, job.threadId))
    .get();
  if (!thread) return { skipped: "thread_gone" };

  const existing = db
    .select()
    .from(threadSummaries)
    .where(eq(threadSummaries.threadId, job.threadId))
    .get();

  // Watermark anchor = (createdAt, rowid) of the last rolled message; anchor
  // deleted → replay from the start (merging from scratch is harmless).
  let wmTs = 0;
  let wmRowid = -1;
  if (existing?.throughMessageId) {
    const anchor = db
      .select({ createdAt: messages.createdAt, rid: sql<number>`rowid` })
      .from(messages)
      .where(eq(messages.id, existing.throughMessageId))
      .get();
    if (anchor) {
      wmTs = anchor.createdAt.getTime();
      wmRowid = Number(anchor.rid);
    }
  }

  // Keep the newest `windowMessages` out of the roll — they still ride in the
  // live chat window; only older history needs summarizing.
  const windowMessages = getSettingInt("chat.windowMessages");
  const windowFloor = db
    .select({ createdAt: messages.createdAt, rid: sql<number>`rowid` })
    .from(messages)
    .where(eq(messages.threadId, job.threadId))
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .offset(Math.max(windowMessages, 1) - 1)
    .get();
  if (!windowFloor) return { skipped: "short_thread", windowMessages };

  const rows = db
    .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, job.threadId),
        sql`(${messages.createdAt} > ${wmTs} OR (${messages.createdAt} = ${wmTs} AND rowid > ${wmRowid}))`,
        sql`(${messages.createdAt} < ${windowFloor.createdAt.getTime()} OR (${messages.createdAt} = ${windowFloor.createdAt.getTime()} AND rowid < ${windowFloor.rid}))`
      )
    )
    .orderBy(sql`rowid ASC`)
    .limit(MAX_PER_RUN)
    .all();
  const lastId = rows[rows.length - 1]?.id ?? null;
  if (!lastId) return { skipped: "nothing_older_than_window", windowMessages };

  const msgTrunc = getSettingInt("memory.transcript.msgTruncChars");
  const transcriptCap = getSettingInt("memory.transcript.capChars");
  const transcript = buildDatedTranscript(rows, msgTrunc, transcriptCap);

  const raw = await completeOnce({
    model: cfg.model,
    messages: [
      { role: "system", content: SUMMARIZE_SYSTEM + "\n" + outputLanguageLine(outputLanguageFor(job.userId)) },
      {
        role: "user",
        content:
          `EXISTING SUMMARY:\n${neutralizedBlock(existing?.summary ?? "") || "(none)"}\n\n` +
          `NEW MESSAGES:\n${transcript}\n\nNew summary:`,
      },
    ],
    signal,
    temperature: 0.2,
  });
  const summary = raw.trim();
  if (!summary || signal.aborted) throw new Error("summary_empty");

  const version = (existing?.version ?? 0) + 1;
  const now = new Date();
  addCommit((tx) => {
    if (existing) {
      tx.update(threadSummaries)
        .set({ summary, throughMessageId: lastId, version, updatedAt: now })
        .where(eq(threadSummaries.threadId, job.threadId!))
        .run();
    } else {
      tx.insert(threadSummaries)
        .values({
          threadId: job.threadId!,
          userId: thread.userId,
          summary,
          throughMessageId: lastId,
          version,
          updatedAt: now,
        })
        .run();
    }
  });
  return { messagesRolled: rows.length, version, throughMessageId: lastId };
};
