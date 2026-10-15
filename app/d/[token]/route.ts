import { after } from "next/server";
import { claimForDownload, deleteDownloadedApk } from "@/lib/apk-builder";
import { ensureReady } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-time APK download. The claim is atomic: a second visit to the same URL
// (or anyone who copied the link) gets a 410. The APK file is deleted once the
// response has been fully sent.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  await ensureReady();
  const { token } = await params;
  const claimed = claimForDownload(token);
  if (!claimed) {
    return new Response(
      "<!doctype html><title>Yasha</title><p style=\"font-family:sans-serif\">This download link is no longer valid (already used or expired). Open Yasha and request the app again.</p>" +
        `<p style="font-family:sans-serif">Ce lien de téléchargement n'est plus valide (déjà utilisé ou expiré). Rouvrez Yasha et demandez l'application à nouveau.</p>`,
      {
        status: 410,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      }
    );
  }
  // APKs are a handful of MB — a single buffer keeps the handler trivial.
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(claimed.path);
  after(() => deleteDownloadedApk(claimed));
  return new Response(body, {
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": `attachment; filename="${claimed.fileName}"`,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
