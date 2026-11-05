"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Zap } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";

/**
 * Admin master switch for the LLM warmup (issue #67, `backend.warm.enabled`).
 * On (default): opening a new chat fires a discarded completion that loads
 * the model and pre-prefills the user's memory-injected system block, so the
 * first real answer starts warm. Off: /api/backend/warm answers
 * {scheduled:false, reason:"disabled"} and the backends are never touched —
 * for instances whose GPU time must stay reserved.
 */
export function WarmupCard() {
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
        if (data.values?.["backend.warm.enabled"] === false) setEnabled(false);
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
        body: JSON.stringify({ "backend.warm.enabled": !enabled }),
      });
      if (res.ok) {
        const data = (await res.json()) as { values?: Record<string, unknown> };
        setEnabled(data.values?.["backend.warm.enabled"] !== false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="warmup-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="size-4" /> {t("warmupTitle")}
        </CardTitle>
        <CardDescription>{t("warmupIntro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Label className="flex cursor-pointer items-center gap-2 font-normal text-sm">
          <input
            type="checkbox"
            data-testid="warmup-enabled"
            className="accent-primary"
            checked={enabled}
            disabled={busy}
            onChange={toggle}
          />
          {t("warmupEnabled")}
        </Label>
      </CardContent>
    </Card>
  );
}
