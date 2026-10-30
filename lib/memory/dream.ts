// memory.dreaming handler (PLAN §4 + MEMORY-ENHANCEMENT-PLAN P3/P4): nightly
// dreaming of one user's memory store, in three phases:
//   1. Consolidation — chunked (rotating per-user cursor, bounded by a
//      SOFT deadline; the job timeout is only a hung-call watchdog): LLM merges
//      duplicates, resolves contradictions (clear corrections supersede;
//      drift/exceptions are REVISED into one memory narrating both sides + time
//      frames; losers superseded). Each chunk commits with its rotation cursor,
//      so an abort loses one chunk, not the night.
//   2. Insight extraction (the actual "dreaming") — the model picks ≤3 topics,
//      sees raw message evidence via FTS, and derives behavioral patterns /
//      drift / implications. Insights are `kind:"insight"` memories citing ≥2
//      evidence ids; confidence is computed in code from the evidence count.
//   3. Typed user card — stability-filtered `identity:`/`attribute:`/
//      `relationship:`/`rule:` entries, rebuilt from memories only every
//      `memory.dream.cardRebuildEvery`-th update.
// Destructive ops only ever touch NON-pinned derived rows (insights included);
// explicit/pinned rows are read-only context.

import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  memories,
  userSettings,
  type Memory,
  type MemoryConfidence,
  type MemoryKind,
} from "@/lib/db/schema";
import { getSettingInt, memoryEnabled } from "@/lib/settings";
import { outputLanguageFor } from "@/lib/user-locale";
import { completeOnce, errMessage, type JobHandler, type JobTx } from "@/lib/jobs/worker";
import { searchMessagesText } from "@/lib/search/fts";
import { getMemoryCard, parseCardEntries, setMemoryCardTx } from "./card";
import {
  QUOTED_DATA_LINE,
  TOOL_OUTPUT_PLACEHOLDER,
  buildDatedTranscript,
  excerpt,
  formatDateStamp,
  hasToolOutput,
  neutralizedBlock,
  outputLanguageLine,
} from "./transcript";

const MAX_READONLY_IN_PROMPT = 100;
const TEXT_TRUNC = 200;
const MAX_OPS = 10;
const INDEX_TRUNC = 120;
const TOPIC_MIN_MEMORIES = 15;
const TOPIC_MAX = 3;
const EVIDENCE_MSG_LIMIT = 25;
const INSIGHT_TEXT_MAX = 240;
const CURSOR_SETTING_KEY = "memory.dreamCursor";

const CONSOLIDATE_SYSTEM =
  "You consolidate a user's memory store. You receive ACTIVE memories (ids, kind, updated dates, " +
  "wording) and READ-ONLY pinned/explicit entries. Reply with ONLY a JSON array (no prose, no " +
  "fences) of at most 10 operations, or [] if the store is already clean:\n" +
  '{"op":"merge","ids":["idA","idB"],"kind":"fact|preference|insight","text":"<one combined atomic ' +
  'statement about the user, <=240 chars, third person: The user ...>"}\n' +
  '{"op":"supersede","staleId":"<id>","winnerId":"<id>","text":"<optional refined wording for ' +
  'the winner>"}\n' +
  '{"op":"revise","staleId":"<id>","winnerId":"<id>","text":"<revised wording for the winner, ' +
  '<=240 chars>"}\n' +
  'merge = two or more ACTIVE entries say the same thing (dedupe into one canonical statement). ' +
  'supersede = a clear correction/relocation: the stale statement was simply wrong or moved on; ' +
  'the more RECENT one wins (winnerId) and the stale one is retired. ' +
  'revise = a contradiction that is really drift or an exception: both sides can be true; the ' +
  "winner's text must NARRATE both the old and the new state with time frames. " +
  'Prefer revise over supersede when both could be true. ' +
  'Keep time markers ("since June 2026", "until 2025") in merge/revise wording. ' +
  'kind=insight rows are DERIVED conclusions (they list confidence and evidence ids); treat them ' +
  'as ordinary ACTIVE rows: they may be merged, superseded or revised. When you supersede or ' +
  "merge away a memory whose id appears in an insight's evidence list, you MUST in the same run " +
  "also supersede (staleId=insight id) or revise that insight — no insight may keep retired " +
  'evidence. Only ever reference ACTIVE ids (never the read-only ones). ' +
  'Never merge trivial unrelated facts together (different topics = different memories, even if both ' +
  'are habits or preferences); if the store is already clean, the correct answer is []. ' +
  'Fewer, safer ops beat clever ones. ' +
  QUOTED_DATA_LINE;

