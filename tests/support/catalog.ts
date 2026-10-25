// Catalog fixtures: seed `models` rows directly (bypassing sync) so tests get
// an exact effective catalog. Rows seeded with a fresh lastSyncedAt survive
// the 60 s ensureCatalog TTL, so no accidental re-sync clobbers them.

import { models } from "@/lib/db/schema";
import { db } from "./db";

export function seedModel(opts: {
  /** Canonical row id (`${providerId}:${remoteId}` — mirrors syncProvider). */
  id: string;
  providerId?: string;
  remoteId?: string;
  vision?: boolean | null;
  audioInput?: boolean | null;
  hidden?: boolean;
  /** Age of lastSyncedAt in ms (0 = just now; > 60_000 = TTL-stale). */
  syncedAgoMs?: number;
}): void {
  const providerId = opts.providerId ?? "default";
  const values = {
    providerId,
    remoteId: opts.remoteId ?? opts.id.replace(`${providerId}:`, ""),
    vision: opts.vision ?? null,
    audioInput: opts.audioInput ?? null,
    hidden: opts.hidden ?? false,
    lastSyncedAt: new Date(Date.now() - (opts.syncedAgoMs ?? 0)),
  };
  db.insert(models)
    .values({ id: opts.id, ...values })
    .onConflictDoUpdate({ target: models.id, set: values })
    .run();
}

/** Remove every catalog row (deterministic sync state). */
export function clearModels(): void {
  db.delete(models).run();
}
