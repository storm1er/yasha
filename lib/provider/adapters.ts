// Adapter factory: maps provider rows to adapter instances. Instances are
// cached per row and rebuilt when the row changes (updatedAt/baseUrl/key/type
// flip the signature). Split out of registry.ts so catalog.ts can build
// adapters without an import cycle.

import { type Provider, type ProviderType } from "@/lib/db/schema";
import { LemonadeProvider } from "./lemonade";
import { OpenAICompatProvider } from "./openai-compatible";
import type { ChatProvider } from "./types";

const ADAPTERS: Record<
  ProviderType,
  new (id: string, baseUrl: string, apiKey: string | null) => ChatProvider
> = {
  lemonade: LemonadeProvider,
  openai_compatible: OpenAICompatProvider,
};

type Cached = { sig: string; provider: ChatProvider };
const instances = new Map<string, Cached>();

/** Drops cached adapter instances (tests / provider CRUD). */
export function resetProviderInstances(): void {
  instances.clear();
}

export function instantiate(row: Provider): ChatProvider {
  const Ctor = ADAPTERS[row.type];
  const sig = `${row.updatedAt.getTime()}|${row.type}|${row.baseUrl}|${row.apiKey ?? ""}`;
  const cached = instances.get(row.id);
  if (cached && cached.sig === sig) return cached.provider;
  const provider = new Ctor(row.id, row.baseUrl, row.apiKey);
  instances.set(row.id, { sig, provider });
  return provider;
}
