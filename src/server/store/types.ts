/**
 * Data store abstraction: the app runs against Postgres (Tiger Cloud) when
 * DATABASE_URL works, and falls back to an in-memory demo dataset when it
 * doesn't — so the dashboard is always viewable and the Postgres path activates
 * automatically once the connection is fixed. Both stores implement the same
 * duplicate-safe upsert semantics (keyed by provider external IDs).
 */

import type {
  AppointmentRow,
  AttributionRow,
  AvailabilityRule,
  BlockedTimeRow,
  CallRow,
  LeadRow,
  RecurringBlock,
} from "../metrics/compute";

export interface UserRow {
  id: string; // internal id (uuid in pg; provider key in memory)
  provider: string; // highlevel
  external_id: string;
  name: string;
  email: string | null;
  is_active: boolean;
  /**
   * OWNER SPEC (design/data-terminology.md): explicit rep activation date
   * (ET calendar date). Before it the rep is visible with operating state
   * "Not Yet Active" — zero calls expected, NO exception/coaching flags, no
   * negative messaging; normal monitoring begins ON the date. Null = active
   * monitoring from whenever their rows start (existing reps).
   */
  call_start_date: string | null;
}

/**
 * Owner-set activation dates (design/data-terminology.md worked example):
 * Dan McKillop is rostered now but begins calling Monday 2026-09-28.
 * Backfilled on schema ensure in both stores when the column is still unset.
 */
export const DEFAULT_CALL_START_DATES: Record<string, string> = {
  "Dan McKillop": "2026-09-28",
};

export interface ContactRow {
  id: string;
  provider: string;
  external_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  assigned_rep_id: string | null;
  created_at: string; // ISO
  // ---- identity-program fields (Session 1; both stores must agree) ----
  first_name?: string | null;
  last_name?: string | null;
  /** Untouched HL value duplicated from `phone` (raw kept alongside normalized). */
  phone_raw?: string | null;
  /** normalizeUSPhone(phone_raw) — canonical identity key (Session 2 matching). */
  phone_normalized?: string | null;
  email_raw?: string | null;
  /** normalizeEmail(email_raw) — canonical identity key (Session 2 matching). */
  email_normalized?: string | null;
  /** HL contact dateAdded / dateUpdated (ISO) where the provider reports them. */
  source_created_at?: string | null;
  source_updated_at?: string | null;
  /** Last time this row was (re)synced from the provider. */
  last_synced_at?: string | null;
}

/** Pipeline opportunity synced from HighLevel (provider rows; upsert by external id). */
export interface OpportunityRow {
  id?: string;
  provider: string; // highlevel
  external_id: string;
  name: string | null;
  status: string | null; // open | won | lost | abandoned
  monetary_value: number | null;
  contact_id: string | null; // internal contacts.id
  rep_id: string | null; // internal users.id (assignedTo)
  pipeline_id: string | null;
  stage_id: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
}

/**
 * S4: light contact identity pair — (internal id, provider external id).
 * The per-tick linkage map + walk frontier read ONLY these two columns;
 * the FULL row materialization (getContacts) is a full-sync concern.
 */
export interface ContactExternalIdRow {
  id: string;
  external_id: string;
}
/**
 * PERF: light contact identity slice — ONLY the columns the Settings page's
 * unattributed-queue/engine identity resolution consumes (id/phone/email/
 * assigned_rep_id). Replaces the 18-column × ~116k-row getContacts()
 * materialization on page paths (~1s remote transfer). Row VALUES are
 * identical for these fields — no semantics change.
 */
export interface ContactIdentityRow {
  id: string;
  phone: string | null;
  email: string | null;
  assigned_rep_id: string | null;
}
/** Raw joined call record for the audit endpoint (source = normalized DB). */
export interface AuditCallRow {
  /** HighLevel call-message id (the calls table's external_call_id). */
  external_call_id: string;
  conversation_id: string | null;
  rep_id: string | null;
  rep_name: string | null;
  /** users.is_active — false/NULL means the call is held UNASSIGNED (non-roster or unknown user). */
  rep_is_active: boolean | null;
  /** RAW HighLevel userId preserved even when the call has no roster rep. */
  provider_rep_external_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_external_id: string | null;
  /**
   * HOW the call's contact was resolved (call→contact restoration backfill):
   * direct_message_contact | parent_conversation_contact | exact_phone |
   * exact_email | ambiguous | unresolved; null = never backfilled.
   */
  contact_resolution_method: string | null;
  direction: string | null;
  call_status: string | null;
  started_at: string;
  duration_seconds: number;
  /**
   * duration_seconds > threshold, computed with the LIVE settings threshold —
   * the SAME rule the metrics layer (summarizeCalls) applies, so the audit view
   * can never diverge from what Reps/Team show for the same day.
   */
  over_threshold: boolean;
}

export interface TeamGoalRow {
  week_start: string; // YYYY-MM-DD (Monday)
  booking_goal: number;
  lead_budget: number;
}

export interface RepGoalRowFull {
  rep_id: string;
  week_start: string;
  goal: number;
}

/** One per-month booking goal — key is the ET calendar month 'YYYY-MM' (rep_goals precedent, month-grain). */
export interface MonthlyGoalRow {
  month: string; // YYYY-MM
  goal: number;
}

/** The owner's editable CC Report narrative for one report week (Big-3 pattern, week-grain). */
export interface WeeklyReportNotesRow {
  week_start: string; // YYYY-MM-DD (Monday) — the save key
  /** Section key → text (keys are the stable ids in WEEKLY_CC_SECTIONS); absent/empty = unfilled. */
  notes: Record<string, string>;
}

export interface ConnectionRow {
  provider: string; // highlevel | acuity | google_sheets
  status: string; // connected | demo | error | disconnected
  is_demo: boolean;
  last_sync_at: string | null;
  last_successful_sync_at: string | null;
  last_error: string | null;
  config: Record<string, unknown>;
}

