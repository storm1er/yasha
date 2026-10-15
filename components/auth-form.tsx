"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

type Mode = "login" | "register";

const USERNAME_RE = /^[a-zA-Z0-9._-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const noopSubscribe = () => () => {};
const getHydratedSnapshot = () => true;
const getHydratedServerSnapshot = () => false;

function mapErrorCode(code: string | undefined | null): string {
  const c = (code ?? "").toUpperCase();
  if (c.includes("ALREADY")) return c.includes("EMAIL") ? "emailTaken" : "usernameTaken";
  if (
    c.includes("INVALID_EMAIL_OR_PASSWORD") ||
    c.includes("INVALID_USERNAME_OR_PASSWORD") ||
    c.includes("USER_DOES_NOT_EXIST") ||
    c === "UNAUTHORIZED"
  )
    return "invalidCredentials";
  // Must come AFTER the invalid-credentials check above: INVALID_USERNAME_OR_PASSWORD
  // also contains "USERNAME" and would otherwise show a misleading format error.
  if (c.includes("USERNAME")) return "usernameInvalid";
  if (c === "INVALID_EMAIL") return "emailInvalid";
  if (c.includes("PASSWORD_TOO_SHORT")) return "passwordTooShort";
  if (c.includes("TOO_MANY_REQUESTS") || c.includes("RATE_LIMIT")) return "tooManyRequests";
  if (c.includes("REGISTRATION_DISABLED")) return "registrationDisabled";
  return "generic";
}

export function AuthForm({ mode, registrationAllowed = true }: { mode: Mode; registrationAllowed?: boolean }) {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // P7: before hydration the form has no JS onSubmit handler, so an IME
  // Enter would native-GET-submit and leak the password into the URL/logs.
  // Keep the submit button inert until the client component is hydrated.
  const hydrated = useSyncExternalStore(noopSubscribe, getHydratedSnapshot, getHydratedServerSnapshot);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorKey(null);

    if (mode === "register") {
      if (!USERNAME_RE.test(username) || username.length < 3 || username.length > 30) {
        setErrorKey("usernameInvalid");
        return;
      }
      if (!EMAIL_RE.test(email)) {
        setErrorKey("emailInvalid");
        return;
      }
      if (password.length < 8) {
        setErrorKey("passwordTooShort");
        return;
      }
    }

    setPending(true);
    try {
      let error: { code?: string } | null | undefined;
      if (mode === "register") {
        // better-auth's client types only know server fields from plugins, not
        // additionalFields; `locale` is seeded server-side via the auth schema.
        const signUpData = {
          name: username,
          username,
          email,
          password,
          locale,
        } as unknown as Parameters<typeof authClient.signUp.email>[0];
        ({ error } = await authClient.signUp.email(signUpData));
      } else if (EMAIL_RE.test(identifier)) {
        ({ error } = await authClient.signIn.email({ email: identifier, password }));
      } else {
        ({ error } = await authClient.signIn.username({ username: identifier, password }));
      }
      if (error) {
        setErrorKey(mapErrorCode(error.code));
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setErrorKey("generic");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {mode === "login" ? t("loginTitle") : t("registerTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {mode === "login" ? t("loginSubtitle") : t("registerSubtitle")}
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          {mode === "login" ? (
            <div className="grid gap-2">
              <Label htmlFor="identifier">{t("username")}</Label>
              <Input
                id="identifier"
                name="identifier"
                autoComplete="username"
                required
                minLength={3}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={t("usernamePlaceholder")}
              />
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="username">{t("username")}</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={30}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t("usernamePlaceholder")}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">{t("email")}</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("emailPlaceholder")}
                />
              </div>
            </>
          )}
          <div className="grid gap-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "register" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {errorKey && (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${errorKey}`)}
            </p>
          )}
          <Button
            type="submit"
            disabled={pending || !hydrated}
            aria-disabled={pending || !hydrated}
            className="w-full"
          >
            {mode === "login" ? t("signIn") : t("signUp")}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-center text-sm text-muted-foreground">
        {mode === "login" ? (
          registrationAllowed && (
            <span>
              {t("noAccount")}{" "}
              <Link href="/register" className="font-medium text-primary underline-offset-4 hover:underline">
                {t("registerCta")}
              </Link>
            </span>
          )
        ) : (
          <span>
            {t("haveAccount")}{" "}
            <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
              {t("loginCta")}
            </Link>
          </span>
        )}
      </CardFooter>
      <span className="sr-only">{tc("appName")}</span>
    </Card>
  );
}
