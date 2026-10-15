"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { Check, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { JobTaskCard } from "@/components/settings/job-task-card";
import { AudioInputCard } from "@/components/settings/audio-input-card";
import { cn } from "@/lib/utils";
import { msToSeconds, secondsToMs } from "@/lib/ms-seconds";

// ── queue runtime card ────────────────────────────────────────────────────────

const RUNTIME_KEYS = [
  "memory.queue.concurrency",
  "memory.queue.claimIntervalMs",
  "memory.queue.staleLeaseMs",
  "memory.queue.retentionDays",
] as const;

type RuntimeKey = (typeof RUNTIME_KEYS)[number];

const RUNTIME_DEFAULTS: Record<RuntimeKey, string> = {
  "memory.queue.concurrency": "1",
  "memory.queue.claimIntervalMs": "5",
  "memory.queue.staleLeaseMs": "300",
  "memory.queue.retentionDays": "7",
};

// Stored in ms, shown/entered in seconds.
const SECOND_KEYS = new Set<RuntimeKey>(["memory.queue.claimIntervalMs", "memory.queue.staleLeaseMs"]);

type RuntimeStatus = "idle" | "saving" | "saved" | "error";

function RuntimeCard() {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  const [values, setValues] = useState<Record<RuntimeKey, string>>({
    "memory.queue.concurrency": "",
    "memory.queue.claimIntervalMs": "",
    "memory.queue.staleLeaseMs": "",
    "memory.queue.retentionDays": "",
  });
  const [status, setStatus] = useState<RuntimeStatus>("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { values?: Record<string, unknown> };
        if (!alive) return;
        setValues((prev) => {
          const next = { ...prev };
          for (const key of RUNTIME_KEYS) {
            const raw = data.values?.[key];
            next[key] =
              typeof raw === "number" && Number.isFinite(raw)
                ? SECOND_KEYS.has(key)
                  ? msToSeconds(raw)
                  : String(raw)
                : "";
          }
          return next;
        });
      } catch {
        /* keep empty inputs; placeholders show the defaults */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const body: Record<string, number> = {};
  for (const key of RUNTIME_KEYS) {
    const trimmed = values[key].trim();
    if (!trimmed) continue;
    if (SECOND_KEYS.has(key)) {
      const ms = secondsToMs(trimmed);
      if (ms !== null) body[key] = ms;
      continue;
    }
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) body[key] = n;
  }
  const invalidInput = RUNTIME_KEYS.some((key) => {
    const trimmed = values[key].trim();
    if (!trimmed) return false;
    if (SECOND_KEYS.has(key)) return secondsToMs(trimmed) === null;
    const n = Number(trimmed);
    return !Number.isInteger(n) || n <= 0;
  });
  const canSave = Object.keys(body).length > 0 && !invalidInput && status !== "saving";

  async function save() {
    if (!canSave) return;
    setStatus("saving");
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setStatus(res.ok ? "saved" : "error");
    } catch {
      setStatus("error");
    }
  }

  const field = (
    key: RuntimeKey,
    id: string,
    testId: string,
    label: ReactNode,
    opts: { min?: number; step?: number } = {}
  ) => (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        data-testid={testId}
        type="number"
        inputMode={SECOND_KEYS.has(key) ? "decimal" : "numeric"}
        min={opts.min ?? 1}
        step={opts.step ?? 1}
        value={values[key]}
        placeholder={RUNTIME_DEFAULTS[key]}
        className="max-w-40 font-mono text-xs"
        onChange={(e) => {
          setValues((v) => ({ ...v, [key]: e.target.value }));
          setStatus("idle");
        }}
      />
    </div>
  );

  return (
    <Card data-testid="jobs-runtime-card">
      <CardHeader>
        <CardTitle>{t("jobs.runtimeTitle")}</CardTitle>
        <CardDescription>{t("jobs.runtimeIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {field(
          "memory.queue.concurrency",
          "jobs-rt-concurrency",
          "jobs-runtime-concurrency",
          <>
            {t("jobs.concurrency")} <span className="text-muted-foreground">(1-8)</span>
          </>
        )}
        {field(
          "memory.queue.claimIntervalMs",
          "jobs-rt-claim-interval",
          "jobs-runtime-claim-interval",
          t("jobs.claimInterval"),
          { min: 1, step: 0.5 }
        )}
        {field(
          "memory.queue.staleLeaseMs",
          "jobs-rt-stale-lease",
          "jobs-runtime-stale-lease",
          t("jobs.staleLease"),
          { min: 10, step: 5 }
        )}
        {field(
          "memory.queue.retentionDays",
          "jobs-rt-retention",
          "jobs-runtime-retention",
          t("jobs.retention")
        )}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            data-testid="jobs-runtime-save"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {ta("save")}
          </Button>
          {status === "saved" && (
            <span data-testid="jobs-runtime-status" className="flex items-center gap-1 text-sm text-emerald-600">
              <Check className="size-4" />
              {ta("saved")}
            </span>
          )}
          {status === "error" && (
            <span data-testid="jobs-runtime-status" className="text-sm text-destructive">
              {ta("errorGeneric")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── queue monitor card ────────────────────────────────────────────────────────

type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
type StatusFilter = "active" | JobStatus;

const STATUS_FILTERS: { value: StatusFilter; key: string }[] = [
  { value: "active", key: "jobs.statusActive" },
  { value: "pending", key: "jobs.statusPending" },
  { value: "running", key: "jobs.statusRunning" },
  { value: "succeeded", key: "jobs.statusSucceeded" },
  { value: "failed", key: "jobs.statusFailed" },
  { value: "cancelled", key: "jobs.statusCancelled" },
];

const JOB_TYPE_OPTIONS = [
  "chat.title_generation",
  "memory.fact_extraction",
  "memory.thread_summary",
  "memory.dreaming",
  "debug.echo",
] as const;

type JobScope = {
  threadId: string | null;
  threadTitle: string | null;
  userId: string | null;
  userName: string | null;
};

type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  scope: JobScope;
  runAfter: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  lastError: string | null;
  resultJson: string | null;
};

type MonitorFeedback = { kind: "ok" | "error"; text: string };

const AUTO_REFRESH_MS = 5000;

function relativeRunAfter(iso: string, t: ReturnType<typeof useTranslations>): string {
  const diff = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diff)) return "—";
  if (diff <= 0) return t("jobs.now");
  return t("jobs.inSeconds", { seconds: Math.max(1, Math.ceil(diff / 1000)) });
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s: string | null, max: number): string {
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function StatusBadge({ status, t }: { status: JobStatus; t: ReturnType<typeof useTranslations> }) {
  const label = t(`jobs.status${status.charAt(0).toUpperCase()}${status.slice(1)}` as "jobs.statusPending");
  switch (status) {
    case "pending":
      return <Badge variant="secondary">{label}</Badge>;
    case "running":
      return <Badge className="border-transparent bg-blue-500/15 text-blue-600">{label}</Badge>;
    case "succeeded":
      return <Badge className="border-transparent bg-emerald-500/15 text-emerald-600">{label}</Badge>;
    case "failed":
      return <Badge variant="destructive">{label}</Badge>;
    case "cancelled":
      return <Badge variant="secondary" className="text-muted-foreground line-through">{label}</Badge>;
  }
}

function MonitorCard() {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  const locale = useLocale();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [typeFilter, setTypeFilter] = useState("");
  const [query, setQuery] = useState("");
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<MonitorFeedback | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const sp = new URLSearchParams();
    sp.set("status", statusFilter);
    if (typeFilter) sp.set("type", typeFilter);
    const q = query.trim();
    if (q) sp.set("q", q);
    sp.set("limit", "100");
    try {
      const res = await fetch(`/api/admin/jobs?${sp.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { jobs?: unknown };
      if (id !== requestId.current) return;
      setJobs(Array.isArray(data.jobs) ? (data.jobs as JobRow[]) : []);
      setFailed(false);
    } catch {
      if (id !== requestId.current) return;
      setFailed(true);
    }
  }, [statusFilter, typeFilter, query]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void load();
    }, AUTO_REFRESH_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [load]);

  async function jobAction(key: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(key);
    try {
      const res = await fetch("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (key === "retryAll") {
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as { retried?: unknown } | null;
          const count = typeof data?.retried === "number" ? data.retried : 0;
          setFeedback({ kind: "ok", text: t("jobs.retried", { count }) });
        } else if (res.status !== 409) {
          setFeedback({ kind: "error", text: ta("errorGeneric") });
        }
      } else if (!res.ok && res.status !== 409) {
        setFeedback({ kind: "error", text: ta("errorGeneric") });
      }
    } catch {
      setFeedback({ kind: "error", text: ta("errorGeneric") });
    } finally {
      setBusy(null);
      void load();
    }
  }

  const selectClass =
    "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

  return (
    <Card data-testid="jobs-monitor-card">
      <CardHeader>
        <CardTitle>{t("jobs.title")}</CardTitle>
        <CardDescription>{t("jobs.intro")}</CardDescription>
        <CardAction>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="jobs-refresh"
              onClick={() => void load()}
            >
              <RefreshCw data-icon="inline-start" />
              {ta("refresh")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="jobs-refresh-run-echo"
              disabled={busy !== null}
              onClick={() =>
                void jobAction("runEcho", {
                  action: "runNow",
                  type: "debug.echo",
                  text: "manual-echo",
                })
              }
            >
              {t("jobs.runEcho")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="jobs-run-facts"
              disabled={busy !== null}
              onClick={() =>
                void jobAction("runFacts", {
                  action: "runNow",
                  type: "memory.fact_extraction",
                  all: true,
                })
              }
            >
              {t("jobs.runFacts")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="jobs-run-summaries"
              disabled={busy !== null}
              onClick={() =>
                void jobAction("runSummaries", {
                  action: "runNow",
                  type: "memory.thread_summary",
                  all: true,
                })
              }
            >
              {t("jobs.runSummaries")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="jobs-run-dreaming"
              disabled={busy !== null}
              onClick={() =>
                void jobAction("runDreaming", {
                  action: "runNow",
                  type: "memory.dreaming",
                  all: true,
                })
              }
            >
              {t("jobs.runDreaming")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="jobs-retry-all"
              disabled={busy !== null}
              onClick={() => void jobAction("retryAll", { action: "retryAllFailed" })}
            >
              {t("jobs.retryAll")}
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            data-testid="jobs-status-filter"
            aria-label={t("jobs.colStatus")}
            className={selectClass}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {t(f.key as "jobs.statusActive")}
              </option>
            ))}
          </select>
          <select
            data-testid="jobs-type-filter"
            aria-label={t("jobs.colType")}
            className={selectClass}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">{t("jobs.typeAll")}</option>
            {JOB_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <Input
            data-testid="jobs-search"
            value={query}
            placeholder={t("jobs.searchPlaceholder")}
            aria-label={t("jobs.searchPlaceholder")}
            maxLength={200}
            className="w-full sm:max-w-56"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {feedback && (
          <p
            role="status"
            data-testid="jobs-feedback"
            className={cn("text-sm", feedback.kind === "ok" ? "text-emerald-600" : "text-destructive")}
          >
            {feedback.text}
          </p>
        )}
        {failed ? (
          <p className="text-sm text-destructive">{t("jobs.failed")}</p>
        ) : jobs === null ? (
          <p className="text-sm text-muted-foreground">{ta("loading")}</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("jobs.empty")}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="bg-card text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">{t("jobs.colType")}</th>
                  <th className="px-3 py-2 font-medium">{t("jobs.colScope")}</th>
                  <th className="px-3 py-2 font-medium">{t("jobs.colStatus")}</th>
                  <th className="px-3 py-2 font-medium">{t("jobs.colAttempts")}</th>
                  <th className="px-3 py-2 font-medium">{t("jobs.colRunAfter")}</th>
                  <th className="px-3 py-2 font-medium">{t("jobs.colDuration")}</th>
                  <th className="px-3 py-2 font-medium">{t("jobs.colError")}</th>
                  <th className="px-3 py-2 font-medium">{t("jobs.colResult")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("jobs.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} data-testid="jobs-row" className="border-b last:border-0">
                    <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-xs">{job.type}</td>
                    <td className="max-w-[12rem] truncate px-3 py-2 text-xs">
                      {job.scope.threadTitle && job.scope.threadId ? (
                        <Link
                          href={`/c/${job.scope.threadId}`}
                          className="text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {job.scope.threadTitle}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">
                          {job.scope.userName ?? job.scope.userId ?? "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={job.status} t={t} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                      {job.runAfter === null
                        ? "—"
                        : job.status === "pending"
                          ? relativeRunAfter(job.runAfter, t)
                          : new Date(job.runAfter).toLocaleString(locale)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{formatDuration(job.durationMs)}</td>
                    <td
                      className={cn(
                        "max-w-[14rem] truncate px-3 py-2 text-xs",
                        job.lastError && "text-destructive"
                      )}
                      title={job.lastError ?? undefined}
                    >
                      {truncate(job.lastError, 60)}
                    </td>
                    <td className="max-w-[14rem] truncate px-3 py-2 font-mono text-xs text-muted-foreground" title={job.resultJson ?? undefined}>
                      {truncate(job.resultJson, 60)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {job.status === "pending" && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          data-testid={`jobs-row-cancel-${job.id}`}
                          disabled={busy !== null}
                          onClick={() =>
                            void jobAction(`cancel:${job.id}`, { action: "cancel", jobId: job.id })
                          }
                        >
                          {busy === `cancel:${job.id}` ? "…" : t("jobs.cancel")}
                        </Button>
                      )}
                      {job.status === "failed" && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          data-testid={`jobs-row-retry-${job.id}`}
                          disabled={busy !== null}
                          onClick={() =>
                            void jobAction(`retry:${job.id}`, { action: "retry", jobId: job.id })
                          }
                        >
                          {busy === `retry:${job.id}` ? "…" : t("jobs.retryNow")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── panel ─────────────────────────────────────────────────────────────────────

export function JobsPanel() {
  return (
    <div className="flex flex-col gap-4" data-testid="jobs-panel">
      <JobTaskCard
        titleKey="titleTaskTitle"
        introKey="titleTaskIntro"
        impactWarningKey="titleTaskNeverWarning"
        settingKey="chat.title_generation"
        testId="title-task"
        afterPersistLabelKey="titleTaskAfterPersist"
      />
      <AudioInputCard />
      <RuntimeCard />
      <MonitorCard />
    </div>
  );
}
