import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { count, inArray } from "drizzle-orm";
import * as schema from "./schema";

const DB_PATH = resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH ?? "/data/yasha.db");
const MIGRATIONS_FOLDER = resolve(/* turbopackIgnore: true */ process.cwd(), "drizzle");

mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

/** Raw better-sqlite3 handle for statements drizzle cannot express (FTS5). */
export const rawSqlite = sqlite;

let ready: Promise<void> | null = null;

/** Runs SQL migrations + first-boot admin seeding exactly once per process. */
export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      // Prune legacy whisper/kokoro settings — the speech feature was replaced
      // by native audio input (AUDIO-REFACTO-PLAN §11). Idempotent.
      db.delete(schema.settings)
        .where(
          inArray(schema.settings.key, [
            "stt_model",
            "tts_model",
            "tts_voice",
            "speech.maxUploadBytes",
            "speech.transcribeTimeoutMs",
            "speech.synthTimeoutMs",
          ]),
        )
        .run();
      const { ensureFts } = await import("@/lib/search/fts");
      ensureFts();
      const { seedBootstrapAdmin } = await import("./bootstrap");
      await seedBootstrapAdmin();
      const { seedMcpBuiltin } = await import("./bootstrap");
      seedMcpBuiltin();
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

export function userCount(): number {
  return db.select({ value: count() }).from(schema.user).get()?.value ?? 0;
}
