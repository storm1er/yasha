// Startup configuration guard: fail fast with an actionable message instead of
// a cryptic better-auth error deep inside module init (single-`docker run`
// happy path). Imported from instrumentation.ts before anything else boots.

export function assertConfig(env: Record<string, string | undefined> = process.env): void {
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error(
      "BETTER_AUTH_SECRET is required — generate one with `openssl rand -hex 32` " +
        "and set it in .env (or -e BETTER_AUTH_SECRET=…); see README.",
    );
  }
}
