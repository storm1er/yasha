"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, Copy, Loader2, Menu, RefreshCw, X } from "lucide-react";
import { Sparkle } from "@/components/brand/sparkle";
import { useChatShell } from "@/components/chat/chat-shell";
import { CodeBlock } from "@/components/chat/code-block";
import { Composer, type ComposerAttachment } from "@/components/chat/composer";
import { useAudioConfig } from "@/lib/browser/use-audio-input";
import type { ModelCapabilities } from "@/components/chat/model-picker";
import { Button } from "@/components/ui/button";

type ToolChip = {
  server: string;
  name: string;
  status: "running" | "done" | "error";
  /** JSON arguments string — present once the call is known (live or stored). */
  args?: string;
  /** Tool output (or error text) — present on terminal states. */
  result?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  audio?: string;
  audioTranscript?: string | null;
  audioTranscriptFailed?: boolean;
  audioCaptionPending?: boolean;
  tools?: ToolChip[];
  streaming?: boolean;
  /** Set when the assistant turn for this user message failed upstream
   *  (persisted in meta.error) — renders the red retry notice. */
  turnError?: string;
};

type ServerEvent = {
  threadId?: string;
  c?: string;
  tool?: ToolChip;
  error?: string;
  done?: boolean;
  aborted?: boolean;
};

const MD_COMPONENTS: Components = {
  pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
};

type ServerMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta?: {
    images?: unknown;
    tools?: unknown;
    audio?: unknown;
    audioTranscript?: unknown;
    audioTranscriptFailed?: unknown;
    error?: unknown;
  } | null;
};

function mapMessage(m: ServerMessage): ChatMessage {
  const images = Array.isArray(m.meta?.images)
    ? m.meta!.images!.filter((s): s is string => typeof s === "string")
    : undefined;
  const audio = typeof m.meta?.audio === "string" ? m.meta!.audio : undefined;
  const audioTranscript =
    typeof m.meta?.audioTranscript === "string" ? m.meta!.audioTranscript : undefined;
  const audioTranscriptFailed = m.meta?.audioTranscriptFailed === true;
  const turnError = typeof m.meta?.error === "string" ? m.meta.error : undefined;
  const tools = Array.isArray(m.meta?.tools)
    ? m.meta!.tools!.filter(
        (t): t is ToolChip & { ok: boolean } =>
          !!t &&
          typeof t === "object" &&
          typeof (t as ToolChip).server === "string" &&
          typeof (t as ToolChip).name === "string" &&
          typeof (t as { ok?: unknown }).ok === "boolean",
      )
    : undefined;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    images,
    audio,
    audioTranscript,
    audioTranscriptFailed,
    turnError,
    tools: tools?.length
      ? tools.map((t) => ({
          server: t.server,
          name: t.name,
          status: t.ok ? ("done" as const) : ("error" as const),
          args: typeof t.args === "string" ? t.args : undefined,
          result: typeof t.result === "string" ? t.result : undefined,
        }))
      : undefined,
  };
}

/** True while a stored audio message has no caption outcome yet (job pending
 *  or never enqueued — the caller decides between pending/unavailable). */
function captionPending(m: ServerMessage): boolean {
  const meta = m.meta;
  return Boolean(
    meta &&
      typeof meta === "object" &&
      typeof meta.audio === "string" &&
      typeof meta.audioTranscript !== "string" &&
      meta.audioTranscriptFailed !== true,
  );
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

function ToolChipView({ tool, label }: { tool: ToolChip; label: string }) {
  const t = useTranslations("chat");
  const [open, setOpen] = useState(false);
  const expandable = typeof tool.args === "string" || typeof tool.result === "string";
  const icon =
    tool.status === "running" ? (
      <Loader2 className="size-3 animate-spin" aria-hidden />
    ) : tool.status === "done" ? (
      <Check className="size-3" aria-hidden />
    ) : (
      <X className="size-3 text-destructive" aria-hidden />
    );
  return (
    <div className="max-w-full min-w-0">
      <button
        type="button"
        aria-expanded={open}
        disabled={!expandable}
        onClick={() => expandable && setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground ${
          expandable ? "cursor-pointer transition-colors hover:bg-muted hover:text-foreground" : ""
        }`}
      >
        {icon}
        {label}
        {expandable && (
          <ChevronDown
            className={`size-3 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        )}
      </button>
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

function parseSse(buffer: string): { events: ServerEvent[]; rest: string } {
  const events: ServerEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()) as ServerEvent);
      } catch {
        /* ignore malformed */
      }
    }
  }
  return { events, rest };
}

function prefersReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ChatSurface({ initialThreadId }: { initialThreadId: string | null }) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const router = useRouter();
  const shell = useChatShell();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFab, setShowFab] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [caps, setCaps] = useState<ModelCapabilities | null>(null);
  const [threadModel, setThreadModel] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(initialThreadId !== null);
  const lastFailed = useRef<{ id: string; text: string; images?: string[]; audio?: string } | null>(null);

  const threadIdRef = useRef<string | null>(initialThreadId);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const selectedModelRef = useRef<string | null>(null);

  // The picker reports its effective value on init (thread model > stored >
  // default) and on every change, so this ref always mirrors what is shown.
  const handleModelChange = useCallback((id: string) => {
    selectedModelRef.current = id;
  }, []);

  useEffect(() => {
    threadIdRef.current = initialThreadId;
    // Deferred to a microtask so it lands before paint without being a
    // synchronous setState inside the effect body; the async branches below
    // (fetch callbacks) are allowed.
    const run = async () => {
      setLoadingHistory(initialThreadId !== null);
      if (!initialThreadId) {
        setThreadModel(null);
        return;
      }
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
        thread?: { model?: string | null };
        messages: ServerMessage[];
      };
      if (alive) {
        stickRef.current = true;
        setLoadingHistory(false);
        setThreadModel(data.thread?.model ?? null);
        setMessages(data.messages.map(mapMessage));
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
  }, [initialThreadId, router, shell]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: streaming && !prefersReduced() ? "auto" : "smooth",
    });
  }, [messages, streaming]);

  // Voice-message captions: after a voice turn (or a caption retry), poll the
  // thread until the background caption job lands (bounded — 8 × 4 s).
  const pollGenRef = useRef(0);
  const pollCaptions = useCallback(async (threadId: string, isCancelled: () => boolean) => {
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
          setMessages(data.messages.map(mapMessage));
          return;
        }
      } catch {
        return;
      }
    }
  }, []);

  const retryCaption = useCallback(
    async (messageId: string, threadId: string) => {
      try {
        const res = await fetch(`/api/chat/messages/${messageId}/transcribe`, { method: "POST" });
        if (!res.ok) return;
      } catch {
        return;
      }
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, audioTranscriptFailed: false, audioCaptionPending: true } : m)));
      const gen = ++pollGenRef.current;
      void pollCaptions(threadId, () => pollGenRef.current !== gen || threadIdRef.current !== threadId);
    },
    [pollCaptions]
  );

  /** Reload a thread after a failed turn so the server-persisted error
   *  annotation (meta.error) renders as the in-thread retry notice. */
  const resyncThread = useCallback(async (threadId: string) => {
    try {
      const res = await fetch(`/api/threads/${threadId}`, { cache: "no-store" });
      if (!res.ok) {
        setError("error");
        return;
      }
      const data = (await res.json()) as { messages: ServerMessage[] };
      setMessages(data.messages.map(mapMessage));
    } catch {
      setError("error");
    }
  }, []);

  const send = useCallback(
    async (rawText: string, images?: string[], audioUrl?: string) => {
      const text = rawText.trim();
      const imgs = images?.length ? images : undefined;
      const audio = audioUrl || undefined;
      if ((!text && !imgs && !audio) || streaming) return;
      setError(null);
      lastFailed.current = null;
      setInput("");
      setAttachments([]);
      stickRef.current = true;

      const tempUserId = `temp-user-${Date.now()}`;
      const tempAssistantId = `temp-assistant-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: tempUserId, role: "user", content: text, images: imgs, audio },
      ]);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setStreaming(true);
      let assistantStarted = false;
      let sseError: string | null = null;

      const fail = () => {
        setError("error");
        lastFailed.current = { id: tempUserId, text, images: imgs, audio };
        // The sent message stays visible next to the error + Retry action.
        setMessages((prev) =>
          prev
            .filter((m) => !(m.id === tempAssistantId && m.content === ""))
            .map((m) => (m.id === tempAssistantId ? { ...m, streaming: false } : m))
        );
      };

      let createdThread: string | null = null;
      try {
        const payload: Record<string, unknown> = { threadId: threadIdRef.current, message: text };
        if (imgs || audio) {
          const attachments: Record<string, unknown> = {};
          if (imgs) attachments.images = imgs;
          if (audio) attachments.audio = audio;
          payload.attachments = attachments;
        }
        // The displayed picker value is the source of truth for every turn.
        if (selectedModelRef.current) payload.model = selectedModelRef.current;
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok || !res.body) {
          fail();
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

      const ensureAssistant = () => {
        if (assistantStarted) return;
        assistantStarted = true;
        setMessages((prev) => [
          ...prev,
          { id: tempAssistantId, role: "assistant", content: "", streaming: true },
        ]);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSse(buffer);
        buffer = rest;
        for (const ev of events) {
          if (ev.threadId && !threadIdRef.current) {
            threadIdRef.current = ev.threadId;
            createdThread = ev.threadId;
            window.history.replaceState(null, "", `/c/${ev.threadId}`);
            shell.notifyActiveThread(ev.threadId);
          }
          if (typeof ev.c === "string") {
            if (!assistantStarted) {
              assistantStarted = true;
              setMessages((prev) => [
                ...prev,
                { id: tempAssistantId, role: "assistant", content: ev.c!, streaming: true },
              ]);
            } else {
              setMessages((prev) =>
                prev.map((m) => (m.id === tempAssistantId ? { ...m, content: m.content + ev.c } : m))
              );
            }
          }
          if (ev.tool) {
            ensureAssistant();
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== tempAssistantId) return m;
                const tools = [...(m.tools ?? [])];
                const idx = tools.findIndex(
                  (tc) =>
                    tc.status === "running" && tc.server === ev.tool!.server && tc.name === ev.tool!.name,
                );
                if (idx >= 0) tools[idx] = ev.tool!;
                else tools.push(ev.tool!);
                return { ...m, tools };
              })
            );
          }
          if (ev.error) {
            // The server kept the user message and annotated it with the error
            // code; re-sync the thread so the failure notice renders in place.
            sseError = String(ev.error);
          }
        }
      }
        // Clear the transient streaming flag on the assistant bubble for every
        // terminal path (done, error, or silent end).
        setMessages((prev) =>
          prev.map((m) => (m.id === tempAssistantId ? { ...m, streaming: false } : m))
        );
      } catch {
        if (!ctrl.signal.aborted) fail();
        setMessages((prev) =>
          prev.map((m) => (m.id === tempAssistantId ? { ...m, streaming: false } : m))
        );
      } finally {
        setStreaming(false);
        abortRef.current = null;
        shell.refreshThreads();
        // The async title job lands seconds later: poll the list until the
        // placeholder is replaced so the sidebar updates without a reload.
        if (createdThread) shell.awaitThreadTitle(createdThread);
        // Voice turn: poll for the background caption (AUDIO-REFACTO-PLAN §6).
        if (audio && threadIdRef.current) {
          const tid = threadIdRef.current;
          const gen = ++pollGenRef.current;
          void pollCaptions(tid, () => pollGenRef.current !== gen || threadIdRef.current !== tid);
        }
        if (sseError && threadIdRef.current) void resyncThread(threadIdRef.current);
      }
    },
    [streaming, router, shell, pollCaptions, resyncThread]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** Resend a user turn (retry after failure / regenerate): a trailing failed
   *  row is dropped from the list first — the server replaces it on the wire. */
  function retryTurn(m: ChatMessage) {
    if (streaming) return;
    setError(null);
    lastFailed.current = null;
    setMessages((prev) => (prev.at(-1)?.id === m.id ? prev.filter((x) => x.id !== m.id) : prev));
    void send(m.content, m.images, m.audio);
  }

  const startNewChat = useCallback(() => {
    // Reset local state first: after the first message the thread URL is set
    // via history.replaceState, which does not update router state, so
    // router.push("/c/new") would be a no-op while the path says otherwise.
    abortRef.current?.abort();
    threadIdRef.current = null;
    setLoadingHistory(false);
    setMessages([]);
    setAttachments([]);
    setError(null);
    setThreadModel(null);
    shell.notifyActiveThread(null);
    const path = window.location.pathname.replace(/\/$/, "");
    if (path !== "/c/new") router.push("/c/new");
  }, [router, shell]);

  const threadDeleted = useCallback((threadId: string) => {
    if (threadIdRef.current === threadId) {
      threadIdRef.current = null;
      setLoadingHistory(false);
      setMessages([]);
      setAttachments([]);
      setThreadModel(null);
      window.history.replaceState(null, "", "/c/new");
    }
  }, []);

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

  const showHero = messages.length === 0 && !streaming && !loadingHistory;
  const awaitingFirstToken =
    streaming && !messages.some((m) => m.role === "assistant" && m.streaming);
  const lastAssistantId = messages.filter((m) => m.role === "assistant").at(-1)?.id;
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");

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
      <Link href="/settings" className="underline underline-offset-2">
        {tc("settings")}
      </Link>
    </p>
  ) : null;

  const composerProps = {
    value: input,
    onChange: setInput,
    onSubmit: () => void send(input, attachments.map((a) => a.dataUrl)),
    streaming,
    onStop: stop,
    onModelChange: handleModelChange,
    onModelCapabilities: setCaps,
    threadModel,
    attachments,
    onAttachmentsChange: setAttachments,
    audioEnabled: audioCfg.enabled,
    smartModelId: audioCfg.smartModel,
    maxAudioBytes: audioCfg.maxAudioBytes,
    onAudioRecorded: (dataUrl: string) => void send(input, attachments.map((a) => a.dataUrl), dataUrl),
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
              {messages.map((m) => (
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
                                  if (tid && !m.id.startsWith("temp-")) void retryCaption(m.id, tid);
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
                        {m.tools && m.tools.length > 0 && (
                          <ToolChipRow
                            tools={m.tools}
                            label={(status, name) =>
                              status === "running"
                                ? t("toolRunning", { name })
                                : status === "done"
                                  ? t("toolDone", { name })
                                  : t("toolError", { name })
                            }
                          />
                        )}
                        <div className="md text-[15px]">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                            {m.content}
                          </ReactMarkdown>
                        </div>
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
            {lastFailed.current && (
              <Button
                size="xs"
                variant="link"
                className="h-auto p-0 text-destructive"
                onClick={() => {
                  const f = lastFailed.current;
                  if (f) retryTurn({ id: f.id, role: "user", content: f.text, images: f.images, audio: f.audio });
                }}
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
