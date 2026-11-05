"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Check, ChevronRight, RefreshCw, Search } from "lucide-react";
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
import { ModelOptionsDialog } from "@/components/settings/model-options-dialog";
import { ChatLimitsCard } from "@/components/settings/chat-limits-card";
import { WarmupCard } from "@/components/settings/warmup-card";
import { McpCard } from "@/components/settings/mcp-card";
import { fetchModelOptions, ModelSelect, type ModelOption } from "@/components/settings/model-select";
import { CatalogCard, ProvidersCard, apiJson, type ProviderRow } from "@/components/settings/providers-card";
import { cn } from "@/lib/utils";

// The Backend tab drives every control-plane call for the SELECTED provider
// (docs/provider-plan.md M3, `?provider=`).
function adminUrl(path: string, providerId: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}provider=${encodeURIComponent(providerId)}`;
}

async function fetchModelRows(providerId: string): Promise<{ rows: ModelRow[]; mutationsEnabled: boolean }> {
  const res = await fetch(adminUrl("/api/admin/models", providerId), { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as { models: ModelRow[]; mutations_enabled?: boolean };
  return {
    rows: Array.isArray(data.models) ? data.models : [],
    mutationsEnabled: data.mutations_enabled === true,
  };
}

// ── shared types ──────────────────────────────────────────────────────────────

export type ModelRow = {
  id: string | null;
  recipe: string | null;
  size: number | string | null;
  downloaded: boolean;
  labels: string[];
  checkpoint: string | null;
  max_context_window: number | null;
};

type ServerData = {
  health: Record<string, unknown> | null;
  systemInfo: Record<string, unknown> | null;
  systemStats: Record<string, unknown> | null;
};

type RegistryEntry = {
  display_name?: string;
  repository_id?: string;
  source?: string;
  downloads?: number;
  has_gguf?: boolean;
};

type RegistryVariant = { name?: string; size_bytes?: number; sharded?: boolean };

type RegistryVariantsInfo = {
  recipe?: string;
  suggestedName?: string;
  labels: string[];
  mmprojFile?: string;
  rows: RegistryVariant[];
};

type RegistryVariantsState = RegistryVariantsInfo | "loading" | "error" | "non-gguf";

type DownloadJob = {
  id?: string;
  model_name?: string;
  status?: string;
  running?: boolean;
  percent?: number | null;
  bytes_downloaded?: number | null;
  total_download_size?: number | null;
  bytes_total?: number | null;
  overall_bytes_downloaded?: number | null;
  cumulative_bytes_downloaded?: number | null;
  completed_files_bytes?: number | null;
  file_index?: number | null;
  total_files?: number | null;
  complete?: boolean;
  error?: string;
};

type TrackedJob = DownloadJob & {
  id: string;
  modelName: string;
  label: string;
  repo?: string;
  variantKey: string;
  cancelling?: boolean;
};

type MutationState = "unknown" | "disabled" | "enabled";

const SERVER_REFRESH_MS = 30_000;
const DOWNLOAD_POLL_MS = 2_500;

// ── helpers ───────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sizeNumber(size: number | string | null): number | null {
  const n = typeof size === "number" ? size : size === null ? NaN : Number(size);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

/**
 * Multi-file downloads report per-file progress (bytes_downloaded/percent reset at file
 * boundaries); prefer the overall counters so the bar keeps advancing across files.
 */
function jobOverall(job: DownloadJob): { done: number | null; total: number | null } {
  const done =
    num(job.overall_bytes_downloaded) ??
    num(job.cumulative_bytes_downloaded) ??
    (num(job.completed_files_bytes) != null
      ? (num(job.completed_files_bytes) as number) + (num(job.bytes_downloaded) ?? 0)
      : num(job.bytes_downloaded));
  const total = sizeNumber(sizeOrNull(job.total_download_size)) ?? sizeNumber(sizeOrNull(job.bytes_total));
  return { done: done != null && Number.isFinite(done) ? done : null, total };
}

function jobPercent(job: DownloadJob): number | null {
  const { done, total } = jobOverall(job);
  if (done != null && total) return Math.max(0, Math.min(100, (done / total) * 100));
  return num(job.percent);
}

function sizeOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" ? v : null;
}

/** Upstream /v1/models `size` is already GB; registry variant sizes are bytes. */
function formatGb(gb: number | null): string {
  if (gb === null) return "—";
  return gb >= 100 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
}

function parseGb(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/([\d.,]+)\s*GB/i);
  return m ? Number.parseFloat(m[1].replace(",", ".")) : null;
}

function StatBar({
  testId,
  label,
  percent,
  valueText,
}: {
  testId: string;
  label: string;
  percent: number;
  valueText?: string;
}) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{valueText ?? `${Math.round(pct)}%`}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          data-testid={testId}
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Server card ───────────────────────────────────────────────────────────────

function ServerCard({ providerId }: { providerId: string }) {
  const t = useTranslations("admin");
  const [data, setData] = useState<ServerData | null>(null);
  const [failed, setFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(adminUrl("/api/admin/server", providerId), { cache: "no-store" });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setData((await res.json()) as ServerData);
      setFailed(false);
      setUpdatedAt(Date.now());
    } catch {
      setFailed(true);
    }
  }, [providerId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), SERVER_REFRESH_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [load]);

  const health = data?.health ?? null;
  const info = data?.systemInfo ?? null;
  const stats = data?.systemStats ?? null;
  const online = health !== null;

  const loaded = (Array.isArray(health?.all_models_loaded) ? health.all_models_loaded : [])
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .map((e) => ({
      checkpoint: typeof e.checkpoint === "string" ? e.checkpoint : "",
      device: typeof e.device === "string" ? e.device : "",
    }))
    .filter((e) => e.checkpoint || e.device);

  const systemLine = info
    ? [info["OS Version"], info["Processor"], info["Physical Memory"]]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(" · ")
    : "";

  const cpuPercent = num(stats?.cpu_percent) ?? 0;
  const memGb = num(stats?.memory_gb);
  const totalGb = parseGb(info?.["Physical Memory"]);
  const memPct = memGb !== null && totalGb ? (memGb / totalGb) * 100 : 0;

  return (
    <Card data-testid="admin-server-card">
      <CardHeader>
        <CardTitle>{t("serverTitle")}</CardTitle>
        <CardDescription className="flex items-center gap-2">
          <span
            data-testid="server-health-dot"
            title={online ? t("online") : t("offline")}
            className={cn("size-2.5 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-destructive")}
          />
          {failed && !data ? t("serverFailed") : online ? t("online") : t("offline")}
          {updatedAt !== null && (
            <span className="font-mono text-xs">
              {new Date(updatedAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
        </CardDescription>
        <CardAction>
          <Button type="button" size="sm" variant="ghost" data-testid="server-refresh" onClick={() => void load()}>
            <RefreshCw data-icon="inline-start" />
            {t("refresh")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1">
          <p className="text-xs font-medium text-muted-foreground">{t("loadedModels")}</p>
          {loaded.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noneLoaded")}</p>
          ) : (
            loaded.map((m, i) => (
              <p
                key={`${m.checkpoint}-${i}`}
                data-testid="server-loaded-model"
                className="truncate font-mono text-xs"
              >
                {m.checkpoint}
                {m.device && <span className="text-muted-foreground"> · {m.device}</span>}
              </p>
            ))
          )}
        </div>
        {systemLine && (
          <p data-testid="server-system-line" className="text-xs text-muted-foreground">
            {systemLine}
          </p>
        )}
        <div className="grid gap-3 pt-1">
          <StatBar testId="bar-cpu" label={t("cpu")} percent={cpuPercent} />
          <StatBar
            testId="bar-memory"
            label={t("memory")}
            percent={memPct}
            valueText={
              memGb !== null
                ? `${memGb.toFixed(1)}${totalGb ? ` / ${totalGb.toFixed(0)}` : ""} GB`
                : "—"
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("autoRefresh")}</p>
      </CardContent>
    </Card>
  );
}

// ── Models card ───────────────────────────────────────────────────────────────

type SortKey = "id" | "recipe" | "size";
type SortDir = "asc" | "desc";

type Feedback = { kind: "ok" | "error"; text: string };

function ModelsCard({
  providerId,
  rows,
  failed,
  mutations,
  onMutationsDisabled,
  refreshModels,
}: {
  providerId: string;
  rows: ModelRow[] | null;
  failed: boolean;
  mutations: MutationState;
  onMutationsDisabled: () => void;
  refreshModels: () => void;
}) {
  const t = useTranslations("admin");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "id", dir: "asc" });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelRow | null>(null);

  const mutationsDisabled = mutations !== "enabled";

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!pendingDelete) return;
    const timer = window.setTimeout(() => setPendingDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [pendingDelete]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((m) => {
      if (!q) return true;
      return (m.id ?? "").toLowerCase().includes(q) || (m.recipe ?? "").toLowerCase().includes(q);
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "size") {
        const an = sizeNumber(a.size);
        const bn = sizeNumber(b.size);
        if (an === null && bn === null) return 0;
        if (an === null) return 1;
        if (bn === null) return -1;
        return (an - bn) * dir;
      }
      const av = (a[sort.key] ?? "").toLowerCase();
      const bv = (b[sort.key] ?? "").toLowerCase();
      return av.localeCompare(bv) * dir;
    });
  }, [rows, query, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
  }

  async function runAction(action: "load" | "unload" | "delete", modelId: string) {
    const busyKey = `${action}:${modelId}`;
    if (busyAction || mutationsDisabled) return;
    setBusyAction(busyKey);
    setError(false);
    try {
      const res = await fetch(adminUrl("/api/admin/actions", providerId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, model: modelId }),
      });
      if (res.status === 503) {
        onMutationsDisabled();
        return;
      }
      if (!res.ok) {
        setError(true);
        setFeedback({ kind: "error", text: t("errorGeneric") });
        return;
      }
      const message =
        action === "load"
          ? t("feedbackLoaded", { name: modelId })
          : action === "unload"
            ? t("feedbackUnloaded", { name: modelId })
            : t("feedbackDeleted", { name: modelId });
      setFeedback({ kind: "ok", text: message });
      refreshModels();
    } catch {
      setError(true);
      setFeedback({ kind: "error", text: t("errorGeneric") });
    } finally {
      setBusyAction(null);
    }
  }

  function clickDelete(modelId: string) {
    if (pendingDelete !== modelId) {
      setPendingDelete(modelId);
      return;
    }
    setPendingDelete(null);
    void runAction("delete", modelId);
  }

  const header = (key: SortKey, label: string) => {
    const active = sort.key === key;
    return (
      <th
        className="px-3 py-2 font-medium"
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          data-testid={`models-sort-${key}`}
          className="flex cursor-pointer items-center gap-1 hover:text-foreground"
          onClick={() => toggleSort(key)}
        >
          {label}
          {active ? sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
        </button>
      </th>
    );
  };

  const actionButton = (
    action: "load" | "unload",
    modelId: string,
    label: string
  ) => (
    <span title={mutationsDisabled ? t("mutationsDisabled") : undefined}>
      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid={`model-action-${action}-${modelId}`}
        disabled={mutationsDisabled || busyAction !== null}
        onClick={() => void runAction(action, modelId)}
      >
        {busyAction === `${action}:${modelId}` ? "…" : label}
      </Button>
    </span>
  );

  return (
    <Card data-testid="admin-models-card">
      <CardHeader>
        <CardTitle>{t("modelsTitle")}</CardTitle>
        <CardDescription>{t("modelsIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            data-testid="models-search"
            value={query}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="w-full sm:max-w-xs"
            onChange={(e) => setQuery(e.target.value)}
          />
          <span data-testid="models-count" className="ml-auto text-xs text-muted-foreground">
            {t("shownCount", { count: visible.length, total: rows?.length ?? 0 })}
          </span>
        </div>
        {feedback && (
          <p
            role="status"
            data-testid="models-feedback"
            className={cn("text-sm", feedback.kind === "ok" ? "text-emerald-600" : "text-destructive")}
          >
            {feedback.text}
          </p>
        )}
        {error && !feedback && <p className="text-sm text-destructive">{t("errorGeneric")}</p>}
        {failed ? (
          <p className="text-sm text-destructive">{t("modelsFailed")}</p>
        ) : rows === null ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noResults")}</p>
        ) : (
          <div data-testid="models-table" className="max-h-[26rem] overflow-y-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr className="border-b">
                  {header("id", t("colId"))}
                  {header("recipe", t("colRecipe"))}
                  {header("size", t("colSize"))}
                  <th className="px-3 py-2 text-right font-medium">{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => (
                  <tr key={m.id ?? "—"} data-testid="model-row" className="border-b last:border-0">
                    <td className="max-w-[16rem] truncate px-3 py-2 font-mono text-xs">{m.id ?? "—"}</td>
                    <td className="max-w-[10rem] truncate px-3 py-2 text-xs text-muted-foreground">{m.recipe ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{formatGb(sizeNumber(m.size))}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap items-center justify-end gap-1.5">
                        {m.downloaded && m.id && (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            data-testid={`model-edit-${m.id}`}
                            onClick={() => setEditing(m)}
                          >
                            {t("edit")}
                          </Button>
                        )}
                        {m.id && actionButton("load", m.id, t("load"))}
                        {m.id && actionButton("unload", m.id, t("unload"))}
                        {m.id && (
                          <span title={mutationsDisabled ? t("mutationsDisabled") : undefined}>
                            <Button
                              type="button"
                              size="xs"
                              variant="destructive"
                              data-testid={`model-action-delete-${m.id}`}
                              disabled={mutationsDisabled || busyAction !== null}
                              onClick={() => clickDelete(m.id as string)}
                            >
                              {busyAction === `delete:${m.id}`
                                ? "…"
                                : pendingDelete === m.id
                                  ? t("deleteConfirm")
                                  : t("del")}
                            </Button>
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {editing?.id && (
        <ModelOptionsDialog
          row={editing}
          onClose={() => setEditing(null)}
          mutationsDisabled={mutationsDisabled}
          onMutationsDisabled={onMutationsDisabled}
          onApplied={(kind) => {
            setFeedback({
              kind: "ok",
              text: kind === "loaded"
                ? t("feedbackLoaded", { name: editing.id ?? "" })
                : t("feedbackSaved", { name: editing.id ?? "" }),
            });
            setEditing(null);
            refreshModels();
          }}
        />
      )}
    </Card>
  );
}

// ── Registry card ─────────────────────────────────────────────────────────────

function RegistryCard({
  providerId,
  mutations,
  onMutationsDisabled,
  refreshModels,
}: {
  providerId: string;
  mutations: MutationState;
  onMutationsDisabled: () => void;
  refreshModels: () => void;
}) {
  const t = useTranslations("admin");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RegistryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [variants, setVariants] = useState<Record<string, RegistryVariantsState>>({});
  const [jobs, setJobs] = useState<Record<string, TrackedJob>>({});
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const mutationsDisabled = mutations !== "enabled";

  async function search() {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(false);
    setResults(null);
    setExpanded(null);
    setVariants({});
    try {
      const res = await fetch(adminUrl(`/api/admin/registry?q=${encodeURIComponent(q)}`, providerId), { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { results?: unknown };
      setResults(Array.isArray(data.results) ? (data.results as RegistryEntry[]) : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function toggleExpand(id: string, isGguf: boolean) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!isGguf) {
      setVariants((m) => ({ ...m, [id]: "non-gguf" }));
      return;
    }
    const existing = variants[id];
    if (existing && existing !== "error") return;
    setVariants((m) => ({ ...m, [id]: "loading" }));
    try {
      const res = await fetch(adminUrl(`/api/admin/variants?name=${encodeURIComponent(id)}`, providerId), { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        variants?: unknown;
        recipe?: unknown;
        suggested_name?: unknown;
        suggested_labels?: unknown;
        mmproj_files?: unknown;
      };
      const rows = Array.isArray(data.variants) ? (data.variants as RegistryVariant[]) : [];
      const labels = Array.isArray(data.suggested_labels)
        ? data.suggested_labels.filter((l): l is string => typeof l === "string")
        : [];
      const mmprojFiles = Array.isArray(data.mmproj_files)
        ? data.mmproj_files.filter((f): f is string => typeof f === "string")
        : [];
      setVariants((m) => ({
        ...m,
        [id]: {
          recipe: typeof data.recipe === "string" ? data.recipe : undefined,
          suggestedName: typeof data.suggested_name === "string" ? data.suggested_name : undefined,
          labels,
          mmprojFile: mmprojFiles[0],
          rows,
        },
      }));
      if (typeof data.suggested_name === "string") {
        const suggested = data.suggested_name;
        setJobs((c) => {
          let changed = false;
          const n = { ...c };
          for (const key of Object.keys(n)) {
            const jb = n[key];
            if (jb.variantKey || !jb.modelName) continue;
            for (const r of rows) {
              const quant = typeof r.name === "string" ? r.name.trim() : "";
              if (!quant) continue;
              const modelName = `user.${`${suggested}-${quant}`.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
              if (jb.modelName === modelName) {
                n[key] = { ...jb, variantKey: `${id}|${quant}`, label: quant, repo: id };
                changed = true;
                break;
              }
            }
          }
          return changed ? n : c;
        });
      }
    } catch {
      setVariants((m) => ({ ...m, [id]: "error" }));
    }
  }

  // Re-adopt server-owned downloads after a reload/navigation.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(adminUrl("/api/admin/downloads", providerId), { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as unknown;
        const list = Array.isArray(data)
          ? (data as DownloadJob[])
          : Array.isArray((data as { downloads?: unknown }).downloads)
            ? ((data as { downloads: DownloadJob[] }).downloads)
            : [];
        if (list.length === 0) return;
        setJobs((c) => {
          const n = { ...c };
          for (const d of list) {
            if (typeof d.id !== "string" || !d.id) continue;
            if (n[d.id]) continue;
            if (d.complete === true || d.status === "completed" || d.status === "cancelled") continue;
            const modelName = typeof d.model_name === "string" ? d.model_name : "";
            n[d.id] = {
              ...(d as DownloadJob),
              id: d.id,
              modelName,
              label: modelName.startsWith("user.") ? modelName.slice(5) : modelName || d.id,
              repo: "",
              variantKey: "",
            };
          }
          return n;
        });
      } catch {
        /* best effort */
      }
    })();
    return () => {
      alive = false;
    };
  }, [providerId]);

  // Poll server-owned download jobs while pulls are tracked; finalize terminal
  // states (completed → refresh models, cancelled → remove from upstream).
  useEffect(() => {
    if (Object.keys(jobs).length === 0) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      let list: DownloadJob[] | null = null;
      try {
        const res = await fetch(adminUrl("/api/admin/downloads", providerId), { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as unknown;
          list = Array.isArray(data)
            ? (data as DownloadJob[])
            : Array.isArray((data as { downloads?: unknown }).downloads)
              ? ((data as { downloads: DownloadJob[] }).downloads)
              : null;
        }
      } catch {
        /* transient; keep previous state */
      }
      if (!alive) return;
      if (list) {
        const removeIds: string[] = [];
        const installedKeys: string[] = [];
        let changed = false;
        const next: Record<string, TrackedJob> = {};
        for (const [id, job] of Object.entries(jobs)) {
          const fresh = list.find((d) => d.id === id);
          if (!fresh) {
            if (job.cancelling) {
              removeIds.push(id);
              changed = true;
              continue;
            }
            next[id] = job;
            continue;
          }
          if (fresh.complete === true || fresh.status === "completed") {
            installedKeys.push(job.variantKey);
            changed = true;
            continue;
          }
          if (fresh.status === "cancelled" && fresh.running !== true) {
            removeIds.push(id);
            changed = true;
            continue;
          }
          const merged: TrackedJob = {
            ...job,
            ...fresh,
            id,
            modelName: job.modelName,
            label: job.label,
            variantKey: job.variantKey,
            cancelling: job.cancelling || fresh.status === "cancelled",
          };
          if (
            merged.status !== job.status ||
            merged.running !== job.running ||
            merged.percent !== job.percent ||
            merged.error !== job.error ||
            merged.bytes_downloaded !== job.bytes_downloaded
          ) {
            changed = true;
          }
          next[id] = merged;
        }
        if (changed) setJobs(next);
        for (const id of removeIds) {
          void fetch(adminUrl("/api/admin/downloads-control", providerId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, action: "remove" }),
          }).catch(() => {});
        }
        if (installedKeys.length > 0) {
          setJustAdded((prev) => new Set([...prev, ...installedKeys]));
          refreshModels();
        }
      }
      timer = window.setTimeout(() => void tick(), DOWNLOAD_POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobs, refreshModels]);

  async function controlJob(id: string, action: "cancel") {
    try {
      const res = await fetch(adminUrl("/api/admin/downloads-control", providerId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (res.status === 503) {
        onMutationsDisabled();
        return;
      }
      if (res.ok) {
        setJobs((c) => (c[id] ? { ...c, [id]: { ...c[id], cancelling: true } } : c));
        return;
      }
      let detail = String(res.status);
      try {
        const payload = (await res.json()) as { detail?: unknown; error?: unknown };
        detail = String(payload?.detail ?? payload?.error ?? detail);
      } catch {
        /* keep status code */
      }
      setJobs((c) => (c[id] ? { ...c, [id]: { ...c[id], error: detail } } : c));
    } catch {
      setJobs((c) => (c[id] ? { ...c, [id]: { ...c[id], error: "network" } } : c));
    }
  }

  function dismissJob(id: string) {
    setJobs((c) => {
      const n = { ...c };
      delete n[id];
      return n;
    });
  }

  function failedJobId(variantKey: string) {
    return `error:${variantKey}`;
  }

  async function startPull(entry: RegistryEntry, info: RegistryVariantsState | null, variantKey: string, quant: string) {
    if (busyKey || mutationsDisabled || !quant || info === null || typeof info !== "object") return;
    setBusyKey(variantKey);
    const entryId = entry.repository_id ?? entry.display_name;
    try {
      const base = info.suggestedName || (entryId?.split("/").pop() ?? "model");
      const modelName = `user.${`${base}-${quant}`.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      const body: Record<string, unknown> = {
        action: "pull",
        model: modelName,
        recipe: info.recipe ?? "llamacpp",
        checkpoint: entryId ? `${entryId}:${quant}` : quant,
      };
      if (entry.source === "modelscope") body.source = "modelscope";
      if (info.labels.includes("vision") && info.mmprojFile) {
        body.vision = true;
        body.mmproj = info.mmprojFile;
      }
      if (info.labels.includes("embeddings")) body.embedding = true;
      if (info.labels.includes("reranking")) body.reranking = true;
      const res = await fetch(adminUrl("/api/admin/actions", providerId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 503) {
        onMutationsDisabled();
        return;
      }
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: Record<string, unknown>;
        error?: unknown;
        detail?: unknown;
      } | null;
      const result = payload?.result;
      if (res.ok && result) {
        const jobId =
          typeof result.id === "string" && result.id ? result.id : `model:${modelName}`;
        setJobs((c) => {
          const n = { ...c };
          delete n[failedJobId(variantKey)];
          n[jobId] = {
            ...(result as DownloadJob),
            id: jobId,
            modelName,
            label: quant,
            repo: entryId ?? "",
            variantKey,
          };
          return n;
        });
        return;
      }
      const detail = String(payload?.detail ?? payload?.error ?? `http_${res.status}`);
      setJobs((c) => ({
        ...c,
        [failedJobId(variantKey)]: {
          id: failedJobId(variantKey),
          status: "error",
          error: detail,
          modelName: "",
          label: quant,
          repo: entryId ?? "",
          variantKey,
        },
      }));
    } catch {
      setJobs((c) => ({
        ...c,
        [failedJobId(variantKey)]: {
          id: failedJobId(variantKey),
          status: "error",
          error: "network",
          modelName: "",
          label: quant,
          repo: entryId ?? "",
          variantKey,
        },
      }));
    } finally {
      setBusyKey(null);
    }
  }

  function chipModelName(job: TrackedJob) {
    return job.repo ?? "";
  }

  const entries = results ?? [];

  return (
    <Card data-testid="admin-registry-card">
      <CardHeader>
        <CardTitle>{t("registryTitle")}</CardTitle>
        <CardDescription>{t("registryIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {Object.keys(jobs).length > 0 && (
          <div data-testid="download-jobs" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
            <p className="text-xs font-medium text-muted-foreground">{t("downloads")}</p>
            {Object.values(jobs).map((job) => {
              const jobFailed = job.status === "error" || Boolean(job.error);
              const jobCancelled = job.status === "cancelled" || job.cancelling;
              const jobPaused = job.status === "paused";
              const { done: jobDone, total: jobTotal } = jobOverall(job);
              const jobPct = jobPercent(job);
              const jobFile =
                num(job.total_files) && (job.total_files as number) > 1 && num(job.file_index)
                  ? ` · ${t("pullFile")} ${job.file_index}/${job.total_files}`
                  : "";
              return (
                <div
                  key={job.id}
                  data-testid={`pull-job-${job.id}`}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden gap-1 rounded-lg border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span
                      className="basis-full min-w-0 truncate font-mono sm:basis-auto"
                      title={job.modelName || job.label}
                    >
                      {job.label}
                      {chipModelName(job) && (
                        <span className="text-muted-foreground"> - {chipModelName(job)}</span>
                      )}
                    </span>
                    {!jobFailed && (
                      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                        {jobPct == null
                          ? t("pullQueued")
                          : jobPaused
                            ? t("pullPaused")
                            : `${t("pullDownloading")} ${Math.round(jobPct)}%`}
                        {jobDone != null && jobTotal ? ` · ${formatBytes(jobDone)} / ${formatBytes(jobTotal)}` : ""}
                        {jobFile}
                      </span>
                    )}
                    {jobFailed ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        className="ml-auto shrink-0"
                        data-testid={`pull-job-dismiss-${job.id}`}
                        onClick={() => dismissJob(job.id)}
                      >
                        {t("pullDismiss")}
                      </Button>
                    ) : jobCancelled ? (
                      <span className="ml-auto shrink-0 text-muted-foreground">…</span>
                    ) : (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        className="ml-auto shrink-0"
                        data-testid={`pull-job-cancel-${job.id}`}
                        onClick={() => void controlJob(job.id, "cancel")}
                      >
                        {t("pullCancel")}
                      </Button>
                    )}
                  </div>
                  {!jobFailed && !jobCancelled && (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        data-testid={`pull-job-progress-${job.id}`}
                        className="h-full rounded-full bg-primary transition-[width] duration-500"
                        style={{ width: `${jobPct ?? 0}%` }}
                      />
                    </div>
                  )}
                  {jobFailed && (
                    <p className="text-xs text-destructive">{t("pullFailed", { detail: job.error ?? "" })}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <Input
            data-testid="registry-search"
            value={query}
            placeholder={t("registryPlaceholder")}
            aria-label={t("registryPlaceholder")}
            maxLength={200}
            className="max-w-sm"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" data-testid="registry-submit" disabled={!query.trim() || loading}>
            <Search data-icon="inline-start" />
            {t("search")}
          </Button>
        </form>
        {error && <p className="text-sm text-destructive">{t("errorGeneric")}</p>}
        {loading && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
        {!loading && !error && results !== null && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("noResults")}</p>
        )}
        {!loading && entries.length > 0 && (
          <div data-testid="registry-results" className="grid gap-1">
            {entries.map((r, i) => {
              const id = r.repository_id ?? r.display_name ?? String(i);
              const open = expanded === id;
              const vs = variants[id];
              const vsData =
                vs && vs !== "loading" && vs !== "error" && vs !== "non-gguf" ? vs : null;
              return (
                <div key={id} className="min-w-0 overflow-hidden rounded-lg border">
                  <button
                    type="button"
                    data-testid={`registry-expand-${id}`}
                    aria-expanded={open}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
                    onClick={() => void toggleExpand(id, r.has_gguf === true)}
                  >
                    <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.display_name ?? id}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">{id}</span>
                    </span>
                    {r.has_gguf && <span className="shrink-0 text-xs text-muted-foreground">GGUF</span>}
                  </button>
                  {open && (
                    <div data-testid={`registry-variants-${id}`} className="grid gap-1 border-t px-3 py-2">
                      {vs === "loading" && <p className="text-xs text-muted-foreground">{t("loading")}</p>}
                      {vs === "error" && <p className="text-xs text-destructive">{t("errorGeneric")}</p>}
                      {vs === "non-gguf" && (
                        <p className="text-xs text-muted-foreground">{t("registryNonGguf")}</p>
                      )}
                      {vsData && vsData.rows.length === 0 && (
                        <p className="text-xs text-muted-foreground">{t("noResults")}</p>
                      )}
                      {vsData &&
                        vsData.rows.map((v, j) => {
                          const quant = typeof v.name === "string" ? v.name.trim() : "";
                          const variantKey = `${id}|${quant || `#${j}`}`;
                          const job = Object.values(jobs).find((jb) => jb.variantKey === variantKey);
                          const jobFailed = Boolean(job) && (job!.status === "error" || Boolean(job!.error));
                          const inflight = Boolean(job) && !jobFailed;
                          const installed = justAdded.has(variantKey);
                          return (
                            <div key={`${id}-${quant || j}`} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                              <span className="min-w-0 basis-full truncate font-mono sm:basis-0 sm:flex-1">
                                {quant || "—"}
                              </span>
                              <span className="flex shrink-0 items-center gap-2 sm:ml-auto">
                                <span className="font-mono text-muted-foreground">
                                  {formatBytes(sizeNumber(typeof v.size_bytes === "number" ? v.size_bytes : null))}
                                </span>
                                {installed && (
                                  <Check data-testid={`registry-installed-${variantKey}`} className="size-3.5 shrink-0 text-emerald-600" />
                                )}
                                <span title={mutationsDisabled ? t("mutationsDisabled") : undefined}>
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="outline"
                                    data-testid={`registry-pull-${id}-${quant || j}`}
                                    disabled={mutationsDisabled || busyKey !== null || !quant || inflight}
                                    onClick={() => void startPull(r, vsData, variantKey, quant)}
                                  >
                                    {inflight ? "…" : busyKey === variantKey ? "…" : t("pull")}
                                  </Button>
                                </span>
                              </span>
                            </div>
                          );
                        })}
                      {vsData &&
                        Array.from(justAdded)
                          .filter((k) => k.startsWith(`${id}|`))
                          .map((k) => (
                            <p key={k} data-testid="registry-installed-line" className="text-xs text-emerald-600">
                              {t("pullInstalled", { name: k.split("|").pop() ?? "" })}
                            </p>
                          ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Chat models card ──────────────────────────────────────────────────────────

function ChatModelsCard() {
  const t = useTranslations("admin");
  const [fast, setFast] = useState("");
  const [smart, setSmart] = useState("");
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ids = await fetchModelOptions();
      if (alive) setOptions(ids);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { models: { id: string; label?: string }[]; default: string };
        if (!alive) return;
        const fastEntry = data.models.find((m) => m.label === "fast");
        const smartEntry = data.models.find((m) => m.label === "smart");
        setFast(fastEntry?.id ?? data.default ?? "");
        setSmart(smartEntry?.id ?? "");
      } catch {
        /* keep empty inputs */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    const fastValue = fast.trim();
    if (!fastValue || status === "saving") return;
    setStatus("saving");
    try {
      const payload: Record<string, string> = {
        fast_model: fastValue,
      };
      const smartValue = smart.trim();
      if (smartValue) payload.smart_model = smartValue;
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

  return (
    <Card data-testid="admin-chatmodels-card">
      <CardHeader>
        <CardTitle>{t("chatModelsTitle")}</CardTitle>
        <CardDescription>{t("modelHint")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2">
          <Label htmlFor="admin-fast-model">{t("fastModel")}</Label>
          <ModelSelect
            ariaLabel={t("fastModel")}
            testId="chat-fast-input"
            value={fast}
            options={options}
            placeholder={t("modelPick")}
            onChange={(id) => {
              setFast(id);
              setStatus("idle");
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="admin-smart-model">{t("smartModel")}</Label>
          <ModelSelect
            ariaLabel={t("smartModel")}
            testId="chat-smart-input"
            value={smart}
            options={options}
            placeholder={t("modelPick")}
            emptyOptionLabel={t("modelNone")}
            onChange={(id) => {
              setSmart(id);
              setStatus("idle");
            }}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            data-testid="chat-save"
            disabled={!fast.trim() || status === "saving"}
            onClick={() => void save()}
          >
            {t("save")}
          </Button>
          {status === "saved" && (
            <span data-testid="chat-save-status" className="flex items-center gap-1 text-sm text-emerald-600">
              <Check className="size-4" />
              {t("saved")}
            </span>
          )}
          {status === "error" && (
            <span data-testid="chat-save-status" className="text-sm text-destructive">
              {t("errorGeneric")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

/** Lemonade control-plane console for the selected provider (M3). */
function LemonadeConsole({ providerId }: { providerId: string }) {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [mutations, setMutations] = useState<MutationState>("unknown");

  const refreshModels = useCallback(async () => {
    try {
      const { rows } = await fetchModelRows(providerId);
      setModels(rows);
    } catch {
      setModelsFailed(true);
    }
  }, []);

  // The model-list response carries the read-only mutations flag, so the UI
  // never needs a (log-noisy) probe against the mutating endpoints.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { rows, mutationsEnabled } = await fetchModelRows(providerId);
        if (!alive) return;
        setModels(rows);
        setMutations(mutationsEnabled ? "enabled" : "disabled");
      } catch {
        if (alive) setModelsFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <ServerCard providerId={providerId} />
      <ModelsCard
        providerId={providerId}
        rows={models}
        failed={modelsFailed}
        mutations={mutations}
        onMutationsDisabled={() => setMutations("disabled")}
        refreshModels={() => void refreshModels()}
      />
      <RegistryCard
        providerId={providerId}
        mutations={mutations}
        onMutationsDisabled={() => setMutations("disabled")}
        refreshModels={() => void refreshModels()}
      />
    </>
  );
}

/**
 * Backend tab (Q21): provider CRUD + catalog capability overrides; the
 * Lemonade console renders only when the selected provider offers one
 * (Q10). Chat model choice, limits and MCP are global and stay below.
 */
export function AdminPanel() {
  const t = useTranslations("admin");
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [providersReload, setProvidersReload] = useState(0);

  useEffect(() => {
    let alive = true;
    apiJson<{ providers: ProviderRow[] }>("/api/backend/providers")
      .then((d) => {
        if (!alive) return;
        setProviders(d.providers);
        setSelectedId((cur) => (cur && d.providers.some((p) => p.id === cur) ? cur : d.providers[0]?.id ?? ""));
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    return () => {
      alive = false;
    };
  }, [providersReload]);

  const selected = providers?.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="admin-panel">
      {providers !== null && (
        <ProvidersCard
          providers={providers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChanged={() => setProvidersReload((n) => n + 1)}
        />
      )}
      {selected && selected.type !== "lemonade" && (
        <p className="text-sm text-muted-foreground" data-testid="backend-no-console">
          {t("noConsole")}
        </p>
      )}
      {selected && <CatalogCard providerId={selected.id} />}
      {selected?.type === "lemonade" && <LemonadeConsole key={selected.id} providerId={selected.id} />}
      <ChatModelsCard />
      <WarmupCard />
      <ChatLimitsCard />
      <McpCard />
    </div>
  );
}
