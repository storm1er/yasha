"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AdminPanel } from "@/components/settings/admin-panel";
import { GeneralPanel } from "@/components/settings/general-panel";
import { JobsPanel } from "@/components/settings/jobs-panel";
import { MemoryPanel } from "@/components/settings/memory-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "yasha.settingsTab";

type Tab = "general" | "security" | "memory" | "backend" | "jobs";

const ADMIN_TABS: readonly Tab[] = ["backend", "jobs"];

function normalizeTab(raw: string | null): Tab | null {
  if (raw === "admin" || raw === "lemonade") return "backend"; // legacy persisted values
  return raw === "general" || raw === "security" || raw === "memory" || raw === "backend" || raw === "jobs"
    ? raw
    : null;
}

export function SettingsTabs({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("settings");
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const isAvailable = (next: Tab) => !ADMIN_TABS.includes(next) || isAdmin;
        // An explicit ?tab= deep link wins over the persisted tab; a tab the
        // role cannot use (or an unknown value) falls back to the persisted one.
        const deepLink = normalizeTab(searchParams.get("tab"));
        const saved = normalizeTab(window.localStorage.getItem(STORAGE_KEY));
        const next = deepLink && isAvailable(deepLink) ? deepLink : saved && isAvailable(saved) ? saved : null;
        if (next) setTab(next);
      } catch {
        /* storage unavailable */
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [isAdmin, searchParams]);

  function select(next: Tab) {
    setTab(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
  }

  const tabClass = (active: boolean) =>
    cn(
      "cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
      "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
    );

  return (
    <div>
      <div role="tablist" aria-label={t("title")} className="mb-4 flex w-fit gap-1 rounded-full bg-muted p-1">
        <button
          type="button"
          role="tab"
          id="settings-tab-general"
          aria-selected={tab === "general"}
          data-testid="tab-general"
          className={tabClass(tab === "general")}
          onClick={() => select("general")}
        >
          {t("tabGeneral")}
        </button>
        <button
          type="button"
          role="tab"
          id="settings-tab-security"
          aria-selected={tab === "security"}
          data-testid="tab-security"
          className={tabClass(tab === "security")}
          onClick={() => select("security")}
        >
          {t("tabSecurity")}
        </button>
        <button
          type="button"
          role="tab"
          id="settings-tab-memory"
          aria-selected={tab === "memory"}
          data-testid="tab-memory"
          className={tabClass(tab === "memory")}
          onClick={() => select("memory")}
        >
          {t("tabMemory")}
        </button>
        {isAdmin && (
          <>
            <button
              type="button"
              role="tab"
              id="settings-tab-backend"
              aria-selected={tab === "backend"}
              data-testid="tab-backend"
              className={tabClass(tab === "backend")}
              onClick={() => select("backend")}
            >
              {t("tabBackend")}
            </button>
            <button
              type="button"
              role="tab"
              id="settings-tab-jobs"
              aria-selected={tab === "jobs"}
              data-testid="tab-jobs"
              className={tabClass(tab === "jobs")}
              onClick={() => select("jobs")}
            >
              {t("tabJobs")}
            </button>
          </>
        )}
      </div>
      {tab === "backend" && isAdmin ? (
        <AdminPanel />
      ) : tab === "jobs" && isAdmin ? (
        <JobsPanel />
      ) : tab === "memory" ? (
        <MemoryPanel isAdmin={isAdmin} />
      ) : tab === "security" ? (
        <SecurityPanel isAdmin={isAdmin} />
      ) : (
        <GeneralPanel />
      )}
    </div>
  );
}
