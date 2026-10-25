// Per-provider health probes for the Backend status API + UI badge
// (docs/provider-plan.md Q19/Q23). Lemonade answers GET /v1/health; every
// other type answers GET /v1/models (2xx = healthy). Results are cached per
// provider for a short TTL so badge polls and admin lists don't stampede.

import type { Provider } from "@/lib/db/schema";

export const HEALTH_PROBE_TTL_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

export type ProviderHealth = {
  id: string;
  label: string;
  type: Provider["type"];
  baseUrl: string;
  ok: boolean;
  status: number | null;
};

type ProbeResult = { ok: boolean; status: number | null; at: number };
const probes = new Map<string, ProbeResult>();

/** Drops cached probe results (tests / provider CRUD). */
export function resetHealthProbes(): void {
  probes.clear();
}

async function probeProvider(row: Provider): Promise<ProbeResult> {
  const path = row.type === "lemonade" ? "/v1/health" : "/v1/models";
  const headers: Record<string, string> = {};
  if (row.apiKey) headers.Authorization = `Bearer ${row.apiKey}`;
  try {
    const res = await fetch(`${row.baseUrl}${path}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, at: Date.now() };
  } catch {
    return { ok: false, status: null, at: Date.now() };
  }
}

/** Health of each given provider row, from cache when fresher than the TTL. */
export async function providersHealth(rows: Provider[]): Promise<ProviderHealth[]> {
  const now = Date.now();
  const fresh = new Map<string, ProbeResult>();
  for (const row of rows) {
    const cached = probes.get(row.id);
    if (cached && now - cached.at < HEALTH_PROBE_TTL_MS) fresh.set(row.id, cached);
  }
  const toProbe = rows.filter((r) => !fresh.has(r.id));
  const results = await Promise.all(
    toProbe.map(async (row) => [row.id, await probeProvider(row)] as const)
  );
  for (const [id, result] of results) {
    probes.set(id, result);
    fresh.set(id, result);
  }
  return rows.map((row) => {
    const p = fresh.get(row.id)!;
    return { id: row.id, label: row.label, type: row.type, baseUrl: row.baseUrl, ok: p.ok, status: p.status };
  });
}
