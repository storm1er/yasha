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
  builtin: boolean;
  name: string;
  url: string | null;
  enabled: boolean;
  owner: string | null;
  headers: Record<string, string> | null;
  disabledTools: string[];
  oauth: { configured: boolean; authorized: boolean };
  health: { ok: boolean; toolCount: number; error: string | null; code?: string };
  tools: ServerTool[];
};

export function McpCard() {
  const t = useTranslations("admin");
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [userServersEnabled, setUserServersEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [addHeaders, setAddHeaders] = useState<Record<string, string>>({});
  const [editHeadersId, setEditHeadersId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Keyed error with a timestamp: a later successful reload() must not wipe a
  // failure message (that made errors vanish in a flash).
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorAt, setErrorAt] = useState(0);
  const [lastReloadAt, setLastReloadAt] = useState(0);
  const [userPrivateUrls, setUserPrivateUrls] = useState(false);
  // Issue #32: MCP calls pause for an explicit per-call user verdict.
  const [requireApprovals, setRequireApprovals] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  function showError(key: string) {
    setErrorKey(key);
    setErrorAt(Date.now());
  }

  async function reload(): Promise<ServerEntry[] | null> {
    try {
      const res = await fetch("/api/admin/mcp", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        mcpEnabled: boolean;
        userServersEnabled: boolean;
        userPrivateUrls?: boolean;
        requireToolApprovals?: boolean;
        servers: ServerEntry[];
      };
      setServers(data.servers);
      setGlobalEnabled(data.mcpEnabled);
      setUserServersEnabled(data.userServersEnabled === true);
      setUserPrivateUrls(data.userPrivateUrls === true);
      setRequireApprovals(data.requireToolApprovals === true);
      setLastReloadAt(Date.now());
      return data.servers;
    } catch {
      showError("mcpError");
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

  async function connect(s: ServerEntry) {
    setBusy(s.id);
    try {
      const res = await fetch("/api/admin/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", id: s.id }),
      });
      if (!res.ok) {
        showError(`mcp${mcpErrSuffix(await mcpErrCode(res))}`);
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
      showError("mcpError");
    } finally {
      setBusy(null);
    }
  }

  async function call(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(String(payload.id ?? payload.action));
    try {
      const res = await fetch("/api/admin/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        showError(`mcp${mcpErrSuffix(await mcpErrCode(res))}`);
        return false;
      }
      await reload();
      return true;
    } catch {
      showError("mcpError");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function toggleGlobal() {
    setBusy("global");
    try {
      await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "mcp.enabled": !globalEnabled }),
      });
      setGlobalEnabled(!globalEnabled);
    } finally {
      setBusy(null);
    }
  }

  async function toggleUserServers() {
    setBusy("userServers");
    try {
      await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "mcp.userServersEnabled": !userServersEnabled }),
      });
      setUserServersEnabled(!userServersEnabled);
    } finally {
      setBusy(null);
    }
  }

  async function toggleUserPrivateUrls() {
    setBusy("userPrivateUrls");
    try {
      await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "mcp.userPrivateUrls": !userPrivateUrls }),
      });
      setUserPrivateUrls(!userPrivateUrls);
    } finally {
      setBusy(null);
    }
  }

  async function toggleRequireApprovals() {
    setBusy("requireApprovals");
    try {
      await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "mcp.requireToolApprovals": !requireApprovals }),
      });
      setRequireApprovals(!requireApprovals);
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
    if (ok) {
      setName("");
      setUrl("");
      setAddHeaders({});
      setAdding(false);
    }
  }

  const headerStrings = {
    name: t("mcpHeaderName"),
    value: t("mcpHeaderValue"),
    addHeader: t("mcpHeaderAdd"),
    remove: t("mcpHeaderRemove"),
    save: t("mcpHeadersSave"),
    cancel: t("mcpCancel"),
    hint: t("mcpHeadersHint"),
  };

  const visibleError = errorKey && errorAt > lastReloadAt ? errorKey : null;

  return (
    <Card data-testid="admin-mcp-card">
      <CardHeader>
        <CardTitle>{t("mcpTitle")}</CardTitle>
        <CardDescription>{t("mcpDesc")}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span>{t("mcpGlobalToggle")}</span>
          <Button
            variant={globalEnabled ? "default" : "outline"}
            size="sm"
            disabled={busy === "global"}
            onClick={() => void toggleGlobal()}
          >
            {globalEnabled ? t("mcpOn") : t("mcpOff")}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span>{t("mcpUserToggle")}</span>
          <Button
            variant={userServersEnabled ? "default" : "outline"}
            size="sm"
            disabled={busy === "userServers"}
            data-testid="mcp-user-toggle"
            onClick={() => void toggleUserServers()}
          >
            {userServersEnabled ? t("mcpOn") : t("mcpOff")}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span>{t("mcpUserPrivateToggle")}</span>
          <Button
            variant={userPrivateUrls ? "default" : "outline"}
            size="sm"
            disabled={busy === "userPrivateUrls"}
            data-testid="mcp-user-private-toggle"
            onClick={() => void toggleUserPrivateUrls()}
          >
            {userPrivateUrls ? t("mcpOn") : t("mcpOff")}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span className="flex-col">
            <span>{t("mcpApprovalsToggle")}</span>
            <span className="block text-xs text-muted-foreground">{t("mcpApprovalsHint")}</span>
          </span>
          <Button
            variant={requireApprovals ? "default" : "outline"}
            size="sm"
            disabled={busy === "requireApprovals"}
            data-testid="mcp-approvals-toggle"
            onClick={() => void toggleRequireApprovals()}
          >
            {requireApprovals ? t("mcpOn") : t("mcpOff")}
          </Button>
        </div>
        {visibleError && (
          <p className="text-sm text-red-600" data-testid="mcp-error">
            {t(visibleError)}
          </p>
        )}
        {loaded && servers.length === 0 && <p className="text-sm text-muted-foreground">{t("mcpNone")}</p>}
        {servers.map((s) => (
          <div key={s.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border p-3" data-testid={`mcp-server-${s.id}`}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {s.name}
                  {s.builtin && <span className="ml-2 text-xs text-muted-foreground">{t("mcpBuiltin")}</span>}
                  {s.owner && (
                    <span className="ml-2 text-xs text-muted-foreground">{t("mcpOwnedBy", { owner: s.owner })}</span>
                  )}
                </p>
                {s.url && <p className="truncate text-xs text-muted-foreground">{s.url}</p>}
                <p className="text-xs">
                  {s.health.ok
                    ? t("mcpHealthy", { count: s.health.toolCount })
                    : s.health.code === "needs_auth"
                      ? t("mcpNeedsAuth")
                      : t("mcpUnhealthy", { error: s.health.error ?? "error" })}
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                {!s.builtin && !s.owner && s.oauth.authorized && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === s.id}
                    data-testid={`mcp-disconnect-${s.id}`}
                    onClick={() => void call({ action: "disconnect", id: s.id })}
                  >
                    {t("mcpDisconnect")}
                  </Button>
                )}
                {!s.builtin && !s.owner && s.url && !s.oauth.authorized && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === s.id}
                    data-testid={`mcp-connect-${s.id}`}
                    onClick={() => void connect(s)}
                  >
                    {t("mcpConnect")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === s.id}
                  onClick={() => void call({ action: "check", id: s.id })}
                >
                  {t("mcpCheck")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === s.id}
                  onClick={() => void call({ action: "toggle", id: s.id })}
                >
                  {s.enabled ? t("mcpDisable") : t("mcpEnable")}
                </Button>
                {!s.builtin && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === s.id}
                    onClick={() => void call({ action: "delete", id: s.id })}
                  >
                    {t("mcpDelete")}
                  </Button>
                )}
                {!s.builtin && !s.owner && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`mcp-headers-toggle-${s.id}`}
                    onClick={() => setEditHeadersId(editHeadersId === s.id ? null : s.id)}
                  >
                    {t("mcpHeaders")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? t("mcpHideTools") : t("mcpShowTools")}
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
                  <li className="text-muted-foreground">{t("mcpNoTools")}</li>
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
                      data-testid={`mcp-exclude-${s.id}-${tool.name}`}
                      onClick={() => void call({ action: "update", id: s.id, disabledTools: [...s.disabledTools, tool.name] })}
                    >
                      {t("mcpExcludeTool")}
                    </Button>
                  </li>
                ))}
                {s.disabledTools.map((name) => (
                  <li key={name} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-muted-foreground">
                    <span className="min-w-0 flex-1 break-words">
                      <code className="break-all text-xs line-through">{name}</code> — {t("mcpToolExcluded")}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === s.id}
                      data-testid={`mcp-include-${s.id}-${name}`}
                      onClick={() => void call({ action: "update", id: s.id, disabledTools: s.disabledTools.filter((n) => n !== name) })}
                    >
                      {t("mcpIncludeTool")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {adding ? (
          <div className="grid gap-2 rounded-lg border p-3">
            <Label htmlFor="mcp-name">{t("mcpName")}</Label>
            <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} />
            <Label htmlFor="mcp-url">{t("mcpUrl")}</Label>
            <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            <Label>{t("mcpHeaders")}</Label>
            <McpHeadersEditor strings={headerStrings} onChange={setAddHeaders} />
            <div className="flex gap-2">
              <Button size="sm" disabled={!name.trim() || !url.trim() || busy === "add"} onClick={() => void add()}>
                {t("mcpAdd")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setAdding(false); setName(""); setUrl(""); setAddHeaders({}); }}>
                {t("mcpCancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setAdding(true)}>
            {t("mcpAddServer")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
