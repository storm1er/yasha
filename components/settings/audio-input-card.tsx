"use client";

// Admin "Audio input" card (Background jobs tab, below title generation,
// AUDIO-REFACTO-PLAN §7): feature
// status derived from the FAST model, the hardcoded compatible-model notice
// when off, and the "smart model is never used for audio" note.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { JobTaskCard } from "@/components/settings/job-task-card";
import type { AudioConfig } from "@/lib/browser/use-audio-input";

export function AudioInputCard() {
  const t = useTranslations("settings");
  const [config, setConfig] = useState<AudioConfig | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/audio/config", { cache: "no-store" });
        if (!res.ok || !alive) return;
        setConfig((await res.json()) as AudioConfig);
      } catch {
        /* card shows a load error state below */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <Card data-testid="audio-input-card">
        <CardHeader>
          <CardTitle>{t("audioTitle")}</CardTitle>
          <CardDescription>{t("audioDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {config === null ? (
            <p className="text-xs text-muted-foreground" data-testid="audio-state-loading">
              …
            </p>
          ) : config.enabled ? (
            <p data-testid="audio-state-enabled" className="text-emerald-600 dark:text-emerald-400">
              {t("audioEnabledOn", { model: config.model ?? "" })}
            </p>
          ) : (
            <p data-testid="audio-state-disabled" className="rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
              {config.model
                ? t("audioDisabledWithModel", { model: config.model })
                : t("audioDisabledNoModel")}{" "}
              {t("audioCompatList", { models: config.compatibleModels.join(", ") })}
            </p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="audio-smart-note">
            {t("audioSmartNeverNote")}
            {config?.smartAudioCapable ? ` ${t("audioSmartIgnored")}` : ""}
          </p>
        </CardContent>
      </Card>
      {/* Voice-message caption job (fast model, verbatim transcription). */}
      <JobTaskCard
        titleKey="audioCaptionTaskTitle"
        introKey="audioCaptionTaskIntro"
        impactWarningKey="audioCaptionTaskNeverWarning"
        settingKey="chat.audio_transcription"
        testId="audio-caption-task"
        afterPersistLabelKey="audioCaptionTaskAfterPersist"
      />
    </>
  );
}