const TOPICS_SYSTEM =
  "You select dream topics for one user's memory store. You receive an index of ACTIVE memory " +
  "entries (id | kind | text). Choose at most 3 topic areas that deserve reflection: repeated " +
  "habits, contradictions or drift, clusters that imply something not stated yet, neglected " +
  "areas of the store. Reply with ONLY a JSON array of short lowercase topic phrases " +
  '(strings, <= 60 chars), or [] if the store is too small or too clean to reflect on. ' +
  QUOTED_DATA_LINE;

const insightSystem = (maxInsights: number) =>
  "You dream about one user's memory store: you DERIVE new knowledge, you never restate it. " +
  "You receive a topic, dated raw message excerpts (context only, never citable), the ACTIVE " +
  "memory index (the only citable evidence), and existing insights. Write at most " +
  `${maxInsights} insights: behavioral patterns repeated across exchanges, preferences in ` +
  'practice, temporal drift ("prefers X, switched to Y since ~2026-06"), implications (what ' +
  "the facts imply about the user). Reply with ONLY a JSON array, each item: " +
  '{"text":"<one insight, <=240 chars, third person: The user ...>","evidenceIds":["<id>",...]}.\n' +
  "Rules: every insight must cite at least 2 evidenceIds taken verbatim from the memory index "
  "(facts/preferences only — NEVER another insight; insights are conclusions, not evidence); " +
  "never restate a single existing memory; never cite the message excerpts; skip anything an " +
  "existing insight already says; fewer, better insights — [] is a valid answer. " +
  QUOTED_DATA_LINE;

const CARD_SYSTEM =
  "You maintain <user_card>: a typed identity profile of one user for an AI assistant's system " +
  "prompt. Reply with ONLY a JSON array of entry strings (no prose, no fences). Each entry is " +
  "exactly one stable fact prefixed by ONE of these prefixes and a colon:\n" +
  "identity: who the user is (name, role, where they live)\n" +
  "attribute: durable traits (expertise, languages, chronic constraints)\n" +
  "relationship: named people/organizations tied to the user\n" +
  "rule: standing instructions for the assistant — ONLY things the user explicitly said\n" +
  "Stability test: keep an entry only if it plausibly stays true for the next six months. " +
  "Behavioral patterns, habits, preferences-in-practice and anything marked inferred are NOT " +
  "card material (they live in memories — never copy them). One fact per entry, <=160 chars, " +
  "at most 40 entries, no examples, no hedging. On conflicts explicit/pinned entries win. " +
  "Drop prior entries the current memories no longer support. " +
  QUOTED_DATA_LINE;

type Op =
  | { op: "merge"; ids: string[]; kind: MemoryKind; text: string }
  | { op: "supersede"; staleId: string; winnerId: string; text?: string }
  | { op: "revise"; staleId: string; winnerId: string; text: string };

/** In-memory active-set row (real rows and rows created this run). */
type LiveRow = {
  id: string;
  kind: MemoryKind;
  text: string;
  source: string;
  pinned: boolean;
  confidence?: MemoryConfidence | null;
};

function parseArray(raw: string): unknown[] {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    // text sliced from '[' to ']' can only parse to a JSON array (or throw)
    return JSON.parse(s.slice(start, end + 1)) as unknown[];
  } catch {
    return [];
  }
}