export interface SyncRunRow {
  id: string;
  provider: string;
  status: string; // running | success | error
  started_at: string;
  finished_at: string | null;
  records_upserted: number;
  error: string | null;
}

// ---------- sync-run freshness (shared by both stores + the scheduler) ----------

/**
 * STALE-RUN REAP WINDOW (owner directive 2026-09-28): a bounded provider's
 * "running" sync_runs row stuck longer than this is a hung process, not a live
 * one. Defined HERE (not in sync/scheduler) so both stores can use it in
 * getRunningSyncRun without importing the scheduler (which imports the store
 * — a cycle). sync/scheduler re-exports it for its callers/tests.
 */
export const STALE_RUN_REAP_MINUTES = 15;

/**
 * Defensive started_at parse. Accepts ISO strings AND Postgres's text form
 * ("YYYY-MM-DD HH:MM:SS.ffffff+00" — space separator, microseconds) that some
 * engines' Date.parse rejects; retries with a "T" separator before giving up.
 * Returns NaN when unparsable — callers treat that as stale and never crash.
 */
export function parseSyncStartedMs(raw: string): number {
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  return Date.parse(raw.replace(" ", "T"));
}

/**
 * One conversation discovered by the resumable call harvest
 * (src/server/sync/call-harvest.ts). `visited` marks that its messages have
 * been fetched and scanned for TYPE_CALL messages; coverage = visited/total
 * over the in-window rows. Persisted so a stopped run resumes exactly.
 */
export interface HarvestConvRow {
  conv_id: string;
  last_message_date: number; // epoch ms
  date_added: number; // epoch ms
  message_types: number[]; // numeric codes; 1 = call (probed 2026-09-26)
  last_message_type: string | null;
  contact_id: string | null;
  assigned_to: string | null;
}

/**
 * One call message in the harvest-side ledger (harvest_calls table; written by
 * the harvest runner). The call→contact restoration backfill reads it as the
 * DIRECT source identity: message_id = calls.external_call_id,
 * contact_external_id = the HL message's own contactId.
 */
export interface HarvestCallRow {
  message_id: string;
  conversation_id: string | null;
  user_external_id: string | null;
  contact_external_id: string | null;
  started_at: string; // ISO
  duration_seconds: number | null;
  direction: string | null;
  call_status: string | null;
}

/**
 * HOW a call's contact was resolved (call→contact restoration backfill,
 * owner-ratified hierarchy): direct message contactId > parent conversation
 * contactId > exact normalized phone > exact normalized email; ambiguity and
 * failure are recorded, never guessed around.
 */
export type CallContactResolutionMethod =
  | "direct_message_contact"
  | "parent_conversation_contact"
  | "exact_phone"
  | "exact_email"
  | "ambiguous"
  | "unresolved";

/**
 * One call's restoration verdict for the fill-null-only store update.
 * contact_id is the resolved internal contact (NULL for ambiguous/unresolved —
 * the method records WHY); an existing non-null contact_id is NEVER
 * overwritten (direct source data always wins; inheritance only fills NULL).
 */
export interface CallContactBackfillUpdate {
  call_id: string;
  contact_id: string | null;
  resolution_method: CallContactResolutionMethod;
  contact_resolved_at: string; // ISO
}

/** Singleton progress row for the call harvest (id 'highlevel-calls'). */
export interface HarvestProgressRow {
  id: string; // 'highlevel-calls'
  window_start_utc: string;
  /** dateAdded waterfall cursor: the next (lower) window's exclusive upper bound. */
  list_hi_exclusive: number;
  list_complete: boolean;
  list_requests: number;
  conversations_listed: number;
  visits_done: number;
  calls_found: number;
  messages_scanned: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
}

/** Manual lead-count correction vs the synced sheet rows (one per work_date+sheet). */
export interface LeadCountAdjustmentRow {
  work_date: string;
  sheet: string;
  delta: number;
  reason: string | null;
  updated_at: string;
}

export interface ManualOverrideRow {
  id: string;
  entity_type: string;
  entity_id: string;
  field: string;
  previous_value: string | null;
  new_value: string;
  changed_by: string;
  changed_at: string;
}

export interface DailyPrioritiesRow {
  date: string;
  priority1: string | null;
  priority2: string | null;
  priority3: string | null;
  updated_at: string;
}

/**
 * One entry of the active roster: a rep's name plus every email that should
 * count as theirs (Allison carries BOTH the owner-quoted gmail and the live
 * mallory address — see DEFAULT_ACTIVE_ROSTER). Matching is case-insensitive
 * on both fields; the pure rule lives in src/server/roster.ts.
 */
export interface RosterEntry {
  name: string;
  emails: string[];
}

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

/**
 * Sanitize a stored roster: keep entries with a non-empty name and at least
 * one non-empty email; fall back to the default five when nothing valid
 * remains (the dashboard never runs with an EMPTY roster — that would zero
 * every rep surface; edit entries instead of deleting them all).
 */
export function normalizeRoster(raw: unknown): RosterEntry[] {
  const fallback = (): RosterEntry[] => JSON.parse(JSON.stringify(DEFAULT_ACTIVE_ROSTER));
  if (!Array.isArray(raw)) return fallback();
  const out: RosterEntry[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Partial<RosterEntry> & { email?: unknown };
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const rawEmails = Array.isArray(r.emails) ? r.emails : r.email != null ? [r.email] : [];
    const emails = rawEmails
      .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
      .map((e) => e.trim());
    if (name && emails.length) out.push({ name, emails });
  }
  return out.length > 0 ? out : fallback();
}

/**
 * One roster-mapping entry (design/data-terminology.md): a HighLevel user id
 * OUTSIDE the CC roster explicitly mapped to a CC rep by the owner. The raw
 * HighLevel user id is the KEY (stable across stores; internal ids are not
 * owner-visible). Mapping drives REPORTING ELIGIBILITY ONLY at query time —
 * it must NEVER alter the original source record (provider_rep_external_id,
 * rep linkage, ids, timestamps stay untouched).
 */
