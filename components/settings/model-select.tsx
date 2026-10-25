"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Option for the admin model selects: `id` is the canonical `provider:remote`
 * id that gets stored (Q6); `label` is the human display name (provider's own
 * model id + provider hint), never persisted.
 */
export type ModelOption = { id: string; label: string };

/**
 * Canonical model ids (Q6 `provider:remote`) + display names from the synced
 * catalog — the option list for every admin model select (fast/smart
 * settings, per-task job models). Already ordered by provider, then model id.
 */
export async function fetchModelOptions(): Promise<ModelOption[]> {
  try {
    const res = await fetch("/api/models/catalog", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { id: string; name?: string; providerId?: string }[] };
    if (!Array.isArray(data.models)) return [];
    return data.models.map((m) => ({
      id: m.id,
      label: m.providerId ? `${m.name ?? m.id} · ${m.providerId}` : (m.name ?? m.id),
    }));
  } catch {
    return [];
  }
}

/**
 * Dropdown model picker (replaces the old free-text + datalist inputs):
 * only chat-capable models from the synced catalog are selectable. The current
 * value stays listed even when the catalog dropped it, so a saved setting is
 * never silently lost.
 */
export function ModelSelect({
  value,
  options,
  onChange,
  placeholder,
  emptyOptionLabel,
  ariaLabel,
  testId,
}: {
  value: string;
  options: ModelOption[];
  onChange: (id: string) => void;
  placeholder?: string;
  /** When set, an extra entry clears the value to "" (label = this text). */
  emptyOptionLabel?: string;
  ariaLabel?: string;
  testId: string;
}) {
  const list: ModelOption[] = options.some((o) => o.id === value) || !value ? options : [{ id: value, label: value }, ...options];
  const current = options.find((o) => o.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        data-testid={testId}
        className="flex w-full items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-left font-mono text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="truncate">{current ? current.label : value || placeholder || ""}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-60 overflow-y-auto">
        {emptyOptionLabel && (
          <DropdownMenuItem data-testid={`${testId}-empty`} onClick={() => onChange("")}>
            <span className="min-w-0 flex-1 truncate italic opacity-80">{emptyOptionLabel}</span>
            {value === "" && <Check className="size-3.5 opacity-70" />}
          </DropdownMenuItem>
        )}
        {list.map((o) => (
          <DropdownMenuItem key={o.id} data-testid={`${testId}-option-${o.id}`} onClick={() => onChange(o.id)}>
            <span className="min-w-0 flex-1 truncate text-xs">{o.label}</span>
            {o.id === value && <Check className="size-3.5 opacity-70" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