function parseEvidence(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Evidence-repair: consolidation may merge away memories cited by insights (the
 * prompt rule asking the model to keep insight evidence live is advisory only),
 * and legacy insights may cite other insights (conclusion-on-conclusion). Prune
 * non-citable citations (dead or insight-kind) and recompute confidence; drop
 * insights left with <2 live citations — they regenerate if the pattern holds.
 * Row deletes/updates stay FTS-safe via the memories_fts triggers.
 */
function repairInsightEvidence(userId: string): { repaired: number; dropped: number } {
  const insights = db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.kind, "insight"), isNull(memories.supersededById)))
    .all();
  const citable = new Set(
    db
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.userId, userId), isNull(memories.supersededById), ne(memories.kind, "insight")))
      .all()
      .map((r) => r.id)
  );
  let repaired = 0;
  let dropped = 0;
  for (const m of insights) {
    const ev = parseEvidence(m.evidenceIds);
    const kept = [...new Set(ev.filter((id) => citable.has(id)))];
    if (kept.length === ev.length) continue;
    if (kept.length < 2) {
      db.delete(memories).where(eq(memories.id, m.id)).run();
      dropped += 1;
    } else {
      db.update(memories)
        .set({ evidenceIds: JSON.stringify(kept), confidence: confidenceFor(kept.length), updatedAt: new Date() })
        .where(eq(memories.id, m.id))
        .run();
      repaired += 1;
    }
  }
  return { repaired, dropped };
}

function confidenceFor(evidenceCount: number): MemoryConfidence {
  if (evidenceCount >= 5) return "high";
  if (evidenceCount >= 3) return "medium";
  return "low";
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/, "")
    .trim();
}

function validateOps(items: unknown[], movableIds: Set<string>): Op[] {
  const touched = new Set<string>();
  const ops: Op[] = [];
  for (const item of items.slice(0, MAX_OPS)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.op === "merge" && Array.isArray(o.ids)) {
      const ids = o.ids.filter((id): id is string => typeof id === "string" && movableIds.has(id));
      const unique = [...new Set(ids)];
      const text = typeof o.text === "string" ? o.text.trim().slice(0, 300) : "";
      if (unique.length < 2 || !text) continue;
      if (unique.some((id) => touched.has(id))) continue;
      unique.forEach((id) => touched.add(id));
      const kind: MemoryKind =
        o.kind === "preference" ? "preference" : o.kind === "insight" ? "insight" : "fact";
      ops.push({ op: "merge", ids: unique, kind, text });
    } else if (
      (o.op === "supersede" || o.op === "revise") &&
      typeof o.staleId === "string" &&
      typeof o.winnerId === "string"
    ) {
      if (o.staleId === o.winnerId || !movableIds.has(o.staleId) || !movableIds.has(o.winnerId)) continue;
      if (touched.has(o.staleId)) continue;
      const text = typeof o.text === "string" ? o.text.trim().slice(0, 300) : undefined;
      if (o.op === "revise" && !text) continue;
      touched.add(o.staleId);
      ops.push(
        o.op === "revise"
          ? { op: "revise", staleId: o.staleId, winnerId: o.winnerId, text: text! }
          : { op: "supersede", staleId: o.staleId, winnerId: o.winnerId, text }
      );
    }
  }
  return ops;
}

/**
 * Rotation cursor: per-user chunkIndex persisted in user_settings (NOT
 * job_checkpoints — that table is keyed (job_type, thread_id) and dreaming
 * rows carry no thread, so every user would share one cursor).
 */
function readChunkIndex(userId: string): number {
  const row = db
    .select({ v: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId), eq(userSettings.key, CURSOR_SETTING_KEY)))
    .get();
  if (!row) return 0;
  try {
    const p = JSON.parse(row.v) as { chunkIndex?: unknown };
    return typeof p.chunkIndex === "number" && Number.isFinite(p.chunkIndex) && p.chunkIndex >= 0
      ? Math.trunc(p.chunkIndex)
      : 0;
  } catch {
    return 0;
  }
}

function writeChunkIndexTx(executor: JobTx | typeof db, userId: string, chunkIndex: number): void {
  const value = JSON.stringify({ chunkIndex });
  const now = new Date();
  const where = and(eq(userSettings.userId, userId), eq(userSettings.key, CURSOR_SETTING_KEY));
  if (executor.select({ userId: userSettings.userId }).from(userSettings).where(where).get()) {
    executor.update(userSettings).set({ value, updatedAt: now }).where(where).run();
  } else {
    executor.insert(userSettings).values({ userId, key: CURSOR_SETTING_KEY, value, updatedAt: now }).run();
  }
}

