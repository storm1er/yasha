import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";
import { db, ensureReady, userCount } from "./db";
import { registrationAllowed } from "./settings";

function trustedOrigins(): string[] {
  const configured = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base = process.env.BETTER_AUTH_URL;
  return [...new Set(base ? [base, ...configured] : configured)];
}

export const auth = betterAuth({
  appName: process.env.APP_NAME ?? "Yasha",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: trustedOrigins(),
  database: drizzleAdapter(db, { provider: "sqlite", usePlural: false }),
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
        input: false,
      },
      locale: {
        type: "string",
        required: false,
        defaultValue: null,
        input: true,
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },
  // Public sign-up kill-switch (Settings → Security, admin). Fresh instances
  // (no users yet) always pass so the BOOTSTRAP_ADMIN seed can never lock
  // itself out; direct drizzle inserts bypass auth endpoints and are too.
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          if (!registrationAllowed() && userCount() > 0) {
            throw new APIError(403, {
              message: "Account registration is disabled on this instance.",
              code: "REGISTRATION_DISABLED",
            });
          }
        },
      },
    },
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
    }),
  ],
});

/** Server-side session helper (awaits migrations/seed first). Exported for later phases. */
export async function getServerSession(headers: Headers) {
  await ensureReady();
  return auth.api.getSession({ headers });
}

export type Session = typeof auth.$Infer.Session;
