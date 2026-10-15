// Pure UI helpers: settings/API values are stored in milliseconds, but admin
// forms show and accept seconds.

export function msToSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : String(Number(s.toFixed(3)));
}

export function secondsToMs(raw: string): number | null {
  const s = Number.parseFloat(raw.trim().replace(",", "."));
  if (!Number.isFinite(s) || s <= 0) return null;
  const ms = Math.round(s * 1000);
  return ms > 0 ? ms : null;
}
