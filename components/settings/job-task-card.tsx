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
import { fetchModelOptions, ModelSelect, type ModelOption } from "@/components/settings/model-select";
import { msToSeconds, secondsToMs } from "@/lib/ms-seconds";

type Schedule = "after_persist" | "idle" | "cron" | "never";

type EventConfig = {
  schedule: Schedule;
  idleMinutes?: number;
  cronExpr?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  enabled?: boolean;
};



const SCHEDULES: Schedule[] = ["after_persist", "idle", "cron", "never"];

function toInt(v: string): number | undefined {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function JobTaskCard({
  titleKey,
  introKey,
  impactWarningKey,
  settingKey,
  testId,
  afterPersistLabelKey,
}: {
  titleKey: string;
  introKey: string;
  impactWarningKey: string;
  settingKey: string;
  testId: string;
  // Per-task override: `after_persist` means "each message" for memory events but
  // "first message of a new chat" for the title task.
  afterPersistLabelKey?: string;
}) {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  const [schedule, setSchedule] = useState<Schedule>("after_persist");
  const [idleMinutes, setIdleMinutes] = useState("30");
  const [cronExpr, setCronExpr] = useState("0 4 * * *");
  const [model, setModel] = useState("");
  const [timeoutSec, setTimeoutSec] = useState("60");
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [settingsRes, modelIds] = await Promise.all([
          fetch("/api/admin/settings", { cache: "no-store" }),
          fetchModelOptions(),
        ]);
        if (!alive) return;
        if (settingsRes.ok) {
          const data = (await settingsRes.json()) as { values?: Record<string, unknown> };
          const stored = data.values?.[settingKey];
          if (stored && typeof stored === "object") {
            const c = stored as EventConfig;
            if (SCHEDULES.includes(c.schedule)) setSchedule(c.schedule);
            if (typeof c.idleMinutes === "number") setIdleMinutes(String(c.idleMinutes));
            if (typeof c.cronExpr === "string" && c.cronExpr) setCronExpr(c.cronExpr);
            if (typeof c.model === "string") setModel(c.model);
            if (typeof c.timeoutMs === "number") setTimeoutSec(msToSeconds(c.timeoutMs));
            if (typeof c.maxAttempts === "number") setMaxAttempts(String(c.maxAttempts));
            if (typeof c.enabled === "boolean") setEnabled(c.enabled);
          }
        }
        setModelOptions(modelIds);
      } catch {
        /* keep defaults / empty datalist */
      }
    })();
    return () => {
      alive = false;
    };
  }, [settingKey]);

  function scheduleLabel(mode: Schedule): string {
    switch (mode) {
      case "after_persist":
        return t(afterPersistLabelKey ?? "task.scheduleAfterPersist");
      case "idle":
        return t("task.scheduleIdle");
      case "cron":
        return t("task.scheduleCron");
      default:
        return t("task.scheduleNever");
    }
  }

  async function save() {
    if (status === "saving") return;
    setStatus("saving");
    const config: EventConfig = {
      schedule,
      idleMinutes: toInt(idleMinutes),
      cronExpr: cronExpr.trim() || undefined,
      model: model.trim() || undefined,
      timeoutMs: secondsToMs(timeoutSec) ?? undefined,
      maxAttempts: toInt(maxAttempts),
      enabled,
    };
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingKey]: config }),
      });
      setStatus(res.ok ? "saved" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(titleKey)}</CardTitle>
        <CardDescription>{t(introKey)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2">
          <Label>{t("task.schedule")}</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {SCHEDULES.map((mode) => (
              <Label key={mode} className="cursor-pointer font-normal">
                <input
                  type="radio"
                  name={`${testId}-schedule`}
                  data-testid={`${testId}-schedule-${mode}`}
                  checked={schedule === mode}
                  className="accent-primary"
                  onChange={() => {
                    setSchedule(mode);
                    setStatus("idle");
                  }}
                />
                {scheduleLabel(mode)}
              </Label>
            ))}
          </div>
        </div>
        {schedule === "never" && (
          <p data-testid={`${testId}-warning`} className="text-sm text-destructive">
            {t(impactWarningKey)}
          </p>
        )}
        {schedule === "idle" && (
          <div className="grid gap-2">
            <Label htmlFor={`${testId}-idle`}>{t("task.idleMinutes")}</Label>
            <Input
              id={`${testId}-idle`}
              type="number"
              min={1}
              data-testid={`${testId}-idle`}
              value={idleMinutes}
              className="max-w-32 font-mono text-xs"
              onChange={(e) => {
                setIdleMinutes(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
        )}
        {schedule === "cron" && (
          <div className="grid gap-2">
            <Label htmlFor={`${testId}-cron`}>{t("task.cronExpr")}</Label>
            <Input
              id={`${testId}-cron`}
              data-testid={`${testId}-cron`}
              value={cronExpr}
              maxLength={100}
              className="max-w-48 font-mono text-xs"
              onChange={(e) => {
                setCronExpr(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor={`${testId}-model`}>{t("task.model")}</Label>
          <ModelSelect
            ariaLabel={t("task.model")}
            testId={`${testId}-model`}
            value={model}
            options={modelOptions}
            placeholder={t("task.modelPlaceholder")}
            emptyOptionLabel={t("task.modelPlaceholder")}
            onChange={(id) => {
              setModel(id);
              setStatus("idle");
            }}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor={`${testId}-timeout`}>{t("task.timeout")}</Label>
            <Input
              id={`${testId}-timeout`}
              type="number"
              min={1}
              step={0.1}
              data-testid={`${testId}-timeout`}
              value={timeoutSec}
              className="font-mono text-xs"
              onChange={(e) => {
                setTimeoutSec(e.target.value);
                setStatus("idle");
              }}
            />
            <p className="text-xs text-muted-foreground">{t("task.timeoutHint")}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${testId}-attempts`}>{t("task.attempts")}</Label>
            <Input
              id={`${testId}-attempts`}
              type="number"
              min={1}
              data-testid={`${testId}-attempts`}
              value={maxAttempts}
              className="font-mono text-xs"
              onChange={(e) => {
                setMaxAttempts(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            data-testid={`${testId}-save`}
            disabled={status === "saving"}
            onClick={() => void save()}
          >
            {ta("save")}
          </Button>
          {status === "saved" && (
            <span
              data-testid={`${testId}-save-status`}
              className="flex items-center gap-1 text-sm text-emerald-600"
            >
              <Check className="size-4" />
              {ta("saved")}
            </span>
          )}
          {status === "error" && (
            <span data-testid={`${testId}-save-status`} className="text-sm text-destructive">
              {ta("errorGeneric")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
