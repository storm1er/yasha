"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { AdminZoneHeader } from "@/components/settings/admin-zone-header";
import { SessionsCard } from "@/components/settings/sessions-card";
import { UsersPanel } from "@/components/settings/users-panel";
import { msToSeconds, secondsToMs } from "@/lib/ms-seconds";

function ApiLimitsSection() {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  const [timeoutSec, setTimeoutSec] = useState("");
  const [maxTokensDefault, setMaxTokensDefault] = useState("");
  const [maxTokensCap, setMaxTokensCap] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { values?: Record<string, unknown> };
        const stored = data.values?.["api.firstTokenTimeoutMs"];
        if (typeof stored === "number") setTimeoutSec(msToSeconds(stored));
        const def = data.values?.["api.maxTokensDefault"];
        if (typeof def === "number") setMaxTokensDefault(String(def));
        const cap = data.values?.["api.maxTokensCap"];
        if (typeof cap === "number") setMaxTokensCap(String(cap));
      } catch {
        /* keep empty input */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    if (status === "saving") return;
    const payload: Record<string, number> = {};
    const timeout = secondsToMs(timeoutSec);
    if (timeout !== null) payload["api.firstTokenTimeoutMs"] = timeout;
    const def = Number.parseInt(maxTokensDefault, 10);
    if (Number.isFinite(def) && def > 0) payload["api.maxTokensDefault"] = def;
    const cap = Number.parseInt(maxTokensCap, 10);
    if (Number.isFinite(cap) && cap > 0) payload["api.maxTokensCap"] = cap;
    if (Object.keys(payload).length === 0) return;
    setStatus("saving");
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setStatus(res.ok ? "saved" : "error");
    } catch {
      setStatus("error");
    }
  }

  const anyValid =
    secondsToMs(timeoutSec) !== null ||
    (Number.isFinite(Number.parseInt(maxTokensDefault, 10)) && Number.parseInt(maxTokensDefault, 10) > 0) ||
    (Number.isFinite(Number.parseInt(maxTokensCap, 10)) && Number.parseInt(maxTokensCap, 10) > 0);

  return (
    <Card data-testid="api-limits-card">
      <CardHeader>
        <CardTitle>{t("apiLimitsTitle")}</CardTitle>
        <CardDescription>{t("apiLimitsIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2">
          <Label htmlFor="api-limits-input">{t("apiLimitsKey")}</Label>
          <Input
            id="api-limits-input"
            type="number"
            min={0.1}
            step={0.1}
            placeholder="15"
            data-testid="api-limits-input"
            value={timeoutSec}
            className="max-w-40 font-mono text-xs"
            onChange={(e) => {
              setTimeoutSec(e.target.value);
              setStatus("idle");
            }}
          />
          <p className="text-xs text-muted-foreground">{t("apiLimitsHint")}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="api-limits-tokens-default">{t("apiMaxTokensDefault")}</Label>
            <Input
              id="api-limits-tokens-default"
              type="number"
              min={1}
              placeholder="512"
              data-testid="api-limits-tokens-default"
              value={maxTokensDefault}
              className="max-w-40 font-mono text-xs"
              onChange={(e) => {
                setMaxTokensDefault(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="api-limits-tokens-cap">{t("apiMaxTokensCap")}</Label>
            <Input
              id="api-limits-tokens-cap"
              type="number"
              min={1}
              placeholder="1024"
              data-testid="api-limits-tokens-cap"
              value={maxTokensCap}
              className="max-w-40 font-mono text-xs"
              onChange={(e) => {
                setMaxTokensCap(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("apiMaxTokensHint")}</p>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            data-testid="api-limits-save"
            disabled={status === "saving" || !anyValid}
            onClick={() => void save()}
          >
            {ta("save")}
          </Button>
          {status === "saved" && (
            <span
              data-testid="api-limits-save-status"
              className="flex items-center gap-1 text-sm text-emerald-600"
            >
              <Check className="size-4" />
              {ta("saved")}
            </span>
          )}
          {status === "error" && (
            <span data-testid="api-limits-save-status" className="text-sm text-destructive">
              {ta("errorGeneric")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RegistrationSection() {
  const t = useTranslations("settings");
  const [allowed, setAllowed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { values?: Record<string, unknown> };
        const stored = data.values?.["auth.allowRegistration"];
        if (stored === false) setAllowed(false);
      } catch {
        /* keep default */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "auth.allowRegistration": !allowed }),
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = (await res.json()) as { values?: Record<string, unknown> };
      setAllowed(data.values?.["auth.allowRegistration"] !== false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="registration-card">
      <CardHeader>
        <CardTitle>{t("registrationTitle")}</CardTitle>
        <CardDescription>{t("registrationDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span>{t("registrationToggle")}</span>
          <div className="flex items-center gap-2">
            {error && <span className="text-sm text-destructive">{t("registrationError")}</span>}
            <Button
              type="button"
              variant={allowed ? "default" : "outline"}
              size="sm"
              disabled={busy}
              data-testid="registration-toggle"
              onClick={() => void toggle()}
            >
              {allowed ? t("registrationOn") : t("registrationOff")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SecurityPanel({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("settings");
  return (
    <div className="flex flex-col gap-4" data-testid="security-panel">
      <Card data-testid="api-card">
        <CardHeader>
          <CardTitle>{t("apiTitle")}</CardTitle>
          <CardDescription>{t("apiIntro")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeysPanel embedded />
        </CardContent>
      </Card>
      <SessionsCard />
      {!isAdmin && <UsersPanel isAdmin={false} />}
      {isAdmin && (
        <>
          <AdminZoneHeader />
          <ApiLimitsSection />
          <RegistrationSection />
          <UsersPanel isAdmin />
        </>
      )}
    </div>
  );
}
