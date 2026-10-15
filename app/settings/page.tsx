import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Sparkle } from "@/components/brand/sparkle";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { getServerSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect("/login");
  // Role never crosses to the client beyond this boolean; the Admin tab's own
  // API calls are guarded server-side (requireAdmin) regardless.
  const isAdmin = (session.user as unknown as { role?: unknown }).role === "admin";
  return <SettingsContent isAdmin={isAdmin} />;
}

function SettingsContent({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("settings");
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col px-4 py-6">
      <div className="flex items-center gap-2 pb-4">
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
      <SettingsTabs isAdmin={isAdmin} />
      <p className="pt-4 text-sm">
        <Link href="/docs/api" className="text-primary underline-offset-4 hover:underline">
          {t("apiDocs")}
        </Link>
      </p>
    </main>
  );
}
