// Resolves the output language for server-generated content (memory facts,
// insights, card, summaries, titles): the account locale wins, else
// DEFAULT_LOCALE. Jobs run outside any request, so this reads the user row.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { defaultLocale, isLocale, type Locale } from "@/i18n/routing";

// Full language names for prompt injection ("in French", not "in fr").
// If LOCALES grows beyond this map, switch to
// new Intl.DisplayNames([tag], { type: "language" }).of(tag) with a
// capitalized fallback.
const LANGUAGE_NAMES: Record<Locale, string> = {
  en: "English",
  fr: "French",
};

export function languageNameFor(tag: string | null | undefined): string {
  return isLocale(tag) ? LANGUAGE_NAMES[tag] : LANGUAGE_NAMES[defaultLocale()];
}

/** Language name for a user's generated content (null-safe: unknown user or
 * null locale → default locale's language). */
export function outputLanguageFor(userId: string): string {
  const row = db.select({ locale: user.locale }).from(user).where(eq(user.id, userId)).get();
  return languageNameFor(row?.locale ?? null);
}
