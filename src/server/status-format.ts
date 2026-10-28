/**
 * STATUS VIEW — PURE FORMAT HELPERS (no imports at all).
 *
 * The Status route's component imports these directly, so this module must
 * stay dependency-free: anything it reached (store, supervisor-decisions,
 * boot-guard) would drag the server graph (postgres) into the browser bundle.
 * The server-side page-data builder (status-health.ts) re-exports these so
 * tests and the server share ONE definition; the route imports from HERE.
 */

/** Minutes between an ISO start and `nowMs`; null when unparsable — never a guess. */
export function minutesSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round(((nowMs - t) / 60_000) * 10) / 10);
}

/** Honest duration label: "—" for missing, "<1 min" for a real zero. */
export function formatAgeMinutes(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "<1 min";
  if (minutes < 120) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