export interface RepMapping {
  external_user_id: string;
  rep_id: string; // internal users.id of an ACTIVE roster rep
}

/** Keep well-formed mappings; last one wins per HL user id; never throws. */
export function normalizeRepMappings(raw: unknown): RepMapping[] {
  if (!Array.isArray(raw)) return [];
  const byExternal = new Map<string, RepMapping>();
  for (const item of raw) {
    const r = (item ?? {}) as Partial<RepMapping>;
    const ext = typeof r.external_user_id === "string" ? r.external_user_id.trim() : "";
    const rep = typeof r.rep_id === "string" ? r.rep_id.trim() : "";
    if (ext && rep) byExternal.set(ext, { external_user_id: ext, rep_id: rep });
  }
  return [...byExternal.values()];
}

export interface AppSettings {
  meaningful_call_threshold_seconds: number;
  /** Background HighLevel sync cadence (owner-configurable, default 90s, clamped 30–3600). */
  highlevel_sync_interval_seconds: number;
  attribution_window_hours: number;
  timezone: string;
  /**
   * The dashboard's reps: the owner-configured active roster (exactly the five
   * CC team members by default). The sync marks a live HighLevel user
   * users.is_active=true ONLY when name AND one of the entry's emails match
   * (case-insensitive) — everyone else keeps their rows in the DB but never
   * appears on rep surfaces or in team rollups. See src/server/roster.ts.
   */
  active_roster: RosterEntry[];
  /**
   * Owner-managed HL-user → CC-rep roster mappings (Settings → Roster
   * Mapping). When a non-roster HighLevel user is mapped here, ALL historical
   * calls under that HL user id become eligible AT QUERY TIME for the mapped
   * rep's performance and the CC team totals — no re-import, no backfill,
   * and the source records stay immutable. Empty = verified part-2 behavior.
   */
  rep_mappings: RepMapping[];
  studio: {
    appointment_duration_min: number;
    slot_interval_min: number;
    padding_min: number;
    hours: AvailabilityRule[]; // per-weekday rules; also mirrored into availability_rules
    recurring_blocks: RecurringBlock[]; // weekly recurring blocked times (Settings CRUD)
  };
  sheets: {
    family: SheetConfig;
    animalia: SheetConfig;
  };
  acuity: {
    calendars_included: string[];
    types_included: string[];
  };
}

/**
 * Per-sheet Google Sheets config. `mode` selects the sheet shape (the real
 * sheets were not visible when this shipped, so BOTH are first-class):
 *  - row_per_day_count: one row per day with a lead-count column (primary)
 *  - row_per_lead: one row per lead with phone/email (the Phase-1 shape)
 * `columns` maps logical fields to spreadsheet column letters; `count` is
 * only meaningful in row_per_day_count mode.
 */
export type SheetMappingMode = "row_per_day_count" | "row_per_lead";
export interface SheetConfig {
  sheet_id: string;
  mode: SheetMappingMode;
  columns: Record<string, string>;
}

// The two SPEC'd Google Sheet IDs live in settings.
export const DEFAULT_SHEET_IDS = {
  family: "1_5d1TDrOLg_E3RICEY6M7K9wnM97M9wkHLUN-C0oIvg",
  animalia: "1Zp_ghywl-u4e13NHMoPRubZ9DCZC-Khv1ePL6PVahZU",
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

export function isSheetMappingModeValue(v: unknown): v is SheetMappingMode {
  return v === "row_per_day_count" || v === "row_per_lead";
}

function normalizeSheetConfig(raw: unknown, fallbackId: string): SheetConfig {
  const r = (raw ?? {}) as Partial<SheetConfig> & { columns?: Record<string, unknown> };
  const rawColumns: Record<string, string> = {};
  if (r.columns && typeof r.columns === "object") {
    for (const [k, v] of Object.entries(r.columns)) if (typeof v === "string") rawColumns[k] = v;
  }
  const hasColumns = Object.keys(rawColumns).length > 0;
  // No stored mapping (fresh install / legacy row) → the owner-corrected
  // default shape: row_per_day_count with the date in column Q. A stored
  // config always wins over defaults (explicit owner choice in Settings).
  const mode: SheetMappingMode = isSheetMappingModeValue(r.mode)
    ? r.mode
    : hasColumns
      ? rawColumns.count
        ? "row_per_day_count" // legacy stored config with a count column
        : "row_per_lead"
      : "row_per_day_count";
  const columns = hasColumns
    ? rawColumns
    : { ...(mode === "row_per_day_count" ? DEFAULT_COLUMN_MAPPING_DAY_COUNT : DEFAULT_COLUMN_MAPPING) };
  return { sheet_id: typeof r.sheet_id === "string" && r.sheet_id ? r.sheet_id : fallbackId, mode, columns };
}

/**
 * Deep-merge stored settings with the current defaults so settings saved
 * before a newer field existed (e.g. sheets.<sheet>.mode) still see that
 * default. Used by BOTH stores on read.
 */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
  const r = (raw ?? {}) as Partial<AppSettings>;
  const clampNumber = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const merged: AppSettings = {
    ...base,
    ...r,
    highlevel_sync_interval_seconds: clampNumber(r.highlevel_sync_interval_seconds, base.highlevel_sync_interval_seconds, 30, 3600),
    active_roster: normalizeRoster(r.active_roster ?? base.active_roster),
    rep_mappings: normalizeRepMappings(r.rep_mappings ?? base.rep_mappings),
    studio: { ...base.studio, ...(r.studio ?? {}) },
    sheets: {
      family: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.family ?? base.sheets.family, DEFAULT_SHEET_IDS.family),
      animalia: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.animalia ?? base.sheets.animalia, DEFAULT_SHEET_IDS.animalia),
    },
    acuity: { ...base.acuity, ...(r.acuity ?? {}) },
  };
  return merged;
}

