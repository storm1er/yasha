"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, ChevronDown, Copy, Loader2, Menu, RefreshCw, X } from "lucide-react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useChat } from "@ai-sdk/react";
import { Sparkle } from "@/components/brand/sparkle";
import { useChatShell } from "@/components/chat/chat-shell";
import { CodeBlock } from "@/components/chat/code-block";
import { GenUiCardView } from "@/components/chat/gen-ui";
import { Composer, type ComposerAttachment } from "@/components/chat/composer";
import {
  captionPending,
  lastTurnErrored,
  projectMessages,
  storedToUiMessages,
  threadIdFromMessages,
  type ChatMessage,
  type ChatMessageMeta,
  type InteractiveAsk,
  type ServerMessage,
  type ToolApproval,
  type ToolChip,
  type YashaUIMessage,
} from "@/lib/chat/ui-messages";
import type { GenerativeCard } from "@/lib/chat/generative";
import { useAudioConfig } from "@/lib/browser/use-audio-input";
import type { ModelCapabilities } from "@/components/chat/model-picker";
import { Button } from "@/components/ui/button";

const MD_COMPONENTS: Components = {
  pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
};

function prefersReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatToolJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function ToolChipRow({
  tools,
  label,
}: {
  tools: ToolChip[];
  label: (status: ToolChip["status"], name: string) => string;
}) {
  return (
    <div data-testid="tool-chips" className="mb-2 flex flex-wrap gap-1.5">
      {tools.map((tc, i) => (
        <ToolChipView key={`${tc.server}:${tc.name}:${i}`} tool={tc} label={label(tc.status, tc.name)} />
      ))}
    </div>
  );
}

function ToolSegments({
  segments,
  label,
}: {
  segments: NonNullable<ChatMessage["segments"]>;
  label: (status: ToolChip["status"], name: string) => string;
}) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "tools" ? (
          <ToolChipRow key={`tools-${i}`} tools={seg.tools} label={label} />
        ) : seg.kind === "card" ? (
          <GenUiCardView key={seg.card.id} card={seg.card} />
        ) : (
          <div key={`text-${i}`} className="md text-[15px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {seg.text}
            </ReactMarkdown>
          </div>
        ),
      )}
    </>
  );
}

