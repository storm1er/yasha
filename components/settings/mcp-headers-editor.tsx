"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type McpHeadersEditorStrings = {
  name: string;
  value: string;
  addHeader: string;
  remove: string;
  save: string;
  cancel: string;
  hint: string;
};

type Row = { id: number; key: string; value: string; existing: boolean; removed: boolean };

let nextRowId = 1;

function addModeDict(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key) out[key] = r.value;
  }
  return out;
}

/**
 * Key/value editor for static MCP headers (e.g. `Authorization: Bearer …`).
 *
 * Add mode (no `existing`): free rows; `onChange` reports the full dict.
 * Edit mode (`existing` = the masked dict from the API): one locked row per
 * saved key — empty value keeps the stored secret, typing replaces it,
 * Remove deletes it; `onSubmit` emits a merge-patch (null = delete).
 */
export function McpHeadersEditor({
  existing,
  strings,
  onChange,
  onSubmit,
  onCancel,
}: {
  existing?: Record<string, string> | null;
  strings: McpHeadersEditorStrings;
  onChange?: (headers: Record<string, string>) => void;
  onSubmit?: (patch: Record<string, string | null>) => void;
  onCancel?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    existing
      ? Object.keys(existing).map((key) => ({ id: nextRowId++, key, value: "", existing: true, removed: false }))
      : [],
  );

  function mutate(next: Row[]) {
    setRows(next);
    if (onChange && !existing) onChange(addModeDict(next));
  }

  function update(id: number, patch: Partial<Row>) {
    mutate(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function submit() {
    if (!onSubmit) return;
    if (!existing) {
      onSubmit(addModeDict(rows));
      return;
    }
    const patch: Record<string, string | null> = {};
    for (const r of rows) {
      if (r.removed) patch[r.key] = null;
      else if (r.value) patch[r.key] = r.value;
    }
    onSubmit(patch);
  }

  return (
    <div className="grid gap-2 rounded-lg border p-3" data-testid="mcp-headers-editor">
      <p className="text-xs text-muted-foreground">{strings.hint}</p>
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2">
          {r.existing ? (
            <code className={`min-w-32 break-all text-xs ${r.removed ? "line-through opacity-50" : ""}`}>
              {r.key}
            </code>
          ) : (
            <Input
              className="min-w-0 flex-1"
              value={r.key}
              placeholder={strings.name}
              data-testid="mcp-header-key"
              onChange={(e) => update(r.id, { key: e.target.value })}
            />
          )}
          <Input
            className="min-w-0 flex-1"
            type="password"
            value={r.value}
            placeholder={r.existing ? "••••" : strings.value}
            disabled={r.existing && r.removed}
            data-testid="mcp-header-value"
            onChange={(e) => update(r.id, { value: e.target.value })}
          />
          <Button
            variant="ghost"
            size="sm"
            data-testid="mcp-header-remove"
            onClick={() => (r.existing ? update(r.id, { removed: !r.removed }) : mutate(rows.filter((x) => x.id !== r.id)))}
          >
            {strings.remove}
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {onSubmit && (
          <Button size="sm" data-testid="mcp-headers-save" onClick={submit}>
            {strings.save}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => mutate([...rows, { id: nextRowId++, key: "", value: "", existing: false, removed: false }])}
        >
          {strings.addHeader}
        </Button>
        {onCancel && (
          <Button size="sm" variant="outline" onClick={onCancel}>
            {strings.cancel}
          </Button>
        )}
      </div>
    </div>
  );
}
