/**
 * CANONICAL GENRE MODULE (owner directive 2026-10-22): Fairyland is a THIRD
 * Acuity genre treated exactly like Family/Animalia everywhere — no fork, no
 * separate workflow, no separate UI treatment. Every bar, legend, tick, filter
 * and settings surface iterates GENRES (display order: Fairyland appends
 * LAST); the ONE exception is the Today-page filter chips, whose order is the
 * owner's quoted "All | Family | Animalia | Fairyland".
 *
 * Pure + client-safe: constants and classifiers only — importable from client
 * routes AND server metrics (the server's isAnimaliaSession/isFairylandSession
 * in server/metrics/weekly.ts stay in lockstep with classifySessionGenre here;
 * the duplication is deliberate so the server keeps its tested exports).
 */
export const GENRES = ["family", "animalia", "fairyland"] as const;
export type Genre = (typeof GENRES)[number];

export const GENRE_LABELS: Record<Genre, string> = {
  family: "Family",
  animalia: "Animalia",
  fairyland: "Fairyland",
};

/** Mix-bar / legend color per genre — CSS custom properties defined in app.css. */
export const GENRE_BAR: Record<Genre, string> = {
  family: "var(--text-muted)",
  animalia: "var(--bar-fill)",
  fairyland: "var(--genre-fairyland)",
};

/**
 * Case-insensitive containment — the SAME convention as the server's
 * isAnimaliaSession/isFairylandSession. Existing animalia classification is
 * preserved bit-for-bit (animalia is checked first, exactly as before the
 * widening); Fairyland is the NEW branch; everything else stays Family.
 */
export function classifySessionGenre(appointmentType: string): Genre {
  const t = appointmentType ?? "";
  if (/animalia/i.test(t)) return "animalia";
  if (/fairyland/i.test(t)) return "fairyland";
  return "family";
}

/**
 * Lead-row genre classifier (lead_type text first; optional sourceSheet is
 * the SHEET-IDENTITY FALLBACK — a lead ingested from the fairyland sheet is
 * fairyland even when its Campaign Name text doesn't contain "fairyland").
 * Family/Animalia sheets classify exactly as before (text-first order).
 */
export function classifyLeadGenre(leadType: string, sourceSheet?: string): Genre {
  const t = leadType ?? "";
  if (/animalia/i.test(t)) return "animalia";
  if (/fairyland/i.test(t)) return "fairyland";
  if (sourceSheet === "fairyland") return "fairyland";
  return "family";
}

/**
 * Today-page filter chips (owner directive 10/22, net-new UI): "All | Family |
 * Animalia | Fairyland" — the ONE genre list that does not follow GENRES
 * order. Display-layer only: it selects which mix-bar segments / legend rows
 * are PRESENTED; stored data is never filtered or changed.
 */
export function genresForFilter(selected: Genre | "all"): readonly Genre[] {
  return selected === "all" ? GENRES : GENRES.filter((g) => g === selected);
}
