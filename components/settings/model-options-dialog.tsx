"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ModelRow } from "@/components/settings/admin-panel";

type OptionsResponse = {
  recipe?: string;
  saved?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  effective?: Record<string, unknown>;
  resolved_ctx_size?: number;
  loaded?: boolean;
  pinned?: boolean;
};

type PatchValue = string | number | boolean | null;

const CONTEXT_MIN = 2048;

function ctxValue(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= CONTEXT_MIN ? v : null;
}

function fmtCtxShort(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

function clampCtx(n: number, max: number): number {
  return Math.max(CONTEXT_MIN, Math.min(max, Math.round(n)));
}

/**
 * Lemonade-style "Model Options" popup for a downloaded model. Only the context
 * size and the pin toggle are editable; backend / llama.cpp arguments / merge
 * stay exactly as the Lemonade server has them (its defaults, or values the
 * user edited directly in Lemonade).
 * Save persists via POST /api/admin/models/{id}/options; "Save & load" first
 * persists (always) then runs POST /api/admin/actions {action:"load", model,
 * ctx_size, pinned}.
 */
export function ModelOptionsDialog({
  row,
  onClose,
  mutationsDisabled,
  onMutationsDisabled,
  onApplied,
}: {
  row: ModelRow;
  onClose: () => void;
  mutationsDisabled: boolean;
  onMutationsDisabled: () => void;
  /** Called after a successful save/pin/load so the parent can refresh. */
  onApplied: (kind: "saved" | "loaded") => void;
}) {
  const t = useTranslations("admin");
  const modelId = row.id ?? "";
  const maxCtx = Math.max(CONTEXT_MIN, row.max_context_window ?? 262144);

  const [data, setData] = useState<OptionsResponse | null>(null);
  const [baseCtx, setBaseCtx] = useState(CONTEXT_MIN);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [copyOk, setCopyOk] = useState(false);
  const [ctx, setCtx] = useState(CONTEXT_MIN);
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState<"save" | "load" | null>(null);
  const [error, setError] = useState<"error" | "disabled" | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/models/${encodeURIComponent(modelId)}/options`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as OptionsResponse;
        if (!alive) return;
        const initial = clampCtx(
          ctxValue(json.saved?.ctx_size) ??
            ctxValue(json.effective?.ctx_size) ??
            ctxValue(json.resolved_ctx_size) ??
            4096,
          maxCtx
        );
        setData(json);
        setBaseCtx(initial);
        setCtx(initial);
        setPin(json.pinned === true);
      } catch {
        if (alive) setFailed(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [modelId, maxCtx]);

  if (!modelId) return null;

  function buildPatch(): Record<string, PatchValue> {
    return ctx !== baseCtx ? { ctx_size: ctx } : {};
  }

  type PostResult = "ok" | "disabled" | "error";

  async function postOptions(
    patch: Record<string, PatchValue>,
    pinPatch: boolean | null
  ): Promise<PostResult> {
    const res = await fetch(`/api/admin/models/${encodeURIComponent(modelId)}/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(Object.keys(patch).length > 0 ? { options: patch } : {}),
        ...(pinPatch !== null ? { pin: pinPatch } : {}),
      }),
    });
    if (res.status === 503) {
      onMutationsDisabled();
      return "disabled";
    }
    return res.ok ? "ok" : "error";
  }

  async function persistPatch(): Promise<PostResult> {
    const p = buildPatch();
    const pinChanged = data ? pin !== (data.pinned === true) : false;
    if (Object.keys(p).length === 0 && !pinChanged) return "ok";
    return postOptions(p, pinChanged ? pin : null);
  }

  async function save() {
    if (busy) return;
    setBusy("save");
    setError(null);
    try {
      const r = await persistPatch();
      if (r === "ok") {
        onApplied("saved");
        onClose();
      } else {
        setError(r);
      }
    } catch {
      setError("error");
    } finally {
      setBusy(null);
    }
  }

  async function saveAndLoad() {
    if (busy) return;
    setBusy("load");
    setError(null);
    try {
      const r = await persistPatch();
      if (r !== "ok") {
        setError(r);
        return;
      }
      const body: Record<string, unknown> = { action: "load", model: modelId };
      // Only forward user edits: upstream /v1/load records explicit overrides into
      // saved options, so untouched fields must not be sent (they keep their
      // Lemonade value). `pinned:false` matches the server default.
      if (ctx !== baseCtx) body.ctx_size = ctx;
      if (pin) body.pinned = true;
      const res = await fetch("/api/admin/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 503) {
        onMutationsDisabled();
        setError("disabled");
        return;
      }
      if (res.ok) {
        onApplied("loaded");
        onClose();
      } else {
        setError("error");
      }
    } catch {
      setError("error");
    } finally {
      setBusy(null);
    }
  }

  async function copyName() {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopyOk(true);
      window.setTimeout(() => setCopyOk(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const sectionLabel = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="model-options-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("optsTitle")}</DialogTitle>
        </DialogHeader>

        {failed ? (
          <p className="text-sm text-destructive">{t("errorGeneric")}</p>
        ) : loading || !data ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : (
          <div data-testid="opts-form" className="grid gap-1">
            <div className="grid gap-1 pb-1">
              <button
                type="button"
                data-testid="opts-copy"
                className="flex flex-wrap cursor-pointer items-center gap-1.5 text-left text-sm hover:opacity-80"
                onClick={() => void copyName()}
                title={modelId}
              >
                <span className="break-all font-mono font-semibold">
                  <span className="uppercase">{t("optsNameKey")}: </span>
                  {modelId}
                </span>
                {copyOk ? (
                  <Check data-testid="opts-copied" className="size-3.5 shrink-0 text-emerald-600" />
                ) : (
                  <Copy className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            </div>

            <div className="h-px bg-border" />

            <div className="grid gap-2 pt-1">
              <p className={sectionLabel}>{t("ctxSizeLabel")}</p>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  data-testid="opts-ctx-slider"
                  min={CONTEXT_MIN}
                  max={maxCtx}
                  step={1024}
                  value={Math.min(maxCtx, Math.max(CONTEXT_MIN, ctx))}
                  disabled={busy !== null}
                  className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-default"
                  onChange={(e) => setCtx(clampCtx(Number(e.target.value), maxCtx))}
                />
                <input
                  type="number"
                  data-testid="opts-ctx-input"
                  min={CONTEXT_MIN}
                  max={maxCtx}
                  step={1024}
                  value={ctx}
                  disabled={busy !== null}
                  className="h-8 w-24 rounded-md border bg-transparent px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= CONTEXT_MIN && n <= maxCtx) setCtx(clampCtx(n, maxCtx));
                  }}
                />
              </div>
            </div>

            <div className="grid gap-1.5 pt-3">
              <p className="text-sm font-semibold">{t("pinLabel")}</p>
              <label className="flex cursor-pointer items-start gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  data-testid="opts-pin"
                  checked={pin}
                  disabled={busy !== null}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  onChange={(e) => setPin(e.target.checked)}
                />
                {t("pinHint")}
              </label>
              {data.loaded && <p className="pl-6 text-xs">{t("pinLiveHint")}</p>}
            </div>
          </div>
        )}

        {error && (
          <p data-testid="opts-error" className="text-sm text-destructive">
            {error === "disabled" ? t("mutationsDisabled") : t("errorGeneric")}
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" data-testid="opts-cancel" />}>
            {t("cancel")}
          </DialogClose>
          <Button
            type="button"
            variant="outline"
            data-testid="opts-save"
            disabled={loading || failed || busy !== null || mutationsDisabled}
            title={mutationsDisabled ? t("mutationsDisabled") : undefined}
            onClick={() => void save()}
          >
            {busy === "save" ? "…" : t("save")}
          </Button>
          <Button
            type="button"
            data-testid="opts-save-load"
            disabled={loading || failed || busy !== null || mutationsDisabled}
            title={mutationsDisabled ? t("mutationsDisabled") : undefined}
            onClick={() => void saveAndLoad()}
          >
            {busy === "load" ? "…" : t("saveAndLoad")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
