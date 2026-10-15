"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { mcpErrCode, mcpErrSuffix } from "@/components/settings/mcp-error";
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
import { McpHeadersEditor } from "@/components/settings/mcp-headers-editor";

type ServerTool = { name: string; description: string };
type ServerEntry = {
  id: string;
  name: string;
  url: string | null;
  enabled: boolean;
  headers: Record<string, string> | null;
  disabledTools: string[];
  oauth: { configured: boolean; authorized: boolean };
  health: { ok: boolean; toolCount: number; error: string | null; code?: string };
  tools: ServerTool[];
};

/**
 * Personal MCP servers (user-owned, isolated). Hidden while the instance
 * disables user servers (`mcp.userServersEnabled`). Remote HTTP only; the
 * admin Tools card manages global servers.
 */
export function UserMcpCard() {
  const t = useTranslations("settings");
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [serversEnabled, setServersEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [addHeaders, setAddHeaders] = useState<Record<string, string>>({});
  const [editHeadersId, setEditHeadersId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Error carries its timestamp: a later successful reload() refreshes the
  // list without wiping the message (that made failures vanish in a flash).
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorSeenAt, setErrorSeenAt] = useState(0);
  const [lastReloadAt, setLastReloadAt] = useState(0);
  const [privateUrlsAllowed, setPrivateUrlsAllowed] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  function showError(key: string) {
    setErrorKey(key);
    setErrorSeenAt(Date.now());
  }

  async function reload(): Promise<ServerEntry[] | null> {
    try {
      const res = await fetch("/api/mcp/servers", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        serversEnabled: boolean;
        privateUrlsAllowed?: boolean;
        servers: ServerEntry[];
      };
      setServers(data.servers);
      setServersEnabled(data.serversEnabled);
      setPrivateUrlsAllowed(data.privateUrlsAllowed !== false);
      setLastReloadAt(Date.now());
      return data.servers;
    } catch {
      showError("userMcpError");
      return null;
    }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      await reload();
      if (alive) setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function call(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(String(payload.id ?? payload.action));
    try {
      const res = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        showError(`userMcp${mcpErrSuffix(await mcpErrCode(res))}`);
        return false;
      }
      await reload();
      return true;
    } catch {
      showError("userMcpError");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl) return;
    const headers = Object.fromEntries(Object.entries(addHeaders).filter(([k]) => k));
    const ok = await call({
      action: "add",
      name: trimmedName,
      url: trimmedUrl,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    // Keep the form (values included) when the server rejected the add.
    if (ok) {
      setName("");
      setUrl("");
      setAddHeaders({});
      setAdding(false);
    }
  }

  const headerStrings = {
    name: t("userMcpHeaderName"),
    value: t("userMcpHeaderValue"),
    addHeader: t("userMcpHeaderAdd"),
    remove: t("userMcpHeaderRemove"),
    save: t("userMcpHeadersSave"),
    cancel: t("userMcpCancel"),
    hint: t("userMcpHeadersHint"),
  };

  async function connect(s: ServerEntry) {
    setBusy(s.id);
    try {
      const res = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", id: s.id }),
      });
      if (!res.ok) {
        showError(`userMcp${mcpErrSuffix(await mcpErrCode(res))}`);
        return;
      }
      const data = (await res.json()) as { needsAuth?: boolean; authorizationUrl?: string };
      if (data.needsAuth && data.authorizationUrl) {
        window.open(data.authorizationUrl, "_blank", "noopener,width=560,height=720");
        // Poll while the user completes consent in the popup.
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          const latest = await reload();
          if (latest?.find((x) => x.id === s.id)?.oauth.authorized) break;
        }
      }
    } catch {
      showError("userMcpError");
    } finally {
      setBusy(null);
    }
  }

  if (loaded && !serversEnabled && !errorKey) return null;

  const visibleError = errorKey && errorSeenAt > lastReloadAt ? errorKey : null;

  return (
    <Card data-testid="user-mcp-card">
      <CardHeader>
        <CardTitle>{t("userMcpTitle")}</CardTitle>
        <CardDescription>{t("userMcpDesc")}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {visibleError && (
          <p className="text-sm text-red-600" data-testid="user-mcp-error">
            {t(visibleError)}
          </p>
        )}
        {loaded && servers.length === 0 && !errorKey && (
          <p className="text-sm text-muted-foreground">{t("userMcpNone")}</p>
        )}
        {servers.map((s) => (
          <div key={s.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border p-3" data-testid={`user-mcp-server-${s.id}`}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{s.name}</p>
                {s.url && <p className="truncate text-xs text-muted-foreground">{s.url}</p>}
                {s.headers && Object.keys(s.headers).length > 0 && (
                  <p className="truncate text-xs text-muted-foreground">
                    {Object.keys(s.headers)
                      .sort()
                      .map((k) => `${k}: ••••`)
                      .join(" · ")}
                  </p>
                )}
                <p className="text-xs">
                  {s.health.ok
                    ? t("userMcpHealthy", { count: s.health.toolCount })
                    : s.health.code === "needs_auth"
                      ? t("userMcpNeedsAuth")
                      : t("userMcpUnhealthy", { error: s.health.error ?? "error" })}
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                {s.oauth.authorized && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === s.id}
                    data-testid={`user-mcp-disconnect-${s.id}`}
                    onClick={() => void call({ action: "disconnect", id: s.id })}
                  >
                    {t("userMcpDisconnect")}
                  </Button>
                )}
                {!s.oauth.authorized && s.url && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === s.id}
                    data-testid={`user-mcp-connect-${s.id}`}
                    onClick={() => void connect(s)}
                  >
                    {t("userMcpConnect")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === s.id}
                  onClick={() => void call({ action: "check", id: s.id })}
                >
                  {t("userMcpCheck")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === s.id}
                  onClick={() => void call({ action: "toggle", id: s.id })}
                >
                  {s.enabled ? t("userMcpDisable") : t("userMcpEnable")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === s.id}
                  onClick={() => void call({ action: "delete", id: s.id })}
                >
                  {t("userMcpDelete")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`user-mcp-headers-toggle-${s.id}`}
                  onClick={() => setEditHeadersId(editHeadersId === s.id ? null : s.id)}
                >
                  {t("userMcpHeaders")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? t("userMcpHideTools") : t("userMcpShowTools")}
                </Button>
              </div>
            </div>
            {editHeadersId === s.id && (
              <McpHeadersEditor
                existing={s.headers ?? {}}
                strings={headerStrings}
                onCancel={() => setEditHeadersId(null)}
                onSubmit={async (patch) => {
                  if (!Object.keys(patch).length) {
                    setEditHeadersId(null);
                    return;
                  }
                  if (await call({ action: "update", id: s.id, headers: patch })) setEditHeadersId(null);
                }}
              />
            )}
            {expanded === s.id && (
              <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                {s.tools.length === 0 && s.disabledTools.length === 0 && (
                  <li className="text-muted-foreground">{t("userMcpNoTools")}</li>
                )}
                {s.tools.map((tool) => (
                  <li key={tool.name} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="min-w-0 flex-1 break-words">
                      <code className="break-all text-xs">{tool.name}</code>
                      {tool.description ? ` — ${tool.description}` : ""}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === s.id}
                      data-testid={`user-mcp-exclude-${s.id}-${tool.name}`}
                      onClick={() =>
                        void call({ action: "update", id: s.id, disabledTools: [...s.disabledTools, tool.name] })
                      }
                    >
                      {t("userMcpExcludeTool")}
                    </Button>
                  </li>
                ))}
                {s.disabledTools.map((toolName) => (
                  <li key={toolName} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-muted-foreground">
                    <span className="min-w-0 flex-1 break-words">
                      <code className="break-all text-xs line-through">{toolName}</code> — {t("userMcpToolExcluded")}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === s.id}
                      data-testid={`user-mcp-include-${s.id}-${toolName}`}
                      onClick={() =>
                        void call({ action: "update", id: s.id, disabledTools: s.disabledTools.filter((n) => n !== toolName) })
                      }
                    >
                      {t("userMcpIncludeTool")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {adding ? (
          <div className="grid gap-2 rounded-lg border p-3">
            <Label htmlFor="user-mcp-name">{t("userMcpName")}</Label>
            <Input id="user-mcp-name" value={name} onChange={(e) => setName(e.target.value)} />
            <Label htmlFor="user-mcp-url">{t("userMcpUrl")}</Label>
            <Input id="user-mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            {!privateUrlsAllowed && (
              <p className="text-xs text-muted-foreground" data-testid="user-mcp-lan-hint">
                {t("userMcpLanHint")}
              </p>
            )}
            <Label>{t("userMcpHeaders")}</Label>
            <McpHeadersEditor strings={headerStrings} onChange={setAddHeaders} />
            <div className="flex gap-2">
              <Button size="sm" disabled={!name.trim() || !url.trim() || busy === "add"} onClick={() => void add()}>
                {t("userMcpAdd")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAdding(false);
                  setName("");
                  setUrl("");
                  setAddHeaders({});
                }}
              >
                {t("userMcpCancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setAdding(true)}>
            {t("userMcpAddServer")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