export const DEFAULT_SETTINGS: AppSettings = {
  meaningful_call_threshold_seconds: 120,
  highlevel_sync_interval_seconds: 90,
  attribution_window_hours: 24,
  timezone: "America/New_York",
  active_roster: DEFAULT_ACTIVE_ROSTER,
  rep_mappings: [],
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
  },
  acuity: { calendars_included: [], types_included: [] },
};

export function defaultSettings(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}

// ========================================================================
// PERFORMANCE MANAGEMENT (PIP module, Phase 1 — owner directive 9/30)
// ------------------------------------------------------------------------
// DETERMINISTIC + EVIDENCE-BASED, explicitly NOT an AI feature: the system
// stores and displays verified facts; the manager decides everything. There
// is deliberately NO second performance-calculation engine here — later
// phases reuse the existing verified metric functions. PIP rows are
// sensitive HR material: they must never surface on leaderboards, team
// comparisons, or any non-manager view.
// ========================================================================

/** PIP lifecycle: draft → issued (frozen snapshot) → completed | cancelled. */
export type PipStatus = "draft" | "issued" | "completed" | "cancelled";
export const PIP_STATUSES: PipStatus[] = ["draft", "issued", "completed", "cancelled"];

export function isPipStatus(v: unknown): v is PipStatus {
  return v === "draft" || v === "issued" || v === "completed" || v === "cancelled";
}

/**
 * One editable action item inside the JSONB action sections. `completed_at`
 * is set by the manager when they mark it done (never system-derived).
 */
export interface PipActionItem {
  text: string;
  completed: boolean;
  completed_at: string | null; // ISO
}

/** Sanitize a stored/entered action list: keep well-formed items, drop junk. */
export function normalizePipActionList(raw: unknown): PipActionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PipActionItem[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Partial<PipActionItem>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    out.push({
      text,
      completed: r.completed === true,
      completed_at: typeof r.completed_at === "string" ? r.completed_at : null,
    });
  }
  return out;
}

/**
 * One Performance Improvement Plan. The `issued` state is a PERMANENT frozen
 * evidence boundary: the pips row itself keeps its live fields, but the
 * issued document (version snapshot in pip_evidence_snapshots) never changes —
 * later live-data changes never rewrite an issued PIP; corrections happen via
 * documented amendments (a later phase adds NEW snapshot version rows).
 */
export interface PipRow {
  id: string;
  rep_id: string | null; // internal users.id; FK ON DELETE SET NULL (app requires a rep on create)
  title: string;
  status: PipStatus;
  goal_text: string | null;
  /** Nullable int — the weekly goal for the review period (single source: rep_goals semantics; never a second calc engine). */
  weekly_goal_min: number | null;
  /** OWNER RULE: hard weekly minimums are never averaged across weeks. */
  hard_weekly_minimum: boolean;
  review_start_date: string | null; // YYYY-MM-DD
  review_end_date: string | null; // YYYY-MM-DD
  pip_start_date: string | null; // YYYY-MM-DD (required to issue)
  pip_end_date: string | null; // YYYY-MM-DD (required to issue)
  manager_observations: string | null;
  action_plan: PipActionItem[];
  personal_development_actions: PipActionItem[];
  professional_development_actions: PipActionItem[];
  conclusion_category: string | null; // required to complete (manager choice)
  conclusion_notes: string | null; // required to complete
  issued_at: string | null; // ISO
  issued_by: string | null;
  completed_at: string | null; // ISO
  cancelled_at: string | null; // ISO
  cancelled_by: string | null;
  cancellation_reason: string | null; // required to cancel
  employee_visible: boolean;
  /** Current frozen-evidence version (1 = the original issue; amendments bump). */
  current_version: number;
  employee_acked_at: string | null;
  employee_acked_by: string | null;
  manager_acked_at: string | null;
  manager_acked_by: string | null;
  created_by: string | null;
  created_at: string; // ISO
  updated_at: string; // ISO
}

/** Manager-entered fields for a new PIP draft (status is always born 'draft'). */
export interface PipCreateInput {
  rep_id: string;
  title: string;
  goal_text?: string | null;
  weekly_goal_min?: number | null;
  hard_weekly_minimum?: boolean;
  review_start_date?: string | null;
  review_end_date?: string | null;
  pip_start_date?: string | null;
  pip_end_date?: string | null;
  manager_observations?: string | null;
  action_plan?: PipActionItem[];
  personal_development_actions?: PipActionItem[];
  professional_development_actions?: PipActionItem[];
  created_by?: string;
}

/** Editable fields of a DRAFT (the only mutable state of the document). */
export interface PipDraftPatch {
  rep_id?: string;
  title?: string;
  goal_text?: string | null;
  weekly_goal_min?: number | null;
  hard_weekly_minimum?: boolean;
  review_start_date?: string | null;
  review_end_date?: string | null;
  pip_start_date?: string | null;
  pip_end_date?: string | null;
  manager_observations?: string | null;
  action_plan?: PipActionItem[];
  personal_development_actions?: PipActionItem[];
  professional_development_actions?: PipActionItem[];
  /** Who made the edit (audit trail). */
  actor?: string;
}

/**
 * One frozen-evidence snapshot of a PIP document, written ONLY at issue time
 * (and later by amendments as NEW version rows). NEVER updated in place —
 * the UNIQUE (pip_id, version) key enforces write-once.
 */
export interface PipEvidenceSnapshotRow {
  id: string;
  pip_id: string;
  version: number;
  snapshot: Record<string, unknown>; // full frozen document (the pip row at issue)
  created_by: string | null;
  created_at: string; // ISO
}

