"use client";

// Memory tab (PLAN §5): shared "My memories" panel (list/add/edit/pin/delete +
// personal opt-out) for every user; admin-only master switch + extraction-task
// cards below, under an "Administration" zone header.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Pencil, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { JobTaskCard } from "@/components/settings/job-task-card";
import { AdminZoneHeader } from "@/components/settings/admin-zone-header";
import { cn } from "@/lib/utils";

type MemoryRow = {
  id: string;
  kind: "fact" | "preference" | "summary" | "insight";
  text: string;
  source: "derived" | "explicit";
  confidence: "low" | "medium" | "high" | null;
  pinned: boolean;
  createdAt: string | number;
};

const KIND_LABEL_KEYS: Record<MemoryRow["kind"], string> = {
  fact: "memory.kindFact",
  preference: "memory.kindPreference",
  summary: "memory.kindSummary",
  insight: "memory.kindInsight",
};

const CONFIDENCE_LABEL_KEYS: Record<"low" | "medium" | "high", string> = {
  low: "memory.confidenceLow",
  medium: "memory.confidenceMedium",
  high: "memory.confidenceHigh",
};

const PAGE_SIZE = 50;

function MyMemoriesPanel() {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [userEnabled, setUserEnabled] = useState<boolean | null>(null);
  const [instanceEnabled, setInstanceEnabled] = useState<boolean | null>(null);
  const [card, setCard] = useState<{ text: string; version: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<"fact" | "preference">("fact");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  // offset/append: page 0 replaces the list (bundle fields included),
  // further offsets append their page to it.
  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    try {
      const res = await fetch(`/api/memory?limit=${PAGE_SIZE}&offset=${offset}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        memories?: MemoryRow[];
        total?: number;
        hasMore?: boolean;
        userEnabled?: boolean | null;
        instanceEnabled?: boolean | null;
        card?: { text: string; version: number } | null;
      };
      const list = Array.isArray(data.memories) ? data.memories : [];
      setRows((prev) => (append ? [...prev, ...list] : list));
      setTotal(typeof data.total === "number" ? data.total : list.length);
      setHasMore(data.hasMore === true);
      if (!append) {
        setUserEnabled(typeof data.userEnabled === "boolean" ? data.userEnabled : null);
        setInstanceEnabled(typeof data.instanceEnabled === "boolean" ? data.instanceEnabled : null);
        setCard(data.card && typeof data.card.text === "string" ? data.card : null);
      }
    } catch {
      /* keep list */
    }
  }, []);

  const load = useCallback(() => fetchPage(0, false), [fetchPage]);

  useEffect(() => {
    // Deferred (0ms) to avoid a synchronous setState cascade on mount.
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  async function mutate(url: string, init: RequestInit, after: () => void) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      if (!res.ok) setError(true);
      else after();
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const followInstance = userEnabled !== false;

  return (
    <Card data-testid="memory-panel">
      <CardHeader>
        <CardTitle>{t("memory.title")}</CardTitle>
        <CardDescription>{t("memory.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {instanceEnabled === false && (
          <p
            data-testid="memory-instance-disabled"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600"
          >
            {t("memory.instanceDisabledNotice")}
          </p>
        )}
        <Label className="flex cursor-pointer items-center gap-2 font-normal text-sm">
          <input
            type="checkbox"
            data-testid="memory-optout"
            className="accent-primary"
            checked={followInstance}
            disabled={busy}
            onChange={(e) =>
              void mutate(
                "/api/memory/prefs",
                { method: "POST", body: JSON.stringify({ userEnabled: e.target.checked ? null : false }) },
                () => {}
              )
            }
          />
          {t("memory.optOut")}
        </Label>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            void mutate(
              "/api/memory",
              { method: "POST", body: JSON.stringify({ text, kind }) },
              () => setDraft("")
            );
          }}
        >
          <Input
            data-testid="memory-add-input"
            value={draft}
            maxLength={500}
            placeholder={t("memory.addPlaceholder")}
            className="min-w-48 flex-1"
            onChange={(e) => setDraft(e.target.value)}
          />
          <select
            data-testid="memory-add-kind"
            aria-label={t("memory.addKindLabel")}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
            value={kind}
            onChange={(e) => setKind(e.target.value === "preference" ? "preference" : "fact")}
          >
            <option value="fact">{t("memory.addKindFact")}</option>
            <option value="preference">{t("memory.addKindPreference")}</option>
          </select>
          <Button type="submit" size="sm" data-testid="memory-add" disabled={busy || !draft.trim()}>
            <Plus data-icon="inline-start" />
            {t("memory.add")}
          </Button>
        </form>
        {error && (
          <p data-testid="memory-error" className="text-sm text-destructive">
            {ta("errorGeneric")}
          </p>
        )}

        {card && (
          <div
            data-testid="memory-card-profile"
            className="grid gap-1 rounded-xl border bg-muted/40 px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">{t("memory.profileTitle")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t("memory.profileUpdated", { version: card.version })}
              </span>
            </div>
            <p className="text-[13px] leading-relaxed whitespace-pre-line">{card.text}</p>
          </div>
        )}

        {rows.length === 0 ? (
          <p data-testid="memory-empty" className="text-sm text-muted-foreground">
            {t("memory.empty")}
          </p>
        ) : (
          <ul className="grid gap-2" data-testid="memory-list">
            {rows.map((m) => (
              <li
                key={m.id}
                data-testid={`memory-row-${m.id}`}
                className="flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  {editingId === m.id ? (
                    <div className="grid gap-2">
                      <Input
                        data-testid={`memory-edit-input-${m.id}`}
                        value={editText}
                        maxLength={500}
                        onChange={(e) => setEditText(e.target.value)}
                      />
                      <div className="flex gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          data-testid={`memory-edit-save-${m.id}`}
                          disabled={busy || !editText.trim()}
                          onClick={() =>
                            void mutate(
                              `/api/memory/${m.id}`,
                              { method: "PATCH", body: JSON.stringify({ text: editText.trim() }) },
                              () => setEditingId(null)
                            )
                          }
                        >
                          <Check data-icon="inline-start" />
                          {t("memory.save")}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          <X data-icon="inline-start" />
                          {t("memory.cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm break-words">{m.text}</p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <Badge variant="secondary" className={cn("text-[10px]", m.pinned && "order-3")}>
                          {t(KIND_LABEL_KEYS[m.kind])}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {m.source === "explicit" ? t("memory.sourceExplicit") : t("memory.sourceDerived")}
                        </Badge>
                        {m.kind === "insight" && m.confidence && (
                          <Badge variant="outline" className="text-[10px]" data-testid={`memory-confidence-${m.id}`}>
                            {t(CONFIDENCE_LABEL_KEYS[m.confidence])}
                          </Badge>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {editingId !== m.id && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={m.pinned ? t("memory.unpin") : t("memory.pin")}
                      data-testid={`memory-pin-${m.id}`}
                      disabled={busy}
                      onClick={() =>
                        void mutate(`/api/memory/${m.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ pinned: !m.pinned }),
                        }, () => {})
                      }
                    >
                      {m.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t("memory.edit")}
                      data-testid={`memory-edit-${m.id}`}
                      onClick={() => {
                        setEditingId(m.id);
                        setEditText(m.text);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t("memory.delete")}
                      data-testid={`memory-delete-${m.id}`}
                      disabled={busy}
                      onClick={() => void mutate(`/api/memory/${m.id}`, { method: "DELETE" }, () => {})}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {hasMore && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="memory-load-more"
            disabled={busy}
            className="justify-self-center"
            onClick={() => void fetchPage(rows.length, true)}
          >
            {t("memory.loadMore", { count: Math.max(0, total - rows.length) })}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function EnableCard() {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  // Mirrors the server-side default (feature on until an admin turns it off).
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { values?: Record<string, unknown> };
        if (typeof data.values?.["memory.enabled"] === "boolean") {
          setEnabled(data.values["memory.enabled"] as boolean);
        }
      } catch {
        /* keep default */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save(next: boolean) {
    setStatus("saving");
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "memory.enabled": next }),
      });
      if (res.ok) {
        setEnabled(next);
        setStatus("saved");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  return (
    <Card data-testid="memory-enable-card">
      <CardHeader>
        <CardTitle>{t("memory.adminEnableTitle")}</CardTitle>
        <CardDescription>{t("memory.adminEnableIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Label className="flex cursor-pointer items-center gap-2 font-normal text-sm">
          <input
            type="checkbox"
            data-testid="memory-enabled"
            className="accent-primary"
            checked={enabled}
            disabled={status === "saving"}
            onChange={(e) => void save(e.target.checked)}
          />
          {t("memory.enableLabel")}
        </Label>
        {status === "saved" && (
          <span data-testid="memory-enable-status" className="flex items-center gap-1 text-sm text-emerald-600">
            <Check className="size-4" />
            {ta("saved")}
          </span>
        )}
        {status === "error" && (
          <span data-testid="memory-enable-status" className="text-sm text-destructive">
            {ta("errorGeneric")}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

type TuningKey =
  | "memory.recall.tokenBudget"
  | "memory.recall.topK"
  | "memory.transcript.msgTruncChars"
  | "memory.transcript.capChars"
  | "memory.dream.softDeadlineMs"
  | "memory.dream.chunkSize"
  | "memory.dream.insightsPerNight"
  | "memory.dream.cardRebuildEvery";

const TUNING_KEYS: TuningKey[] = [
  "memory.recall.tokenBudget",
  "memory.recall.topK",
  "memory.transcript.msgTruncChars",
  "memory.transcript.capChars",
  "memory.dream.softDeadlineMs",
  "memory.dream.chunkSize",
  "memory.dream.insightsPerNight",
  "memory.dream.cardRebuildEvery",
];

const TUNING_LABEL_KEYS: Record<TuningKey, string> = {
  "memory.recall.tokenBudget": "memory.tuningRecallBudget",
  "memory.recall.topK": "memory.tuningTopK",
  "memory.transcript.msgTruncChars": "memory.tuningMsgTrunc",
  "memory.transcript.capChars": "memory.tuningTranscriptCap",
  "memory.dream.softDeadlineMs": "memory.tuningDreamDeadline",
  "memory.dream.chunkSize": "memory.tuningDreamChunk",
  "memory.dream.insightsPerNight": "memory.tuningDreamInsights",
  "memory.dream.cardRebuildEvery": "memory.tuningDreamCardRebuild",
};

const TUNING_HINT_KEYS: Record<TuningKey, string> = {
  "memory.recall.tokenBudget": "memory.tuningRecallBudgetHint",
  "memory.recall.topK": "memory.tuningTopKHint",
  "memory.transcript.msgTruncChars": "memory.tuningMsgTruncHint",
  "memory.transcript.capChars": "memory.tuningTranscriptCapHint",
  "memory.dream.softDeadlineMs": "memory.tuningDreamDeadlineHint",
  "memory.dream.chunkSize": "memory.tuningDreamChunkHint",
  "memory.dream.insightsPerNight": "memory.tuningDreamInsightsHint",
  "memory.dream.cardRebuildEvery": "memory.tuningDreamCardRebuildHint",
};

function TuningCard() {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  const [values, setValues] = useState<Record<TuningKey, string>>({
    "memory.recall.tokenBudget": "",
    "memory.recall.topK": "",
    "memory.transcript.msgTruncChars": "",
    "memory.transcript.capChars": "",
    "memory.dream.softDeadlineMs": "",
    "memory.dream.chunkSize": "",
    "memory.dream.insightsPerNight": "",
    "memory.dream.cardRebuildEvery": "",
  });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { values?: Record<string, unknown> };
        setValues((prev) => {
          const next = { ...prev };
          for (const key of TUNING_KEYS) {
            const v = data.values?.[key];
            if (typeof v === "number") next[key] = String(v);
          }
          return next;
        });
      } catch {
        /* keep empty inputs */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    if (status === "saving") return;
    const payload: Record<string, number> = {};
    for (const key of TUNING_KEYS) {
      const n = Number.parseInt(values[key], 10);
      if (Number.isFinite(n) && n > 0) payload[key] = n;
    }
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

  const anyValid = TUNING_KEYS.some((key) => {
    const n = Number.parseInt(values[key], 10);
    return Number.isFinite(n) && n > 0;
  });

  return (
    <Card data-testid="memory-tuning-card">
      <CardHeader>
        <CardTitle>{t("memory.tuningTitle")}</CardTitle>
        <CardDescription>{t("memory.tuningIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {TUNING_KEYS.map((key) => (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={`memory-tuning-${key}`}>{t(TUNING_LABEL_KEYS[key])}</Label>
              <Input
                id={`memory-tuning-${key}`}
                type="number"
                min={1}
                data-testid={`memory-tuning-${key}`}
                value={values[key]}
                className="max-w-40 font-mono text-xs"
                onChange={(e) => {
                  setValues((prev) => ({ ...prev, [key]: e.target.value }));
                  setStatus("idle");
                }}
              />
              <p className="text-xs text-muted-foreground">{t(TUNING_HINT_KEYS[key])}</p>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            data-testid="memory-tuning-save"
            disabled={status === "saving" || !anyValid}
            onClick={() => void save()}
          >
            {ta("save")}
          </Button>
          {status === "saved" && (
            <span data-testid="memory-tuning-status" className="flex items-center gap-1 text-sm text-emerald-600">
              <Check className="size-4" />
              {ta("saved")}
            </span>
          )}
          {status === "error" && (
            <span data-testid="memory-tuning-status" className="text-sm text-destructive">
              {ta("errorGeneric")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function MemoryPanel({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="grid gap-4">
      <MyMemoriesPanel />
      {isAdmin && (
        <>
          <AdminZoneHeader />
          <EnableCard />
          <TuningCard />
          <JobTaskCard
            titleKey="memory.taskTitle"
            introKey="memory.taskIntro"
            impactWarningKey="memory.taskImpact"
            settingKey="memory.events.fact_extraction"
            testId="memory-task"
          />
          <JobTaskCard
            titleKey="memory.taskSummaryTitle"
            introKey="memory.taskSummaryIntro"
            impactWarningKey="memory.taskSummaryImpact"
            settingKey="memory.events.thread_summary"
            testId="summary-task"
          />
          <JobTaskCard
            titleKey="memory.taskDreamTitle"
            introKey="memory.taskDreamIntro"
            impactWarningKey="memory.taskDreamImpact"
            settingKey="memory.events.dreaming"
            testId="dream-task"
          />
        </>
      )}
    </div>
  );
}
