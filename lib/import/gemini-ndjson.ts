// Reader/validator for the raw NDJSON written by the upstream Gemini capture
// userscript (docs/GEMINI-IMPORT-PLAN.md §Upstream input contract; verified
// against userscript v0.1.3, where each line is
// `{ id, title, turns:[{role:"user"|"model",text}], source:"scraper", flags[] }`).
//
// Two jobs, both deliberately free of SQLite and settings so they are pure and
// unit-testable:
//  1. stream a spooled file **at byte level** — thousands of conversations must
//     ingest in flat memory (self-hosters run this on RPi-class boxes), and each
//     result carries the byte offset to resume from;
//  2. validate/normalize one line at a time (role mapping, empty-turn drop,
//     size cap, body hash) or classify it failed/empty/malformed — the importer
//     never trusts the file, because upstream can emit stale-page stubs.
//
// Line splitting is byte-safe: UTF-8 continuation bytes never contain 0x0A, so
// splitting on the newline byte can't cut a character in half.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const IMPORT_PROVIDER = "gemini";

/** Safety cap for one NDJSON line (a whole conversation is one JSON object).
 *  A longer line is counted malformed instead of buffering the rest of a file. */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Flags Yasha adds itself; upstream flags are preserved verbatim beside them. */
export type ImportFlag = "truncated" | "unknown-role" | "untitled" | "suspect-duplicates";

export type GeminiTurn = { role: "user" | "assistant"; text: string };

export type ParsedConversation = {
  externalId: string;
  /** Empty when absent or when it is upstream's `(untitled <id>)` placeholder. */
  title: string;
  turns: GeminiTurn[];
  /** Upstream flags, verbatim (e.g. `[]`, `["needs-review"]`). */
  upstreamFlags: string[];
  flags: ImportFlag[];
  /** SHA-256 over NUL-delimited `role`+`text` per turn. Ours, not upstream's
   *  (the format ships no hash): equal hash ⇒ equal content. */
  bodyHash: string;
};

export type RowResult =
  | { kind: "conversation"; conv: ParsedConversation; offsetAfter: number }
  /** Upstream gave up on this conversation (`flags:["failed",<reason>]`). */
  | { kind: "failed"; externalId: string; reason: string; offsetAfter: number }
  /** Parsed fine but holds no non-empty turn — nothing worth importing. */
  | { kind: "empty"; externalId: string; offsetAfter: number }
  | { kind: "malformed"; reason: string; offsetAfter: number };

export function bodyHashOf(turns: GeminiTurn[]): string {
  const hash = createHash("sha256");
  for (const turn of turns) hash.update(`${turn.role}\u0000${turn.text}\n`);
  return hash.digest("hex");
}

type RawTurn = { role?: unknown; text?: unknown };

/** One NDJSON line → classified row (blank/unparseable lines are the caller's
 *  "malformed" bucket; this never throws). */