/** One manager-logged check-in during an ISSUED PIP's review period. */
export interface PipCheckinRow {
  id: string;
  pip_id: string;
  checkin_date: string; // YYYY-MM-DD
  manager_name: string | null;
  employee_name: string | null;
  current_performance: string | null;
  topics_discussed: string | null;
  coaching_provided: string | null;
  employee_comments: string | null;
  manager_notes: string | null;
  next_actions: string | null;
  next_checkin_date: string | null; // YYYY-MM-DD
  created_at: string; // ISO
}

/** Manager-created reusable PIP template (Phase 1: CRUD only; applying to drafts is a later phase). */
export interface PipTemplateRow {
  id: string;
  name: string;
  category: string | null;
  default_goal_text: string | null;
  default_action_plan: PipActionItem[];
  default_personal: PipActionItem[];
  default_professional: PipActionItem[];
  default_checkin_cadence_days: number | null;
  default_duration_weeks: number | null;
  created_by: string | null;
  created_at: string; // ISO
  updated_at: string; // ISO
}

export interface PipTemplateCreateInput {
  name: string;
  category?: string | null;
  default_goal_text?: string | null;
  default_action_plan?: PipActionItem[];
  default_personal?: PipActionItem[];
  default_professional?: PipActionItem[];
  default_checkin_cadence_days?: number | null;
  default_duration_weeks?: number | null;
  created_by?: string;
}

export type PipTemplatePatch = Partial<Omit<PipTemplateCreateInput, "created_by">> & { actor?: string };

/**
 * PIP event log (module audit trail). The existing manual_overrides table CAN
 * represent lifecycle events (and receives a compact mirror row for every
 * one, so the Settings → Audit page never misses a PIP action), but the
 * module keeps its OWN typed log — before/after JSONB, template events,
 * amendment-ready — which later phases (History page, amendments) query.
 * History is NEVER deleted.
 */
export type PipEventType =
  | "pip_created"
  | "pip_edited"
  | "pip_observation_changed"
  | "pip_issued"
  | "pip_completed"
  | "pip_cancelled"
  | "pip_checkin_added"
  | "pip_template_created"
  | "pip_template_updated"
  | "pip_template_deleted";

export interface PipEventRow {
  id: string;
  pip_id: string | null;
  template_id: string | null;
  event_type: PipEventType;
  actor: string | null;
  field: string | null;
  previous_value: string | null;
  new_value: string | null;
  details: Record<string, unknown> | null;
  created_at: string; // ISO
}

export interface Store {
  mode: "postgres" | "memory";
  ensureSchema(): Promise<void>;

  // settings
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  // goals
  upsertTeamGoal(row: TeamGoalRow): Promise<void>;
  getTeamGoal(weekStart: string): Promise<TeamGoalRow | null>;
  /** All stored weekly goals ordered by week_start (Settings week-list editor). */
  getTeamGoals(): Promise<TeamGoalRow[]>;
  upsertRepGoals(rows: RepGoalRowFull[]): Promise<void>;
  getRepGoals(weekStart: string): Promise<RepGoalRowFull[]>;
  /** Remove a rep's goal override so the team-share fallback applies again. */
  deleteRepGoal(repId: string, weekStart: string): Promise<void>;
  /** Per-month booking goals (Monthly Booking Goal, owner-approved 2026-09-29) — months never inherit each other. */
  upsertMonthlyGoal(row: MonthlyGoalRow): Promise<void>;
  getMonthlyGoal(month: string): Promise<MonthlyGoalRow | null>;
  deleteMonthlyGoal(month: string): Promise<void>;
  /** Editable CC Report narrative per report week (week_start Monday key). */
  getWeeklyReportNotes(weekStart: string): Promise<WeeklyReportNotesRow | null>;
  upsertWeeklyReportNotes(row: WeeklyReportNotesRow): Promise<void>;

