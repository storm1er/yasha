// Client-side image preprocessing for composer attachments: downscale to a
// vision-friendly size and re-encode so payloads stay within the server caps.

import { MAX_IMAGE_DATAURL_CHARS, type AttachmentError } from "@/lib/chat-attachments";

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SIDE = 1568;

export type ProcessedImage = { ok: true; dataUrl: string } | { ok: false; error: AttachmentError };

export async function processImageFile(file: File, maxFileBytes = DEFAULT_MAX_FILE_BYTES): Promise<ProcessedImage> {
  if (!file.type.startsWith("image/") || !ACCEPTED_TYPES.has(file.type)) {
    return { ok: false, error: "unsupported" };
  }
  if (file.size > maxFileBytes) return { ok: false, error: "too_large" };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, error: "unsupported" };
    if (file.type !== "image/png") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const dataUrl =
      file.type === "image/png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85);
    if (dataUrl.length > MAX_IMAGE_DATAURL_CHARS) return { ok: false, error: "too_large" };
    return { ok: true, dataUrl };
  } catch {
    return { ok: false, error: "unsupported" };
  }
}
