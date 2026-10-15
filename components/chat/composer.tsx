"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, Mic, Plus, Square, X } from "lucide-react";
import { ModelPicker, type ModelCapabilities } from "@/components/chat/model-picker";
import { Button } from "@/components/ui/button";
import type { AttachmentError } from "@/lib/chat-attachments";
import { processImageFile } from "@/lib/image-attachment";
import { useAudioInput } from "@/lib/browser/use-audio-input";
import { cn } from "@/lib/utils";

const MAX_HEIGHT = 144; // 6 rows × 24px line-height

const DEFAULT_LIMITS = { maxImagesPerMessage: 4, maxUploadBytes: 20 * 1024 * 1024 };

const ERROR_KEYS = {
  too_many: "attachErrorTooMany",
  too_large: "attachErrorTooLarge",
  unsupported: "attachErrorUnsupported",
} as const;

export type ComposerAttachment = { id: string; dataUrl: string };

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  streaming: boolean;
  onStop: () => void;
  onModelChange?: (id: string) => void;
  onModelCapabilities?: (caps: ModelCapabilities) => void;
  threadModel?: string | null;
  attachments: ComposerAttachment[];
  onAttachmentsChange: Dispatch<SetStateAction<ComposerAttachment[]>>;
  className?: string;
  /** No vision-capable model configured → hide the attach (+) affordance. */
  hideAttach?: boolean;
  /** Fast model is audio-compatible → show the tap-to-record mic (AUDIO-REFACTO-PLAN). */
  audioEnabled?: boolean;
  /** Smart model id → mic hides while the smart model is selected (never gets audio). */
  smartModelId?: string | null;
  /** Audio byte cap for the recorded WAV (client-side pre-check). */
  maxAudioBytes?: number;
  /** Finished recording (data URL) — the parent sends it immediately. */
  onAudioRecorded?: (dataUrl: string) => void;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  streaming,
  onStop,
  onModelChange,
  onModelCapabilities,
  threadModel,
  attachments,
  onAttachmentsChange,
  className,
  hideAttach,
  audioEnabled,
  smartModelId,
  maxAudioBytes,
  onAudioRecorded,
}: Props) {
  const t = useTranslations("chat");
  const placeholder = t("placeholder");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachError, setAttachError] = useState<AttachmentError | null>(null);
  const [dragging, setDragging] = useState(false);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [pickedModel, setPickedModel] = useState<string | null>(threadModel ?? null);

  // Mic: tap → record → VAD auto-stop → onAudioRecorded (parent auto-sends).
  const audio = useAudioInput({
    enabled: Boolean(audioEnabled),
    maxAudioBytes: maxAudioBytes ?? 8388608,
    onAudio: (dataUrl) => onAudioRecorded?.(dataUrl),
  });
  const recording = audio.recording;
  const micVisible = Boolean(audioEnabled) && (smartModelId === null || smartModelId === undefined || pickedModel !== smartModelId);

  function handleModelChange(id: string) {
    setPickedModel(id);
    onModelChange?.(id);
  }

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        audio.cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, audio]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/attachment-limits", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { maxImagesPerMessage?: number; maxUploadBytes?: number };
        setLimits({
          maxImagesPerMessage:
            typeof data.maxImagesPerMessage === "number" ? data.maxImagesPerMessage : DEFAULT_LIMITS.maxImagesPerMessage,
          maxUploadBytes:
            typeof data.maxUploadBytes === "number" ? data.maxUploadBytes : DEFAULT_LIMITS.maxUploadBytes,
        });
      } catch {
        /* keep client defaults */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const errorTimer = useRef<number | null>(null);
  // P7: a localized placeholder longer than the available width used to wrap
  // onto a second line that the 1-row textarea clipped. Reserve up to 2 lines
  // of min-height (imperatively, like the auto-resize below) while empty.
  const placeholderLinesRef = useRef(1);

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const measure = () => {
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx || el.clientWidth === 0) return;
      const style = window.getComputedStyle(el);
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const usable = el.clientWidth - (parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
      placeholderLinesRef.current = Math.min(
        Math.max(Math.ceil(ctx.measureText(placeholder).width / Math.max(usable, 1)), 1),
        2
      );
      if (el.value === "") el.style.minHeight = `${16 + placeholderLinesRef.current * 24}px`;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [placeholder]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.minHeight = value ? "" : `${16 + placeholderLinesRef.current * 24}px`;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(
    () => () => {
      if (errorTimer.current) window.clearTimeout(errorTimer.current);
    },
    []
  );

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !streaming;

  function showError(error: AttachmentError) {
    setAttachError(error);
    if (errorTimer.current) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setAttachError(null), 2600);
  }

  async function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const room = limits.maxImagesPerMessage - attachments.length;
    if (room <= 0) {
      showError("too_many");
      return;
    }
    const accepted: ComposerAttachment[] = [];
    let error: AttachmentError | null = images.length > room ? "too_many" : null;
    for (const file of images.slice(0, room)) {
      const result = await processImageFile(file, limits.maxUploadBytes);
      if (result.ok) accepted.push({ id: crypto.randomUUID(), dataUrl: result.dataUrl });
      else if (!error) error = result.error;
    }
    if (accepted.length > 0) onAttachmentsChange([...attachments, ...accepted]);
    if (error) showError(error);
  }

  return (
    <form
      className={cn(
        "relative flex flex-col rounded-[28px] bg-composer",
        "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_6px_24px_rgba(0,0,0,0.07)]",
        "transition-shadow focus-within:shadow-[0_2px_4px_rgba(0,0,0,0.08),0_10px_32px_rgba(0,0,0,0.1)]",
        "dark:ring-white/10 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_6px_24px_rgba(0,0,0,0.5)]",
        dragging ? "ring-2 ring-primary/60" : "ring-1 ring-black/5",
        className
      )}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      {micVisible && recording && (
        <div
          data-testid="listening-bubble"
          className="absolute bottom-full left-1/2 z-20 mb-2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-3.5 py-1.5 text-xs text-background shadow-lg"
        >
          <span
            aria-hidden
            className="size-2 rounded-full bg-red-500"
            style={{ opacity: 0.4 + Math.min(audio.level * 4, 0.6) }}
          />
          <span data-testid="listening-label">{t("listening")}</span>
          <span className="tabular-nums">{Math.floor(audio.seconds / 60)}:{String(audio.seconds % 60).padStart(2, "0")}</span>
          <span className="text-background/70">· {t("listeningHint")}</span>
        </div>
      )}
      {micVisible && audio.error && (
        <span
          role="alert"
          data-testid="audio-error"
          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-[240px] -translate-x-1/2 rounded-lg bg-destructive px-2.5 py-1 text-center text-xs text-destructive-foreground shadow-lg"
        >
          {audio.error === "mic" ? t("audioErrorMic") : audio.error === "too_large" ? t("audioErrorTooLarge") : t("audioErrorTooShort")}
        </span>
      )}
      {attachments.length > 0 && (
        <div data-testid="composer-attachments" className="flex gap-2 overflow-x-auto px-3.5 pt-3">
          {attachments.map((a) => (
            <div key={a.id} className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- data-URL thumbnails, not optimizable */}
              <img
                src={a.dataUrl}
                alt=""
                className="size-16 rounded-xl object-cover ring-1 ring-black/10 dark:ring-white/15"
              />
              <button
                type="button"
                aria-label={t("removeImage")}
                title={t("removeImage")}
                data-testid="remove-attachment"
                onClick={() => onAttachmentsChange((prev) => prev.filter((x) => x.id !== a.id))}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow-md transition-opacity hover:opacity-80"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1 px-2.5 py-2">
        <div className="relative shrink-0">
          {!hideAttach && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("attach")}
              data-testid="composer-plus"
              className="size-9 rounded-full text-muted-foreground hover:bg-muted"
              onClick={() => fileRef.current?.click()}
            >
              <Plus className="size-5" />
            </Button>
          )}
          {attachError && (
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-[220px] -translate-x-1/2 rounded-lg bg-foreground px-2.5 py-1 text-center text-xs text-background shadow-lg"
            >
              {t(ERROR_KEYS[attachError], { max: limits.maxImagesPerMessage })}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            data-testid="attachment-input"
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
        <textarea
          ref={taRef}
          data-testid="composer"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          className="max-h-36 flex-1 resize-none self-center bg-transparent px-1.5 py-2 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSubmit();
            }
          }}
        />
        <div className="flex shrink-0 items-center gap-1 pb-0.5">
          {micVisible && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              data-testid="composer-mic"
              aria-label={recording ? t("micStop") : t("mic")}
              title={recording ? t("micStop") : t("mic")}
              className={cn(
                "size-9 rounded-full",
                recording ? "bg-red-500 text-white hover:bg-red-600" : "text-muted-foreground hover:bg-muted",
              )}
              disabled={streaming}
              onClick={() => (recording ? audio.stop() : void audio.start())}
            >
              {recording ? <Square className="size-3.5" fill="currentColor" /> : <Mic className="size-5" />}
            </Button>
          )}
          <ModelPicker onChange={handleModelChange} onCapabilities={onModelCapabilities} threadModel={threadModel} />
          {streaming ? (
            <Button
              type="button"
              size="icon"
              data-testid="stop"
              aria-label={t("stop")}
              title={t("stop")}
              className="size-9 rounded-full bg-foreground text-background hover:bg-foreground/80"
              onClick={onStop}
            >
              <Square className="size-3" fill="currentColor" />
            </Button>
          ) : (
            canSend && (
              <Button
                type="submit"
                size="icon"
                data-testid="send"
                aria-label={t("send")}
                title={t("send")}
                className="size-9 rounded-full bg-primary text-primary-foreground hover:bg-primary/85"
              >
                <ArrowUp className="size-5" />
              </Button>
            )
          )}
        </div>
      </div>
    </form>
  );
}
