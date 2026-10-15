"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type ModelOption = { id: string; label?: string; vision?: boolean };
export type ModelCapabilities = { defaultId: string; models: ModelOption[]; noVision: boolean };

const STORAGE_KEY = "yasha.model";

export function ModelPicker({
  onChange,
  onCapabilities,
  threadModel = null,
}: {
  onChange?: (id: string) => void;
  onCapabilities?: (caps: ModelCapabilities) => void;
  /** Model persisted on the opened thread; overrides the stored global pick. */
  threadModel?: string | null;
}) {
  const t = useTranslations("chat");
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [value, setValue] = useState<string | null>(null);

  const capsRef = useRef(onCapabilities);
  const changeRef = useRef(onChange);
  useEffect(() => {
    capsRef.current = onCapabilities;
  }, [onCapabilities]);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          models: ModelOption[];
          default: string | null;
          noVision?: boolean;
        };
        if (!alive) return;
        setModels(data.models);
        setDefaultId(data.default);
        // Empty list (no admin model configured, or none vision-capable) still
        // reports capabilities so the surface can show the right notice.
        capsRef.current?.({ defaultId: data.default ?? "", models: data.models, noVision: data.noVision === true });
      } catch {
        /* picker is best-effort */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Sync the effective pick whenever the thread or model list changes:
  // thread model > stored choice > server default. A manual selection stays
  // until the thread changes again (see lastThreadModelRef).
  const initializedRef = useRef(false);
  const lastThreadModelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!models || !defaultId) return;
    if (initializedRef.current && (threadModel ?? null) === lastThreadModelRef.current) return;
    lastThreadModelRef.current = threadModel ?? null;
    initializedRef.current = true;
    let stored: string | null = null;
    try {
      const s = window.localStorage.getItem(STORAGE_KEY);
      if (s && models.some((m) => m.id === s)) stored = s;
    } catch {
      /* storage unavailable */
    }
    const threadPick = threadModel && models.some((m) => m.id === threadModel) ? threadModel : null;
    const next = threadPick ?? stored ?? defaultId;
    setValue((prev) => (prev === next ? prev : next));
    changeRef.current?.(next);
    capsRef.current?.({ defaultId: next, models, noVision: false });
  }, [models, defaultId, threadModel]);

  if (!models || models.length === 0 || !value) return null;
  const current = models.find((m) => m.id === value) ?? models[0];

  function select(id: string) {
    setValue(id);
    onChange?.(id);
    capsRef.current?.({ defaultId: id, models: models ?? [], noVision: false });
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("model")}
        title={current.id}
        data-testid="model-picker"
        className={cn(
          "flex max-w-[220px] cursor-pointer items-center gap-1 rounded-full px-2.5 py-1.5",
          "text-xs font-medium text-foreground/80 outline-none transition-colors",
          "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        )}
      >
        <span className="hidden truncate md:inline">{current.id}</span>
        {current.label === "fast" && (
          <Badge
            variant="outline"
            data-testid="model-badge"
            className="border-transparent bg-[#e8f0fe] text-[#1967d2] dark:bg-[#26314a] dark:text-[#8ab4f8]"
          >
            {t("modelFast")}
          </Badge>
        )}
        {current.label === "smart" && (
          <Badge
            variant="outline"
            data-testid="model-badge"
            className="border-transparent bg-[#f3e8fd] text-[#8430ce] dark:bg-[#31253f] dark:text-[#c58af9]"
          >
            {t("modelSmart")}
          </Badge>
        )}
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-60">
        {models.map((m) => (
          <DropdownMenuItem key={m.id} onClick={() => select(m.id)}>
            <span className="min-w-0 flex-1 truncate">{m.id}</span>
            {m.label === "fast" && (
              <Badge className="border-transparent bg-[#e8f0fe] text-[#1967d2] dark:bg-[#26314a] dark:text-[#8ab4f8]">
                {t("modelFast")}
              </Badge>
            )}
            {m.label === "smart" && (
              <Badge className="border-transparent bg-[#f3e8fd] text-[#8430ce] dark:bg-[#31253f] dark:text-[#c58af9]">
                {t("modelSmart")}
              </Badge>
            )}
            {m.id === value && <Check className="size-3.5 opacity-70" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
