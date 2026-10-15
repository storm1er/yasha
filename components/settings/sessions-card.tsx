"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type SessionRow = {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
};

export function SessionsCard() {
  const t = useTranslations("settings");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/me/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionRow[] };
      setSessions(data.sessions);
    } catch {
      /* keep last list */
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await fetch("/api/me/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const others = sessions.filter((s) => !s.current);

  return (
    <Card data-testid="sessions-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="size-4" /> {t("sessionsTitle")}
        </CardTitle>
        <CardDescription>{t("sessionsIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            data-testid={`session-row-${s.current ? "current" : s.id}`}
            className="flex items-center gap-3 rounded-lg border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {s.userAgent || t("sessionsUnknownDevice")}
                {s.current && (
                  <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                    {t("sessionsCurrent")}
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {t("sessionsLastUsed", { when: new Date(s.lastUsedAt).toLocaleString() })}
                {s.ipAddress ? ` · ${s.ipAddress}` : ""}
              </p>
            </div>
            {!s.current && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                data-testid={`session-revoke-${s.id}`}
                onClick={() => void act({ action: "revoke", sessionId: s.id })}
              >
                {t("sessionsRevoke")}
              </Button>
            )}
          </div>
        ))}
        {others.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid="sessions-revoke-others"
            className="w-fit"
            onClick={() => void act({ action: "revokeOthers" })}
          >
            {t("sessionsRevokeOthers")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
