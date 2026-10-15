export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/** Env-driven fallback locale (never throws; anything unknown → "en"). */
export function defaultLocale(): Locale {
  const env = process.env.DEFAULT_LOCALE;
  return isLocale(env) ? env : "en";
}
