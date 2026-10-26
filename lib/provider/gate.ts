// Per-user in-flight generation gate (Yasha policy, shared by /api/chat +
// /v1/chat/completions).
//
// Naive rate limit: 1 in-flight generation per user. Module-scope Map is
// per-process only (single Next dev/prod instance); resets on server restart.
// Keyed by userId and shared across the session route (/api/chat) and the
// API-key route (/v1/chat/completions), so a user cannot double-book upstream.

const inFlight = new Map<string, AbortController>();

/** Claims the per-user generation slot, or returns null if one is already in flight. */
export function tryAcquireGeneration(userId: string): AbortController | null {
  if (inFlight.has(userId)) return null;
  const controller = new AbortController();
  inFlight.set(userId, controller);
  return controller;
}

export function releaseGeneration(userId: string): void {
  inFlight.delete(userId);
}

export function hasInFlightGeneration(userId: string): boolean {
  return inFlight.has(userId);
}
