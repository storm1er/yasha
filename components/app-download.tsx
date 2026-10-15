"use client";

import { useCallback, useEffect, useState } from "react";
import { toDataURL } from "qrcode";
import { Download, Loader2, RefreshCw, Smartphone } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
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
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";

type AppDownloadStatus = {
  state: "idle" | "queued" | "building" | "ready" | "failed" | "consumed";
  error?: string;
  downloadUrl?: string;
  expiresAt?: string;
};

const POLL_MS = 4000;

function useAppDownload(open: boolean) {
  const [status, setStatus] = useState<AppDownloadStatus | null>(null);
  const [qr, setQr] = useState<{ url: string; data: string } | null>(null);

  const refresh = useCallback(async (method: "GET" | "POST" = "GET") => {
    try {
      const res = await fetch("/api/app-download", { method, cache: "no-store" });
      const data = (await res.json().catch(() => null)) as AppDownloadStatus | null;
      // Non-OK with a state payload (e.g. 409 misconfiguration) still renders.
      if (!res.ok && (!data || !("state" in data))) return;
      if (data) setStatus(data);
    } catch {
      /* keep last state */
    }
  }, []);

  useEffect(() => {
    if (!open || status !== null) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/app-download", { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as AppDownloadStatus | null;
        if (!alive || !data || !("state" in data)) return;
        setStatus(data);
      } catch {
        /* offline → retry on next open */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !status) return;
    if (status.state !== "queued" && status.state !== "building") return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [open, status, refresh]);

  // QR generation is a side effect of having a ready one-time URL; failures
  // degrade to "no image, link below".
  useEffect(() => {
    const url =
      status?.state === "ready" && status.downloadUrl
        ? `${window.location.origin}${status.downloadUrl}`
        : null;
    if (!url) return;
    let alive = true;
    void toDataURL(url, { width: 240, margin: 1 })
      .then((data) => {
        if (alive) setQr({ url, data });
      })
      .catch(() => {
        if (alive) setQr({ url, data: "" });
      });
    return () => {
      alive = false;
    };
  }, [status]);

  return { status, qr, retry: () => void refresh("POST") };
}

export function AppDownloadBody({ testId }: { testId: string }) {
  const t = useTranslations("appDownload");
  const { status, qr, retry } = useAppDownload(true);

  if (!status) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`${testId}-loading`}>
        <Loader2 className="size-4 animate-spin" /> {t("loading")}
      </p>
    );
  }
  if (status.state === "idle") {
    return (
      <div className="flex flex-col items-start gap-2" data-testid={`${testId}-idle`}>
        <p className="max-w-sm text-sm text-muted-foreground">{t("idleHint")}</p>
        <Button type="button" onClick={retry} data-testid={`${testId}-generate`}>
          <Download className="size-4" /> {t("generate")}
        </Button>
      </div>
    );
  }
  if (status.state === "queued" || status.state === "building") {
    return (
      <div className="flex items-start gap-3" data-testid={`${testId}-building`}>
        <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
        <div>
          <p className="text-sm font-medium">{t("building")}</p>
          <p className="text-sm text-muted-foreground">{t("buildingHint")}</p>
        </div>
      </div>
    );
  }
  if (status.state === "ready" && status.downloadUrl) {
    return (
      <div className="flex flex-col items-start gap-4 sm:flex-row" data-testid={`${testId}-ready`}>
        {qr?.url === `${window.location.origin}${status.downloadUrl}` && qr.data !== "" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr.data} alt={t("qrAlt")} className="size-44 rounded-lg border bg-white p-1.5" />
        )}
        <div className="flex flex-col gap-2">
          <a
            href={status.downloadUrl}
            data-testid={`${testId}-download`}
            className={buttonVariants({ className: "w-fit" })}
          >
            <Download className="size-4" /> {t("download")}
          </a>
          <p className="max-w-sm text-sm text-muted-foreground">{t("oneTimeHint")}</p>
          {status.expiresAt && (
            <p className="text-xs text-muted-foreground">
              {t("expires", { when: new Date(status.expiresAt).toLocaleString() })}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (status.state === "consumed") {
    return (
      <div className="flex flex-col items-start gap-2" data-testid={`${testId}-consumed`}>
        <p className="text-sm text-muted-foreground">{t("consumed")}</p>
        <Button type="button" variant="outline" onClick={retry}>
          <RefreshCw className="size-4" /> {t("newLink")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2" data-testid={`${testId}-failed`}>
      <p className="text-sm text-destructive">
        {status.error === "trusted_origins_unset" ? t("failedTrustedOrigins") : t("failed")}
      </p>
      {status.error && status.error !== "trusted_origins_unset" && (
        <p className="max-w-sm break-all text-xs text-muted-foreground">{status.error}</p>
      )}
      <Button type="button" variant="outline" onClick={retry}>
        <RefreshCw className="size-4" /> {t("retry")}
      </Button>
    </div>
  );
}

export function AppDownloadSidebarEntry() {
  const t = useTranslations("appDownload");
  const [open, setOpen] = useState(false);
  const { status } = useAppDownload(open);
  const readyDot = status?.state === "ready";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        aria-label={t("title")}
        title={t("title")}
        data-testid="app-download-entry"
        className={buttonVariants({ variant: "ghost", size: "icon", className: "relative size-8 shrink-0 text-muted-foreground" })}
      >
        <Smartphone className="size-4" />
        {readyDot && status?.state === "ready" && (
          <span aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-emerald-500" />
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("intro")}</DialogDescription>
        </DialogHeader>
        <AppDownloadBody testId="app-download-dialog" />
      </DialogContent>
    </Dialog>
  );
}

export function AppDownloadSettingsCard() {
  const t = useTranslations("appDownload");
  return (
    <Card data-testid="app-download-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4" /> {t("title")}
        </CardTitle>
        <CardDescription>{t("intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <AppDownloadBody testId="app-download-settings" />
      </CardContent>
    </Card>
  );
}
