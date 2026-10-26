import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));

// Integration tests only (no browser): real route handlers + real better-auth +
// real drizzle/SQLite (per-file throwaway DB via DATABASE_PATH in setup.ts) +
// global fetch stubbed so any model backend is NEVER reached.
export default defineConfig({
  resolve: {
    alias: [
      // Request-context seam: routes read next/headers; tests drive it via
      // tests/support/request-context.ts (setCurrentHeaders).
      {
        find: /^next\/headers$/,
        replacement: fileURLToPath(new URL("./tests/support/next-headers-shim.ts", import.meta.url)),
      },
      { find: /^@\//, replacement: root },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./tests/support/global-setup.ts"],
    setupFiles: ["./tests/support/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      // Server-side scope (integration-testable surface). Browser-only modules
      // (auth client, DOM image preprocessing, UI components/pages) are out of
      // scope for this no-browser integration suite.
      include: ["app/**/route.ts", "lib/**/*.ts", "instrumentation.ts"],
      exclude: [
        "lib/auth-client.ts",
        "lib/image-attachment.ts",
        "lib/browser/audio-capture.ts",
        "lib/browser/use-audio-input.ts",
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: ["text", "json-summary"],
    },
  },
});
