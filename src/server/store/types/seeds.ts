/**
 * SEED CONSTANTS (DEFAULT_*) — moved verbatim from src/server/store/types.ts
 * (docs/DECOMPOSITION-PLAN.md step 4). Type-only imports from ./rows-core
 * (AppSettings, RetentionSettings, RosterEntry) keep the load order acyclic:
 * rows-core imports these seed VALUES, seeds imports only TYPES back.
 */

import type { AppSettings, RetentionSettings, RosterEntry } from "./rows-core";

/**
 * Owner-set activation dates (design/data-terminology.md worked example):
 * Dan McKillop is rostered now but begins calling Monday 2026-09-28.
 * Backfilled on schema ensure in both stores when the column is still unset.
 */
export const DEFAULT_CALL_START_DATES: Record<string, string> = {
  "Dan McKillop": "2026-09-28",
};

/**
 * COMMISSION TRACKER seed profiles (owner directive 2026-10-01, spec §B — the
 * owner's four current assignments). Applied by BOTH stores' ensureSchema the
 * same way as DEFAULT_CALL_START_DATES: fill-only-when-unset (commission_tier
 * IS NULL), so a later owner change in Settings never snaps back on restart.
 * Tier effective dates: the owner gave none — seeded to the first validation
 * cycle start 2026-08-31 (interpretation note 5, flagged to the owner).
 * Dan McKillop (roster entrant 9/28) has NO tier → stays ineligible.
 */
export interface CommissionProfileSeed {
  employment_type: import("../../commission/engine").EmploymentType;
  commission_tier: number;
  tier_effective_date: string;
}

export const DEFAULT_COMMISSION_PROFILES: Record<string, CommissionProfileSeed> = {
  "Allison Wittner": { employment_type: "full_time", commission_tier: 5, tier_effective_date: "2026-08-31" },
  "Laura Rivera": { employment_type: "part_time", commission_tier: 3, tier_effective_date: "2026-08-31" },
  "Carmine Morgano": { employment_type: "full_time", commission_tier: 1, tier_effective_date: "2026-08-31" },
  // Owner's "Jen" = Jennifer Stitt (the only Jennifer on the roster).
  "Jennifer Stitt": { employment_type: "full_time", commission_tier: 1, tier_effective_date: "2026-08-31" },
};

/**
 * OWNER SPEC: the rep roster is EXACTLY these five people. Live HighLevel
 * users that match an entry (name + email) are reps; every other user
 * (admins, other staff, agencies) is excluded from all rep surfaces while
 * their raw rows stay in the DB. Allison's HighLevel account currently carries
 * allison@malloryportraits.com while the owner quoted allisonwittner@gmail.com
 * — BOTH are accepted so a provider-side email change can never silently drop
 * the rep (flagged to the owner for reconciliation).
 */
export const DEFAULT_ACTIVE_ROSTER: RosterEntry[] = [
  { name: "Allison Wittner", emails: ["allisonwittner@gmail.com", "allison@malloryportraits.com"] },
  { name: "Carmine Morgano", emails: ["carmine@malloryportraits.com"] },
  { name: "Dan McKillop", emails: ["dan@malloryportraits.com"] },
  { name: "Jennifer Stitt", emails: ["jennifer@malloryportraits.com"] },
  { name: "Laura Rivera", emails: ["laura@malloryportraits.com"] },
];
export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  due_days: 7,
  qualifying_statuses: ["scheduled"],
  compute_lookback_days: 30,
  employee_initials: {},
  max_attempts: null,
  max_attempt_days: null,
  max_contact_days: null,
  reschedule_days: 14,
  /** The week of Mon Oct 12 2026 ET (owner directive 10/21). */
  data_start_week_start: "2026-10-12",
};
// The two SPEC'd Google Sheet IDs live in settings. Fairyland (third genre,
// owner directive 2026-10-22) has NO default id: an empty string means "not
// configured" — the sync skips it and no count/correction is ever invented.
/** The "Forms Data - Mallory Portraits" workbook — one id, four source tabs (owner directive 2026-10-27). */
export const FORMS_WORKBOOK_ID = "1ePTLKCpHVzvYo7zRUoAbE-rL3adXtkgjIsWXWtdf8Ms";
export const DEFAULT_SHEET_IDS = {
  family: "1_5d1TDrOLg_E3RICEY6M7K9wnM97M9wkHLUN-C0oIvg",
  animalia: "1Zp_ghywl-u4e13NHMoPRubZ9DCZC-Khv1ePL6PVahZU",
  fairyland: "",
  // FORM-WORKBOOK SOURCES: all four tabs live in ONE workbook, verified shared
  // with the service account (Viewer) — the id is the owner's directive.
  auction_register_certificate: FORMS_WORKBOOK_ID,
  google_ads_leads: FORMS_WORKBOOK_ID,
  alliance_activate_certificate: FORMS_WORKBOOK_ID,
  website_applications: FORMS_WORKBOOK_ID,
};

