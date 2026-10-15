import { getRequestConfig } from "next-intl/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { isLocale, LOCALE_COOKIE, defaultLocale, type Locale } from "./routing";

export { defaultLocale };

/** Locale from the raw Cookie header (cookie() would need a Next request
 * scope that headers() already proves we're in; also testable via the
 * headers shim). */
function cookieLocale(cookieHeader: string | null): Locale | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return isLocale(value) ? value : null;
  }
  return null;
}

/** Signed-in account locale (from the session user record) wins over the
 * browser cookie; anonymous requests fall through to cookie/default. */
export async function resolveLocale(): Promise<Locale> {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  const accountLocale = isLocale(session?.user.locale) ? session.user.locale : null;
  return accountLocale ?? cookieLocale(h.get("cookie")) ?? defaultLocale();
}

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!isLocale(locale)) {
    locale = await resolveLocale();
  }
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
