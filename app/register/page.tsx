import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { LanguageSwitcher } from "@/components/language-switcher";
import { getServerSession } from "@/lib/auth";
import { registrationAllowed } from "@/lib/settings";

export const dynamic = "force-dynamic";

// Belt & braces for P6 finding #1: if a pre-hydration native GET submit ever
// reaches the server with credential-ish query params, bounce to the clean URL.
const LEAKY_QUERY_KEYS = ["password", "email", "identifier", "username"];

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  if (LEAKY_QUERY_KEYS.some((k) => k in query)) redirect("/register");
  if (await getServerSession(await headers())) redirect("/c/new");
  if (!registrationAllowed()) redirect("/login");
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <AuthForm mode="register" />
      <LanguageSwitcher />
    </main>
  );
}
