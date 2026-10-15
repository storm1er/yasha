"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Dropdown model picker (replaces the old free-text + datalist inputs):
 * only chat-capable model ids from the Lemonade catalog are selectable.
 * The current value stays listed even when the catalog dropped it, so a
 * saved setting is never silently lost.
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
  options: string[];
  onChange: (id: string) => void;
  placeholder?: string;
  /** When set, an extra entry clears the value to "" (label = this text). */
  emptyOptionLabel?: string;
  ariaLabel?: string;
  testId: string;
}) {
  const list = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        data-testid={testId}
        className="flex w-full items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-left font-mono text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="truncate">{value || placeholder || ""}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-60 overflow-y-auto">
        {emptyOptionLabel && (
          <DropdownMenuItem data-testid={`${testId}-empty`} onClick={() => onChange("")}>
            <span className="min-w-0 flex-1 truncate italic opacity-80">{emptyOptionLabel}</span>
            {value === "" && <Check className="size-3.5 opacity-70" />}
          </DropdownMenuItem>
        )}
        {list.map((id) => (
          <DropdownMenuItem key={id} data-testid={`${testId}-option-${id}`} onClick={() => onChange(id)}>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{id}</span>
            {id === value && <Check className="size-3.5 opacity-70" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
