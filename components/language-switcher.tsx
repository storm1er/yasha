"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { LOCALES, LOCALE_COOKIE, type Locale } from "@/i18n/routing";

function writeLocaleCookie(next: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`;
}

// Signed-in users also move the account locale (canonical, drives generated
// content); anonymous requests 401 and the cookie alone remains the source.
async function syncAccountLocale(next: Locale) {
  try {
    await fetch("/api/me/locale", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
  } catch {
    // offline/server down: cookie-only switch, account stays put
  }
}

export function LanguageSwitcher() {
  const t = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();

  async function setLocale(next: Locale) {
    writeLocaleCookie(next);
    await syncAccountLocale(next);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>{t("localeLabel")}:</span>
      {LOCALES.map((code) => (
        <Button
          key={code}
          type="button"
          size="sm"
          variant={code === locale ? "secondary" : "ghost"}
          onClick={() => setLocale(code)}
          aria-pressed={code === locale}
        >
          {t(code)}
        </Button>
      ))}
    </div>
  );
}