  // core entities
  upsertUsers(rows: UserRow[]): Promise<number>;
  /** Set/clear one rep's activation date (Settings editor; ET YYYY-MM-DD or null). */
  setUserCallStartDate(repId: string, date: string | null): Promise<void>;
  /** Active-roster users only (every page/rep surface reads this). */
  getUsers(): Promise<UserRow[]>;
  /**
   * ALL users including inactive ones (roster-excluded reps keep their rows).
   * Used by the sync for rep-ID linkage so excluded users' calls/contacts keep
   * their references — never by page surfaces.
   */
  getAllUsers(): Promise<UserRow[]>;
  upsertContacts(rows: ContactRow[]): Promise<number>;
  getContacts(): Promise<ContactRow[]>;
  /**
   * S4: cheap population count for ONE provider — the every-tick contacts
   * reconciliation tripwire (meta.total vs stored count) without any
   * materialization.
   */
  countContacts(provider: string): Promise<number>;
  /**
   * S4: light (id, external_id) pairs for ONE provider's contacts — the
   * per-tick replacement for the FULL getContacts() materialization (18
   * columns × ~116k rows every tick only ever fed the external-id→id linkage
   * map and the contacts walk's known-id set). `only` filters to specific
   * external ids (targeted linkage lookup for rows just upserted this tick).
   */
  getContactExternalIds(provider: string, only?: string[]): Promise<ContactExternalIdRow[]>;
  /** PERF: identity slice of every contact (see ContactIdentityRow) — page-path replacement for the full getContacts() read. */
  getContactIdentityRows(): Promise<ContactIdentityRow[]>;
  /**
   * Call upsert (keyed by provider + external_call_id — duplicates never
   * duplicate rows). provider_rep_external_id preserves the RAW HighLevel
   * userId even when it does not map to the active roster (rep_id NULL) — the
   * unattributed call is KEPT, never silently discarded. conversation_id links
   * the call message back to its HL conversation (audit endpoint).
   */
  upsertCalls(rows: (CallRow & { external_call_id: string; provider: string; provider_rep_external_id?: string | null; conversation_id?: string | null })[]): Promise<number>;
  getCallsBetween(startUtc: string, endUtc: string): Promise<CallRow[]>;
  getAllCallsSince(startUtc: string): Promise<CallRow[]>;
  /**
   * Raw records behind the call metrics (audit endpoint): rep/contact joined.
   * repSpec: null|"all" = every call, "non-roster" = calls whose rep resolves
   * to a KNOWN user that is not on the active roster, "unattributed" = calls
   * with rep NULL (no determinable owner). "unassigned" is kept as a legacy
   * alias for the UNION of both buckets (the exact complement of
   * keepRosterRepCalls' kept set, so counts reconcile with the roster math by
   * construction). A user id string filters to that user (roster or not —
   * read-only audit). thresholdSeconds drives over_threshold (live settings
   * value, metrics rule).
   */
  getAuditCalls(startUtc: string, endUtc: string, repSpec: string | null, thresholdSeconds: number): Promise<AuditCallRow[]>;
  upsertOpportunities(rows: OpportunityRow[]): Promise<number>;
  getOpportunities(): Promise<OpportunityRow[]>;
  /** Opportunities on specific GHL pipelines (Alliance/Auction lead counts). */
  getOpportunitiesByPipelines(pipelineIds: string[]): Promise<OpportunityRow[]>;
  /**
   * Remove rows the demo generator seeded for the HighLevel provider
   * (external ids prefixed "demo-"), FK-safe: nulls attribution call links
   * and contact/rep references before deleting calls → contacts → users.
   * Called after a successful LIVE HighLevel sync so real provider data
   * replaces demo content (idempotent; no-op when no demo rows remain).
   */
  deleteDemoHighLevelRows(): Promise<{ users: number; contacts: number; calls: number }>;
  /**
   * Remove rows the demo generator seeded for the ACUITY provider (appointment
   * ids prefixed "demo-", blocked times with provider="acuity" and demo
   * external ids). Called after a successful LIVE Acuity sync so demo slots
   * never mix with live availability (owner spec: no demo/live mixing).
   * Manual blocks (provider="manual") and recurring blocks (settings) are
   * untouched. Idempotent; no-op when no demo rows remain.
   */
  deleteDemoAcuityRows(): Promise<{ appointments: number; blocked: number }>;
  upsertAppointments(
    rows: (AppointmentRow & {
      acuity_appointment_id: string;
      client_name?: string | null;
      client_phone?: string | null;
      client_email?: string | null;
      /** S7c: ET business date of the authoritative creation instant. */
      created_business_date?: string | null;
      created_time_source?: string | null;
      created_time_precision?: string | null;
      /** S7c: FULL provider object (appointments.raw). */
      raw?: Record<string, unknown> | null;
      /** BOOKING WIN payment model (rev 12; derived by the sync via payments.ts). */
      payment_state?: string | null;
      /** ET business date the deposit was received — win bucket. Write-once: an existing non-null value is never overwritten. */
      booking_win_business_date?: string | null;
      payment_business_date_source?: string | null;
      first_seen_paid_at?: string | null;
    })[],
  ): Promise<number>;
  /**
   * S7c: appointments CREATED on an ET BUSINESS DATE in [start, end] — the
   * created-based metrics bucket reads created_business_date (booking-MADE ET
   * calendar date), inclusive both ends. Replaces the old instant-bounds
   * created_at window that mis-bucketed date-only bookings one ET day early.
   */
  getAppointmentsCreatedBusinessDateBetween(start: string, end: string): Promise<AppointmentRow[]>;
  /**
   * BOOKING WIN metrics bucket (rev 12): the SUPERSET the win-date bucketing
   * needs — appointments whose booking_win_business_date falls in [start, end]
   * (a win counts on the date the deposit was received, regardless of when it
   * was created), UNION appointments with NO persisted win date whose
   * created_business_date falls in [start, end] (not-yet-derived and legacy
   * rows; the metrics layer filters those to wins by the same fallback rules).
   * Callers feed the result through the metrics layer's win filters — unpaid
   * rows in the result never count.
   */
  getAppointmentsByWinBusinessDateBetween(start: string, end: string): Promise<AppointmentRow[]>;
  getAppointmentsOverlapping(startUtc: string, endUtc: string): Promise<AppointmentRow[]>;
  getAllAppointmentsSince(startUtc: string): Promise<AppointmentRow[]>;
  /** Appointments with client contact fields joined (unattributed-bookings queue).
   *  excludePendingDismissed (owner request 2026-09-30): drops owner-dismissed
   *  pending payments (pending_dismissed_at non-null) — ONLY the Today page's
   *  pending list passes it; the attribution tick + unattributed queue use the
   *  default so dismissed appointments stay in the engine. */
  getAppointmentsWithClientsSince(startUtc: string, opts?: { excludePendingDismissed?: boolean }): Promise<(AppointmentRow & {
    acuity_appointment_id: string | null;
    client_name: string | null;
    client_phone: string | null;
    client_email: string | null;
    calendar_name: string | null;
  })[]>;
  /**
   * PENDING PAYMENT DISMISSAL (owner request 2026-09-30): mark ONE appointment's
   * pending payment as dismissed by the owner. Sets pending_dismissed_at
   * (keep-first, idempotent); the appointment row itself is NEVER deleted —
   * Acuity is the source of truth and the sync would re-create it. Affects
   * ONLY the pending list: a later-paid appointment still counts as a Booking
   * Win everywhere (paid wins are never dismissible — callers guard).
   */
  dismissPendingPayment(appointmentId: string): Promise<void>;

