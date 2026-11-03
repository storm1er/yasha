"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";

/**
 * Admin master switch for the in-app Android update channel (issue #34
 * Phase C, `app_updates.enabled`). Off ⇒ /api/app/version answers 403 and
 * /api/app-update refuses builds: apps show no banner, no background checks
 * surface anything, and nothing gets built on this server for updates.
 * (The web "Get the app" first-install flow is NOT affected.)
 */
export function AppUpdatesCard() {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { values?: Record<string, unknown> };
        if (data.values?.["app_updates.enabled"] === false) setEnabled(false);
      } catch {
        /* keep default (on) */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "app_updates.enabled": !enabled }),
      });
      if (res.ok) {
        const data = (await res.json()) as { values?: Record<string, unknown> };
        setEnabled(data.values?.["app_updates.enabled"] !== false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="app-updates-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowUpCircle className="size-4" /> {t("appUpdatesTitle")}
        </CardTitle>
        <CardDescription>{t("appUpdatesIntro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Label className="flex cursor-pointer items-center gap-2 font-normal text-sm">
          <input
            type="checkbox"
            data-testid="app-updates-enabled"
            className="accent-primary"
            checked={enabled}
            disabled={busy}
            onChange={toggle}
          />
          {t("appUpdatesEnabled")}
        </Label>
      </CardContent>
    </Card>
  );
}
