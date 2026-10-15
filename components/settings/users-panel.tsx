"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
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

type UserRow = {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: string;
  createdAt: number | string;
};

export function UsersPanel({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [suggestRevokeOthers, setSuggestRevokeOthers] = useState(false);

  const load = useCallback(async () => {
    try {
      if (isAdmin) {
        const res = await fetch("/api/admin/users", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { users: UserRow[] };
        setUsers(data.users);
      } else {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { user: UserRow };
        setUsers([data.user]);
      }
    } catch {
      /* keep last list */
    }
  }, [isAdmin]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  function openEdit(u: UserRow) {
    setEditing(u);
    setUsername(u.username ?? u.name);
    setEmail(u.email);
    setPassword("");
    setStatus("idle");
    setErrorKey(null);
  }

  async function save() {
    if (!editing || status === "saving") return;
    setStatus("saving");
    setErrorKey(null);
    try {
      const payload: Record<string, string> = { userId: editing.id };
      if (username.trim() && username.trim() !== (editing.username ?? "")) payload.username = username.trim();
      if (email.trim() && email.trim().toLowerCase() !== editing.email) payload.email = email.trim();
      if (password) payload.password = password;
      if (Object.keys(payload).length === 1) {
        setEditing(null);
        return;
      }
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { passwordChanged?: boolean } | null;
        // Password renewal does not revoke other sessions → invite the user
        // to disconnect them (Sessions card, same page).
        if (data?.passwordChanged) setSuggestRevokeOthers(true);
        setStatus("saved");
        setPassword("");
        void load();
        setTimeout(() => setEditing(null), 600);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setErrorKey(body?.error ?? "invalid_payload");
      setStatus("error");
    } catch {
      setStatus("error");
      setErrorKey("invalid_payload");
    }
  }

  return (
    <Card data-testid="users-card">
      <CardHeader>
        <CardTitle>{isAdmin ? t("usersTitle") : t("accountTitle")}</CardTitle>
        <CardDescription>{isAdmin ? t("usersIntro") : t("accountIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {users.map((u) => (
          <div
            key={u.id}
            data-testid={`user-row-${u.username ?? u.email}`}
            className="flex items-center gap-3 rounded-lg border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {u.username ?? u.name}
                {u.role === "admin" && (
                  <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">admin</span>
                )}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">{u.email}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => openEdit(u)}>
              {t("usersEdit")}
            </Button>
          </div>
        ))}

        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("usersEdit")}</DialogTitle>
              <DialogDescription>{editing?.email}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="users-edit-username">{t("usersUsername")}</Label>
              <Input
                id="users-edit-username"
                data-testid="users-edit-username"
                value={username}
                maxLength={30}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setStatus("idle");
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="users-edit-email">{t("usersEmail")}</Label>
              <Input
                id="users-edit-email"
                data-testid="users-edit-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setStatus("idle");
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="users-edit-password">{t("usersPassword")}</Label>
              <Input
                id="users-edit-password"
                data-testid="users-edit-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setStatus("idle");
                }}
              />
              <p className="text-xs text-muted-foreground">{t("usersPasswordHint")}</p>
            </div>
            {status === "error" && (
              <p data-testid="users-edit-error" role="alert" className="text-sm text-destructive">
                {t(`usersErrors.${errorKey ?? "invalid_payload"}`)}
              </p>
            )}
            <DialogFooter>
              {status === "saved" && (
                <span className="mr-auto flex items-center gap-1 text-sm text-emerald-600">
                  <Check className="size-4" />
                  {ta("saved")}
                </span>
              )}
              <Button type="button" data-testid="users-edit-save" disabled={status === "saving"} onClick={() => void save()}>
                {ta("save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {suggestRevokeOthers && (
          <div
            data-testid="users-revoke-others-hint"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
          >
            <p className="min-w-0 flex-1 text-sm">{t("passwordChangedRevokeHint")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await fetch("/api/me/sessions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "revokeOthers" }),
                  });
                } finally {
                  setSuggestRevokeOthers(false);
                }
              }}
            >
              {t("sessionsRevokeOthers")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
