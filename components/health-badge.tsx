"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Status = "checking" | "ok" | "offline";
type ProviderHealth = { id: string; label: string; ok: boolean };

export function HealthBadge() {
  const t = useTranslations("common");
  const [status, setStatus] = useState<Status>("checking");
  const [providers, setProviders] = useState<ProviderHealth[]>([]);

  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const res = await fetch("/api/backend/status", { cache: "no-store" });
        const data = (await res.json()) as { ok?: boolean; providers?: ProviderHealth[] };
        if (!alive) return;
        // Worst status across enabled providers (Q19); zero providers is
        // offline too (soft state — the Backend tab is the fix path).
        setStatus(data.ok ? "ok" : "offline");
        setProviders(data.providers ?? []);
      } catch {
        if (alive) setStatus("offline");
      }
    }
    check();
    const id = setInterval(check, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const label = status === "ok" ? t("connected") : status === "offline" ? t("offline") : t("checking");
  const dot =
    status === "ok" ? "bg-green-500" : status === "offline" ? "bg-red-500" : "bg-yellow-500";
  // Per-provider tooltip when there is more than one backend configured.
  const tip = providers.length > 1 ? providers.map((p) => `${p.label}: ${p.ok ? "●" : "✕"}`).join("\n") : undefined;

  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground" title={tip}>
      <span
        data-testid="health-dot"
        aria-hidden
        className={`inline-block size-2.5 rounded-full ${dot}`}
      />
      <span role="status">{label}</span>
    </span>
  );
}
