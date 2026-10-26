// Direct DB fixtures for tests (same module graph as the app: migrations, FTS
// triggers and all apply).

import { db, rawSqlite } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { invalidateSettingsCache } from "@/lib/settings";

export { db, rawSqlite };

export function setSetting(key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
  invalidateSettingsCache();
}

export function setFastModel(id = "default:fast-model.test"): void {
  setSetting("fast_model", id);
}
