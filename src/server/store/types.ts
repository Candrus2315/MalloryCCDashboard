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
    slot_interval_min: 90,
    padding_min: 15,
    recurring_blocks: [],
    hours: [
      { weekday: 1, open_time: "10:00", close_time: "18:00", active: true },
      { weekday: 2, open_time: "10:00", close_time: "18:00", active: true },
      { weekday: 3, open_time: "10:00", close_time: "18:00", active: true },
      { weekday: 4, open_time: "10:00", close_time: "18:00", active: true },
      { weekday: 5, open_time: "10:00", close_time: "18:00", active: true },
      { weekday: 6, open_time: "10:00", close_time: "16:00", active: true },
      { weekday: 0, open_time: "10:00", close_time: "16:00", active: false },
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
    })[],
  ): Promise<number>;
  getAppointmentsCreatedBetween(startUtc: string, endUtc: string): Promise<AppointmentRow[]>;
  getAppointmentsOverlapping(startUtc: string, endUtc: string): Promise<AppointmentRow[]>;
  getAllAppointmentsSince(startUtc: string): Promise<AppointmentRow[]>;
  /** Appointments with client contact fields joined (unattributed-bookings queue). */
  getAppointmentsWithClientsSince(startUtc: string): Promise<(AppointmentRow & {
    acuity_appointment_id: string | null;
    client_name: string | null;
    client_phone: string | null;
    client_email: string | null;
    calendar_name: string | null;
  })[]>;

  // attributions
  upsertAttributions(rows: AttributionRow[]): Promise<number>;
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
   * e.g. "family"). Used by the Sheets sync as a per-sheet REPLACE so
   * row-per-day counts replace (not add to) the previous sync, and removed
   * sheet rows disappear instead of lingering. Manual lead-count adjustments
   * live in their own table and are unaffected.
   */
  deleteLeadsForSheet(sourceSheet: string): Promise<void>;
  getLeadsByWorkDates(dates: string[]): Promise<LeadRow[]>;
  /** Manual work-date correction (overrides UI); caller writes the audit row. */
  updateLeadWorkDate(id: string, workDate: string): Promise<void>;

  // lead count adjustments (manual corrections; applied inside the metrics layer)
  upsertLeadCountAdjustment(row: Omit<LeadCountAdjustmentRow, "updated_at">): Promise<void>;
  getLeadCountAdjustments(dates: string[]): Promise<LeadCountAdjustmentRow[]>;

  // availability
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
  /** The in-flight sync_runs row for a provider (status=running, finished_at null), or null. Guards background/manual sync overlap. */
  getRunningSyncRun(provider: string): Promise<SyncRunRow | null>;
  /** Incremental HighLevel sync watermark (ISO timestamp: everything before it is already stored), or null when never synced. */
  getSyncWatermark(provider: string): Promise<string | null>;
  setSyncWatermark(provider: string, watermarkIso: string): Promise<void>;

  // call harvest (resumable; see src/server/sync/call-harvest.ts)
  /** One progress row per listing pass (id e.g. 'highlevel-calls-calllast' or 'highlevel-calls-all'). */
  getHarvestProgress(id?: string): Promise<HarvestProgressRow | null>;
  saveHarvestProgress(p: HarvestProgressRow): Promise<void>;
  upsertHarvestConversations(rows: HarvestConvRow[]): Promise<number>;
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
}
