// Synced model catalog (docs/provider-plan.md Q13/Q14): the `models` table is
// the catalog cache — identity + admin capability overrides — refreshed from
// each provider on a 60 s TTL (the same cadence the pre-catalog live cache
// used). Sync auto-seeds capability flags on first sight of a model and never
// overwrites existing ones, so admin overrides always win. Volatile upstream
// state (loaded/downloaded) is never cached here — the admin console reads it
// live through the control plane.
//
// Public model ids are CANONICAL (Q6): `${providerId}:${remoteId}` — the row
// id, used by the UI, `threads.model`, the fast/smart settings and Yasha's own
// /v1 facade. Only the OUTBOUND upstream call swaps to the provider's remote
// id (routeModel / remoteModelId below).

import { and, asc, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { models, providers } from "@/lib/db/schema";
import { chatProviders } from "./registry";
import type { ChatModel, ChatProvider } from "./types";

const SYNC_TTL_MS = 60_000;

export type CatalogModel = {
  /** Canonical public id `${providerId}:${remoteId}` (Q6). */
  id: string;
  providerId: string;
  /** The provider's own id for this model — what goes upstream. */
  remoteId: string;
  vision: boolean;
  audioInput: boolean;
};

export type CatalogState = {
  models: CatalogModel[];
  /** True when a provider's sync failed this round AND nothing was served. */
  allUnavailable: boolean;
};

type ModelRow = typeof models.$inferSelect;

function toCatalog(row: ModelRow): CatalogModel {
  return {
    id: row.id,
    providerId: row.providerId,
    remoteId: row.remoteId,
    vision: row.vision === true,
    audioInput: row.audioInput === true,
  };
}

/** Current effective catalog: non-hidden rows of enabled providers. */
export function readCatalog(): CatalogModel[] {
  return db
    .select({ row: models })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.hidden, false), eq(providers.enabled, true)))
    .orderBy(asc(models.providerId), asc(models.remoteId))
    .all()
    .map(({ row }) => toCatalog(row));
}

/** Sync one provider into the catalog. Returns false on upstream failure. */
export async function syncProvider(provider: ChatProvider): Promise<boolean> {
  let listed: ChatModel[];
  try {
    listed = await provider.listChatModels();
  } catch {
    return false;
  }
  const startedAt = new Date();
  for (const m of listed) {
    db.insert(models)
      .values({
        id: `${provider.id}:${m.id}`,
        providerId: provider.id,
        remoteId: m.id,
        vision: m.vision,
        audioInput: m.audioInput,
        hidden: false,
        lastSyncedAt: startedAt,
      })
      // Existing rows keep their (admin-editable) flags + hidden state (Q14);
      // only the sync watermark advances.
      .onConflictDoUpdate({ target: models.id, set: { lastSyncedAt: startedAt } })
      .run();
  }
  // Models the upstream no longer lists are dropped (rows not refreshed by
  // this sync still carry an older watermark).
  db.delete(models)
    .where(and(eq(models.providerId, provider.id), lt(models.lastSyncedAt, startedAt)))
    .run();
  return true;
}

/** Ensure every enabled provider has a catalog row set fresher than the TTL;
 *  then serve the effective catalog. Never throws. */
export async function ensureCatalog(): Promise<CatalogState> {
  const wired = chatProviders();
  if (wired.length === 0) return { models: [], allUnavailable: false };

  const rows = db
    .select({ providerId: models.providerId, lastSyncedAt: models.lastSyncedAt })
    .from(models)
    .all();
  const latest = new Map<string, number>();
  for (const r of rows) {
    if (r.lastSyncedAt) latest.set(r.providerId, Math.max(latest.get(r.providerId) ?? 0, r.lastSyncedAt.getTime()));
  }

  const now = Date.now();
  let failures = 0;
  for (const p of wired) {
    const at = latest.get(p.id);
    if (at && now - at < SYNC_TTL_MS) continue;
    if (!(await syncProvider(p))) failures += 1;
  }
  const catalog = readCatalog();
  // wired.length >= 1 here (empty list returned early), so equality with the
  // provider count already implies at least one failure.
  return { models: catalog, allUnavailable: failures === wired.length };
}

/** True when a model id (any enabled provider) is admin/heuristic-flagged
 *  for audio input. Replaces the old hardcoded compatibility list. */
export function isAudioInputModel(id: string | null | undefined): boolean {
  if (!id) return false;
  return readCatalog().some((m) => m.id === id && m.audioInput);
}

/** Ids of audio-input-capable catalog models (settings notices list these). */
export function audioCapableModelIds(): string[] {
  return readCatalog()
    .filter((m) => m.audioInput)
    .map((m) => m.id);
}

/** Provider serving `model` (canonical id) out of a NON-EMPTY list: the
 *  provider whose catalog row lists it, else the first provider — an unknown
 *  id still reaches an upstream that produces a real model error (historical
 *  passthrough kept). */
export function pickProvider(providersIn: ChatProvider[], catalog: CatalogModel[], model: string): ChatProvider {
  if (providersIn.length === 1) return providersIn[0];
  const row = catalog.find((m) => m.id === model);
  if (row) {
    const match = providersIn.find((p) => p.id === row.providerId);
    if (match) return match;
  }
  return providersIn[0];
}

/**
 * The provider's OWN id for a public model id, sent in the outbound completion
 * body (the `${providerId}:` namespace is Yasha-internal). Canonical ids are
 * built as `${providerId}:${remoteId}` (syncProvider), so stripping the chosen
 * provider's prefix always yields the remote id; an id whose prefix belongs to
 * a DIFFERENT provider (unknown-id fallback routing) passes through untouched
 * so upstream returns its real model error.
 */
export function upstreamModelId(model: string, providerId: string): string {
  const prefix = `${providerId}:`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

export type ModelRoute = { provider: ChatProvider; model: string };

/** Resolve a canonical model id to its serving provider AND the remote id to
 *  send upstream (TTL-catalog for the multi-provider pick). A single provider
 *  serves everything — no catalog lookup (and no sync) needed. Unknown ids
 *  route to the first provider and pass through so upstream produces a real
 *  model error. */
export async function routeModel(model: string): Promise<ModelRoute | null> {
  const wired = chatProviders();
  if (wired.length === 0) return null;
  if (wired.length === 1) {
    return { provider: wired[0], model: upstreamModelId(model, wired[0].id) };
  }
  const { models: catalog } = await ensureCatalog();
  const provider = pickProvider(wired, catalog, model);
  return { provider, model: upstreamModelId(model, provider.id) };
}
