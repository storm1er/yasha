// Client-side message model for the chat surface (M4, docs/AI-SDK-MIGRATION-PLAN.MD).
//
// One render model fed from two sources:
//   - stored thread rows (GET /api/threads/[id]) → `storedToUiMessages`:
//     meta_json (content, tools, parts, audio, error) becomes UIMessages with
//     custom `data-tool` parts + metadata, so history flows through the exact
//     same projection as live turns;
//   - `useChat` streaming UIMessages → `projectMessages`: merges `data-tool`
//     events into chips (a terminal event replaces the running chip with the
//     same server+name — the v1 state machine), builds the ordered text/tools
//     segments, and surfaces voice-caption metadata and the failed-turn marker.
//
// Invisible parts: `data-thread` (adopted by the surface, not rendered) and
// `data-error` (triggers a thread resync; the notice renders from meta.error).

import type { TextUIPart, UIMessage } from "ai";
import { parseGenerativeCard, type GenerativeCard } from "@/lib/chat/generative";

export type ToolChip = {
  server: string;
  name: string;
  status: "running" | "done" | "error";
  /** JSON arguments string — present once the call is known (live or stored). */
  args?: string;
  /** Tool output (or error text) — present on terminal states. */
  result?: string;
  /** Result was cut at the server-side cap → amber warn chip (issue #8). */
  truncated?: boolean;
  /** Generative UI (issue #16): structured card from a valid yasha_card tool
   *  result — rendered under the chip; absent for plain results. */
  card?: GenerativeCard;
};

/** Ordered rendering segment of an assistant turn (issue #7): tool chips
 *  interleaved with the surrounding text in execution order. */
export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: ToolChip[] };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  audio?: string;
  audioTranscript?: string;
  audioTranscriptFailed?: boolean;
  audioCaptionPending?: boolean;
  tools?: ToolChip[];
  segments?: MessageSegment[];
  streaming?: boolean;
  /** Set when the assistant turn for this user message failed upstream
   *  (persisted in meta.error) — renders the red retry notice. */
  turnError?: string;
};

/** Raw row shape from GET /api/threads/[id]. */
export type ServerMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta?: Record<string, unknown> | null;
};

/** UIMessage.metadata: everything the renderer needs beyond the parts. */
export type ChatMessageMeta = {
  images?: string[];
  audio?: string;
  audioTranscript?: string;
  audioTranscriptFailed?: boolean;
  audioCaptionPending?: boolean;
  turnError?: string;
};

/** Custom UI-stream parts of protocol v2 (lib/chat/stream.ts). */
export type YashaDataParts = {
  thread: { threadId: string };
  tool: ToolChip;
  error: { code: string };
};

export type YashaUIMessage = UIMessage<ChatMessageMeta, YashaDataParts>;

type TextPart = TextUIPart;

const isTextPart = (p: YashaUIMessage["parts"][number]): p is TextPart => p.type === "text";

/** Concatenated text content of a UIMessage (transport body + rendering). */
export function messageText(m: YashaUIMessage | undefined): string {
  return m ? m.parts.filter(isTextPart).map((p) => p.text).join("") : "";
}

/** True while a stored audio message has no caption outcome yet (job pending
 *  or never enqueued — the caller decides between pending/unavailable). */
export function captionPending(m: ServerMessage): boolean {
  const meta = m.meta;
  return Boolean(
    meta &&
      typeof meta.audio === "string" &&
      typeof meta.audioTranscript !== "string" &&
      meta.audioTranscriptFailed !== true,
  );
}

/** The thread id announced by the stream (data-thread part), if any. */
export function threadIdFromMessages(messages: YashaUIMessage[]): string | null {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "data-thread") return p.data.threadId;
    }
  }
  return null;
}

/** True when the last (assistant) message carries the terminal data-error
 *  part — the surface resyncs the thread so meta.error renders in place. */
export function lastTurnErrored(messages: YashaUIMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === "assistant" && last.parts.some((p) => p.type === "data-error");
}

/** Stored flat `meta.tools` → terminal chips (the v1 row filter: entries
 *  without server/name/ok are junk and get dropped). */
function storedChips(tools: unknown): ToolChip[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(
      (t): t is Record<string, unknown> =>
        !!t &&
        typeof t === "object" &&
        typeof (t as { server?: unknown }).server === "string" &&
        typeof (t as { name?: unknown }).name === "string" &&
        typeof (t as { ok?: unknown }).ok === "boolean",
    )
    .map((t) => {
      const card = parseGenerativeCard(t.card);
      return {
        server: t.server as string,
        name: t.name as string,
        status: t.ok ? ("done" as const) : ("error" as const),
        args: typeof t.args === "string" ? t.args : undefined,
        result: typeof t.result === "string" ? t.result : undefined,
        truncated: t.truncated === true ? true : undefined,
        // Malformed persisted cards degrade to no-card (stored data is trusted
        // but re-validated — the renderer must never see a partial shape).
        ...(card ? { card } : {}),
      };
    });
}

/**
 * Stored `meta.parts` + flat chips → the parts a live turn would have
 * streamed (text parts interleaved with data-tool parts). Mirrors v1's
 * `mapSegments`: undefined on ANY mismatch (legacy rows, malformed data) so
 * the caller falls back to "chips above the text". `tools` parts consume the
 * flat chip list in order.
 */
