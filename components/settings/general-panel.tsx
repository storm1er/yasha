"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { AppDownloadSettingsCard } from "@/components/app-download";
import { AppUpdatesCard } from "@/components/settings/app-updates-card";
import { GeminiImportCard } from "@/components/settings/gemini-import-card";
import { UserMcpCard } from "@/components/settings/user-mcp-card";

function ToolsPrefSection() {
  const t = useTranslations("settings");
  const [userEnabled, setUserEnabled] = useState<boolean | null>(null);
  const [instanceEnabled, setInstanceEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/mcp/prefs", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { userEnabled?: boolean | null; instanceEnabled?: boolean };
        if (!alive) return;
        setUserEnabled(typeof data.userEnabled === "boolean" ? data.userEnabled : null);
        setInstanceEnabled(data.instanceEnabled !== false);
      } catch {
        /* keep defaults */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function setPref(value: boolean | null) {
    setBusy(true);
    try {
      await fetch("/api/mcp/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userEnabled: value }),
      });
      setUserEnabled(value);
    } finally {
      setBusy(false);
    }
  }

  // Admin kill-switch off ⇒ the whole preference is meaningless: hide it.
  if (!instanceEnabled) return null;

  return (
    <Card data-testid="tools-pref-card">
      <CardHeader>
        <CardTitle>{t("toolsPrefTitle")}</CardTitle>
        <CardDescription>{t("toolsPrefIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Label className="flex cursor-pointer items-center gap-2 font-normal text-sm">
          <input
            type="checkbox"
            data-testid="tools-pref-optout"
            className="accent-primary"
            checked={userEnabled !== false}
            disabled={busy}
            onChange={(e) => void setPref(e.target.checked ? null : false)}
          />
          {t("toolsPrefFollow")}
        </Label>
      </CardContent>
    </Card>
  );
}

export function GeneralPanel() {
  return (
    <div className="flex flex-col gap-4" data-testid="general-panel">
      <ToolsPrefSection />
      <UserMcpCard />
      <AppDownloadSettingsCard />
      <AppUpdatesCard />
      <GeminiImportCard />
    </div>
  );
}