  // attributions
  /**
   * Replace-attribution upsert (the ONE engine persist path). WRITER
   * PROTECTION (owner directive 2026-09-27): the write runs under a PG
   * advisory lock (one writer at a time; no-op in the memory store) and the
   * DEGRADATION GUARD — a write that would strip attribution from a large
   * share of the currently-attributed rows it touches (the 49→3 stale-writer
   * shape) throws and the table is left untouched. `force` bypasses the
   * degradation guard for a deliberate recovery recompute (manual_override
   * rows are still skipped, always).
   */
  upsertAttributions(rows: AttributionRow[], opts?: { force?: boolean }): Promise<number>;
  getAttributions(): Promise<AttributionRow[]>;
  /** Manual assignment from the overrides UI — force-writes method="manual", manual_override=true. */
  setManualAttribution(row: AttributionRow): Promise<void>;
  /**
   * Remove ONE appointment's attribution row entirely (manual UNASSIGN). The
   * row is computed data — deleting it returns the appointment to the engine's
   * control, and the next attribution tick recomputes it from raw rows.
   */
  deleteAttribution(appointmentId: string): Promise<void>;

  // leads
  upsertLeads(
    rows: (LeadRow & { source_id: string; provider: string; name?: string | null; phone?: string | null; email?: string | null })[],
  ): Promise<number>;
  /**
   * Remove every stored lead for one source sheet (provider google_sheets,
   * e.g. "family"). NOT used by the Sheets sync anymore — the sync is
   * upsert-only under content keys (v2) and never mass-deletes stored leads
   * a fetch didn't include. Kept as an explicit store primitive for tests and
   * deliberate repairs. Manual lead-count adjustments live in their own table
   * and are unaffected.
   */
  deleteLeadsForSheet(sourceSheet: string): Promise<void>;
  /**
   * All stored leads of one provider with their FULL identity columns
   * (source_id, name, phone, email) — the re-key migration and the sheets
   * sync's drift guard read these. Heavier than getLeadsByWorkDates; not for
   * per-request page paths.
   */
  getLeadsByProvider(provider: string): Promise<(LeadRow & { source_id: string; provider: string; name: string | null; phone: string | null; email: string | null })[]>;
  /** Delete stored leads by exact provider + source_id (re-key migration, demo purge). Returns rows deleted. */
  deleteLeadsBySourceIds(provider: string, sourceIds: string[]): Promise<number>;
  getLeadsByWorkDates(dates: string[]): Promise<LeadRow[]>;
  /**
   * Read-only counterpart of getLeadsByWorkDates keyed on SOURCE_DATE (the
   * date the lead entered the sheet). The Weekly Report's lead section and
   * assigned-lead conversion denominator are source-dated (owner directive
   * 2026-09-29) — work_date deliberately does NOT biject with source_date
   * across a week boundary (Fri/Sat/Sun sources work the NEXT Monday), so a
   * work-date fetch cannot substitute. Presentation reads only; never written.
   */
  getLeadsBySourceDates(dates: string[]): Promise<LeadRow[]>;
  /**
   * Cheap count of a provider's stored leads (no row materialization). Used by
   * the Sheets sync's demo-seed guard: demo rows may only ever seed a dataset
   * with NO stored google_sheets leads — live data is never demo-replaced.
   */
  countLeads(provider: string): Promise<number>;
  /** Manual work-date correction (overrides UI); caller writes the audit row. */
  updateLeadWorkDate(id: string, workDate: string): Promise<void>;

  // lead count adjustments (manual corrections; applied inside the metrics layer)
  upsertLeadCountAdjustment(row: Omit<LeadCountAdjustmentRow, "updated_at">): Promise<void>;
  getLeadCountAdjustments(dates: string[]): Promise<LeadCountAdjustmentRow[]>;

  // availability
  /** Mirror refresh (REPLACE semantics): the list is the COMPLETE rule set; multi-block per weekday supported. */
  upsertAvailabilityRules(rows: AvailabilityRule[]): Promise<void>;
  getAvailabilityRules(): Promise<AvailabilityRule[]>;
  upsertBlockedTimes(rows: (BlockedTimeRow & { provider: string; external_id: string })[]): Promise<number>;
  getBlockedTimesBetween(startUtc: string, endUtc: string): Promise<BlockedTimeRow[]>;
  /** Manual one-off block (overrides UI); provider="manual", external_id generated. */
  insertBlockedTime(row: { start_at: string; end_at: string; reason: string | null }): Promise<BlockedTimeRow>;
  deleteBlockedTime(id: string): Promise<void>;

  // daily priorities
  upsertDailyPriorities(row: DailyPrioritiesRow): Promise<void>;
  getDailyPriorities(date: string): Promise<DailyPrioritiesRow | null>;

  // integrations + sync
  upsertConnection(row: ConnectionRow): Promise<void>;
  getConnections(): Promise<ConnectionRow[]>;
  insertSyncRun(provider: string): Promise<string>;
  finishSyncRun(id: string, status: string, recordsUpserted: number, error: string | null): Promise<void>;
  getSyncRuns(limit: number): Promise<SyncRunRow[]>;
  /**
   * EVERY in-flight sync_runs row (status=running, finished_at null) of any
   * age, oldest first — the stale-run reaper's full scan. NOT bounded by
   * getSyncRuns' recent-N window: at the ~90s sync cadence the 200 most
   * recent runs span only a few hours, which is exactly how zombies older
   * than that survived the reaper (the 2026-09-27 HighLevel row: 37h).
   */
  getRunningSyncRuns(): Promise<SyncRunRow[]>;
  /**
   * The in-flight sync_runs row for a provider (status=running, finished_at
   * null), or null. Guards background/manual sync overlap.
   * FRESHNESS BOUND (owner directive 2026-09-28): a running row older than
   * STALE_RUN_REAP_MINUTES is a hung process — reported as NOT running so a
   * zombie can never wedge the header's "Syncing…" indicator or the tick
   * guards; the reaper marks it failed on the next tick. An unparsable
   * started_at is treated as stale (null), never a crash.
   */
  getRunningSyncRun(provider: string): Promise<SyncRunRow | null>;
  /** Incremental HighLevel sync watermark (ISO timestamp: everything before it is already stored), or null when never synced. */
  getSyncWatermark(provider: string): Promise<string | null>;
  setSyncWatermark(provider: string, watermarkIso: string): Promise<void>;
  /** Generic named checkpoint KV (jsonb value) — used by resumable backfill jobs (e.g. the HL contacts backfill cursor). */
  getSyncCheckpoint(key: string): Promise<string | null>;
  setSyncCheckpoint(key: string, value: string): Promise<void>;

