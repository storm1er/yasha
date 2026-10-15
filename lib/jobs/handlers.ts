// Job handlers (memory handlers join in M1 under lib/memory/).

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, threads } from "@/lib/db/schema";
import { outputLanguageFor } from "@/lib/user-locale";
import { outputLanguageLine } from "@/lib/memory/transcript";
import { completeOnce, type JobHandler } from "./worker";

const TITLE_SYSTEM =
  'You write chat thread titles. Reply with ONLY a short title (2-6 words) that names the topic of the conversation. No quotes, no trailing punctuation, no markdown.';

function cleanTitle(raw: string): string {
  let t = raw.trim();
  t = t.split("\n").find((l) => l.trim())!; // first line (raw is non-empty, trimmed)
  t = t.replace(/^#+\s*/, "");
  t = t.replace(/^["'`«“»”]+|["'`«“»”]+$/g, "").trim();
  t = t.replace(/[.!?。]+$/, "").trim();
  return t.slice(0, 60);
}

function excerpt(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const handleTitleGeneration: JobHandler = async ({ job, cfg, signal }) => {
  if (!cfg.model) return { titleUpdated: false, skipped: "no_model_configured" };
  if (!job.threadId) return { titleUpdated: false, skipped: "no_thread" };
  const rows = db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, job.threadId))
    .orderBy(asc(messages.createdAt))
    .limit(4)
    .all();
  const firstUser = rows.find((r) => r.role === "user");
  if (!firstUser) return { titleUpdated: false, skipped: "no_user_message" };
  const firstAssistant = rows.find((r) => r.role === "assistant");
  const userLine = excerpt(firstUser.content, 1200) || "[image]";
  const assistantPart = firstAssistant ? `\nAssistant: ${excerpt(firstAssistant.content, 600)}` : "";
  const raw = await completeOnce({
    model: cfg.model,
    messages: [
      { role: "system", content: TITLE_SYSTEM + "\n" + outputLanguageLine(outputLanguageFor(job.userId)) },
      { role: "user", content: `User: ${userLine}${assistantPart}` },
    ],
    signal,
    temperature: 0.2,
  });
  const title = cleanTitle(raw);
  if (!title) return { titleUpdated: false, skipped: "empty_title" };
  db.update(threads).set({ title }).where(eq(threads.id, job.threadId)).run();
  return { titleUpdated: true, title };
};
