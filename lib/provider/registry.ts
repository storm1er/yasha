// Provider registry: seeds the `providers` table from BACKEND_* env at boot
// (ONLY while the table is empty — Q5; the table is the source of truth
// afterwards) and exposes the enabled provider adapters. The synced model
// catalog and model→provider routing live in catalog.ts.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providers, type Provider, type ProviderType } from "@/lib/db/schema";
import { instantiate, resetProviderInstances } from "./adapters";
import type { ChatProvider, ControlPlane } from "./types";

export { resetProviderInstances };

/** Seeds one default provider from BACKEND_* env while the table is empty. */
export function seedProvidersFromEnv(): void {
  const baseUrl = process.env.BACKEND_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return;
  if (db.select({ id: providers.id }).from(providers).all().length > 0) return;
  const type: ProviderType =
    process.env.BACKEND_TYPE?.trim() === "openai_compatible" ? "openai_compatible" : "lemonade";
  const now = new Date();
  db.insert(providers)
    .values({
      id: "default",
      type,
      label: "Default backend",
      baseUrl,
      apiKey: process.env.BACKEND_API_KEY?.trim() || null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}

/** All enabled provider rows, insertion-stable order. */
export function enabledProviderRows(): Provider[] {
  return db.select().from(providers).where(eq(providers.enabled, true)).all();
}

/** Adapters for all enabled provider rows. */
export function chatProviders(): ChatProvider[] {
  return enabledProviderRows().map(instantiate);
}

export type ControlPlaneLookup =
  | { ok: true; controlPlane: ControlPlane }
  | { ok: false; error: "no_backend" | "provider_lacks_control_plane" | "provider_not_found" };

/**
 * Control plane for admin routes (Q10). Without `providerId`: the first
 * enabled provider offering one (legacy semantics). With one (the Backend
 * tab's `?provider=`, M3): exactly that provider — unknown/disabled ids are
 * `provider_not_found` (404), enabled-but-plain ones lack_control_plane (501).
 */
export function controlPlaneForAdmin(providerId?: string | null): ControlPlaneLookup {
  if (providerId) {
    const row = db
      .select()
      .from(providers)
      .where(and(eq(providers.id, providerId), eq(providers.enabled, true)))
      .get();
    if (!row) return { ok: false, error: "provider_not_found" };
    const cp = instantiate(row).asControlPlane();
    return cp ? { ok: true, controlPlane: cp } : { ok: false, error: "provider_lacks_control_plane" };
  }
  if (enabledProviderRows().length === 0) return { ok: false, error: "no_backend" };
  for (const p of chatProviders()) {
    const cp = p.asControlPlane();
    if (cp) return { ok: true, controlPlane: cp };
  }
  // Providers enabled but none manages models (e.g. openai_compatible only).
  return { ok: false, error: "provider_lacks_control_plane" };
}