function partsFromStoredMeta(
  rawParts: unknown,
  chips: ToolChip[],
): YashaUIMessage["parts"] | undefined {
  if (!Array.isArray(rawParts)) return undefined;
  const out: YashaUIMessage["parts"] = [];
  let i = 0;
  for (const entry of rawParts) {
    if (!entry || typeof entry !== "object") return undefined;
    const part = entry as { type?: unknown; text?: unknown; count?: unknown };
    if (part.type === "text") {
      if (typeof part.text !== "string") return undefined;
      out.push({ type: "text", text: part.text });
    } else if (part.type === "tools") {
      const n =
        typeof part.count === "number" && Number.isInteger(part.count) && part.count >= 0
          ? part.count
          : -1;
      if (n < 0 || i + n > chips.length) return undefined;
      for (const chip of chips.slice(i, i + n)) out.push({ type: "data-tool", data: chip });
      i += n;
    } else {
      return undefined;
    }
  }
  return i === chips.length ? out : undefined;
}

/** Thread rows → UIMessages (metadata + parts) for `useChat.setMessages`. */
export function storedToUiMessages(rows: ServerMessage[]): YashaUIMessage[] {
  return rows.map((m) => {
    const meta = m.meta ?? {};
    const messageMeta: ChatMessageMeta = {};
    if (Array.isArray(meta.images)) {
      const images = meta.images.filter((s): s is string => typeof s === "string");
      if (images.length > 0) messageMeta.images = images;
    }
    if (typeof meta.audio === "string") messageMeta.audio = meta.audio;
    if (typeof meta.audioTranscript === "string") messageMeta.audioTranscript = meta.audioTranscript;
    if (meta.audioTranscriptFailed === true) messageMeta.audioTranscriptFailed = true;
    if (typeof meta.error === "string") messageMeta.turnError = meta.error;

    let parts: YashaUIMessage["parts"] = [];
    if (m.role === "assistant") {
      const chips = storedChips(meta.tools);
      parts = partsFromStoredMeta(meta.parts, chips) ?? [
        ...chips.map((chip) => ({ type: "data-tool" as const, data: chip })),
        ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
      ];
    } else if (m.content) {
      parts = [{ type: "text", text: m.content }];
    }
    return { id: m.id, role: m.role, metadata: messageMeta, parts };
  });
}

/**
 * UIMessages (stored or live) → the renderer's ChatMessage model. Assistant
 * turns: text parts coalesce into text segments; data-tool events keep the v1
 * chip state machine (terminal replaces the running chip with the same
 * server+name, otherwise the chip appends — to the trailing tools segment or
 * as a new one). Assistant messages with nothing visible (pure data-thread /
 * data-error bookkeeping) produce no row — that is the "awaiting first token"
 * state. When `streaming` is true, the LAST assistant row is flagged so the
 * surface knows to hide copy/regenerate affordances.
 */
export function projectMessages(messages: YashaUIMessage[], streaming: boolean): ChatMessage[] {
  const out: ChatMessage[] = [];
  messages.forEach((m, idx) => {
    const meta = m.metadata ?? {};
    const content = messageText(m);
    if (m.role === "user") {
      out.push({
        id: m.id,
        role: "user",
        content,
        images: meta.images,
        audio: meta.audio,
        audioTranscript: meta.audioTranscript,
        audioTranscriptFailed: meta.audioTranscriptFailed,
        audioCaptionPending: meta.audioCaptionPending,
        turnError: meta.turnError,
      });
      return;
    }
    const tools: ToolChip[] = [];
    const segments: MessageSegment[] = [];
    for (const part of m.parts) {
      if (isTextPart(part)) {
        if (part.text === "") continue;
        const lastSeg = segments.at(-1);
        if (lastSeg?.kind === "text") {
          segments[segments.length - 1] = { kind: "text", text: lastSeg.text + part.text };
        } else {
          segments.push({ kind: "text", text: part.text });
        }
        continue;
      }
      if (part.type !== "data-tool") continue; // data-thread/data-error: not rendered here
      const chip = { ...part.data };
      const flatIdx = tools.findIndex(
        (tc) => tc.status === "running" && tc.server === chip.server && tc.name === chip.name,
      );
      if (flatIdx >= 0) tools[flatIdx] = chip;
      else tools.push(chip);
      const lastSeg = segments.at(-1);
      if (lastSeg?.kind === "tools") {
        const segIdx = lastSeg.tools.findIndex(
          (tc) => tc.status === "running" && tc.server === chip.server && tc.name === chip.name,
        );
        if (segIdx >= 0) lastSeg.tools[segIdx] = chip;
        else lastSeg.tools.push(chip);
      } else {
        segments.push({ kind: "tools", tools: [chip] });
      }
    }
    if (content === "" && tools.length === 0) return; // nothing visible yet
    out.push({
      id: m.id,
      role: "assistant",
      content,
      tools: tools.length > 0 ? tools : undefined,
      // A projected row always carries at least one segment (non-empty text
      // or at least one chip — invisible-only messages are skipped above).
      segments,
      streaming: streaming && idx === messages.length - 1 ? true : undefined,
    });
  });
  return out;
}