// Generative UI card (issue #16, Milestone 1): display-only structure emitted
// by a tool result envelope (lib/chat/generative.ts). All text is tool data —
// no new i18n strings; body renders as plain text (no markdown injection).
function GenerativeCardView({ card }: { card: GenerativeCard }) {
  return (
    <div
      data-testid={`generative-card-${card.kind}`}
      className="mt-1 w-[min(420px,80vw)] min-w-0 rounded-xl border bg-card p-3 shadow-sm"
    >
      <div className="text-sm font-medium">{card.title}</div>
      {card.body && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
          {card.body}
        </p>
      )}
      {card.fields && card.fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          {card.fields.map((f, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="break-words">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.links && card.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {card.links.map((l, i) => (
            <a
              key={i}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border px-2 py-0.5 text-xs text-primary transition-colors hover:bg-muted"
            >
              {l.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// Protocol v3 interactive ask (ask_choice / confirm_action): the question the
// server paused on, with answer buttons feeding addToolOutput (the resume turn
// auto-sends). Once answered the buttons give way to the recorded answer.
function InteractiveAskView({
  ask,
  disabled,
  t,
  onAnswer,
}: {
  ask: InteractiveAsk;
  disabled: boolean;
  t: ReturnType<typeof useTranslations>;
  onAnswer: (ask: InteractiveAsk, output: string) => void;
}) {
  if (ask.answered !== undefined) {
    return (
      <p data-testid="ask-answered" className="text-sm text-muted-foreground">
        {t("askAnswered", { answer: ask.answered })}
      </p>
    );
  }
  const buttons =
    ask.tool === "ask_choice"
      ? (ask.options ?? []).map((o) => ({ label: o, output: o }))
      : [
          { label: t("askConfirm"), output: "confirmed" },
          { label: t("askCancel"), output: "cancelled" },
        ];
  return (
    <div data-testid="interactive-ask" className="rounded-2xl border border-primary/30 bg-card px-4 py-3">
      <p className="text-[15px] font-medium">{ask.question}</p>
      {ask.detail && <p className="mt-1 text-sm text-muted-foreground">{ask.detail}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {buttons.map((b) => (
          <button
            key={b.output}
            type="button"
            disabled={disabled}
            data-testid="ask-option"
            onClick={() => onAnswer(ask, b.output)}
            className="rounded-full border border-primary/40 px-4 py-1.5 text-sm transition-colors hover:bg-primary/10 disabled:opacity-50"
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// MCP-tool approval (issue #32): a paused MCP call waiting for an explicit
// verdict. Approve/Deny feed addToolOutput like the interactive asks — the
// resume request executes (or refuses) the deferred tool server-side.
function ToolApprovalView({
  approval,
  disabled,
  t,
  onAnswer,
}: {
  approval: ToolApproval;
  disabled: boolean;
  t: ReturnType<typeof useTranslations>;
  onAnswer: (approval: ToolApproval, output: string) => void;
}) {
  if (approval.answered !== undefined) {
    return (
      <p data-testid="approval-answered" className="text-sm text-muted-foreground">
        {t("askAnswered", { answer: approval.answered === "approved" ? t("approve") : t("deny") })}
      </p>
    );
  }
  return (
    <div data-testid="tool-approval" className="rounded-2xl border border-amber-500/40 bg-card px-4 py-3">
      <p className="text-[15px] font-medium">{t("approvalQuestion", { tool: approval.tool })}</p>
      {approval.server !== "" && (
        <p className="mt-0.5 text-xs text-muted-foreground">{t("approvalServer", { server: approval.server })}</p>
      )}
      {approval.args && (
        <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-muted px-2 py-1.5 text-xs">{approval.args}</pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          data-testid="approval-approve"
          onClick={() => onAnswer(approval, "approved")}
          className="rounded-full border border-emerald-500/50 px-4 py-1.5 text-sm transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
        >
          {t("approve")}
        </button>
        <button
          type="button"
          disabled={disabled}
          data-testid="approval-deny"
          onClick={() => onAnswer(approval, "denied")}
          className="rounded-full border border-destructive/40 px-4 py-1.5 text-sm transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          {t("deny")}
        </button>
      </div>
    </div>
  );
}

function ToolChipView({ tool, label }: { tool: ToolChip; label: string }) {
  const t = useTranslations("chat");
  const [open, setOpen] = useState(false);
  const expandable = typeof tool.args === "string" || typeof tool.result === "string";
  // Warn (amber) when the server cut the output at the tool-result cap
  // (issue #8); errors keep their red styling.
  const warn = tool.truncated === true && tool.status !== "error";
  const icon =
    tool.status === "running" ? (
      <Loader2 className="size-3 animate-spin" aria-hidden />
    ) : tool.status === "error" ? (
      <X className="size-3 text-destructive" aria-hidden />
    ) : warn ? (
      <AlertTriangle className="size-3" aria-hidden />
    ) : (
      <Check className="size-3" aria-hidden />
    );
  const chipLabel = warn ? t("toolTruncated", { name: tool.name }) : label;
  return (
    <div className="max-w-full min-w-0">
      <button
        type="button"
        aria-expanded={open}
        disabled={!expandable}
        onClick={() => expandable && setOpen((o) => !o)}
        data-testid={warn ? "tool-chip-truncated" : "tool-chip"}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
          warn ? "border-amber-500/60 text-amber-600 dark:text-amber-400" : "text-muted-foreground"
        } ${expandable ? "cursor-pointer transition-colors hover:bg-muted hover:text-foreground" : ""}`}
      >
        {icon}
        {chipLabel}
        {expandable && (
          <ChevronDown
            className={`size-3 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        )}
      </button>
      {tool.card && <GenerativeCardView card={tool.card} />}
      {open && expandable && (
        <div className="mt-1 w-[min(420px,80vw)] min-w-0 rounded-xl border bg-muted/50 p-2 text-xs">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {tool.server}
          </div>
          {typeof tool.args === "string" && tool.args !== "" && (
            <div className="mb-1.5">
              <div className="mb-0.5 font-medium text-muted-foreground">{t("toolArgs")}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-1.5 font-mono text-[11px]">
                {formatToolJson(tool.args)}
              </pre>
            </div>
          )}
          {typeof tool.result === "string" ? (
            <div>
              <div className="mb-0.5 font-medium text-muted-foreground">{t("toolResult")}</div>
              <pre
                className={`max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-1.5 font-mono text-[11px] ${
                  tool.status === "error" ? "text-destructive" : ""
                }`}
              >
                {tool.result}
              </pre>
            </div>
          ) : (
            <div className="italic text-muted-foreground">{t("toolNoResult")}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatSurface({ initialThreadId }: { initialThreadId: string | null }) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const router = useRouter();
  const shell = useChatShell();

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showFab, setShowFab] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [caps, setCaps] = useState<ModelCapabilities | null>(null);
  const [threadModel, setThreadModel] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(initialThreadId !== null);

  const threadIdRef = useRef<string | null>(initialThreadId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const selectedModelRef = useRef<string | null>(null);
  // Bookkeeping for the in-flight send: what went out (voice → caption poll)
  // and whether it adopted a brand-new thread (sidebar title await).
  const pendingSendRef = useRef<{ audio?: string } | null>(null);
  const createdThreadRef = useRef<string | null>(null);
  const pollGenRef = useRef(0);

  // The picker reports its effective value on init (thread model > stored >
  // default) and on every change, so this ref always mirrors what is shown.
  // On a NEW chat every report doubles as the warmup trigger (issue #67):
  // the effective model is now known, so fire the discarded warm completion
  // (model load + memory-prefix prefill) before the first message is typed.
  // Fire-and-forget — the endpoint is session-gated and dedupes server-side.
  const handleModelChange = useCallback((id: string) => {
    selectedModelRef.current = id;
    if (threadIdRef.current === null) {
      void fetch("/api/backend/warm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: id }),
      }).catch(() => {
        /* warmup is best-effort */
      });
    }
  }, []);

  // Protocol v3 transport (docs/protocol-v3.md): the stock useChat body —
  // thread id + the full client window — with model/attachments appended as
  // extra fields. History is transport only: the server reconciles ids and
  // hydrates content from its own rows (lib/chat/request-v3.ts).
  // `prepareReconnectToStreamRequest` is an imperative SDK callback — it reads
  // the thread ref at RESUME time, never during render, but the compiler
  // attributes the whole transport construction to the render phase (scoped
  // disable below). Undefined ⇒ default URL, which matches no hub while no
  // thread is open (204, no-resume).
  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      new DefaultChatTransport<YashaUIMessage>({
        api: "/api/chat",
        fetch: (url, init) =>
          globalThis.fetch(url, init).then((res) => {
            if (res.status === 401) router.replace("/login");
            return res;
          }),
        // Assembled per send: id + extras come from send() (ChatRequestOptions
        // .body), the window from useChat's own state.
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { messages, ...(body ?? {}) },
        }),
        // Issue #33 reattach: point the SDK's `GET ${api}/${chatId}/stream`
        // probe at the CURRENT thread's replay hub (the chat id is constant —
        // the thread lives in a ref, not the chat identity).
        prepareReconnectToStreamRequest: () => {
          const t = threadIdRef.current;
          return { api: t ? `/api/chat/${encodeURIComponent(t)}/stream` : undefined };
        },
      }),
    [router]
  );

  const { messages, setMessages, sendMessage, stop, status, addToolOutput, resumeStream } =
    useChat<YashaUIMessage>({
      transport,
      // Answering an interactive ask (addToolOutput) immediately sends the v3
      // resume request carrying the tool output (docs/protocol-v3.md).
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      // Transport-level failure (HTTP status, network death): the sent user
      // message stays visible next to the error + Retry action below.
      onError: () => setError("error"),
    });
  const streaming = status === "submitted" || status === "streaming";
  const projected = useMemo(() => projectMessages(messages, streaming), [messages, streaming]);

  // Voice-message captions: after a voice turn (or a caption retry), poll the
  // thread until the background caption job lands (bounded — 8 × 4 s).
  const pollCaptions = useCallback(
    async (threadId: string, isCancelled: () => boolean) => {
      for (let i = 0; i < 8; i++) {
        await new Promise<void>((r) => setTimeout(r, 4000));
        if (isCancelled()) return;
        try {
          const res = await fetch(`/api/threads/${threadId}`, { cache: "no-store" });
          if (!res.ok) return;
          const data = (await res.json()) as { messages: ServerMessage[] };
          if (isCancelled()) return;
          const pending = data.messages.some(captionPending);
          if (!pending || i === 7) {
            setMessages(storedToUiMessages(data.messages));
            return;
          }
        } catch {
          return;
        }
      }
    },
    [setMessages]
  );

  const retryCaption = useCallback(
    async (messageId: string, threadId: string) => {
      try {
        const res = await fetch(`/api/chat/messages/${messageId}/transcribe`, { method: "POST" });
        if (!res.ok) return;
      } catch {
        return;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                metadata: { ...m.metadata, audioTranscriptFailed: false, audioCaptionPending: true },
              }
            : m
        )
      );
      const gen = ++pollGenRef.current;
      void pollCaptions(threadId, () => pollGenRef.current !== gen || threadIdRef.current !== threadId);
    },
    [pollCaptions, setMessages]
  );

  /** Reload a thread after a failed turn so the server-persisted error
   *  annotation (meta.error) renders as the in-thread retry notice. */
  const resyncThread = useCallback(
    async (threadId: string) => {
      try {
        const res = await fetch(`/api/threads/${threadId}`, { cache: "no-store" });
        if (!res.ok) {
          setError("error");
          return;
        }
        const data = (await res.json()) as { messages: ServerMessage[] };
        setMessages(storedToUiMessages(data.messages));
      } catch {
        setError("error");
      }
    },
    [setMessages]
  );

  // Thread adoption: the first data-thread part of a brand-new conversation
  // rewrites the URL without a navigation (v1 parity).
  useEffect(() => {
    if (threadIdRef.current) return;
    const tid = threadIdFromMessages(messages);
    if (!tid) return;
    threadIdRef.current = tid;
    createdThreadRef.current = tid;
    window.history.replaceState(null, "", `/c/${tid}`);
    shell.notifyActiveThread(tid);
  }, [messages, shell]);

  // Failed turns: the terminal data-error part means the server annotated the
  // user message (meta.error) — resync so the in-thread retry notice renders.
  useEffect(() => {
    if (streaming) return;
    const tid = threadIdRef.current;
    if (tid && lastTurnErrored(messages)) void resyncThread(tid);
  }, [messages, streaming, resyncThread]);

  // Turn-finished bookkeeping (v1's send-finally): sidebar refresh + title
  // polling for fresh threads, caption polling for voice turns.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev !== "submitted" && prev !== "streaming") return;
    if (status !== "ready" && status !== "error") return;
    shell.refreshThreads();
    const created = createdThreadRef.current;
    createdThreadRef.current = null;
    if (created) shell.awaitThreadTitle(created);
    const sent = pendingSendRef.current;
    if (sent?.audio && threadIdRef.current) {
      const tid = threadIdRef.current;
      const gen = ++pollGenRef.current;
      void pollCaptions(tid, () => pollGenRef.current !== gen || threadIdRef.current !== tid);
    }
  }, [status, shell, pollCaptions]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: streaming && !prefersReduced() ? "auto" : "smooth",
    });
  }, [projected, streaming]);

  // Thread navigation (sidebar, /c/new, delete → router): load from the API
  // and swap the chat state wholesale. The null branch deliberately does NOT
  // touch messages: the history.replaceState on thread adoption makes Next's
  // HistoryUpdater re-render with a fresh router object, and this effect
  // re-running then would abort and wipe the in-flight turn (thread→new
  // clearing is startNewChat's job instead).
  useEffect(() => {
    // Never overwrite an adopted thread id with the still-null prop (the
    // adoption replaceState re-fires this effect with initialThreadId=null).
    threadIdRef.current = initialThreadId ?? threadIdRef.current;
    const run = async () => {
      setLoadingHistory(initialThreadId !== null);
      if (!initialThreadId) {
        setThreadModel(null);
        return;
      }
      stop(); // a turn from a previous thread must not stream into this one
      createdThreadRef.current = null;
      shell.notifyActiveThread(initialThreadId);
      const res = await fetch(`/api/threads/${initialThreadId}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 403) {
        if (alive) setLoadingHistory(false);
        router.replace("/c/new");
        return;
      }
      if (!res.ok) {
        if (alive) {
          setLoadingHistory(false);
          setError("error");
        }
        return;
      }
      const data = (await res.json()) as {
        thread?: { model?: string | null; generating?: boolean };
        messages: ServerMessage[];
      };
      if (alive) {
        stickRef.current = true;
        setLoadingHistory(false);
        setThreadModel(data.thread?.model ?? null);
        setMessages(storedToUiMessages(data.messages));
        // Issue #33: the turn may still be generating server-side (reload or
        // reconnect mid-turn) — reattach and replay it live from frame zero.
        if (data.thread?.generating === true) void resumeStream();
      }
    };
    let alive = true;
    void run().catch(() => {
      if (alive) {
        setLoadingHistory(false);
        setError("error");
      }
    });
    return () => {
      alive = false;
    };
  }, [initialThreadId, router, shell, setMessages, stop, resumeStream]);

  /** Explicit server-side stop (issue #33): a local stop() only closes this
   *  view — the detached generation would keep running upstream. The stop
   *  route aborts the turn (partial persists as aborted), then we release UI.
   *  Before the first data-thread arrives there is no id to target: the turn
   *  finishes server-side and shows up on the thread (documented window). */
  const stopAll = useCallback(async () => {
    const t = threadIdRef.current;
    if (t) {
      try {
        await fetch("/api/chat/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: t }),
        });
      } catch {
        /* best-effort: the local stop below still releases the UI */
      }
    }
    stop();
  }, [stop]);

  const send = useCallback(
    (rawText: string, images?: string[], audioUrl?: string) => {
      const text = rawText.trim();
      const imgs = images?.length ? images : undefined;
      const audio = audioUrl || undefined;
      if ((!text && !imgs && !audio) || streaming) return;
      setError(null);
      pendingSendRef.current = { audio };
      createdThreadRef.current = null;
      setInput("");
      setAttachments([]);
      stickRef.current = true;
      const meta: ChatMessageMeta = {};
      if (imgs) meta.images = imgs;
      if (audio) meta.audio = audio;
      // v3 body extras — id (thread adoption rewrites the ref mid-session) +
      // attachments/model; the transport appends the useChat window (which
      // already carries this turn's text message) to form the standard body.
      const body: Record<string, unknown> = { id: threadIdRef.current ?? "new" };
      if (imgs || audio) {
        const sendAttachments: Record<string, unknown> = {};
        if (imgs) sendAttachments.images = imgs;
        if (audio) sendAttachments.audio = audio;
        body.attachments = sendAttachments;
      }
      if (selectedModelRef.current) body.model = selectedModelRef.current;
      void sendMessage(
        Object.keys(meta).length > 0 ? { text, metadata: meta } : { text },
        { body }
      );
    },
    [streaming, sendMessage]
  );

  /** Resend a user turn (retry after failure / regenerate): a trailing failed
   *  row is dropped from the list first — the server replaces it on the wire. */
  function retryTurn(m: ChatMessage) {
    if (streaming) return;
    setError(null);
    setMessages((prev) => (prev.at(-1)?.id === m.id ? prev.filter((x) => x.id !== m.id) : prev));
    send(m.content, m.images, m.audio);
  }

  /** Answer an interactive ask (protocol v3): the output rides the trailing
   *  assistant tool part and sendAutomaticallyWhen fires the resume request
   *  right away — body extras carry the thread id (no send() wrapper here). */
  const answerAsk = useCallback(
    (ask: InteractiveAsk, output: string) => {
      addToolOutput({
        tool: ask.tool,
        toolCallId: ask.toolCallId,
        output,
        options: { body: { id: threadIdRef.current ?? "new" } },
      });
    },
    [addToolOutput]
  );

  /** Answer an MCP-tool approval (issue #32): identical resume machinery —
   *  the verdict rides the synthetic `mcp_approval` tool part; the server
   *  executes or refuses the deferred call and overlays its result. */
  const answerApproval = useCallback(
    (approval: ToolApproval, output: string) => {
      addToolOutput({
        tool: "mcp_approval",
        toolCallId: approval.toolCallId,
        output,
        options: { body: { id: threadIdRef.current ?? "new" } },
      });
    },
    [addToolOutput]
  );

  const startNewChat = useCallback(() => {
    // Reset local state first: after the first message the thread URL is set
    // via history.replaceState, which does not update router state, so
    // router.push("/c/new") would be a no-op while the path says otherwise.
    stop();
    threadIdRef.current = null;
    createdThreadRef.current = null;
    setLoadingHistory(false);
    setMessages([]);
    setAttachments([]);
    setError(null);
    setThreadModel(null);
    shell.notifyActiveThread(null);
    const path = window.location.pathname.replace(/\/$/, "");
    if (path !== "/c/new") router.push("/c/new");
  }, [router, shell, setMessages, stop]);

  const threadDeleted = useCallback(
    (threadId: string) => {
      if (threadIdRef.current === threadId) {
        stop();
        threadIdRef.current = null;
        setLoadingHistory(false);
        setMessages([]);
        setAttachments([]);
        setThreadModel(null);
        window.history.replaceState(null, "", "/c/new");
      }
    },
    [setMessages, stop]
  );

  useEffect(() => {
    shell.setSurfaceHandlers({ newChat: startNewChat, threadDeleted });
    return () => shell.setSurfaceHandlers(null);
  }, [shell, startNewChat, threadDeleted]);

  const audioCfg = useAudioConfig();

  async function copyMessage(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = gap < 120;
    setShowFab(gap >= 120);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReduced() ? "auto" : "smooth" });
    stickRef.current = true;
    setShowFab(false);
  }

  const showHero = projected.length === 0 && !streaming && !loadingHistory;
  const toolLabel = (status: ToolChip["status"], name: string) =>
    status === "running"
      ? t("toolRunning", { name })
      : status === "done"
        ? t("toolDone", { name })
        : t("toolError", { name });
  const awaitingFirstToken =
    streaming && !projected.some((m) => m.role === "assistant" && m.streaming);
  const lastAssistantId = projected.filter((m) => m.role === "assistant").at(-1)?.id;
  const lastUserMsg = projected.findLast((m) => m.role === "user");

  function regenerate() {
    if (!lastUserMsg || streaming) return;
    retryTurn(lastUserMsg);
  }

  const noVisionWarning = caps?.noVision ? (
    <p
      data-testid="no-vision-warning"
      className="text-[13px] leading-snug text-amber-600 dark:text-amber-400"
    >
      {t("noVisionModel")}{" "}
      <Link href="/settings" className="underline underline-offset-2">
        {tc("settings")}
      </Link>
    </p>
  ) : null;

  const showModelSetupNotice = caps !== null && caps.models.length === 0 && !caps.noVision;
  const modelSetupNotice = showModelSetupNotice ? (
    <p
      data-testid="model-setup-notice"
      className="text-[13px] leading-snug text-amber-600 dark:text-amber-400"
    >
      {t("noModelConfigured")}{" "}
      <Link href="/settings?tab=backend" className="underline underline-offset-2">
        {tc("settings")}
      </Link>
    </p>
  ) : null;

  const composerProps = {
    value: input,
    onChange: setInput,
    onSubmit: () => send(input, attachments.map((a) => a.dataUrl)),
    streaming,
    onStop: stopAll,
    onModelChange: handleModelChange,
    onModelCapabilities: setCaps,
    threadModel,
    attachments,
    onAttachmentsChange: setAttachments,
    audioEnabled: audioCfg.enabled,
    smartModelId: audioCfg.smartModel,
    maxAudioBytes: audioCfg.maxAudioBytes,
    onAudioRecorded: (dataUrl: string) => send(input, attachments.map((a) => a.dataUrl), dataUrl),
  };

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col overflow-x-hidden">
        {loadingHistory && (
          <div
            data-testid="loading-bar"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label={tc("loading")}
            className="topbar"
          />
        )}
        <header className="flex items-center gap-1 px-2 py-1.5 md:hidden">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid="menu-button"
            aria-label={t("openMenu")}
            onClick={shell.openMobileNav}
          >
            <Menu className="size-5" />
          </Button>
          <span className="flex items-center gap-1.5">
            <Sparkle className="size-5" />
            <span className="text-base font-medium tracking-tight">{tc("appName")}</span>
          </span>
        </header>

        <div
          ref={scrollRef}
          data-testid="messages"
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {!showHero && (
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 py-6">
              {projected.map((m) => (
                <div key={m.id} data-testid={`msg-${m.role}`} className="msg-enter flex gap-3">
                  {m.role === "user" ? (
                    <div className="ml-auto flex max-w-[88%] flex-col items-end gap-2">
                      {m.images && m.images.length > 0 && (
                        <div data-testid="message-images" className="flex flex-wrap justify-end gap-2">
                          {m.images.map((src, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setLightbox(src)}
                              className="cursor-zoom-in"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- data-URL attachments, not optimizable */}
                              <img
                                src={src}
                                alt={t("imageAlt", { number: i + 1 })}
                                className="max-h-44 max-w-[240px] rounded-2xl object-cover ring-1 ring-black/10 dark:ring-white/15"
                              />
                            </button>
                          ))}
                        </div>
                      )}
                      {m.audio && (
                        <div data-testid="message-audio" className="flex w-full max-w-[320px] flex-col items-stretch gap-1.5">
                          <audio
                            controls
                            src={m.audio}
                            data-testid="audio-player"
                            className="h-9 w-full"
                            preload="metadata"
                          />
                          {typeof m.audioTranscript === "string" ? (
                            <p
                              data-testid="audio-caption"
                              className="max-h-40 overflow-y-auto rounded-xl bg-muted/60 px-3 py-1.5 text-[13px] leading-snug whitespace-pre-wrap text-muted-foreground"
                            >
                              {m.audioTranscript}
                            </p>
                          ) : m.audioTranscriptFailed ? (
                            <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="audio-caption-failed">
                              {t("captionFailed")}
                              <button
                                type="button"
                                data-testid="caption-retry"
                                className="font-medium text-primary underline underline-offset-2"
                                onClick={() => {
                                  const tid = threadIdRef.current;
                                  if (tid) void retryCaption(m.id, tid);
                                }}
                              >
                                {t("captionRetry")}
                              </button>
                            </p>
                          ) : m.audioCaptionPending || audioCfg.enabled ? (
                            <span
                              data-testid="audio-caption-pending"
                              role="status"
                              aria-label={t("captionPending")}
                              className="shimmer h-3 w-2/3 self-end rounded-full"
                            />
                          ) : (
                            <p className="text-xs text-muted-foreground" data-testid="audio-caption-unavailable">
                              {t("captionUnavailable")}
                            </p>
                          )}
                        </div>
                      )}
                      {m.content && (
                        <div className="rounded-3xl bg-user-bubble px-5 py-3 text-[15px] leading-relaxed whitespace-pre-wrap">
                          {m.content}
                        </div>
                      )}
                      {m.turnError && (
                        <p
                          data-testid="turn-error-notice"
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-destructive"
                        >
                          <span>{m.turnError === "timeout" ? t("turnTimeout") : t("error")}</span>
                          <button
                            type="button"
                            data-testid="turn-error-retry"
                            className="font-medium underline underline-offset-2"
                            onClick={() => retryTurn(m)}
                          >
                            {t("retry")}
                          </button>
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="group flex w-full gap-3">
                      <Sparkle className="mt-1 size-6" title={t("assistant")} />
                      <div className="min-w-0 flex-1">
                        {m.segments && m.segments.length > 0 ? (
                          <ToolSegments segments={m.segments} label={toolLabel} />
                        ) : (
                          <>
                            {m.tools && m.tools.length > 0 && (
                              <ToolChipRow tools={m.tools} label={toolLabel} />
                            )}
                            <div className="md text-[15px]">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                                {m.content}
                              </ReactMarkdown>
                            </div>
                          </>
                        )}
                        {m.interactive && m.interactive.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {m.interactive.map((ask) => (
                              <InteractiveAskView
                                key={ask.toolCallId}
                                ask={ask}
                                disabled={streaming}
                                t={t}
                                onAnswer={answerAsk}
                              />
                            ))}
                          </div>
                        )}
                        {m.approvals && m.approvals.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {m.approvals.map((approval) => (
                              <ToolApprovalView
                                key={approval.toolCallId}
                                approval={approval}
                                disabled={streaming}
                                t={t}
                                onAnswer={answerApproval}
                              />
                            ))}
                          </div>
                        )}
                        {!m.streaming && (
                          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                            <button
                              type="button"
                              data-testid="copy-message"
                              aria-label={t("copy")}
                              title={t("copy")}
                              onClick={() => void copyMessage(m.id, m.content)}
                              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              {copiedId === m.id ? <Check className="size-4" /> : <Copy className="size-4" />}
                            </button>
                            {m.id === lastAssistantId && !streaming && (
                              <button
                                type="button"
                                data-testid="regenerate"
                                aria-label={t("regenerate")}
                                title={t("regenerate")}
                                onClick={regenerate}
                                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              >
                                <RefreshCw className="size-4" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {awaitingFirstToken && (
                <div className="msg-enter flex gap-3" data-testid="thinking" aria-label={t("thinking")}>
                  <Sparkle className="mt-1 size-6" />
                  <div className="flex-1 pt-3">
                    <div className="shimmer h-3.5 w-48 rounded-full" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="relative z-20 mx-auto flex w-full max-w-[720px] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 pb-1 text-sm text-destructive"
          >
            <span>{t("error")}</span>
            {lastUserMsg && (
              <Button
                size="xs"
                variant="link"
                className="h-auto p-0 text-destructive"
                onClick={() => retryTurn(lastUserMsg)}
              >
                {t("retry")}
              </Button>
            )}
          </div>
        )}

        {showHero ? (
          <div className="hero-enter pointer-events-none absolute inset-0 z-10 flex flex-col items-center px-4">
            <div
              aria-hidden
              className="hero-glow absolute left-1/2 top-[18vh] size-[480px] max-w-[92vw] -translate-x-1/2 rounded-full"
            />
            <div className="relative z-10 mt-[28vh] flex w-full max-w-[640px] flex-col items-center text-center">
              <h1 className="text-[clamp(28px,5vw,44px)] leading-[1.15] font-light tracking-tight">
                {t("heroTitle")}
              </h1>
              <div className="pointer-events-auto mt-7 w-full text-left">
                <Composer {...composerProps} hideAttach={caps?.noVision === true} />
                {(modelSetupNotice || noVisionWarning) && (
                  <div className="px-4 pb-2">
                    {modelSetupNotice}
                    {noVisionWarning}
                  </div>
                )}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{t("disclaimer")}</p>
            </div>
          </div>
        ) : (
          <div className="z-20 mx-auto w-full max-w-[720px] shrink-0 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
            {(modelSetupNotice || noVisionWarning) && (
              <div className="grid gap-1 px-4 pb-1.5">
                {modelSetupNotice}
                {noVisionWarning}
              </div>
            )}
            <Composer {...composerProps} className="composer-enter" hideAttach={caps?.noVision === true} />
          </div>
        )}

        {!showHero && showFab && (
          <button
            type="button"
            data-testid="scroll-bottom"
            aria-label={t("scrollToBottom")}
            onClick={scrollToBottom}
            className="absolute right-4 bottom-[116px] z-20 flex size-9 items-center justify-center rounded-full border bg-background text-foreground shadow-md transition-colors hover:bg-muted md:right-8"
          >
            <ChevronDown className="size-4.5" />
          </button>
        )}
      </main>

      {lightbox && (
        <div
          data-testid="lightbox"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/85 p-4"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- data-URL attachment, not optimizable */}
          <img
            src={lightbox}
            alt={t("imageAlt", { number: 1 })}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </>
  );
}
