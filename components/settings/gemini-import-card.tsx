"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CircleAlert, CircleCheck, CircleDashed, ChevronDown, TriangleAlert } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TERMINAL, type ImportBatchView, type ImportReportView } from "@/components/settings/gemini-import-types";

const POLL_MS = 2500;

// A past batch in one of these statuses counts as "migration done": the card
// collapses by default (still openable) once the user has imported their chats.
const DONE_STATUSES: readonly string[] = ["succeeded", "partial"];

const ERROR_KEYS: Record<string, string> = {
  empty_upload: "errEmpty",
  not_ndjson: "errNotNdjson",
  upload_too_large: "errTooLarge",
  import_in_progress: "errInProgress",
  upload_aborted: "errAborted",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "succeeded") return <CircleCheck className="size-4 shrink-0" aria-hidden />;
  if (status === "partial" || status === "failed") return <TriangleAlert className="size-4 shrink-0" aria-hidden />;
  if (status === "cancelled") return <CircleAlert className="size-4 shrink-0" aria-hidden />;
  return <CircleDashed className="size-4 shrink-0" aria-hidden />;
}

export function GeminiImportCard() {
  const t = useTranslations("settings.geminiImport");
  const [batch, setBatch] = useState<ImportBatchView | null>(null);
  const [report, setReport] = useState<ImportReportView | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [learn, setLearn] = useState(false);
  // Hidden while the admin memory-derivation switch is off (the import itself
  // still runs; only the learnFromImports chain depends on memory).
  const [learnEnabled, setLearnEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [migrated, setMigrated] = useState(false);
  // null = user never toggled the card: follow the auto rule (collapsed once
  // a migration is done). true/false = manual choice until the next mount.
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = !migrated || (expandedOverride ?? false);

  const active = batch !== null && !TERMINAL.includes(batch.status);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/import/gemini/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { import: ImportBatchView; report: ImportReportView | null };
    setBatch(data.import);
    setReport(data.report);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/import/gemini", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { imports: ImportBatchView[]; learnEnabled?: boolean };
      setLearnEnabled(data.learnEnabled !== false);
      const latest = data.imports[0] ?? null;
      setBatch(latest);
      setMigrated(data.imports.some((i) => DONE_STATUSES.includes(i.status)));
      if (latest && TERMINAL.includes(latest.status)) await loadDetail(latest.importId);
      else setReport(null);
    } catch {
      /* transient network error; the poller retries */
    }
  }, [loadDetail]);

  useEffect(() => {
    // Deferred like the jobs panel: avoids a synchronous setState cascade on mount.
    const initial = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(initial);
  }, [refresh]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const res = await fetch(`/api/import/gemini/upload${learn ? "?learn=1" : ""}`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson", "x-file-name": file.name },
        body: file,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorKey(ERROR_KEYS[body.error ?? ""] ?? "errGeneric");
      } else {
        setFile(null);
        setExpandedOverride(true); // keep the card open to watch the new import
        await refresh();
      }
    } catch {
      setErrorKey("errGeneric");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!batch) return;
    setBusy(true);
    setErrorKey(null);
    try {
      await fetch(`/api/import/gemini/${batch.importId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const counts = batch?.counts;

  return (
    <Card data-testid="gemini-import-card">
      <CardHeader>
        <button
          type="button"
          data-testid="gemini-import-toggle"
          className={cn("flex items-start justify-between gap-2 text-left", !migrated && "cursor-default")}
          disabled={!migrated}
          aria-expanded={expanded}
          onClick={() => setExpandedOverride((v) => !(v ?? false))}
        >
          <span className="grid gap-1">
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("intro")}</CardDescription>
          </span>
          {migrated && (
            <ChevronDown
              className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
              aria-hidden
            />
          )}
        </button>
      </CardHeader>
      {expanded && (
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {t("scriptHintStart")}{" "}
          <a
            className="underline underline-offset-2"
            href="https://github.com/storm1er/gemini-chat-exporter"
            target="_blank"
            rel="noreferrer"
          >
            {t("scriptLink")}
          </a>
          {t("scriptHintEnd")}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            accept=".ndjson,application/x-ndjson,application/json"
            data-testid="gemini-import-file"
            className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-2 file:py-1 file:text-sm"
            disabled={busy || active}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {learnEnabled && (
            <label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
              <input
                type="checkbox"
                data-testid="gemini-import-learn"
                className="accent-primary"
                checked={learn}
                disabled={busy || active}
                onChange={(e) => setLearn(e.target.checked)}
              />
              {t("learn")}
            </label>
          )}
          <Button data-testid="gemini-import-upload" size="sm" disabled={!file || busy || active} onClick={() => void upload()}>
            {t("start")}
          </Button>
        </div>
        {learnEnabled && <p className="text-xs text-muted-foreground">{t("learnHint")}</p>}

        {errorKey && (
          <p className="text-sm text-destructive" data-testid="gemini-import-error">
            {t(errorKey)}
          </p>
        )}

        {batch && (
          <div className="grid gap-1 rounded-lg border border-border p-3" data-testid="gemini-import-progress">
            <p className="flex items-center gap-2 text-sm font-medium">
              {batch && <StatusIcon status={batch.status} />}
              {t(`status.${batch.status}`)}
              {active && (
                <Button
                  data-testid="gemini-import-cancel"
                  size="sm"
                  variant="destructive"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  {t("cancel")}
                </Button>
              )}
            </p>
            {counts && (
              <p className="text-sm text-muted-foreground" data-testid="gemini-import-counts">
                {t("importedCount", { n: counts.imported })}
                {counts.skippedUnchanged > 0 && ` · ${t("skippedUnchanged", { n: counts.skippedUnchanged })}`}
                {counts.skippedChanged > 0 && ` · ${t("skippedChanged", { n: counts.skippedChanged })}`}
                {counts.failed > 0 && ` · ${t("failedCount", { n: counts.failed })}`}
                {counts.malformed > 0 && ` · ${t("malformedCount", { n: counts.malformed })}`}
              </p>
            )}
            {batch.status === "cancelled" && <p className="text-xs text-muted-foreground">{t("cancelledNote")}</p>}
          </div>
        )}

        {report && (
          <div className="grid gap-2 rounded-lg border border-border p-3 text-sm" data-testid="gemini-import-report">
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlert className={report.duplicateGroups.length > 0 || report.suspectRun ? "size-4 text-amber-500" : "hidden"} aria-hidden />
              {t("reportTitle")}
            </p>
            <p className="text-xs text-muted-foreground">{t("datesNote")}</p>
            {report.failures.length > 0 ? (
              <div className="grid gap-0.5">
                <p className="font-medium">{t("failuresTitle")}</p>
                {report.failures.slice(0, 8).map((f) => (
                  <p key={f.externalId} className="text-xs text-muted-foreground">
                    {t("failureItem", { id: f.externalId.slice(0, 8), reason: f.reason })}
                  </p>
                ))}
                {report.failures.length > 8 && (
                  <p className="text-xs text-muted-foreground">{t("moreFailures", { n: report.failures.length - 8 })}</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("noFailures")}</p>
            )}
            {report.duplicateGroups.length > 0 && (
              <div className="grid gap-0.5">
                <p className="font-medium">{t("duplicatesTitle")}</p>
                {report.duplicateGroups.slice(0, 5).map((g) => (
                  <p key={g.bodyHash} className="text-xs text-muted-foreground">
                    {t("duplicatesItem", { count: g.count, hash: g.bodyHash })}
                  </p>
                ))}
              </div>
            )}
            {report.suspectRun && (
              <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="gemini-import-suspect">
                {t("suspectNote", { start: report.suspectRun.startLine, length: report.suspectRun.length })}
              </p>
            )}
          </div>
        )}
      </CardContent>
      )}
    </Card>
  );
}
