"use client";

import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { msToSeconds, secondsToMs } from "@/lib/ms-seconds";

export function ChatLimitsCard() {
  const t = useTranslations("settings");
  const ta = useTranslations("admin");
  const [windowMessages, setWindowMessages] = useState("");
  const [toolResultMaxChars, setToolResultMaxChars] = useState("");
  const [firstTokenTimeoutSec, setFirstTokenTimeoutSec] = useState("");
  const [maxImages, setMaxImages] = useState("");
  const [maxWindowImages, setMaxWindowImages] = useState("");
  const [maxUploadMb, setMaxUploadMb] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { values?: Record<string, unknown> };
        const windowValue = data.values?.["chat.windowMessages"];
        const toolMaxValue = data.values?.["mcp.toolResultMaxChars"];
        const timeoutValue = data.values?.["chat.firstTokenTimeoutMs"];
        if (typeof windowValue === "number") setWindowMessages(String(windowValue));
        if (typeof toolMaxValue === "number") setToolResultMaxChars(String(toolMaxValue));
        if (typeof timeoutValue === "number") setFirstTokenTimeoutSec(msToSeconds(timeoutValue));
        const images = data.values?.["chat.maxImagesPerMessage"];
        if (typeof images === "number") setMaxImages(String(images));
        const windowImgs = data.values?.["chat.maxWindowImages"];
        if (typeof windowImgs === "number") setMaxWindowImages(String(windowImgs));
        const uploadBytes = data.values?.["chat.maxUploadBytes"];
        if (typeof uploadBytes === "number") setMaxUploadMb(String(Math.round(uploadBytes / 1048576)));
      } catch {
        /* keep empty inputs */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    if (status === "saving") return;
    const payload: Record<string, number> = {};
    const windowValue = Number.parseInt(windowMessages, 10);
    const toolMaxValue = Number.parseInt(toolResultMaxChars, 10);
    const timeoutValue = secondsToMs(firstTokenTimeoutSec);
    if (Number.isFinite(windowValue) && windowValue > 0) payload["chat.windowMessages"] = windowValue;
    if (Number.isFinite(toolMaxValue) && toolMaxValue >= 500 && toolMaxValue <= 100_000)
      payload["mcp.toolResultMaxChars"] = toolMaxValue;
    if (timeoutValue !== null) {
      payload["chat.firstTokenTimeoutMs"] = timeoutValue;
    }
    const images = Number.parseInt(maxImages, 10);
    if (Number.isFinite(images) && images > 0) payload["chat.maxImagesPerMessage"] = images;
    const windowImgs = Number.parseInt(maxWindowImages, 10);
    if (Number.isFinite(windowImgs) && windowImgs > 0) payload["chat.maxWindowImages"] = windowImgs;
    const uploadMb = Number.parseInt(maxUploadMb, 10);
    if (Number.isFinite(uploadMb) && uploadMb > 0) payload["chat.maxUploadBytes"] = uploadMb * 1048576;
    if (Object.keys(payload).length === 0) return;
    setStatus("saving");
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setStatus(res.ok ? "saved" : "error");
    } catch {
      setStatus("error");
    }
  }

  const anyValid =
    (Number.isFinite(Number.parseInt(windowMessages, 10)) && Number.parseInt(windowMessages, 10) > 0) ||
    (Number.isFinite(Number.parseInt(toolResultMaxChars, 10)) &&
      Number.parseInt(toolResultMaxChars, 10) >= 500 &&
      Number.parseInt(toolResultMaxChars, 10) <= 100_000) ||
    secondsToMs(firstTokenTimeoutSec) !== null ||
    (Number.isFinite(Number.parseInt(maxImages, 10)) && Number.parseInt(maxImages, 10) > 0) ||
    (Number.isFinite(Number.parseInt(maxWindowImages, 10)) && Number.parseInt(maxWindowImages, 10) > 0) ||
    (Number.isFinite(Number.parseInt(maxUploadMb, 10)) && Number.parseInt(maxUploadMb, 10) > 0);

  return (
    <Card data-testid="chat-limits-card">
      <CardHeader>
        <CardTitle>{t("chatLimitsTitle")}</CardTitle>
        <CardDescription>{t("chatLimitsIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="chat-limits-window">{t("chatWindowMessages")}</Label>
            <Input
              id="chat-limits-window"
              type="number"
              min={1}
              placeholder="20"
              data-testid="chat-limits-window"
              value={windowMessages}
              className="max-w-40 font-mono text-xs"
              onChange={(e) => {
                setWindowMessages(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="chat-limits-tool-result">{t("chatToolResultMaxChars")}</Label>
            <Input
              id="chat-limits-tool-result"
              type="number"
              min={500}
              max={100000}
              placeholder="20000"
              data-testid="chat-limits-tool-result"
              value={toolResultMaxChars}
              className="max-w-40 font-mono text-xs"
              onChange={(e) => {
                setToolResultMaxChars(e.target.value);
                setStatus("idle");
              }}
            />
            <p className="text-xs text-muted-foreground">{t("chatToolResultMaxCharsHint")}</p>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="chat-limits-timeout">{t("chatFirstTokenTimeout")}</Label>
          <Input
            id="chat-limits-timeout"
            type="number"
            min={1}
            step={0.1}
            placeholder="600"
            data-testid="chat-limits-timeout"
            value={firstTokenTimeoutSec}
            className="max-w-40 font-mono text-xs"
            onChange={(e) => {
              setFirstTokenTimeoutSec(e.target.value);
              setStatus("idle");
            }}
          />
          <p className="text-xs text-muted-foreground">{t("chatFirstTokenTimeoutHint")}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="chat-limits-images">{t("chatMaxImages")}</Label>
            <Input
              id="chat-limits-images"
              type="number"
              min={1}
              placeholder="4"
              data-testid="chat-limits-images"
              value={maxImages}
              className="max-w-40 font-mono text-xs"
              onChange={(e) => {
                setMaxImages(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="chat-limits-window-images">{t("chatMaxWindowImages")}</Label>
            <Input
              id="chat-limits-window-images"
              type="number"
              min={1}
              placeholder="8"
              data-testid="chat-limits-window-images"
              value={maxWindowImages}
              className="max-w-40 font-mono text-xs"
              onChange={(e) => {
                setMaxWindowImages(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="chat-limits-upload">{t("chatMaxUploadMb")}</Label>
            <Input
              id="chat-limits-upload"
              type="number"
              min={1}
              placeholder="20"
              data-testid="chat-limits-upload"
              value={maxUploadMb}
              className="max-w-40 font-mono text-xs"
              onChange={(e) => {
                setMaxUploadMb(e.target.value);
                setStatus("idle");
              }}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("chatAttachmentsHint")}</p>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            data-testid="chat-limits-save"
            disabled={status === "saving" || !anyValid}
            onClick={() => void save()}
          >
            {ta("save")}
          </Button>
          {status === "saved" && (
            <span
              data-testid="chat-limits-save-status"
              className="flex items-center gap-1 text-sm text-emerald-600"
            >
              <Check className="size-4" />
              {ta("saved")}
            </span>
          )}
          {status === "error" && (
            <span data-testid="chat-limits-save-status" className="text-sm text-destructive">
              {ta("errorGeneric")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
