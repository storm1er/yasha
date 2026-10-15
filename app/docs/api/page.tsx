import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { CodeSample } from "@/components/docs/code-sample";
import { Sparkle } from "@/components/brand/sparkle";
import { getServerSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Origin of the incoming request (proxy-safe: X-Forwarded-* first, then Host),
 *  falling back to BETTER_AUTH_URL. Never a hardcoded host. */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const first = (v: string | null) => v?.split(",")[0]?.trim();
  const host = first(h.get("x-forwarded-host")) || first(h.get("host"));
  if (host) {
    const proto = first(h.get("x-forwarded-proto")) ?? "http";
    return `${proto}://${host}`;
  }
  return (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function curlModels(baseUrl: string) {
  return String.raw`curl -s ${baseUrl}/models \
  -H "Authorization: Bearer $YASHA_API_KEY"`;
}

function curlChat(baseUrl: string) {
  return String.raw`curl -N ${baseUrl}/chat/completions \
  -H "Authorization: Bearer $YASHA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter.free",
    "stream": true,
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`;
}

function pySetup(baseUrl: string) {
  return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="ysk_your_key_here",  # create one in /settings
)

for m in client.models.list():
    print(m.id)`;
}

function curlAudio(origin: string) {
  return String.raw`# Audio input rides on the session-authenticated chat API (browser sign-in),
# sent to the audio-compatible FAST model only — never the smart model.
# Feature flags (mic visibility + size cap):
curl -s ${origin}/api/audio/config -b "$SESSION_COOKIE"
# Send a voice message: one audio data URL alongside optional text/images:
curl -N ${origin}/api/chat \
  -b "$SESSION_COOKIE" -H "Content-Type: application/json" \
  -d '{ "message": "", "attachments": { "audio": "data:audio/wav;base64,..." } }'
# Re-queue the background caption of a stored voice message:
curl -s -X POST ${origin}/api/chat/messages/<messageId>/transcribe -b "$SESSION_COOKIE"`;
}

const PY_STREAM = `stream = client.chat.completions.create(
    model="openrouter.free",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)`;

export default async function ApiDocsPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect("/login");
  const origin = await requestOrigin();
  return <ApiDocsContent origin={origin} />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ApiDocsContent({ origin }: { origin: string }) {
  const t = useTranslations("docs");
  const baseUrl = `${origin}/v1`;
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-2xl flex-col px-4 py-6">
      <div className="flex items-center gap-2 pb-2">
        <Link
          href="/c/new"
          data-testid="back-to-chat"
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("backToChat")}
        </Link>
        <span className="ml-auto flex items-center gap-1.5 text-sm font-medium">
          <Sparkle className="size-4" />
          {t("title")}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <p className="pt-2 text-sm">
        <Link href="/settings" className="text-primary underline-offset-4 hover:underline">
          {t("getApiKey")}
        </Link>
      </p>

      <div className="flex flex-wrap items-center gap-2 pt-4 text-sm">
        <span className="text-muted-foreground">{t("baseUrlLabel")}:</span>
        <code className="rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs">{baseUrl}</code>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <ExternalLink className="size-3" />
          OpenAI-compatible
        </span>
      </div>
      <p className="pt-1 text-xs text-muted-foreground">{t("originNote", { origin })}</p>

      <Section title={t("curlTitle")}>
        <CodeSample lang="bash" code={curlModels(baseUrl)} />
      </Section>
      <Section title={t("curlChatTitle")}>
        <CodeSample lang="bash" code={curlChat(baseUrl)} />
      </Section>
      <Section title={t("pythonTitle")}>
        <p className="text-xs text-muted-foreground">{t("pythonInstall")}</p>
        <CodeSample lang="python" code={pySetup(baseUrl)} />
      </Section>
      <Section title={t("pythonStreamTitle")}>
        <CodeSample lang="python" code={PY_STREAM} />
      </Section>
      <Section title={t("audioTitle")}>
        <p className="text-xs text-muted-foreground">{t("audioIntro")}</p>
        <CodeSample lang="bash" code={curlAudio(origin)} />
      </Section>
    </main>
  );
}
