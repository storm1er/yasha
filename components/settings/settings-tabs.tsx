"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AdminPanel } from "@/components/settings/admin-panel";
import { GeneralPanel } from "@/components/settings/general-panel";
import { JobsPanel } from "@/components/settings/jobs-panel";
import { MemoryPanel } from "@/components/settings/memory-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "yasha.settingsTab";

type Tab = "general" | "security" | "memory" | "lemonade" | "jobs";

export function SettingsTabs({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("settings");
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        let saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved === "admin") saved = "lemonade";
        if (saved === "memory" || saved === "security") setTab(saved);
        else if (isAdmin && (saved === "lemonade" || saved === "jobs")) setTab(saved);
      } catch {
        /* storage unavailable */
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [isAdmin]);

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
              id="settings-tab-lemonade"
              aria-selected={tab === "lemonade"}
              data-testid="tab-lemonade"
              className={tabClass(tab === "lemonade")}
              onClick={() => select("lemonade")}
            >
              {t("tabLemonade")}
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
      {tab === "lemonade" && isAdmin ? (
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
