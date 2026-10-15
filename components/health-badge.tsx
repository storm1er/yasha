"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Status = "checking" | "ok" | "offline";

export function HealthBadge() {
  const t = useTranslations("common");
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const res = await fetch("/api/lemonade/status", { cache: "no-store" });
        const data = (await res.json()) as { ok?: boolean };
        if (alive) setStatus(data.ok ? "ok" : "offline");
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

  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <span
        data-testid="health-dot"
        aria-hidden
        className={`inline-block size-2.5 rounded-full ${dot}`}
      />
      <span role="status">{label}</span>
    </span>
  );
}
