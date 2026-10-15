"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChatSidebar, type ThreadSummary } from "@/components/chat/chat-sidebar";

type SurfaceHandlers = {
  newChat: () => void;
  threadDeleted: (threadId: string) => void;
};

type ChatShellValue = {
  refreshThreads: () => void;
  // Sidebar rows re-render every tick; the async title job lands seconds after
  // the stream ends, so poll until this thread's title changes (bounded).
  awaitThreadTitle: (threadId: string) => void;
  notifyActiveThread: (threadId: string | null) => void;
  openMobileNav: () => void;
  setSurfaceHandlers: (handlers: SurfaceHandlers | null) => void;
};

const ChatShellContext = createContext<ChatShellValue | null>(null);

export function useChatShell(): ChatShellValue {
  const ctx = useContext(ChatShellContext);
  if (!ctx) throw new Error("useChatShell must be used within ChatShellProvider");
  return ctx;
}

function threadIdFromPath(path: string): string | null {
  const match = path.match(/^\/c\/([0-9a-fA-F-]{36})\/?$/);
  return match ? match[1] : null;
}

export function ChatShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Active-thread override for URL updates done via history.replaceState
  // (first message on /c/new), which the router pathname never observes.
  const [activeOverride, setActiveOverride] = useState<{ path: string; id: string | null } | null>(
    null
  );
  const activeThreadId =
    activeOverride && activeOverride.path === pathname
      ? activeOverride.id
      : threadIdFromPath(pathname);

  const surfaceRef = useRef<SurfaceHandlers | null>(null);
  const threadsRef = useRef<ThreadSummary[]>([]);
  const titlePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/threads", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { threads: ThreadSummary[] };
        setThreads(data.threads);
      }
    } catch {
      /* sidebar refresh is best-effort */
    }
  }, [router]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/threads", { cache: "no-store" });
        if (!alive) return;
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (res.ok) {
          const data = (await res.json()) as { threads: ThreadSummary[] };
          if (alive) setThreads(data.threads);
        }
      } catch {
        /* sidebar refresh is best-effort */
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  const stopTitlePoll = useCallback(() => {
    if (titlePollRef.current) {
      clearInterval(titlePollRef.current);
      titlePollRef.current = null;
    }
  }, []);

  const awaitThreadTitle = useCallback(
    (threadId: string) => {
      stopTitlePoll();
      // First known title = placeholder; polling stops when it changes (or after ~45s).
      let baseline: string | null =
        threadsRef.current.find((th) => th.threadId === threadId)?.title ?? null;
      let ticks = 0;
      titlePollRef.current = setInterval(async () => {
        ticks += 1;
        if (ticks > 18) {
          stopTitlePoll();
          return;
        }
        try {
          const res = await fetch("/api/threads", { cache: "no-store" });
          if (!res.ok) return;
          const data = (await res.json()) as { threads: ThreadSummary[] };
          setThreads(data.threads);
          const current = data.threads.find((th) => th.threadId === threadId)?.title ?? null;
          if (current === null) {
            stopTitlePoll(); // thread gone
            return;
          }
          if (baseline === null) {
            baseline = current; // first observation: treat as placeholder baseline
            return;
          }
          if (current !== baseline) stopTitlePoll();
        } catch {
          /* next tick retries */
        }
      }, 2500);
    },
    [stopTitlePoll]
  );

  useEffect(() => stopTitlePoll, [stopTitlePoll]);

  const notifyActiveThread = useCallback(
    (threadId: string | null) => {
      setActiveOverride({ path: pathname, id: threadId });
    },
    [pathname]
  );

  const setSurfaceHandlers = useCallback((handlers: SurfaceHandlers | null) => {
    surfaceRef.current = handlers;
  }, []);

  const openMobileNav = useCallback(() => setMobileOpen(true), []);

  const onSelect = useCallback(
    (threadId: string) => {
      setMobileOpen(false);
      if (threadId === threadIdFromPath(pathname)) return;
      router.push(`/c/${threadId}`);
    },
    [router, pathname]
  );

  const onNewChat = useCallback(() => {
    setMobileOpen(false);
    if (surfaceRef.current) {
      surfaceRef.current.newChat();
    } else {
      router.push("/c/new");
    }
  }, [router]);

  const onDeleted = useCallback(
    (threadId: string) => {
      setThreads((prev) => prev.filter((th) => th.threadId !== threadId));
      const active =
        activeOverride && activeOverride.path === pathname
          ? activeOverride.id
          : threadIdFromPath(pathname);
      if (active === threadId) {
        setActiveOverride({ path: pathname, id: null });
        surfaceRef.current?.threadDeleted(threadId);
      }
    },
    [activeOverride, pathname]
  );

  const value = useMemo<ChatShellValue>(
    () => ({ refreshThreads, awaitThreadTitle, notifyActiveThread, openMobileNav, setSurfaceHandlers }),
    [refreshThreads, awaitThreadTitle, notifyActiveThread, openMobileNav, setSurfaceHandlers]
  );

  return (
    <ChatShellContext.Provider value={value}>
      <div className="flex h-svh w-full min-h-0">
        <ChatSidebar
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={onSelect}
          onNewChat={onNewChat}
          onRenamed={() => void refreshThreads()}
          onDeleted={onDeleted}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
        />
        {children}
      </div>
    </ChatShellContext.Provider>
  );
}
