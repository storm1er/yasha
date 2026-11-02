// Resume-stream replay hub (issue #33, docs/protocol-v3.md §Resume streams).
//
// Generation is DECOUPLED from the response connection: the hub buffers every
// SSE frame of a turn and fans out to any number of views — the original POST
// response plus reattaches via GET /api/chat/[threadId]/stream (the SDK's
// default reconnect URL; a view starting late replays the buffer from zero,
// which is what `resumeStreamIsReplay` expects). A client disconnect only
// unsubscribes its view: generation runs to completion and persists.
//
// Killing is explicit. `openReplay` receives a kill hook (abort the turn +
// mark it aborted so the partial row persists as aborted:true); the stop route
// invokes it. Frames are pre-encoded SSE strings — byte-identical to the SDK's
// `JsonToSseTransformStream` (`data: {...}\n\n`, closed by `data: [DONE]\n\n`),
// so `DefaultChatTransport.processResponseStream` parses hub views unchanged.
//
// Process-local registry, same single-instance assumption as the busy gate.

export type ReplaySink = {
  /** Append an encoded SSE frame to the buffer and broadcast to live views. */
  frame(text: string): void;
  /** Terminal: append the [DONE] sentinel, close every view, drop the hub. */
  close(): void;
  /** Fresh view for this generation: buffered frames, then live until close. */
  view(): ReadableStream<string>;
};

type Entry = {
  frames: string[];
  views: Set<ReadableStreamDefaultController<string>>;
  heartbeat?: ReturnType<typeof setInterval>;
  kill: () => void;
};

const hubs = new Map<string, Entry>();
const hubKey = (userId: string, threadId: string) => `${userId}:${threadId}`;

/** A view that connects many frames must not be unbounded memory: beyond the
 *  cap, reattaches answer 204 (the caller falls back to a history reload). */
const MAX_VIEWS = 8;

/** SSE headers shared by the POST response and reattach GET (identical to
 *  what createUIMessageStreamResponse sent before the hub took over). */
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-store, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

export function sseResponse(view: ReadableStream<string>): Response {
  // Response bodies are byte streams; hub views are text.
  return new Response(view.pipeThrough(new TextEncoderStream()), { headers: SSE_HEADERS });
}

function viewOf(entry: Entry): ReadableStream<string> | null {
  if (entry.views.size >= MAX_VIEWS) return null;
  let ctrl!: ReadableStreamDefaultController<string>;
  return new ReadableStream<string>({
    start(c) {
      ctrl = c;
      for (const f of entry.frames) c.enqueue(f);
      entry.views.add(c);
    },
    cancel() {
      entry.views.delete(ctrl);
    },
  });
}

/** Open the hub for one generation. A lingering entry for the same user+thread
 *  is killed first (the busy gate prevents real overlap; this is the stuck-hub
 *  safety net) — its views terminate with the killed stream. */
export function openReplay(
  userId: string,
  threadId: string,
  heartbeatMs: number | undefined,
  kill: () => void,
): ReplaySink {
  killReplay(userId, threadId);
  const entry: Entry = { frames: [], views: new Set(), kill };
  const key = hubKey(userId, threadId);
  hubs.set(key, entry);
  if (heartbeatMs) {
    // Buffered first frame, mirroring createSseStreamWithKeepAlive (replays
    // see it too — SSE parsers skip comments).
    entry.frames.push(": stream-open\n\n");
    entry.heartbeat = setInterval(() => {
      // Idle pings only when the view is draining (mirrors the SDK keep-alive).
      for (const ctrl of entry.views)
        if (ctrl.desiredSize === null || ctrl.desiredSize > 0) ctrl.enqueue(": keep-alive\n\n");
    }, heartbeatMs);
  }
  const sink: ReplaySink = {
    frame(text) {
      entry.frames.push(text);
      for (const ctrl of entry.views) ctrl.enqueue(text);
    },
    close() {
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      // Only the live hub may terminate itself (a stale sink must not delete a
      // successor's registry entry).
      if (hubs.get(key) === entry) hubs.delete(key);
      sink.frame("data: [DONE]\n\n");
      for (const ctrl of entry.views) ctrl.close();
      entry.views.clear();
    },
    view() {
      // No capacity / already closed: an empty DONE-only stream keeps the SDK
      // happy (it parses zero chunks and finishes).
      return viewOf(entry) ?? new ReadableStream<string>({ start: (c) => c.close() });
    },
  };
  return sink;
}

/** Attach a late view to the in-flight generation for user+thread, or null
 *  when nothing is running (→ 204). Ownership is implicit: the key is the
 *  authenticated user id, another user's thread never matches. */
export function attachReplay(userId: string, threadId: string): ReadableStream<string> | null {
  const entry = hubs.get(hubKey(userId, threadId));
  return entry ? viewOf(entry) : null;
}

export function isGenerating(userId: string, threadId: string): boolean {
  return hubs.has(hubKey(userId, threadId));
}

/** Explicit kill of the in-flight generation (stop route). True if one was
 *  running; the kill hook owns the abort + partial-persist bookkeeping. */
export function killReplay(userId: string, threadId: string): boolean {
  const entry = hubs.get(hubKey(userId, threadId));
  if (!entry) return false;
  entry.kill();
  return true;
}