  // call harvest (resumable; see src/server/sync/call-harvest.ts)
  /** One progress row per listing pass (id e.g. 'highlevel-calls-calllast' or 'highlevel-calls-all'). */
  getHarvestProgress(id?: string): Promise<HarvestProgressRow | null>;
  saveHarvestProgress(p: HarvestProgressRow): Promise<void>;
  upsertHarvestConversations(rows: HarvestConvRow[]): Promise<number>;
  /** Conversation ledger rows for the given HL conversation ids (parent-contact resolution). */
  getHarvestConversationsByIds(convIds: string[]): Promise<HarvestConvRow[]>;
  /** Upsert call-message ledger rows (harvest_calls mirror; the backfill's direct tier). */
  upsertHarvestCalls(rows: HarvestCallRow[]): Promise<number>;
  /** Call-message ledger rows for the given HL message ids (direct-contact resolution). */
  getHarvestCallsByMessageIds(messageIds: string[]): Promise<HarvestCallRow[]>;
  /** Harvest ledger rows started at/after startUtc (s1 window-interaction evidence read). */
  getHarvestCallsSince(startUtc: string): Promise<HarvestCallRow[]>;
  /**
   * Call→contact restoration verdicts, FILL-NULL-ONLY: an existing non-null
   * calls.contact_id is never touched (direct source data always wins); only
   * NULL contact_ids are filled, and the resolution method/timestamp are
   * recorded on the same row (ambiguous/unresolved keep contact_id NULL).
   */
  applyCallContactBackfill(rows: CallContactBackfillUpdate[]): Promise<void>;
  /** Unvisited conversations with lastMessageDate >= windowStartMs, newest first; call-flagged first when requested. */
  getUnvisitedInWindow(windowStartMs: number, limit: number, callFlaggedFirst: boolean): Promise<HarvestConvRow[]>;
  markHarvestVisited(convIds: string[], callsFoundByConv: Record<string, number>, messagesScannedByConv?: Record<string, number>): Promise<void>;
  /** Aggregated harvest coverage over the window, per ET calendar day of lastMessageDate. */
  getHarvestCoverageSummary(windowStartMs: number): Promise<{
    total: number;
    visited: number;
    callFlagged: number;
    byDay: { day: string; total: number; visited: number }[];
  }>;

  // manual overrides
  insertManualOverride(row: Omit<ManualOverrideRow, "id" | "changed_at">): Promise<void>;
  getManualOverrides(limit: number): Promise<ManualOverrideRow[]>;

  // ---- Performance Management (PIP module, Phase 1 — owner directive 9/30) ----
  // STATUS GUARDS (enforced INSIDE both stores — the UI can never bypass):
  //   draft     → fully editable (document fields only)
  //   issued    → document FROZEN (snapshot written once at issue); check-ins only
  //   completed → fully immutable
  //   cancelled → fully immutable
  // Transitions happen ONLY via these explicit manager actions — nothing
  // auto-transitions, ever.
  /** Create a PIP draft (status born 'draft'; requires rep_id + title). Audit: pip_created. */
  createPip(input: PipCreateInput): Promise<PipRow>;
  /** Edit a DRAFT's document fields. Rejects on any non-draft status. Audit: pip_edited (+ pip_observation_changed). */
  updatePipDraft(id: string, patch: PipDraftPatch): Promise<PipRow>;
  getPip(id: string): Promise<PipRow | null>;
  /** All PIPs (newest first), or only one status when given. */
  listPips(status?: PipStatus | null): Promise<PipRow[]>;
  /**
   * draft → issued. Requires goal_text + pip_start_date + pip_end_date.
   * Writes the version-1 frozen-evidence snapshot (pip_evidence_snapshots)
   * transactionally with the status flip. Audit: pip_issued.
   */
  issuePip(id: string, opts: { issuedBy: string }): Promise<PipRow>;
  /** issued → completed. Requires conclusion_category + conclusion_notes. Audit: pip_completed. */
  completePip(id: string, opts: { conclusionCategory: string; conclusionNotes: string; actor: string }): Promise<PipRow>;
  /** issued → cancelled. Requires a cancellation reason. Audit: pip_cancelled. */
  cancelPip(id: string, opts: { cancelledBy: string; reason: string }): Promise<PipRow>;
  /** Log a check-in (ISSUED pips only — drafts have no review period yet; terminal states are frozen). Audit: pip_checkin_added. */
  addPipCheckin(row: Omit<PipCheckinRow, "id" | "created_at">): Promise<PipCheckinRow>;
  /** Check-ins of one PIP, oldest first (append-only history). */
  getPipCheckins(pipId: string): Promise<PipCheckinRow[]>;
  /** Frozen-evidence snapshots of one PIP, version ascending. Write-once rows — never updated. */
  getPipEvidenceSnapshots(pipId: string): Promise<PipEvidenceSnapshotRow[]>;
  createPipTemplate(input: PipTemplateCreateInput): Promise<PipTemplateRow>;
  updatePipTemplate(id: string, patch: PipTemplatePatch): Promise<PipTemplateRow>;
  deletePipTemplate(id: string): Promise<void>;
  getPipTemplate(id: string): Promise<PipTemplateRow | null>;
  listPipTemplates(): Promise<PipTemplateRow[]>;
  /** Append a typed module event (also mirrored compactly into manual_overrides by callers' store methods). */
  insertPipEvent(row: Omit<PipEventRow, "id" | "created_at">): Promise<void>;
  /** Module event log, newest first; optionally scoped to one PIP. */
  getPipEvents(opts?: { pipId?: string; limit?: number }): Promise<PipEventRow[]>;
}
