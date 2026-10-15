"use client";

import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";

export function AdminZoneHeader() {
  const t = useTranslations("settings");
  return (
    <div className="flex items-center gap-2 pt-2" data-testid="admin-zone-header">
      <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {t("adminZone")}
      </h2>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