export function classifyLine(line: string, maxMessageChars: number, offsetAfter: number): RowResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "malformed", reason: "invalid-json", offsetAfter };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", reason: "not-an-object", offsetAfter };
  }
  const obj = parsed as { id?: unknown; title?: unknown; turns?: unknown; flags?: unknown };
  const externalId = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!externalId) return { kind: "malformed", reason: "missing-id", offsetAfter };

  const upstreamFlags = Array.isArray(obj.flags)
    ? obj.flags.filter((f): f is string => typeof f === "string")
    : [];
  if (upstreamFlags.includes("failed")) {
    const reason = upstreamFlags.find((f) => f !== "failed") ?? "unspecified";
    return { kind: "failed", externalId, reason, offsetAfter };
  }
  if (!Array.isArray(obj.turns)) {
    return { kind: "malformed", reason: "missing-turns", offsetAfter };
  }

  // Flags accumulate as booleans so each appears at most once, in a stable order.
  let unknownRole = false;
  let truncated = false;
  const turns: GeminiTurn[] = [];
  for (const entry of obj.turns as RawTurn[]) {
    const rawRole = entry && typeof entry === "object" ? entry.role : undefined;
    const role = rawRole === "user" ? "user" : rawRole === "model" || rawRole === "assistant" ? "assistant" : null;
    if (!role) {
      unknownRole = true;
      continue;
    }
    // Image-only replies come through as empty text turns; keeping them would
    // add empty bubbles to an otherwise plain transcript.
    const text = (typeof entry.text === "string" ? entry.text : "").trim();
    if (!text) continue;
    if (text.length > maxMessageChars) {
      truncated = true;
      turns.push({ role, text: text.slice(0, maxMessageChars) });
      continue;
    }
    turns.push({ role, text });
  }
  if (turns.length === 0) return { kind: "empty", externalId, offsetAfter };

  const rawTitle = typeof obj.title === "string" ? obj.title.trim() : "";
  let title = rawTitle;
  let untitled = false;
  if (!title || title === `(untitled ${externalId})`) {
    title = "";
    untitled = true;
  }

  const flags: ImportFlag[] = [];
  if (unknownRole) flags.push("unknown-role");
  if (truncated) flags.push("truncated");
  if (untitled) flags.push("untitled");

  return {
    kind: "conversation",
    offsetAfter,
    conv: { externalId, title, turns, upstreamFlags, flags, bodyHash: bodyHashOf(turns) },
  };
}

export type NdjsonReadOptions = {
  maxMessageChars: number;
  /** Byte offset to resume from (a previously returned `offsetAfter`). */
  startOffset?: number;
  maxLineBytes?: number;
};

/** Streams `filePath` from `startOffset`, one classified row per non-blank line.
 *  Memory stays bounded by `maxLineBytes` whatever the file size. */
export async function* readGeminiNdjson(
  filePath: string,
  opts: NdjsonReadOptions
): AsyncGenerator<RowResult> {
  const maxLine = opts.maxLineBytes ?? MAX_LINE_BYTES;
  let consumed = opts.startOffset ?? 0;
  let parts: Buffer[] = [];
  let pendingLen = 0;
  // Set once a single line exceeds maxLine: drop bytes up to the next newline.
  let discarding = false;

  const decode = () => Buffer.concat(parts).toString("utf8").trimEnd();

  for await (const raw of createReadStream(filePath, { start: opts.startOffset ?? 0 })) {
    let buf = raw as Buffer;
    while (buf.length > 0) {
      const nl = buf.indexOf(0x0a);
      if (discarding) {
        if (nl === -1) {
          consumed += buf.length;
          break;
        }
        consumed += nl + 1;
        discarding = false;
        yield { kind: "malformed", reason: "line-too-long", offsetAfter: consumed };
        buf = buf.subarray(nl + 1);
        continue;
      }
      const segment = nl === -1 ? buf : buf.subarray(0, nl);
      if (pendingLen + segment.length > maxLine) {
        // Line over the cap: forget what we buffered (memory stays bounded) and
        // skip to its end.
        parts = [];
        pendingLen = 0;
        consumed += segment.length;
        if (nl === -1) {
          discarding = true;
          break;
        }
        consumed += 1;
        yield { kind: "malformed", reason: "line-too-long", offsetAfter: consumed };
        buf = buf.subarray(nl + 1);
        continue;
      }
      parts.push(segment);
      pendingLen += segment.length;
      if (nl === -1) {
        consumed += segment.length;
        break;
      }
      consumed += nl + 1;
      const line = pendingLen === 0 ? "" : decode();
      parts = [];
      pendingLen = 0;
      if (line) yield classifyLine(line, opts.maxMessageChars, consumed);
      buf = buf.subarray(nl + 1);
    }
  }

  if (discarding) {
    yield { kind: "malformed", reason: "line-too-long", offsetAfter: consumed };
  } else if (pendingLen > 0) {
    const line = decode();
    if (line) yield classifyLine(line, opts.maxMessageChars, consumed);
  }
}