// Configurable column mapping (column letters/names per sheet).
// OWNER-CORRECTED DEFAULTS: the lead sheets' DATE lives in column Q (header
// "Date" on both Family + Animalia) — the default mapping reads Q out of the
// box. Default mode is row_per_day_count per the owner's spec; everything
// stays editable in Settings → Sheet column mapping, where the current
// default is shown next to the controls.
export const DEFAULT_COLUMN_MAPPING = {
  source_date: "Q",
  name: "B",
  phone: "C",
  email: "D",
  lead_type: "E",
};
export const DEFAULT_COLUMN_MAPPING_DAY_COUNT = {
  source_date: "Q",
  count: "B",
  lead_type: "C",
};
export const DEFAULT_SETTINGS: AppSettings = {
  meaningful_call_threshold_seconds: 120,
  highlevel_sync_interval_seconds: 90,
  attribution_window_hours: 24,
  timezone: "America/New_York",
  active_roster: DEFAULT_ACTIVE_ROSTER,
  historical_reps: [],
  rep_mappings: [],
  unattributedQueue: { dismissedBefore: null },
  studio: {
    appointment_duration_min: 60,
    // TWO-BLOCK DAILY SCHEDULE (owner directive 2026-09-27, supersedes the
    // interim 50-min/10:00–18:00 workaround): EVERY day carries two active
    // hour-blocks — 09:00–13:00 + 13:30–18:30, 60-min interval, 60-min
    // duration → exactly 9 slot starts per day
    // (9:00, 10:00, 11:00, 12:00 | 1:30, 2:30, 3:30, 4:30, 5:30).
    // The engine runs EVERY active rule for the weekday; the 12:00 session
    // runs to 1:00pm (close 13:00) and the next set starts 1:30pm.
    slot_interval_min: 60,
    padding_min: 15,
    recurring_blocks: [],
    hours: [
      { weekday: 0, open_time: "09:00", close_time: "13:00", active: true },
      { weekday: 0, open_time: "13:30", close_time: "18:30", active: true },
      { weekday: 1, open_time: "09:00", close_time: "13:00", active: true },
      { weekday: 1, open_time: "13:30", close_time: "18:30", active: true },
      { weekday: 2, open_time: "09:00", close_time: "13:00", active: true },
      { weekday: 2, open_time: "13:30", close_time: "18:30", active: true },
      { weekday: 3, open_time: "09:00", close_time: "13:00", active: true },
      { weekday: 3, open_time: "13:30", close_time: "18:30", active: true },
      { weekday: 4, open_time: "09:00", close_time: "13:00", active: true },
      { weekday: 4, open_time: "13:30", close_time: "18:30", active: true },
      { weekday: 5, open_time: "09:00", close_time: "13:00", active: true },
      { weekday: 5, open_time: "13:30", close_time: "18:30", active: true },
      { weekday: 6, open_time: "09:00", close_time: "13:00", active: true },
      { weekday: 6, open_time: "13:30", close_time: "18:30", active: true },
    ],
  },
  // SPEC sheet IDs + configurable column mapping/mode; acuity scope configurable.
  // Default mapping: row_per_day_count, date column Q (owner-corrected).
  // Acuity scope defaults to EMPTY = everything counts (owner rule) — the live
  // account's calendars ("MALLORY PORTRAITS", "Zoom") share no name with the
  // demo-era defaults, and a non-matching default scope would hide real
  // bookings from the availability engine (phantom openings). The owner picks
  // specific calendars/types in Settings when they want a narrower scope.
  sheets: {
    family: { sheet_id: DEFAULT_SHEET_IDS.family, mode: "row_per_day_count", columns: { ...DEFAULT_COLUMN_MAPPING_DAY_COUNT } },
    animalia: { sheet_id: DEFAULT_SHEET_IDS.animalia, mode: "row_per_day_count", columns: { ...DEFAULT_COLUMN_MAPPING_DAY_COUNT } },
    // Third genre: sheet_id "" = NOT configured — the sync skips it honestly
    // until the owner saves the real Fairyland sheet in Settings.
    fairyland: { sheet_id: DEFAULT_SHEET_IDS.fairyland, mode: "row_per_day_count", columns: { ...DEFAULT_COLUMN_MAPPING_DAY_COUNT } },
    // FORM-WORKBOOK SOURCES (owner directive 2026-10-27) — each tab INDEPENDENT:
    // same workbook id, distinct tab_name, mode row_per_lead, column letters
    // verified from the live API:
    //   Auction/Alliance certificates: name A, last_name B, phone C, email H, date L
    //   Google Ads leads: name A, last_name B, email C, phone D, date E, lead_type F
    //   Website applications: name A, phone B, email C, date I
    // lead_type for google_ads_leads mirrors the Fairyland mechanism (a mapped
    // lead_type COLUMN feeds the raw cell value — "Family"/"Pet" project names;
    // per-SOURCE counting classifies by sheet identity, never by this text).
    auction_register_certificate: {
      sheet_id: DEFAULT_SHEET_IDS.auction_register_certificate, mode: "row_per_lead",
      columns: { source_date: "L", name: "A", last_name: "B", phone: "C", email: "H" },
      tab_name: "Auction Register Certificate",
    },
    google_ads_leads: {
      sheet_id: DEFAULT_SHEET_IDS.google_ads_leads, mode: "row_per_lead",
      columns: { source_date: "E", name: "A", last_name: "B", email: "C", phone: "D", lead_type: "F" },
      tab_name: "Google Ads Leads",
    },
    alliance_activate_certificate: {
      sheet_id: DEFAULT_SHEET_IDS.alliance_activate_certificate, mode: "row_per_lead",
      columns: { source_date: "L", name: "A", last_name: "B", phone: "C", email: "H" },
      tab_name: "Alliance Activate Certificate",
    },
    website_applications: {
      sheet_id: DEFAULT_SHEET_IDS.website_applications, mode: "row_per_lead",
      columns: { source_date: "I", name: "A", phone: "B", email: "C" },
      tab_name: "Website Applications",
    },
  },
  acuity: { calendars_included: [], types_included: [] },
};

export function defaultSettings(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}
