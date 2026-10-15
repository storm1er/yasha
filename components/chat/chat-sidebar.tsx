"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Settings,
  Trash2,
} from "lucide-react";
import { Sparkle } from "@/components/brand/sparkle";
import { AppDownloadSidebarEntry } from "@/components/app-download";
import { HealthBadge } from "@/components/health-badge";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import { authClient, useSession } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

export type ThreadSummary = {
  threadId: string;
  title: string;
  updatedAt: string;
};

type Props = {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNewChat: () => void;
  onRenamed: () => void;
  onDeleted: (threadId: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

const COLLAPSE_KEY = "yasha.sidebar.collapsed";

export function ChatSidebar({
  threads,
  activeThreadId,
  onSelect,
  onNewChat,
  onRenamed,
  onDeleted,
  mobileOpen,
  onCloseMobile,
}: Props) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { data: session } = useSession();
  const [collapsed, setCollapsed] = useState(false);
  const [isMd, setIsMd] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => setIsMd(e.matches);
    mq.addEventListener("change", onChange);
    const id = window.setTimeout(() => setIsMd(mq.matches), 0);
    return () => {
      window.clearTimeout(id);
      mq.removeEventListener("change", onChange);
    };
  }, []);

  const rail = collapsed && isMd;

  useEffect(() => {
    const stored = (() => {
      try {
        return window.localStorage.getItem(COLLAPSE_KEY);
      } catch {
        return null;
      }
    })();
    if (stored !== "1") return;
    const id = window.setTimeout(() => setCollapsed(true), 0);
    return () => window.clearTimeout(id);
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  async function commitRename(threadId: string) {
    const title = draft.trim();
    setRenamingId(null);
    if (!title) return;
    const res = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (res.ok) onRenamed();
  }

  async function remove(threadId: string) {
    const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
    if (res.ok) onDeleted(threadId);
  }

  const displayName = session?.user?.username || session?.user?.name || "?";

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={onCloseMobile}
          aria-hidden
        />
      )}
      <aside
        data-testid="sidebar"
        data-rail={rail ? "true" : "false"}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-svh shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground",
          "transition-[width,transform] duration-200 ease-out",
          "md:static md:translate-x-0",
          rail ? "w-[72px]" : "w-[280px]",
          mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        )}
      >
        <div className={cn("flex items-center gap-1 p-2.5", rail && "flex-col")}>
          <button
            type="button"
            onClick={rail ? toggleCollapsed : undefined}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5",
              rail ? "justify-center" : "hover:bg-sidebar-accent"
            )}
            aria-label={rail ? t("expandSidebar") : undefined}
            title={rail ? tc("appName") : undefined}
          >
            <Sparkle className="size-6" />
            {!rail && (
              <span className="truncate text-lg font-medium tracking-tight">{tc("appName")}</span>
            )}
          </button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid="sidebar-collapse"
            aria-label={rail ? t("expandSidebar") : t("collapseSidebar")}
            title={rail ? t("expandSidebar") : t("collapseSidebar")}
            className={cn(
              "hidden shrink-0 text-muted-foreground md:inline-flex",
              !rail && "ml-auto"
            )}
            onClick={toggleCollapsed}
          >
            {rail ? <PanelLeftOpen className="size-4.5" /> : <PanelLeftClose className="size-4.5" />}
          </Button>
        </div>

        <div className={cn("px-2", rail && "px-2.5")}>
          <button
            type="button"
            data-testid="new-chat"
            onClick={onNewChat}
            aria-label={rail ? t("newChat") : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-full border border-border/70 text-sm font-medium",
              "px-3.5 py-2 text-foreground transition-colors hover:bg-sidebar-accent",
              rail && "justify-center px-0 py-2.5"
            )}
            title={rail ? t("newChat") : undefined}
          >
            <MessageSquare className="size-4 shrink-0" />
            {!rail && <span className="truncate">{t("newChat")}</span>}
          </button>
        </div>

        {!rail && (
          <p className="px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground">{t("activity")}</p>
        )}
        <nav
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-1"
          data-testid="thread-list"
          aria-label={t("activity")}
        >
          {threads.length === 0 && !rail && (
            <p className="px-2 py-1 text-sm text-muted-foreground">{t("noThreads")}</p>
          )}
          {threads.map((thread) =>
            rail ? (
              <button
                key={thread.threadId}
                type="button"
                data-testid={`thread-${thread.threadId}`}
                onClick={() => onSelect(thread.threadId)}
                aria-label={thread.title}
                title={thread.title}
                className={cn(
                  "flex w-full items-center justify-center rounded-xl px-0 py-2.5 transition-colors hover:bg-sidebar-accent",
                  thread.threadId === activeThreadId && "bg-sidebar-accent text-sidebar-accent-foreground"
                )}
              >
                <MessageSquare className="size-4.5" />
              </button>
            ) : (
              <div
                key={thread.threadId}
                className={cn(
                  "group flex items-center gap-1 rounded-lg px-2 py-1 text-sm hover:bg-sidebar-accent",
                  thread.threadId === activeThreadId && "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                )}
              >
                {renamingId === thread.threadId ? (
                  <input
                    autoFocus
                    data-testid="rename-input"
                    className="w-full rounded border bg-background px-1 py-0.5 text-sm text-foreground"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(thread.threadId);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => void commitRename(thread.threadId)}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      data-testid={`thread-${thread.threadId}`}
                      className="min-w-0 flex-1 rounded truncate py-1 text-left"
                      onClick={() => onSelect(thread.threadId)}
                      title={thread.title}
                    >
                      {thread.title}
                      <span className="block text-[11px] font-normal text-muted-foreground">
                        {relativeTime(thread.updatedAt, locale)}
                      </span>
                    </button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label={t("rename")}
                      onClick={() => {
                        setDraft(thread.title);
                        setRenamingId(thread.threadId);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label={t("delete")}
                      data-testid={`delete-${thread.threadId}`}
                      onClick={() => void remove(thread.threadId)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
            )
          )}
        </nav>

        <div className={cn("mt-auto border-t border-border/70 p-2", rail && "flex flex-col items-center gap-1")}>
          {rail ? (
            <>
              <ThemeToggle />
              <AppDownloadSidebarEntry />
              <SettingsLink rail />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                >
                  {displayName.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={displayName}>
                  {displayName}
                </span>
                <AppDownloadSidebarEntry />
                <SettingsLink />
                <SignOutIconButton />
              </div>
              <div className="px-1">
                <LanguageSwitcher />
              </div>
              <div className="flex items-center justify-between px-1 pt-1">
                <HealthBadge />
                <ThemeToggle />
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function SettingsLink({ rail = false }: { rail?: boolean }) {
  const t = useTranslations("settings");
  return (
    <Link
      href="/settings"
      data-testid="settings-link"
      aria-label={t("title")}
      title={t("title")}
      className={buttonVariants({
        variant: "ghost",
        size: "icon",
        className: cn("shrink-0 text-muted-foreground", rail && "size-8"),
      })}
    >
      <Settings className="size-4" />
    </Link>
  );
}

function SignOutIconButton() {
  const t = useTranslations("chat");
  const router = useRouter();
  async function onSignOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      data-testid="sign-out"
      aria-label={t("signOut")}
      title={t("signOut")}
      className="size-8 shrink-0 text-muted-foreground"
      onClick={() => void onSignOut()}
    >
      <LogOut className="size-4" />
    </Button>
  );
}
