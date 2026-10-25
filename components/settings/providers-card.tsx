"use client";

// Backend tab — provider CRUD + synced-catalog capability overrides
// (docs/provider-plan.md M3, Q19/Q28). The Lemonade console cards live in
// admin-panel.tsx and render for the selected provider when it has one.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type ProviderRow = {
  id: string;
  type: "lemonade" | "openai_compatible";
  label: string;
  baseUrl: string;
  hasKey: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type CatalogRow = {
  id: string;
  providerId: string;
  remoteId: string;
  vision: boolean | null;
  audioInput: boolean | null;
  hidden: boolean;
  lastSyncedAt: number | null;
};

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

// Q28 presets: pure form sugar — they only prefill the generic add form.
const PRESETS = [
  { key: "presetOpenrouter", type: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1" },
  { key: "presetOllama", type: "openai_compatible", baseUrl: "http://127.0.0.1:11434/v1" },
  { key: "presetLlamacpp", type: "openai_compatible", baseUrl: "http://127.0.0.1:8080/v1" },
  { key: "presetLmstudio", type: "openai_compatible", baseUrl: "http://127.0.0.1:1234/v1" },
] as const;

export function ProvidersCard({
  providers,
  selectedId,
  onSelect,
  onChanged,
}: {
  providers: ProviderRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("admin");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(false);

  async function toggle(row: ProviderRow) {
    setError(false);
    try {
      await apiJson(`/api/backend/providers/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      onChanged();
    } catch {
      setError(true);
    }
  }

  async function remove(row: ProviderRow) {
    if (!window.confirm(t("confirmDeleteProvider", { label: row.label }))) return;
    setError(false);
    try {
      await apiJson(`/api/backend/providers/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      if (selectedId === row.id) onSelect("");
      onChanged();
    } catch {
      setError(true);
    }
  }

  return (
    <Card data-testid="backend-providers-card">
      <CardHeader>
        <CardTitle>{t("providersTitle")}</CardTitle>
        <CardDescription>{t("providersDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          {providers.map((p) => (
            <div
              key={p.id}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm",
                selectedId === p.id && "border-primary"
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col items-start text-left"
                onClick={() => onSelect(p.id)}
                data-testid={`provider-select-${p.id}`}
              >
                <span className="font-medium">
                  {p.label}
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{p.type}</span>
                </span>
                <span className="truncate text-xs text-muted-foreground">{p.baseUrl}</span>
              </button>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input type="checkbox" checked={p.enabled} onChange={() => void toggle(p)} data-testid={`provider-enabled-${p.id}`} />
                {t("enabled")}
              </label>
              <Button type="button" size="sm" variant="ghost" onClick={() => void remove(p)} data-testid={`provider-delete-${p.id}`}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          {providers.length === 0 && <p className="text-sm text-muted-foreground">{t("providersEmpty")}</p>}
        </div>
        {error && <p className="text-sm text-destructive">{t("errorGeneric")}</p>}
        {adding ? (
          <AddProviderForm
            onDone={() => {
              setAdding(false);
              onChanged();
            }}
          />
        ) : (
          <Button type="button" variant="outline" className="w-fit" onClick={() => setAdding(true)} data-testid="provider-add-toggle">
            <Plus className="mr-1 size-4" />
            {t("addProvider")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations("admin");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<"lemonade" | "openai_compatible">("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  async function submit() {
    if (!id.trim() || !label.trim() || !baseUrl.trim() || status === "saving") return;
    setStatus("saving");
    try {
      await apiJson("/api/backend/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: id.trim(),
          type,
          label: label.trim(),
          baseUrl: baseUrl.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      onDone();
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="provider-add-form">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            size="sm"
            variant="outline"
            data-testid={`preset-${preset.key}`}
            onClick={() => {
              setType(preset.type);
              setBaseUrl(preset.baseUrl);
              if (!label.trim()) setLabel(t(preset.key));
            }}
          >
            {t(preset.key)}
          </Button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label={t("fieldId")} data-testid="provider-field-id" value={id} onChange={(e) => setId(e.target.value)} placeholder={t("fieldIdHint")} />
        <Input aria-label={t("fieldLabel")} data-testid="provider-field-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("fieldLabel")} />
        <select
          aria-label={t("fieldType")}
          data-testid="provider-field-type"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={type}
          onChange={(e) => setType(e.target.value as "lemonade" | "openai_compatible")}
        >
          <option value="openai_compatible">OpenAI-compatible</option>
          <option value="lemonade">Lemonade</option>
        </select>
        <Input aria-label={t("fieldBaseUrl")} data-testid="provider-field-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("fieldBaseUrl")} />
        <Input
          aria-label={t("fieldApiKey")}
          data-testid="provider-field-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("fieldApiKey")}
          type="password"
          autoComplete="off"
          className="sm:col-span-2"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" onClick={() => void submit()} disabled={!id.trim() || !label.trim() || !baseUrl.trim() || status === "saving"} data-testid="provider-add-save">
          {t("addProvider")}
        </Button>
        {status === "error" && <span className="text-sm text-destructive">{t("errorGeneric")}</span>}
      </div>
    </div>
  );
}

export function CatalogCard({ providerId }: { providerId: string | null }) {
  const t = useTranslations("admin");
  const [rows, setRows] = useState<CatalogRow[] | null>(null);

  const reload = useCallback(() => {
    apiJson<{ models: CatalogRow[] }>("/api/backend/models")
      .then((d) => setRows(d.models))
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload, providerId]);

  async function patch(row: CatalogRow, body: Record<string, boolean>) {
    // optimistic; reverted on failure
    setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, ...body } : r)) ?? null);
    try {
      await apiJson(`/api/backend/models/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      reload();
    }
  }

  if (!providerId) return null;
  const visible = (rows ?? []).filter((r) => r.providerId === providerId);

  return (
    <Card data-testid="backend-catalog-card">
      <CardHeader>
        <CardTitle>{t("catalogTitle")}</CardTitle>
        <CardDescription>{t("catalogDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th>{t("colModel")}</th>
                <th>{t("colVision")}</th>
                <th>{t("colAudio")}</th>
                <th>{t("colHidden")}</th>
                <th>{t("colSynced")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1.5 font-mono text-xs">{r.remoteId}</td>
                  <td>
                    <input type="checkbox" checked={r.vision === true} data-testid={`catalog-vision-${r.id}`} onChange={(e) => void patch(r, { vision: e.target.checked })} />
                  </td>
                  <td>
                    <input type="checkbox" checked={r.audioInput === true} data-testid={`catalog-audio-${r.id}`} onChange={(e) => void patch(r, { audioInput: e.target.checked })} />
                  </td>
                  <td>
                    <input type="checkbox" checked={r.hidden} data-testid={`catalog-hidden-${r.id}`} onChange={(e) => void patch(r, { hidden: e.target.checked })} />
                  </td>
                  <td className="text-xs text-muted-foreground">
                    {r.lastSyncedAt ? new Date(r.lastSyncedAt).toLocaleString() : t("never")}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr className="border-t">
                  <td colSpan={5} className="py-2 text-muted-foreground">
                    {t("catalogEmpty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
