// Alias target for "next/headers" (vitest.config.ts). Only `headers()` is
// meaningful in tests; everything else would require a real Next request
// scope, which integration tests deliberately do not emulate.

import { getCurrentHeaders } from "./request-context";

export async function headers(): Promise<Headers> {
  return getCurrentHeaders();
}

export async function cookies(): Promise<never> {
  throw new Error("cookies() is not available in integration tests");
}

export async function draftCookies(): Promise<never> {
  throw new Error("draftCookies() is not available in integration tests");
}

export async function connection(): Promise<void> {
  return undefined;
}

export function after(fn: () => unknown): void {
  void Promise.resolve().then(fn);
}

export function revalidatePath(..._args: unknown[]): void {}
export function revalidateTag(..._args: unknown[]): void {}
export function refresh(): void {}
export function unstable_rethrow(err: unknown): void {
  throw err;
}
