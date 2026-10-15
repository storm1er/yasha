"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, Copy, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ApiKeyRow = {
  id: string;
  name: string;
  masked: string;
  createdAt: string;
  revokedAt: string | null;
};

export function ApiKeysPanel({ embedded = false }: { embedded?: boolean }) {
  const t = useTranslations("settings");
  const tc = useTranslations("chat");
  const locale = useLocale();

  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [maxActive, setMaxActive] = useState(20);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/api-keys");
    if (res.ok) {
      const data = (await res.json()) as {
        keys: ApiKeyRow[];
        activeCount: number;
        maxActive: number;
      };
      setKeys(data.keys);
      setActiveCount(data.activeCount);
      setMaxActive(data.maxActive);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(id);
  }, [refresh]);

  function openCreate() {
    setName("");
    setError(null);
    setRevealed(null);
    setCopied(false);
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
    setRevealed(null);
  }

  async function submitCreate() {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        setError(res.status === 409 ? t("errorLimit") : t("errorGeneric"));
        return;
      }
      const data = (await res.json()) as { key: string };
      setRevealed(data.key);
      void refresh();
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget || revoking) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/api-keys/${revokeTarget.id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        setRevokeTarget(null);
        void refresh();
      } else {
        setError(t("errorGeneric"));
      }
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setRevoking(false);
    }
  }

  const atLimit = activeCount >= maxActive;

  const createButton = (
    <Button
      type="button"
      size="sm"
      data-testid="create-key"
      disabled={atLimit}
      onClick={openCreate}
    >
      <Plus data-icon="inline-start" />
      {t("create")}
    </Button>
  );

  const dialogs = (
    <>
            <Dialog open={createOpen} onOpenChange={(open) => (open ? setCreateOpen(true) : closeCreate())}>
        <DialogContent data-testid="create-key-dialog">
          {revealed ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("newKeyTitle")}</DialogTitle>
                <DialogDescription>{t("newKeyWarning")}</DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <code
                  data-testid="revealed-key"
                  className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs"
                >
                  {revealed}
                </code>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  data-testid="copy-key"
                  aria-label={tc("copy")}
                  onClick={() => void copyKey()}
                >
                  {copied ? <Check className="text-primary" /> : <Copy />}
                </Button>
              </div>
              <DialogFooter>
                <Button type="button" data-testid="done-key" onClick={closeCreate}>
                  {t("done")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("dialogTitle")}</DialogTitle>
                <DialogDescription>{t("apiKeysIntro")}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="api-key-name">{t("nameLabel")}</Label>
                <Input
                  id="api-key-name"
                  data-testid="key-name-input"
                  value={name}
                  placeholder={t("namePlaceholder")}
                  maxLength={50}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitCreate();
                  }}
                />
                {error && (
                  <p className="text-sm text-destructive" data-testid="create-error">
                    {error}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={closeCreate}>
                  {t("cancel")}
                </Button>
                <Button
                  type="button"
                  data-testid="submit-key"
                  disabled={!name.trim() || submitting}
                  onClick={() => void submitCreate()}
                >
                  {t("createConfirm")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent data-testid="revoke-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{t("revokeConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {revokeTarget?.name} — {t("revokeConfirmBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRevokeTarget(null)}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="confirm-revoke"
              disabled={revoking}
              onClick={() => void confirmRevoke()}
            >
              {t("revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) {
    return (
      <section data-testid="api-keys-card" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
          <div className="grid gap-1.5">
            <h3 className="text-sm font-semibold">{t("apiKeysTitle")}</h3>
            <p className="text-sm text-muted-foreground">{t("apiKeysIntro")}</p>
          </div>
          {createButton}
        </div>
        <div className="grid gap-4">
        {error && !createOpen && (
          <p className="pb-2 text-sm text-destructive" data-testid="settings-error">
            {error}
          </p>
        )}
        {loading ? null : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t("colName")}</th>
                  <th className="py-2 pr-4 font-medium">{t("colKey")}</th>
                  <th className="py-2 pr-4 font-medium">{t("colCreated")}</th>
                  <th className="py-2 pr-4 font-medium">{t("colStatus")}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr
                    key={k.id}
                    data-testid={`key-row-${k.id}`}
                    className="border-b last:border-0"
                  >
                    <td className="max-w-[10rem] truncate py-2.5 pr-4 font-medium">{k.name}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">{k.masked}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {new Date(k.createdAt).toLocaleDateString(locale, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="py-2.5 pr-4">
                      {k.revokedAt ? (
                        <Badge variant="secondary">{t("revoked")}</Badge>
                      ) : (
                        <Badge variant="outline" className="border-primary/40 text-primary">
                          {t("active")}
                        </Badge>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      {!k.revokedAt && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          data-testid={`revoke-${k.id}`}
                          onClick={() => setRevokeTarget(k)}
                        >
                          {t("revoke")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
        {dialogs}
      </section>
    );
  }

  return (
    <Card data-testid="api-keys-card">
      <CardHeader>
        <CardTitle>{t("apiKeysTitle")}</CardTitle>
        <CardDescription>{t("apiKeysIntro")}</CardDescription>
        <CardAction>{createButton}</CardAction>
      </CardHeader>
      <CardContent>
        {error && !createOpen && (
          <p className="pb-2 text-sm text-destructive" data-testid="settings-error">
            {error}
          </p>
        )}
        {loading ? null : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t("colName")}</th>
                  <th className="py-2 pr-4 font-medium">{t("colKey")}</th>
                  <th className="py-2 pr-4 font-medium">{t("colCreated")}</th>
                  <th className="py-2 pr-4 font-medium">{t("colStatus")}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr
                    key={k.id}
                    data-testid={`key-row-${k.id}`}
                    className="border-b last:border-0"
                  >
                    <td className="max-w-[10rem] truncate py-2.5 pr-4 font-medium">{k.name}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">{k.masked}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {new Date(k.createdAt).toLocaleDateString(locale, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="py-2.5 pr-4">
                      {k.revokedAt ? (
                        <Badge variant="secondary">{t("revoked")}</Badge>
                      ) : (
                        <Badge variant="outline" className="border-primary/40 text-primary">
                          {t("active")}
                        </Badge>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      {!k.revokedAt && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          data-testid={`revoke-${k.id}`}
                          onClick={() => setRevokeTarget(k)}
                        >
                          {t("revoke")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {dialogs}
    </Card>
  );
}
