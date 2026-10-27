/**
 * CANONICAL LEAD-SOURCE MODULE (owner directive 2026-10-27): the "Forms Data -
 * Mallory Portraits" Google workbook connects as FOUR additional independent
 * lead sources through the EXISTING sheets pipeline — no separate counting
 * pipeline, no fork. Every surface that names or enumerates the ingested lead
 * sheets iterates LEAD_SOURCE_SHEETS here; the three genre sheets keep their
 * genres.ts identity (that module stays the ONE canonical genre module — these
 * four are lead SOURCES, not Acuity genres, and never classify into the
 * Family/Animalia/Fairyland session genres).
 *
 * Pure + client-safe: constants only — importable from client routes AND
 * server metrics/stores (the store's settings defaults and the live adapter's
 * per-sheet loop both consume this list, so a sheet can never be configured in
 * Settings but invisible to the sync).
 */

/** The three genre sheets — family/animalia/fairyland, unchanged since their directives. */
export const GENRE_SOURCE_SHEETS = ["family", "animalia", "fairyland"] as const;
export type GenreSourceSheet = (typeof GENRE_SOURCE_SHEETS)[number];

/**
 * The four FORM-WORKBOOK sources (owner directive 2026-10-27). Keys are the
 * settings.sheets keys AND the leads.source_sheet values AND the identity-key
 * sheet segment (gs2#{sheet}#…), so a lead's source is readable from its id.
 * Each targets its own tab of workbook 1ePTLKCpHVzvYo7zRUoAbE-rL3adXtkgjIsWXWtdf8Ms
 * (see DEFAULT_SHEET_IDS in server/store/types.ts).
 */
export const FORM_SOURCE_SHEETS = [
  "auction_register_certificate",
  "google_ads_leads",
  "alliance_activate_certificate",
  "website_applications",
] as const;
export type FormSourceSheet = (typeof FORM_SOURCE_SHEETS)[number];

/** All seven ingested lead sheets in display order (genres first, forms appended). */
export const LEAD_SOURCE_SHEETS = [...GENRE_SOURCE_SHEETS, ...FORM_SOURCE_SHEETS] as const;
export type LeadSourceSheet = (typeof LEAD_SOURCE_SHEETS)[number];

/** Display labels — the owner's own names for the sources (tab names verbatim where sensible). */
export const LEAD_SOURCE_LABELS: Record<LeadSourceSheet, string> = {
  family: "Family",
  animalia: "Animalia",
  fairyland: "Fairyland",
  auction_register_certificate: "Auction Certificates",
  google_ads_leads: "Google Ads Leads",
  alliance_activate_certificate: "Alliance Certificates",
  website_applications: "Website Applications",
};

/** Is this leads.source_sheet one of the four form-workbook sources? */
export function isFormSourceSheet(sourceSheet: string | null | undefined): boolean {
  return (FORM_SOURCE_SHEETS as readonly string[]).includes((sourceSheet ?? "").trim());
}

/** Narrow a raw settings key to a known lead-source sheet key (null when unknown). */
export function asLeadSourceSheet(v: unknown): LeadSourceSheet | null {
  return (LEAD_SOURCE_SHEETS as readonly string[]).includes(typeof v === "string" ? v : "") ? (v as LeadSourceSheet) : null;
}