/** Renders the memory index shared by the topic + insight passes. */
function renderIndex(rows: LiveRow[]): string {
  return rows.map((m) => `- ${m.id} | ${m.kind} | ${neutralizedBlock(excerpt(m.text, INDEX_TRUNC))}`).join("\n");
}

export const handleDreaming: JobHandler = async ({ job, cfg, signal }) => {
  if (!cfg.model) return { skipped: "no_model_configured" };
  if (!memoryEnabled()) return { skipped: "memory_disabled" };
  const active = db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, job.userId), isNull(memories.supersededById)))
    .orderBy(memories.updatedAt)
    .all();
  if (active.length === 0) return { skipped: "empty_store" };

  const started = Date.now();
  const langLine = outputLanguageLine(outputLanguageFor(job.userId));
  const softDeadlineMs = getSettingInt("memory.dream.softDeadlineMs", 5_000, 3_600_000);
  const chunkSize = getSettingInt("memory.dream.chunkSize", 5, 500);
  const insightsPerNight = getSettingInt("memory.dream.insightsPerNight", 0, 20);
  const rebuildEvery = getSettingInt("memory.dream.cardRebuildEvery", 2, 100);

  const movable = active.filter((m) => m.source === "derived" && !m.pinned);
  const pinnedOrExplicit = active.filter((m) => m.source === "explicit" || m.pinned);

  // In-memory post-op view (drives the insight + card passes).
  const retired = new Set<string>();
  const created: LiveRow[] = [];

  const renderConsolidateRow = (m: Memory) =>
    `- ${m.id} | ${m.kind}` +
    (m.kind === "insight"
      ? ` | confidence=${m.confidence ?? "low"} | evidence=[${parseEvidence(m.evidenceIds).join(",")}]`
      : "") +
    ` | updated ${formatDateStamp(m.updatedAt)} | ${neutralizedBlock(excerpt(m.text, TEXT_TRUNC))}`;

  // ── Phase 1: chunked consolidation with rotation checkpoint ───────────────
  let opsApplied = 0;
  let factsRevised = 0;
  let chunksProcessed = 0;
  const readonlyBlock = pinnedOrExplicit.length
    ? pinnedOrExplicit.slice(-MAX_READONLY_IN_PROMPT).map(renderConsolidateRow).join("\n")
    : "(none)";
  const totalChunks = Math.ceil(movable.length / chunkSize);
  let chunkIndex = totalChunks > 0 ? readChunkIndex(job.userId) % totalChunks : 0;
  while (totalChunks > 0 && chunksProcessed < totalChunks && Date.now() - started < softDeadlineMs) {
    const next = (chunkIndex + 1) % totalChunks;
    const chunk = movable.slice(chunkIndex * chunkSize, chunkIndex * chunkSize + chunkSize);
    if (chunk.length >= 2 && !signal.aborted) {
      const raw = await completeOnce({
        model: cfg.model,
        messages: [
          { role: "system", content: CONSOLIDATE_SYSTEM + "\n" + langLine },
          {
            role: "user",
            content:
              `ACTIVE (consolidatable, chunk ${chunkIndex + 1}/${totalChunks}):\n` +
              `${chunk.map(renderConsolidateRow).join("\n")}\n\n` +
              `READ-ONLY (never merge or supersede these):\n${readonlyBlock}`,
          },
        ],
        signal,
        maxTokens: 4096,
        temperature: 0.1,
      });
      // No post-call abort guard: completeOnce rejects on any abort, so a
      // resolved call never needs the v1 "did the night stop mid-call" check.
      const rowsById = new Map(chunk.map((m) => [m.id, m]));
      const ops = validateOps(parseArray(raw), new Set(chunk.map((m) => m.id)));
      const now = new Date();
      db.transaction((tx) => {
        for (const op of ops) {
          if (op.op === "merge") {
            let kind = op.kind;
            let evidenceIds: string | null = null;
            let confidence: MemoryConfidence | null = null;
            if (kind === "insight") {
              const union = new Set<string>();
              for (const id of op.ids) for (const e of parseEvidence(rowsById.get(id)?.evidenceIds)) union.add(e);
              if (union.size >= 2) {
                evidenceIds = JSON.stringify([...union]);
                confidence = confidenceFor(union.size);
              } else {
                kind = "fact";
              }
            }
            const id = crypto.randomUUID();
            tx.insert(memories)
              .values({
                id,
                userId: job.userId,
                kind,
                text: op.text,
                source: "derived",
                confidence,
                evidenceIds,
                pinned: false,
                threadId: null,
                createdAt: now,
                updatedAt: now,
              })
              .run();
            for (const stale of op.ids) {
              tx.update(memories).set({ supersededById: id }).where(eq(memories.id, stale)).run();
              retired.add(stale);
            }
            created.push({ id, kind, text: op.text, source: "derived", pinned: false, confidence });
          } else {
            // supersede and revise both retire the loser; revise also rewrites
            // the winner to narrate both sides + time frames.
            tx.update(memories).set({ supersededById: op.winnerId }).where(eq(memories.id, op.staleId)).run();
            retired.add(op.staleId);
            if (op.text) {
              tx.update(memories).set({ text: op.text, updatedAt: now }).where(eq(memories.id, op.winnerId)).run();
            }
          }
        }
        writeChunkIndexTx(tx, job.userId, next);
      });
      opsApplied += ops.length;
      factsRevised += ops.filter((o) => o.op === "revise").length;
    } else {
      db.transaction((tx) => writeChunkIndexTx(tx, job.userId, next));
    }
    chunkIndex = next;
    chunksProcessed += 1;
  }

  const liveRows = (): LiveRow[] => [
    ...active
      .filter((m) => !retired.has(m.id))
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        text: m.text,
        source: m.source,
        pinned: m.pinned,
        confidence: m.confidence,
      })),
    ...created,
  ];

  // ── Phase 1.5: repair insight evidence invalidated by consolidation ────────
  const { repaired: insightsRepaired, dropped: insightsDropped } = repairInsightEvidence(job.userId);

  // ── Phase 2: insight extraction (topics → FTS message evidence → insights) ─
  let insightsCreated = 0;
  let insightError: string | undefined;
  if (insightsPerNight > 0 && Date.now() - started < softDeadlineMs && !signal.aborted) {
    try {
      let live = liveRows();
      let topics: string[] = [];
      if (live.length >= TOPIC_MIN_MEMORIES) {
        const raw = await completeOnce({
          model: cfg.model,
          messages: [
            { role: "system", content: TOPICS_SYSTEM + "\n" + langLine },
            { role: "user", content: `MEMORY INDEX:\n${renderIndex(live)}` },
          ],
          signal,
          maxTokens: 4096,
          temperature: 0.3,
        });
        topics = parseArray(raw)
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, TOPIC_MAX);
      }
      const msgTrunc = getSettingInt("memory.transcript.msgTruncChars");
      const transcriptCap = getSettingInt("memory.transcript.capChars");
      for (const topic of topics) {
        if (insightsCreated >= insightsPerNight || signal.aborted) break;
        live = liveRows();
        const citableIds = new Set(live.filter((m) => m.kind !== "insight").map((m) => m.id));
        const evidence = searchMessagesText(job.userId, topic, EVIDENCE_MSG_LIMIT);
        const transcript = buildDatedTranscript(
          evidence.map((e) => ({
            role: e.role,
            content: e.role === "assistant" && hasToolOutput(e.metaJson) ? TOOL_OUTPUT_PLACEHOLDER : e.content,
            createdAt: e.createdAt,
          })),
          msgTrunc,
          transcriptCap
        );
        const existingInsights = live.filter((m) => m.kind === "insight");
        const knownTexts = new Set(existingInsights.map((m) => normalize(m.text)));
        const raw = await completeOnce({
          model: cfg.model,
          messages: [
            { role: "system", content: insightSystem(insightsPerNight - insightsCreated) + "\n" + langLine },
            {
              role: "user",
              content:
                `TOPIC: ${topic}\n\nRECENT MESSAGES (context, not citable):\n${transcript || "(none)"}\n\n` +
                `MEMORY INDEX (cite fact/preference ids only):\n${renderIndex(live)}\n\n` +
                `EXISTING INSIGHTS (do not re-derive):\n${
                  existingInsights.length
                    ? existingInsights.map((m) => `- ${m.id}: ${excerpt(m.text, INDEX_TRUNC)}`).join("\n")
                    : "(none)"
                }`,
            },
          ],
          signal,
          maxTokens: 4096,
          temperature: 0.3,
        });
        for (const item of parseArray(raw)) {
          if (insightsCreated >= insightsPerNight) break;
          if (!item || typeof item !== "object") continue;
          const o = item as Record<string, unknown>;
          if (typeof o.text !== "string" || !o.text.trim()) continue;
          const text = o.text.trim().slice(0, INSIGHT_TEXT_MAX);
          if (knownTexts.has(normalize(text))) continue;
          const cited = Array.isArray(o.evidenceIds)
            ? [...new Set(o.evidenceIds.filter((id): id is string => typeof id === "string" && citableIds.has(id)))]
            : [];
          if (cited.length < 2) continue;
          const id = crypto.randomUUID();
          const confidence = confidenceFor(cited.length);
          const now = new Date();
          db.transaction((tx) => {
            tx.insert(memories)
              .values({
                id,
                userId: job.userId,
                kind: "insight",
                text,
                source: "derived",
                confidence,
                evidenceIds: JSON.stringify(cited),
                pinned: false,
                threadId: null,
                createdAt: now,
                updatedAt: now,
              })
              .run();
          });
          created.push({ id, kind: "insight", text, source: "derived", pinned: false, confidence });
          knownTexts.add(normalize(text));
          insightsCreated += 1;
        }
      }
    } catch (err) {
      if (signal.aborted) throw err;
      insightError = errMessage(err);
    }
  }

  // ── Phase 3: typed user card ───────────────────────────────────────────────
  let cardUpdated = false;
  let cardError: string | undefined;
  const prior = getMemoryCard(job.userId);
  const cardVersion = prior?.version ?? 0;
  const rebuild = (cardVersion + 1) % rebuildEvery === 0;
  const cardInput = liveRows();
  if (cardInput.length > 0 && !signal.aborted) {
    try {
      const renderCardRow = (m: LiveRow) =>
        `- (${[m.pinned && "pinned", m.source, m.kind === "insight" && "inferred"].filter(Boolean).join(",")}) ` +
        `${neutralizedBlock(excerpt(m.text, TEXT_TRUNC))}`;
      const raw = await completeOnce({
        model: cfg.model,
        messages: [
          { role: "system", content: CARD_SYSTEM + "\n" + langLine },
          {
            role: "user",
            content:
              (rebuild
                ? "REBUILD MODE: the prior card is intentionally withheld — build the card solely from the memories below.\n\n"
                : `PRIOR CARD (migrate/extend it; drop what is no longer supported):\n${prior?.entries?.join("\n") ?? prior?.text ?? "(none)"}\n\n`) +
              `ACTIVE MEMORIES:\n${cardInput.slice(-MAX_READONLY_IN_PROMPT).map(renderCardRow).join("\n")}`,
          },
        ],
        signal,
        maxTokens: 4096,
        temperature: 0.2,
      });
      const entries = parseCardEntries(parseArray(raw));
      if (entries.length > 0) {
        db.transaction((tx) =>
          setMemoryCardTx(tx, job.userId, {
            entries,
            version: cardVersion + 1,
            updatedAt: new Date().toISOString(),
          })
        );
        cardUpdated = true;
      } else {
        cardError = "card_empty";
      }
    } catch (err) {
      if (signal.aborted) throw err;
      cardError = errMessage(err);
    }
  }

  return {
    memoriesActive: active.length,
    opsApplied,
    factsRevised,
    retired: retired.size,
    chunksProcessed,
    insightsCreated,
    insightsRepaired,
    insightsDropped,
    cardUpdated,
    ...(cardError ? { cardError } : {}),
    ...(insightError ? { insightError } : {}),
  };
};
