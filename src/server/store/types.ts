/**
 * Data store abstraction: the app runs against Postgres (Tiger Cloud) when
 * DATABASE_URL works, and falls back to an in-memory demo dataset when it
 * doesn't — so the dashboard is always viewable and the Postgres path activates
 * automatically once the connection is fixed. Both stores implement the same
 * duplicate-safe upsert semantics (keyed by provider external IDs).
 */

import type {
import { LEAD_SOURCE_SHEETS } from "../../components/lead-sources";
  AppointmentRow,
  AttributionRow,
  AvailabilityRule,
  BlockedTimeRow,
  CallRow,
  LeadRow,
  RecurringBlock,
} from "../metrics/compute";
import type { IngestOptions, RunDeadline } from "./ingest-batch";

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
  // ---- COMMISSION TRACKER profile fields (owner directive 2026-10-01, spec §B) ----
  // Optional in construction (existing literals keep compiling); BOTH stores
  // always populate them on read (defaults null/false = ineligible).
  /** full_time | part_time — drives which §C/§D tier table applies. */
  employment_type?: import("../commission/engine").EmploymentType | null;
  /** 1–5; null = no tier assigned (never commission-eligible — e.g. Dan McKillop). */
  commission_tier?: number | null;
  /** The date the current tier took effect (ET). History uses the tier held that week (snapshot on the weekly record). */
  tier_effective_date?: string | null;
  /** When the tier ends (nullable) — a week qualifies for the tier only when [week_start, week_end] overlaps [effective, end]. */
  tier_end_date?: string | null;
  /** Master switch: false = never in the commission calc even with a tier. */
  commission_eligible?: boolean;
}

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
  employment_type: import("../commission/engine").EmploymentType;
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
 * TICK WATCHDOG CAP — THE ONE SHARED LIVENESS BOUND (2026-10-23, forensics
 * scratch/reliability-forensics.md §2). One scheduler tick may hold the loop
 * at most this long (30 min ≫ any real tick: the heaviest legit piece, a
 * manual bootstrap full-sync, is minutes; past the cap the watchdog RELEASES
 * the loop and the independent reaper closes the run's rows), so a bounded
 * provider's "running" sync_runs row OLDER than this cap cannot be a
 * legitimately live run. Every liveness consumer now derives from THIS single
 * constant — no drift possible:
 *   - store getRunningSyncRun nulls rows older than it (pg.ts + memory.ts);
 *   - sheets-tick's running guard re-checks against it directly;
 *   - STALE_RUN_REAP_MINUTES (below) re-derives the reaper's window from it;
 *   - sync/scheduler re-exports both for the tick watchdog + callers/tests.
 *
 * History: the 2026-09-28 owner directive ("a bounded provider's running row
 * stuck too long is a hang") was first encoded as THREE independent 15-minute
 * bounds (the store guard, a sheets-tick duplicate, the reaper window). Field
 * evidence killed that: a legitimate sheets run finished SUCCESS at 17m28s
 * (full REPLACE of 3,870 rows — scratch/fairyland-run17-out.txt) and two
 * real overlaps were captured — any 15-minute bound misclassifies live runs
 * as dead. 30 min is the tick ceiling itself, so nothing legitimately running
 * can be misclassified, while a genuinely hung row is still reaped within one
 * reaper cadence past the cap.
 *
 * Defined HERE (not in sync/scheduler) for the same no-cycle reason as the
 * reap window below: both stores need it in getRunningSyncRun without
 * importing the scheduler (which imports the store — a cycle).
 */
export const TICK_WATCHDOG_CAP_MS = 30 * 60_000;

/**
 * STALE-RUN REAP WINDOW (owner directive 2026-09-28): a bounded provider's
 * "running" sync_runs row stuck longer than this is a hung process, not a live
 * one. DELIBERATE ALIAS — derived from TICK_WATCHDOG_CAP_MS (the one shared
 * liveness bound above): the store guards null past it, the reaper reaps after
 * it, so the window and the guards can never drift apart. Kept as a public
 * minutes-valued constant because the reaper's honest error message and other
 * consumers (freshness watchdog, Settings running badge) speak in minutes.
 * Defined HERE (not in sync/scheduler) so both stores can use it in
 * getRunningSyncRun without importing the scheduler (which imports the store
 * — a cycle). sync/scheduler re-exports it for its callers/tests.
 */
export const STALE_RUN_REAP_MINUTES = TICK_WATCHDOG_CAP_MS / 60_000;

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
 * one non-empty email. Shared by BOTH roster lists — the ACTIVE roster
 * (normalizeRoster) and the HISTORICAL reps (normalizeHistoricalReps); they
 * differ only in the empty-input fallback.
 */
function sanitizeRosterEntries(raw: unknown): RosterEntry[] {
  const out: RosterEntry[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const r = (item ?? {}) as Partial<RosterEntry> & { email?: unknown };
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const rawEmails = Array.isArray(r.emails) ? r.emails : r.email != null ? [r.email] : [];
    const emails = rawEmails
      .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
      .map((e) => e.trim());
    if (name && emails.length) out.push({ name, emails });
  }
  return out;
}

/**
 * Sanitize a stored roster: keep entries with a non-empty name and at least
 * one non-empty email; fall back to the default five when nothing valid
 * remains (the dashboard never runs with an EMPTY roster — that would zero
 * every rep surface; edit entries instead of deleting them all).
 */
export function normalizeRoster(raw: unknown): RosterEntry[] {
  const fallback = (): RosterEntry[] => JSON.parse(JSON.stringify(DEFAULT_ACTIVE_ROSTER));
  const out = sanitizeRosterEntries(raw);
  return out.length > 0 ? out : fallback();
}

/**
 * HISTORICAL REPS (owner directive 2026-10-20): departed CC reps whose
 * HISTORICAL contribution stays on the reporting surfaces (Weekly + Reps)
 * while they remain OFF the active team. Same entry shape and match rule as
 * the active roster; the EMPTY list is valid (no departed reps preserved) and
 * behaves bit-identically to before the field existed — unlike the active
 * roster, an empty historical list never falls back to the default five.
 */
export function normalizeHistoricalReps(raw: unknown): RosterEntry[] {
  return sanitizeRosterEntries(raw);
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
   * OWNER DIRECTIVE 2026-10-20 ("add back whatever you took out — I think it
   * was Laura's bookings"): departed reps whose HISTORICAL contribution stays
   * on the REPORTING surfaces (Weekly page incl. By-Rep + per-day grid + CC
   * Report copy text; Reps page incl. per-rep history and team totals) while
   * they remain OFF the active team. Match rule is the active roster's
   * (name + email, case-insensitive — src/server/roster.ts). Empty list =
   * no departed reps preserved, bit-identical to before this field existed.
   * OPERATIONAL SURFACES (Today, Daily Report, lead assignment/cohort logic,
   * the sync's is_active write, the attribution engine's write path) stay
   * ACTIVE-ROSTER-ONLY — a historical entry never re-activates anyone.
   */
  historical_reps: RosterEntry[];
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
    /**
     * Third genre (owner directive 2026-10-22). The Fairyland sheet is NOT
     * configured until the owner saves a real sheet id in Settings — the
     * default below is an EMPTY id, and every consumer treats an empty id as
     * "not configured" (the sync skips it, counts read zero, corrections
     * don't apply). Never a guessed sheet id.
     */
    fairyland: SheetConfig;
    /**
     * FOUR FORM-WORKBOOK SOURCES (owner directive 2026-10-27): the "Forms
     * Data - Mallory Portraits" workbook connects through the EXISTING sheets
     * pipeline — one workbook, four tabs, each tab an INDEPENDENT lead source
     * with its own config, its own identity segment (gs2#{key}#…) and its own
     * per-source counts. Unlike Fairyland these ship CONFIGURED (the lead
     * verified the workbook is shared with the service account; the tab names
     * and column letters below are verified from the live Sheets API on
     * 10/27). Key name = leads.source_sheet = the identity-key sheet segment
     * (src/components/lead-sources.ts).
     */
    auction_register_certificate: SheetConfig;
    google_ads_leads: SheetConfig;
    alliance_activate_certificate: SheetConfig;
    website_applications: SheetConfig;
  };
  acuity: {
    calendars_included: string[];
    types_included: string[];
  };
  /**
   * UNATTRIBUTED QUEUE DECLUTTER (owner request 2026-10-21: "can i get a clear
   * all button for the Unattributed Bookings in settings or collapse all the
   * olds so all i see is the new one that come in? Most of those are way
   * before i started to work here."). `dismissedBefore` is the ISO instant the
   * "Clear old entries" action wrote: queue rows with created_at AT or BEFORE
   * it collapse behind a one-line banner on the Settings page (a client-local
   * Show-all reveals them; Undo resets the marker). DISPLAY-LAYER ONLY —
   * nothing is ever deleted, the queue payload and every KPI keep counting all
   * rows, and the write is audited like every manual action on the page.
   * Null/absent (the default) = no marker, the queue renders exactly as before.
   */
  unattributedQueue?: { dismissedBefore: string | null };
  /**
   * RETENTION MODULE business rules (owner spec: rules live in Settings, not
   * code). Stage 3a consumes due_days + qualifying_statuses + the compute
   * lookback; the full Settings surface is the next delegation — these keys
   * exist now so the compute job reads live values, with owner-ratified
   * defaults below when unset.
   */
  retention?: RetentionSettings;
}

/** Owner-ratified retention defaults (D1–D14 approved 2026-10-19; plan §12/§13). */
export interface RetentionSettings {
  /** contact_due_date = appointment ET date − due_days (calendar; default 7). */
  due_days: number;
  /** Appointment statuses that enter the contact funnel (default scheduled). */
  qualifying_statuses: string[];
  /** D13 backfill/compute scope in due-date days behind today (default 30 — the call-sync window). */
  compute_lookback_days: number;
  /** Initials → documenter map for SWC/LVM note lines (D4: owner-supplied; unmapped initials always flagged). */
  employee_initials: Record<string, string>;
  /** Filled when compute_lookback_days is unset. */
  max_attempts: number | null;
  max_attempt_days: number | null;
  max_contact_days: number | null;
  /** §11 reschedule/save window: days after a cancellation in which a rebooking counts as a recovery (plan §12; default 14). */
  reschedule_days: number;
  /**
   * RETENTION DISPLAY SCOPE — the data-start cutoff, stored as the ET
   * calendar date (YYYY-MM-DD) of the Monday that starts the FIRST IN-SCOPE
   * week. Owner-ratified default: the week containing Mon Oct 12 2026 ET
   * (directive 10/21 — "i dont need any data before the week of the 12th of
   * Oct for the retention tab"), which IS 2026-10-12 (Oct 12 2026 is a
   * Monday), so the default is byte-identical to the constant this setting
   * replaces. DISPLAY-LAYER ONLY: stored ret_* rows are never rewritten —
   * every consumer resolves this value from CURRENT settings at call time
   * (the sheets-adapter per-tick contract) and compares ET calendar dates.
   */
  data_start_week_start: string;
}
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

/**
 * The Monday (ET calendar date YYYY-MM-DD) of the week containing a date the
 * owner typed. Strict YYYY-MM-DD shape check first (Date.parse would also
 * accept "2026-10" or "Oct 12 2026"); the round-trip check rejects rollover
 * fabrications (2026-02-31 would parse as Mar 3). Null when unparsable — the
 * normalizer falls back to the default rather than guessing.
 */
export function weekStartOfDateOrUndefined(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  const dow = date.getUTCDay(); // 0 Sun … 6 Sat
  date.setUTCDate(date.getUTCDate() - ((dow + 6) % 7)); // step back to Monday
  return date.toISOString().slice(0, 10);
}

export function normalizeRetentionSettings(raw: unknown): RetentionSettings {
  const base = { ...DEFAULT_RETENTION_SETTINGS };
  const r = (raw ?? {}) as Partial<RetentionSettings>;
  const int = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const statuses = Array.isArray(r.qualifying_statuses) ? r.qualifying_statuses.filter((s): s is string => typeof s === "string" && s.length > 0) : base.qualifying_statuses;
  const initials: Record<string, string> = {};
  if (r.employee_initials && typeof r.employee_initials === "object") {
    for (const [k, v] of Object.entries(r.employee_initials as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) initials[k.toUpperCase().slice(0, 5)] = v;
    }
  }
  return {
    due_days: int(r.due_days, base.due_days, 0, 60),
    qualifying_statuses: statuses.length ? statuses : base.qualifying_statuses,
    compute_lookback_days: int(r.compute_lookback_days, base.compute_lookback_days, 1, 365),
    employee_initials: initials,
    max_attempts: typeof r.max_attempts === "number" && Number.isFinite(r.max_attempts) && r.max_attempts > 0 ? Math.round(r.max_attempts) : null,
    max_attempt_days: typeof r.max_attempt_days === "number" && Number.isFinite(r.max_attempt_days) && r.max_attempt_days > 0 ? Math.round(r.max_attempt_days) : null,
    max_contact_days: typeof r.max_contact_days === "number" && Number.isFinite(r.max_contact_days) && r.max_contact_days > 0 ? Math.round(r.max_contact_days) : null,
    reschedule_days: int(r.reschedule_days, base.reschedule_days, 1, 90),
    // DISPLAY SCOPE (retention Settings surface): a stored/typed date
    // normalizes to the Monday that starts ITS week ("the week containing
    // X"), so the owner can enter any date in the intended week. Unparsable
    // garbage falls back to the owner-ratified default — never a guessed date.
    data_start_week_start: weekStartOfDateOrUndefined(r.data_start_week_start) ?? base.data_start_week_start,
  };
}
/**
 * DEFENSIVE RETENTION MERGE — the ONE merge used by BOTH stores' saveSettings
 * (memory + pg), so their semantics cannot drift. A patch that carries
 * `retention` merges FIELD-WISE over the current group (a partial patch never
 * wipes the owner's other saved retention fields), and the result is
 * normalized (clamps + defaults) so an absent field always falls back to
 * DEFAULT_RETENTION_SETTINGS (existing deployments keep byte-identical
 * behavior). Returns every field THIS write actually CHANGED (old → new) so
 * the stores can audit each through insertManualOverride — exactly the
 * sheet-mode audit pattern.
 */
export function mergeRetentionSettings(
  current: RetentionSettings | undefined,
  patch: Partial<RetentionSettings> | undefined,
): {
  retention: RetentionSettings;
  changes: { field: keyof RetentionSettings; from: string; to: string }[];
} {
  const retention = normalizeRetentionSettings({ ...normalizeRetentionSettings(current), ...(patch ?? {}) });
  const before = normalizeRetentionSettings(current);
  const changes: { field: keyof RetentionSettings; from: string; to: string }[] = [];
  for (const key of Object.keys(retention) as (keyof RetentionSettings)[]) {
    const from = String(before[key]);
    const to = String(retention[key]);
    if (from !== to) changes.push({ field: key, from, to });
  }
  return { retention, changes };
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
  /**
   * OPTIONAL worksheet tab to fetch (owner directive 2026-10-22, Fairyland
   * wiring): when set, the sync targets THIS tab by name; absent/empty = the
   * spreadsheet's FIRST tab (long-standing Family/Animalia behavior,
   * byte-identical). Only sheets whose target tab is not first need this.
   */
  tab_name?: string;
}

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

export function isSheetMappingModeValue(v: unknown): v is SheetMappingMode {
  return v === "row_per_day_count" || v === "row_per_lead";
}

/**
 * Merge a `sheets` settings patch over the current group — the ONE merge used
 * by BOTH stores' saveSettings (memory + pg), so their semantics cannot drift.
 *
 * MODE-PERSISTENCE HARDENING (owner directive 2026-10-07, after the 10/3
 * silent flip): the pre-hardening merge (`{ ...current.sheets, ...patch.sheets }`)
 * replaced a whole sheet config whenever a patch carried one, so a partial or
 * default-application write that omitted `mode` — or re-applied DEFAULT
 * modes — silently dropped the owner's saved mode, and normalizeSheetConfig
 * then re-derived `row_per_day_count` from the count column on read. Now:
 *  - mode is honored from a patch ONLY for owner-labeled writes
 *    (allowModeChange, see SETTINGS_OWNER_ACTOR): any system/unlabeled
 *    writer — a default-application path included — can never change a
 *    saved mode, so a silent flip is structurally impossible;
 *  - a patch that does not carry a VALID mode preserves the saved mode
 *    (defaults apply only when unset — never over an explicitly saved value);
 *  - every mode the merge DOES change is returned so the store can audit it
 *    via insertManualOverride (entity_type "sheet_mapping", field "mode",
 *    old → new, actor label) — visible on the Audit page.
 */
export const SETTINGS_OWNER_ACTOR = "christopher";

export function mergeSheetsSettings(
  current: AppSettings["sheets"],
  patch: Partial<AppSettings["sheets"]> | undefined,
  allowModeChange: boolean,
): {
  sheets: AppSettings["sheets"];
  modeChanges: { sheet: keyof AppSettings["sheets"]; from: SheetMappingMode; to: SheetMappingMode }[];
} {
  const sheets = { ...current };
  const modeChanges: { sheet: keyof AppSettings["sheets"]; from: SheetMappingMode; to: SheetMappingMode }[] = [];
  if (patch) {
    for (const key of LEAD_SOURCE_SHEETS) {
      const p = patch[key];
      if (!p) continue;
      // Normalize the saved config first so a legacy stored shape (mode
      // missing on very old rows) still yields a valid mode to preserve.
      const saved = normalizeSheetConfig(sheets[key] ?? {}, DEFAULT_SHEET_IDS[key]);
      // Preserve the saved mode unless this write may change it AND the patch
      // explicitly carries a valid one (runtime-validated — the server-fn
      // validator does not check the string).
      const mode = allowModeChange && isSheetMappingModeValue(p.mode) ? p.mode : saved.mode;
      sheets[key] = { ...saved, ...p, mode };
      if (mode !== saved.mode) modeChanges.push({ sheet: key, from: saved.mode, to: mode });
    }
  }
  return { sheets, modeChanges };
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
  // Optional target tab: preserved ONLY as a non-empty string — an empty or
  // non-string value normalizes away (absent = first tab, as today). Existing
  // Family/Animalia rows carry no tab_name and read back byte-identical.
  const tabName = typeof r.tab_name === "string" && r.tab_name.trim() ? r.tab_name.trim() : undefined;
  return {
    sheet_id: typeof r.sheet_id === "string" && r.sheet_id ? r.sheet_id : fallbackId,
    mode,
    columns,
    ...(tabName ? { tab_name: tabName } : {}),
  };
}

/**
 * Unattributed-queue declutter marker (owner request 2026-10-21). Fail-honest
 * normalization: only a parsable ISO instant survives — a garbage/absent value
 * reads as NO marker, so a corrupted key can never hide the whole queue.
 */
export function normalizeUnattributedQueueSettings(raw: unknown): { dismissedBefore: string | null } {
  const dismissed = (raw as { dismissedBefore?: unknown } | null | undefined)?.dismissedBefore;
  return typeof dismissed === "string" && Number.isFinite(Date.parse(dismissed))
    ? { dismissedBefore: dismissed }
    : { dismissedBefore: null };
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
    historical_reps: normalizeHistoricalReps(r.historical_reps ?? base.historical_reps),
    rep_mappings: normalizeRepMappings(r.rep_mappings ?? base.rep_mappings),
    studio: { ...base.studio, ...(r.studio ?? {}) },
    sheets: {
      family: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.family ?? base.sheets.family, DEFAULT_SHEET_IDS.family),
      animalia: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.animalia ?? base.sheets.animalia, DEFAULT_SHEET_IDS.animalia),
      // Third genre: absent on settings saved before 2026-10-22 → the default
      // (sheet_id "") applies — "not configured", never a guessed sheet id.
      fairyland: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.fairyland ?? base.sheets.fairyland, DEFAULT_SHEET_IDS.fairyland),
      // Form-workbook sources (owner directive 2026-10-27): absent on settings
      // saved before 10/27 → the verified defaults apply (configured tabs of
      // the Forms workbook). The owner can re-point or blank any of them in
      // Settings exactly like the genre sheets.
      auction_register_certificate: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.auction_register_certificate ?? base.sheets.auction_register_certificate, DEFAULT_SHEET_IDS.auction_register_certificate),
      google_ads_leads: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.google_ads_leads ?? base.sheets.google_ads_leads, DEFAULT_SHEET_IDS.google_ads_leads),
      alliance_activate_certificate: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.alliance_activate_certificate ?? base.sheets.alliance_activate_certificate, DEFAULT_SHEET_IDS.alliance_activate_certificate),
      website_applications: normalizeSheetConfig((r.sheets as Record<string, unknown> | undefined)?.website_applications ?? base.sheets.website_applications, DEFAULT_SHEET_IDS.website_applications),
    },
    acuity: { ...base.acuity, ...(r.acuity ?? {}) },
    unattributedQueue: normalizeUnattributedQueueSettings(r.unattributedQueue ?? base.unattributedQueue),
    retention: normalizeRetentionSettings(r.retention ?? base.retention),
  };
  return merged;
}

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
  /** Template this draft was created from (provenance; frozen into the issue snapshot). */
  template_id: string | null;
  /** The template's version at creation — issued PIPs keep this even after the template moves on. */
  template_version: number | null;
  /** Manager-entered check-in cadence in days (Phase 3 schedules use it; frozen at issue). */
  checkin_cadence_days: number | null;
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
  /** When set, the draft records this template as its origin; defaults are applied by the caller. */
  template_id?: string | null;
  /** The template version applied (resolved by the caller at creation). */
  template_version?: number | null;
  /** Manager-entered check-in cadence in days. */
  checkin_cadence_days?: number | null;
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
  checkin_cadence_days?: number | null;
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
  /** Bumped by EVERY update — issued PIPs keep the version they were issued with (frozen in their snapshots). */
  version: number;
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
  | "pip_ack_recorded"
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

// ========================================================================
// COMMISSION TRACKER (owner directive 2026-10-01, spec §F/§S/§O/§N)
// ------------------------------------------------------------------------
// Phase A foundation: weekly records, cycles, adjustments. The calculation
// engine is PURE (src/server/commission/engine.ts); these are the PERSISTED
// shapes. Weekly records are write-once per (user, week) at the Sunday cutoff
// (close job) or the deliberate historical backfill; submitted payroll locks
// forever (Phase C enforcement builds on the status fields here).
// ========================================================================

/** Money columns are dollars with 2-decimal (cents) precision. */
export type CommissionWeeklyStatus = "final" | "superseded";

/**
 * Phase C upsert result: the store-level SUBMITTED-CYCLE LOCK (spec §O/§19)
 * silently no-ops any rewrite of a locked weekly record and records the block
 * in the audit trail, so callers (close tick, backfill) can report honestly.
 * `written` false + `blocked` true = the stored record was frozen, never
 * touched.
 */
export interface CommissionUpsertResult {
  written: boolean;
  blocked: boolean;
}

/** §O: a weekly record belongs to exactly ONE submitted cycle — never double-counted. */
export type CommissionAssignment = "unassigned" | "current_cycle" | "previously_submitted";

/** §N approval workflow (cycle-level). */
export type CommissionCycleStatus = "in_progress" | "ready_for_review" | "approved" | "submitted";

/** One counted booking snapshot inside a weekly record (§10 audit — the actual records that produced the total). */
export interface CountedBookingSnapshot {
  /** Internal appointment id. */
  id: string;
  /** Provider id when known (click-out/audit). */
  acuity_appointment_id?: string | null;
  client_name?: string | null;
  appointment_type?: string | null;
  /** booking_win_business_date (ET) — the date the deposit was received. */
  win_date: string;
  /** True when the attribution was a manual owner assignment. */
  manual: boolean;
}

/**
 * RULING 3 per-bonus hole audit row (owner 10/1, REQUIRED): rep · appointment
 * date/time · slot previously open (day + block/position) · the filling
 * booking · the qualifying Booking Win · $10 · the week credited. Persisted
 * ON the weekly record (hole_audit jsonb) so the money is auditable forever.
 */
export interface HoleAuditSnapshot {
  userId: string;
  /** The filling booking = the qualifying Booking Win (internal appointment id). */
  appointmentId: string;
  acuity_appointment_id?: string | null;
  client_name?: string | null;
  appointment_type?: string | null;
  /** ET date of the session (== slot date). */
  appointment_date_et: string;
  /** ET clock time of the session (== slot position, e.g. "08:00"). */
  appointment_time_et: string;
  /** The previously-open slot's derived position. */
  slot_date: string;
  slot_time: string;
  slot_block: "morning" | "afternoon";
  /** booking_win_business_date (ET) of the qualifying win. */
  win_date: string;
  bonus_cents: number;
  /** The week credited (Monday, ET). */
  week_start: string;
}

/** §F WEEKLY RECORD — auto-created at the Sunday cutoff (or the deliberate historical backfill). */
export interface CommissionWeeklyRow {
  id: string;
  user_id: string;
  /** Name snapshot (records must stay readable even if a user row later changes/disappears). */
  rep_name: string;
  /** Monday (ET) — the upsert key with user_id. */
  week_start: string;
  /** Sunday (ET). */
  week_end: string;
  employment_type: import("../commission/engine").EmploymentType;
  tier: number;
  /** The tier_effective_date USED that week (§F "Tier Effective Date Used"). */
  tier_effective_date_used: string | null;
  qualifying_bookings: number;
  base_commission: number; // dollars
  additional_commission: number; // dollars (over-threshold portion; 0 on flat tiers)
  pool_bonus: number; // dollars
  hole_bonus: number; // dollars
  manual_adjustment: number; // dollars (0 on the auto calc; corrections modify, Phase C)
  total: number; // dollars = base + additional + pool + hole + manual_adjustment
  calc_date: string; // ISO
  calc_version: number;
  status: CommissionWeeklyStatus;
  cycle_id: string | null;
  assignment: CommissionAssignment;
  counted_bookings: CountedBookingSnapshot[];
  /** RULING 3 per-bonus audit (one row per $10 filled hole; bonus_cents zeroed when capped). */
  hole_audit: HoleAuditSnapshot[];
  /**
   * RULING 5 (owner directive 10/2): true when the week began with more than 8
   * slots open — hole_bonus is $0 for every rep that week regardless of fills;
   * hole_audit rows are retained (zeroed) so the drawer can still show what
   * WAS filled. UI wording: "week had >8 open slots — hole bonus not paid
   * (owner ruling 10/2)".
   */
  hole_bonus_capped: boolean;
}

/** Commission profile fields the Settings editor sets (store-level upsert). */
export interface CommissionProfileInput {
  employment_type: import("../commission/engine").EmploymentType;
  commission_tier: number;
  tier_effective_date: string | null;
  tier_end_date: string | null;
  commission_eligible: boolean;
}

/** §S cycle composition — stored and preserved forever (never derived). */
export interface CommissionCycleRow {
  /** Stable slug id (deterministic for the historical backfill, e.g. "cycle-2026-08-31-2026-09-27"). */
  id: string;
  /** Human label, e.g. "Aug 31 – Sep 27, 2026". */
  label: string;
  start_date: string; // first included week's Monday
  end_date: string; // last included week's Sunday
  submission_date: string; // the first-Monday deadline
  payroll_date: string;
  status: CommissionCycleStatus;
  submitted_date: string | null;
  submitted_by: string | null;
  /** Final snapshot frozen at submission (final counts, totals, calc version). */
  final_snapshot: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** §O/§29 corrections audit — reason REQUIRED, who/what/old/new/when recorded. */
export interface CommissionAdjustmentInput {
  cycle_id: string | null;
  user_id: string | null;
  /** What kind of record was corrected: "weekly_record" | "cycle" | "booking". */
  target: string;
  target_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string; // REQUIRED (validated inside both stores)
  changed_by: string;
}

export interface CommissionAdjustmentRow extends CommissionAdjustmentInput {
  id: string;
  changed_at: string; // ISO
}

// ---- Availability feed cache (Acuity availability rebuild PR-1, 2026-10-06) ----
// Blueprint: design/availability-rebuild-investigation.md §3. Additive-only new
// tables; the appointments schema is untouched; live-only data (demo mode never
// writes or reads these — the demo dataset keeps the existing engine output).

/** One cached Acuity OPEN (bookable) slot for (calendar, ET date, ET time). */
export interface AvailabilitySlotRow {
  id: string;
  calendar_id: string;
  date_et: string; // YYYY-MM-DD (ET calendar date)
  time_et: string; // HH:mm ET (the feed's stated time is the ET clock)
  slots_available: number;
  /** "acuity" — the only writer today (the schema leaves room for "derived"). */
  source: string;
  first_seen_at: string;
  last_confirmed_at: string;
  run_id: string; // availability_sync_runs.id
}

/** Full-month date-index cache per (calendar × representative appointment type). */
export interface AvailabilityDatesRow {
  calendar_id: string;
  appointment_type_id: string;
  month: string; // "YYYY-MM"
  /** The dates within the month that still have bookable open slots ([] = none — the cached coverage horizon). */
  dates_et: string[];
  fetched_at: string;
  run_id: string; // availability_sync_runs.id
}

/** One availability-feed sync run (detailed mirror of the generic sync_runs row). */
export interface AvailabilitySyncRunRow {
  id: string;
  status: string; // running | success | error
  scope: Record<string, unknown>; // {months:[], dates:[], calendars:[], trigger, syncRunId}
  calls_made: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export type AvailabilityDiscrepancyKind =
  | "acuity-open-but-booked" // the feed offers a slot our booked-truth occupies (the 10-24 16:30 divergence)
  | "acuity-silent-but-open" // our booked-truth says free + grid slot, but the feed offers nothing
  | "off-grid-acuity-time"; // the feed offers a time outside the canonical grid

/** One detected feed-vs-truth mismatch (the owner's equation, executable). */
export interface AvailabilityDiscrepancyRow {
  id: string;
  run_id: string;
  calendar_id: string;
  date_et: string;
  time_et: string;
  kind: AvailabilityDiscrepancyKind;
  detail: Record<string, unknown>; // both sides: {acuity:'open'|'silent', booked:[ids], grid:'canonical', ...}
  detected_at: string;
  resolved_at: string | null; // cleared when a later run stops seeing it
}

export interface AvailabilitySlotInput {
  calendar_id: string;
  date_et: string;
  time_et: string;
  slots_available: number;
}

export interface AvailabilityDatesInput {
  calendar_id: string;
  appointment_type_id: string;
  month: string;
  dates_et: string[];
}

export interface AvailabilityDiscrepancyInput {
  calendar_id: string;
  date_et: string;
  time_et: string;
  kind: AvailabilityDiscrepancyKind;
  detail: Record<string, unknown>;
}

// ---- Availability catalog cache (availability rebuild PR-3, 2026-10-07) ----
// The /calendars + /appointment-types answers cached at each feed run so the
// page-level filters can enumerate REAL options (the type↔calendar binding
// comes from the API's calendarIDs — never guessed, §1.2: a mismatched pair
// answers 400 invalid_calendar). REPLACE-all per run: the fresh catalog is
// the truth; no history is kept (the runs table audits when it was fetched).

/** One cached Acuity calendar (/calendars). */
export interface AvailabilityCalendarRow {
  calendar_id: string;
  name: string;
  fetched_at: string;
  run_id: string;
}

/** One cached Acuity appointment type (/appointment-types) with its calendar binding. */
export interface AvailabilityTypeRow {
  appointment_type_id: string;
  name: string;
  /** The calendar ids this type is hard-bound to (the API's calendarIDs). */
  calendar_ids: string[];
  duration_minutes: number | null;
  fetched_at: string;
  run_id: string;
}

export interface AvailabilityCatalogInput {
  calendars: Array<{ calendar_id: string; name: string }>;
  types: Array<{ appointment_type_id: string; name: string; calendar_ids: string[]; duration_minutes: number | null }>;
}

// ---- RETENTION IDENTITY CHAIN (stage 2; owner-approved D1–D14, 2026-10-19) ----
// Canonical client-identity layer: one internal client per real-world client,
// sticky per-system member links, and a Data Match Exceptions queue. Built
// additively per IMPLEMENTATION-PLAN.md §13 (retention/ dir); nothing here
// reuses or repurposes an existing column. Uniqueness lives on the LINK table
// (provider, entity, external_id) — phone/email are NOT unique on the client
// row (a couple may share a landline).

/** Canonical internal client (plan §7). seed_key makes backfill re-runs byte-identical (deviation from the §13 sketch: deterministic idempotence key + evidence/dedupe columns — noted in the plan deviation log). */
export interface InternalClientRow {
  id: string;
  /** Deterministic seed key ('hl-contact:<external_id>') or null for manual-only clients. */
  seed_key: string | null;
  display_name: string | null;
  /** 10-digit NANP comparison value (normalizeUSPhone) — never a sole identity guarantee. */
  normalized_phone: string | null;
  /** normalizeEmail value — never a sole identity guarantee. */
  normalized_email: string | null;
  /** The GHL contact of record (1:1 today; re-pointable only by an audited manual resolve). */
  ghl_contact_external_id: string | null;
  /** auto_matched | manual_resolved | exception */
  match_state: string;
  created_at: string;
  updated_at: string;
}

export interface InternalClientSeedInput {
  seedKey?: string | null;
  displayName?: string | null;
  normalizedPhone?: string | null;
  normalizedEmail?: string | null;
  ghlContactExternalId?: string | null;
  /** auto_matched | manual_resolved | exception (default auto_matched). */
  matchState?: string;
}

/** One sticky member link: every system entity points at EXACTLY ONE internal client, ever (UNIQUE provider+entity+external_id). Manual resolves persist — auto passes never overwrite an existing link. */
export interface ClientMatchLinkRow {
  internal_client_id: string;
  provider: string; // 'highlevel' | 'acuity'
  entity: string; // 'contact' | 'appointment'
  external_id: string;
  /** exact_id | phone_email | phone | email | phone_name | manual */
  match_method: string;
  /** exact | high | medium | manual */
  confidence: string | null;
  /** Source ids that justified the link (auditability: every link preserves why). */
  evidence: Record<string, unknown> | null;
  /** 'auto' | 'manual:<who>' */
  resolved_by: string;
  resolved_at: string;
}

export interface ClientMatchLinkInput {
  internalClientId: string;
  provider: string;
  entity: string;
  externalId: string;
  matchMethod: string;
  confidence?: string | null;
  evidence?: Record<string, unknown> | null;
  resolvedBy?: string;
}

/** Data Match Exceptions queue row (plan §7). dedupe_key (deviation: added for idempotent re-runs) prevents duplicate open rows. */
export interface DataMatchExceptionRow {
  id: string;
  /** ambiguous_id | ambiguous_phone | ambiguous_email | ambiguous_name | name_only | no_identity */
  kind: string;
  dedupe_key: string;
  /** Full candidate list + evidence (ids, names, phones, emails, tiers). */
  payload: Record<string, unknown>;
  /** The appointment/call/contact that triggered it. */
  context: Record<string, unknown> | null;
  /** open | resolved | dismissed */
  status: string;
  resolved_internal_client_id: string | null;
  resolved_method: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  first_seen_at: string;
}

export interface DataMatchExceptionInput {
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  context?: Record<string, unknown> | null;
}

// ---- RETENTION ATTEMPT LEDGER + OUTCOMES (stage 3a; plan §9/§13) ----
// Additive tables that already exist in the §13 DDL sweep (pg.ts); the write
// API lands here. IDEMPOTENCE CONTRACT (both stores): the compute core diffs
// desired rows against the stored rows and writes only genuine inserts +
// content changes — a recompute with unchanged inputs writes NOTHING
// (byte-identical re-run). Per-attempt rows are never merged: every distinct
// call keeps its own row; the ONLY update a row ever receives is an honest
// re-observation of the SAME call (e.g. `ringing` → terminal status on a
// later pass, §9 rule 7), never a merge of another call.
/** One per-attempt row (retention_attempts). (source, external_message_id) is the idempotence key. */
export interface RetentionAttemptRow {
  id: string;
  internal_client_id: string;
  /** Null when unattributed (plan §8 edge cases) — the row stays visible in the client timeline. */
  appointment_id: string | null;
  call_id: string | null;
  /** 'calls' (the normalized calls table) — harvest-ledger rows would carry 'harvest_calls'. */
  source: string;
  external_message_id: string;
  employee_user_id: string | null;
  employee_external_id: string | null;
  attempt_at: string;
  call_status: string | null;
  duration_seconds: number | null;
  direction: string | null;
  attempt_class: string;
  evidence: Record<string, unknown>;
  attribution: string;
}
export interface RetentionAttemptWrite {
  internalClientId: string;
  appointmentId: string | null;
  callId: string | null;
  source: string;
  externalMessageId: string;
  employeeUserId: string | null;
  employeeExternalId: string | null;
  attemptAtIso: string;
  callStatus: string | null;
  durationSeconds: number | null;
  direction: string | null;
  attemptClass: string;
  evidence: Record<string, unknown>;
  attribution: string;
}
/** One per-appointment outcome row (retention_appointment_outcomes; PK appointment_id). */
export interface RetentionOutcomeRow {
  appointment_id: string;
  internal_client_id: string;
  contact_due_date: string;
  eligible: boolean;
  eligibility_basis: string | null;
  attempts_count: number;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  any_answered: boolean;
  final_status: string;
  evidence: Record<string, unknown>;
  needs_review_reason: string | null;
  computed_at: string;
}
export interface RetentionOutcomeWrite {
  appointmentId: string;
  internalClientId: string;
  contactDueDate: string;
  eligible: boolean;
  eligibilityBasis: string;
  attemptsCount: number;
  firstAttemptAtIso: string | null;
  lastAttemptAtIso: string | null;
  anyAnswered: boolean;
  finalStatus: string;
  evidence: Record<string, unknown>;
  needsReviewReason: string | null;
}

/**
 * One per-cancellation ledger row (retention_cancellations; stage 4a, plan
 * §11). PK = appointment_id (the cancelled appointment) — one row per
 * detected cancellation, mirroring the write-once discipline: cancelled_at is
 * COPIED from appointments.cancelled_at (this system's confirmation stamp —
 * Acuity exposes no client-side cancellation timestamp) and never moved.
 * outcome vocabulary (plan §11): saved_original | rescheduled |
 * confirmed_cancellation | unable_to_reach | pending | transferred | other.
 * saved_original here means the client re-booked THE SAME session slot after
 * cancelling (the original appointment, kept — evidence: an actual successor
 * appointment row at the same instant); transferred/other arrive only with
 * the management-override stage.
 */
export interface RetentionCancellationRow {
  appointment_id: string;
  internal_client_id: string | null;
  ghl_contact_external_id: string | null;
  cancelled_at: string | null;
  attempts_count: number;
  any_answered: boolean;
  final_contact_status: string | null;
  outcome: string;
  successor_appointment_id: string | null;
  recovered: boolean;
  recovered_at: string | null;
  manual_overrides: Record<string, unknown> | null;
  notes: Record<string, unknown> | null;
}
export interface RetentionCancellationWrite {
  appointmentId: string;
  internalClientId: string | null;
  ghlContactExternalId: string | null;
  cancelledAtIso: string | null;
  attemptsCount: number;
  anyAnswered: boolean;
  finalContactStatus: string | null;
  outcome: string;
  successorAppointmentId: string | null;
  recovered: boolean;
  recoveredAtIso: string | null;
  notes: Record<string, unknown>;
}

/**
 * One stored no-show ledger row (retention_no_shows; stage 4b — the no-show
 * pipeline, plan §16 + ruling D10). ONE row per detected no-show appointment
 * (PK appointment_id). DETECTION is the owner-ratified D10 proxy: the
 * session's start has passed while the appointment is still a qualifying
 * status (scheduled) and not cancelled, as OBSERVED by the system on a pass.
 *
 * WRITE-ONCE FIELDS (the store COALESCEs them on update; the engine never
 * moves them): session_at / session_date_et (the MISSED session's instant and
 * ET date, copied at detection) and detected_at (when THIS SYSTEM first
 * confirmed the no-show). A later cancellation or reschedule of the same
 * appointment never deletes the row — the missed session happened; the
 * follow-up state column records what came after (state vocabulary below).
 *
 * state vocabulary (closed):
 *   open                      — the no-show stands; no later event (the queue's follow-up work)
 *   rebooked                  — a qualifying successor appointment for the same client was
 *                               created after detected_at (within the reschedule window); the
 *                               client came back — the row is no longer open follow-up work
 *   cancelled_after_no_show   — the appointment was cancelled AFTER the no-show was confirmed
 *   rescheduled_after_no_show — the appointment's own datetime moved into the future AFTER
 *                               detection (Acuity reschedules move the same appointment id)
 */
export interface RetentionNoShowRow {
  appointment_id: string;
  internal_client_id: string | null;
  ghl_contact_external_id: string | null;
  session_at: string | null;
  session_date_et: string | null;
  detected_at: string;
  attempts_count: number;
  any_answered: boolean;
  final_contact_status: string | null;
  state: string;
  successor_appointment_id: string | null;
  manual_overrides: Record<string, unknown> | null;
  notes: Record<string, unknown> | null;
}
export interface RetentionNoShowWrite {
  appointmentId: string;
  internalClientId: string | null;
  ghlContactExternalId: string | null;
  /** The missed session's instant — write-once (the store COALESCEs on update). */
  sessionAtIso: string | null;
  /** The missed session's ET calendar date — write-once (the D10 week anchor). */
  sessionDateEt: string | null;
  /** When THIS SYSTEM confirmed the no-show — set at insert, never moved. */
  detectedAtIso: string;
  attemptsCount: number;
  anyAnswered: boolean;
  finalContactStatus: string | null;
  state: string;
  successorAppointmentId: string | null;
  notes: Record<string, unknown>;
}

/**
/**
 * One stored transfer ledger row (retention_transfers; stage 5 — owner build
 * order "transfers (original-booker exception)"). ONE row per detected
 * transferred original appointment (UNIQUE appointment_id — the content key).
 *
 * DETECTION (evidence, never inference — owner ruling "never guess"): the
 * client's session moved to a DIFFERENT service calendar (staff) while the
 * identity chain holds. The v1 evidence channel: the SAME internal client's
 * cancelled appointment (the original booking, on calendar A) has a successor
 * booking created strictly within the reschedule window on a DIFFERENT known
 * calendar B. If the successor evidence cannot prove the staff change
 * (successor calendar unknown, or same-calendar and cross-calendar candidates
 * mixed) the ambiguity goes to the Data Match Exceptions queue instead of this
 * ledger — a transfer is never asserted from unresolvable evidence.
 *
 * ORIGINAL-BOOKER EXCEPTION (the supersession rule, retention-only):
 *   the row is attributed to the ORIGINAL appointment's internal client (the
 *   original booker's client series). The receiving appointment never gets its
 *   own row (it rides this row as evidence). A cross-client candidate is
 *   structurally impossible (the candidate pool is same-client by
 *   construction) — no transfer is ever asserted across two different client
 *   series, so the receiving side cannot fabricate a new client relationship
 *   here. This engine NEVER rewrites the cancellations/no-show/outcome ledgers
 *   or the core booking attribution — the exception is documentary (this
 *   ledger + its surfaces), never destructive.
 *
 * WRITE-ONCE FIELDS (the store COALESCEs them on update; the engine never
 * moves them): detected_at, original_calendar_id/name (the original booking's
 * staff calendar as first confirmed). A later re-derivation never deletes the
 * row — the transfer happened; the audit trail stays complete.
 */
export interface RetentionTransferRow {
  appointment_id: string;
  internal_client_id: string | null;
  ghl_contact_external_id: string | null;
  original_calendar_id: string | null;
  original_calendar_name: string | null;
  receiving_appointment_id: string | null;
  receiving_calendar_id: string | null;
  receiving_calendar_name: string | null;
  detected_at: string;
  basis: string;
  manual_overrides: Record<string, unknown> | null;
  notes: Record<string, unknown> | null;
}
export interface RetentionTransferWrite {
  appointmentId: string;
  internalClientId: string | null;
  ghlContactExternalId: string | null;
  originalCalendarId: string | null;
  originalCalendarName: string | null;
  receivingAppointmentId: string | null;
  receivingCalendarId: string | null;
  receivingCalendarName: string | null;
  detectedAtIso: string;
  basis: string;
  notes: Record<string, unknown>;
}

/**
 * One stored weekly scorecard row (ret_scorecards; stage 3c, plan §16).

 * APPEND-IF-NEW: one row per scored Mon–Sun ET week (UNIQUE week_start),
 * written ONCE — a stored week is NEVER rewritten (owner rule "past weeks
 * render byte-identically forever"). The cancellation-family cells
 * The cancellation-family cells, the no-show split and transfers are null
 * until their ledger weeks are covered (the no-show ledger has a writer since
 * stage 4b — uncovered weeks still store null; transfers have no writer yet) —
 * null is "not computed", never a fabricated 0.
 */
export interface RetentionScorecardRow {
  id: string;
  /** Monday ET of the scored week (YYYY-MM-DD calendar string). */
  week_start: string;
  /** Sunday ET of the scored week. */
  week_end: string;
  due_days: number;
  /** The Retention Owner of the scored week, resolved from retention_owner_history at compute time (never hard-coded). */
  owner_user_id: string | null;
  owner_name: string | null;
  owner_initials: string | null;
  eligible: number;
  /** Attempt-flavor numerator: cohort appointments with ≥1 in-window attempt (§16). */
  called: number;
  spoken_with: number;
  unreached: number;
  /** spoken_with / eligible — null when eligible = 0 (never a fabricated ratio). */
  compliance_appointment: number | null;
  /** called / eligible — null when eligible = 0. */
  compliance_attempt: number | null;
  cancellations_worked: number | null;
  saves: number | null;
  reschedules: number | null;
  recoveries: number | null;
  recovery_rate: number | null;
  no_shows: number | null;
  no_shows_spoken: number | null;
  no_shows_not_spoken: number | null;
  transfers: number | null;
  needs_review: number;
  /** Open data-match-exceptions snapshot at compute time. */
  match_exceptions: number;
  computed_at: string;
  compute_version: string;
}
export interface RetentionScorecardWrite {
  weekStart: string;
  weekEnd: string;
  dueDays: number;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerInitials: string | null;
  eligible: number;
  called: number;
  spokenWith: number;
  unreached: number;
  complianceAppointment: number | null;
  complianceAttempt: number | null;
  cancellationsWorked: number | null;
  saves: number | null;
  reschedules: number | null;
  recoveries: number | null;
  recoveryRate: number | null;
  noShows: number | null;
  noShowsSpoken: number | null;
  noShowsNotSpoken: number | null;
  transfers: number | null;
  needsReview: number;
  matchExceptions: number;
  computeVersion: string;
}

/**
 * Retention Owner role history (plan §12; retention_owner_history table,
 * §13 DDL). Configurable role record — never hard-coded; a scored week is
 * attributed to whoever owned the role at the time. READ-ONLY in this stage:
 * the Settings surface (build-sequence step 4) adds the writer; the UI reads
 * it so the drill scope line + employee filter light up the moment it exists.
 */
export interface RetentionOwnerHistoryRow {
  id: string;
  employee_user_id: string;
  name: string | null;
  initials: string | null;
  active: boolean;
  /** ET calendar dates. */
  effective_start: string;
  effective_end: string | null;
}

export interface Store {
  mode: "postgres" | "memory";
  ensureSchema(): Promise<void>;

  // settings
  getSettings(): Promise<AppSettings>;
  /**
   * Merge-apply a settings patch. `actor` (default "system") labels this
   * write: a sheet-mapping `mode` in the patch is honored ONLY when the actor
   * is the owner label (SETTINGS_OWNER_ACTOR) — system/unlabeled and default-
   * application writes can never change a saved mode, and any mode change an
   * owner-labeled write makes is audited (manual_overrides, old → new, actor;
   * owner directive: mode changes are explicit + audited, never silent).
   */
  saveSettings(patch: Partial<AppSettings>, actor?: string): Promise<AppSettings>;

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
      /** Cancellation evidence (write-once at the store): the confirmation instant + path. */
      cancelled_at?: string | null;
      cancellation_source?: string | null;
    })[],
    opts?: IngestOptions,
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
  /**
   * CANCELLATION RECONCILIATION (owner report 2026-10-06): mark appointments
   * whose cancellation was CONFIRMED via the Acuity single-appointment GET.
   * Monotone (false→true only), write-once stamps (COALESCE/keep-first), win
   * evidence untouched, demo ids skipped. Returns rows actually flipped.
   */
  markAppointmentsCancelled(acuityIds: string[], cancelledAtIso: string, source: string): Promise<number>;
  /**
   * FLAG LIST (owner report 2026-10-06): appointments counted as Booking Wins
   * (persisted win bucket) that are NOW confirmed cancelled — the honest
   * report-only surface for already-counted wins; stored closed records are
   * never rewritten.
   */
  getCancelledWinAppointments(): Promise<(AppointmentRow & { acuity_appointment_id: string | null })[]>;

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
  upsertAttributions(rows: AttributionRow[], opts?: { force?: boolean; deadline?: RunDeadline }): Promise<number>;
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
    rows: (LeadRow & { source_id: string; provider: string; name?: string | null; phone?: string | null; email?: string | null; source_raw_date?: string | null })[],
    opts?: IngestOptions,
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
  getLeadsByProvider(provider: string): Promise<(LeadRow & { source_id: string; provider: string; name: string | null; phone: string | null; email: string | null; source_raw_date?: string | null })[]>;
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
  /** Resolves true when the transition applied (the run was still 'running');
   * false when the run was already reaped/finished — a late zombie's finish
   * never overwrites the reaper's record. */
finishSyncRun(id: string, status: string, recordsUpserted: number, error: string | null): Promise<boolean>;
  getSyncRuns(limit: number): Promise<SyncRunRow[]>;
  /**
   * The most recent SUCCESSFUL sync_runs row per provider, keyed by provider,
   * value = the row's finished_at normalized to ISO (fallback: started_at —
   * a success row is always finished, this is belt-and-braces). Providers
   * with no success row in their history are ABSENT from the map.
   *
   * Reliability Phase 2a (owner directive 2026-10-16): the freshness
   * watchdog + /health read this instead of getSyncRuns(200)'s recency
   * window — at the 90s HighLevel cadence 200 rows span only a few hours,
   * so a provider stale for longer than that would look "fresh" to any
   * recent-N read. Deliberately NOT wrapped in the pg read cache: /health
   * must answer with the current truth, and the per-provider indexed query
   * is already fast.
   */
  getLatestSuccessfulSyncRunByProvider(): Promise<Record<string, string>>;
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
  issuePip(id: string, opts: { issuedBy: string; snapshotExtras?: Record<string, unknown> }): Promise<PipRow>;
  /** issued → completed. Requires conclusion_category + conclusion_notes. Audit: pip_completed. */
  completePip(id: string, opts: { conclusionCategory: string; conclusionNotes: string; actor: string }): Promise<PipRow>;
  /** issued → cancelled. Requires a cancellation reason. Audit: pip_cancelled. */
  cancelPip(id: string, opts: { cancelledBy: string; reason: string }): Promise<PipRow>;
  /**
   * PHASE 4 — record the manager acknowledgment on an ISSUED PIP (stamps
   * manager_acked_at/manager_acked_by, who+when audited). No employee logins:
   * the manager records it (owner directive 9/30). This is the ACTION behind
   * the existing ack_awaiting derivation — the derivation itself is untouched
   * and clears the moment this lands. Guard: issued only; a recorded
   * acknowledgment is never re-stamped. Audit: pip_ack_recorded.
   */
  recordPipAck(id: string, opts: { ackedBy: string }): Promise<PipRow>;
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
  /** ACTIVE PIPs per template id (draft + issued) — the Phase-4 "in use" counts that tell managers a template is still referenced by a live plan. */
  getPipTemplateUsage(): Promise<Map<string, number>>;
  /** Append a typed module event (also mirrored compactly into manual_overrides by callers' store methods). */
  insertPipEvent(row: Omit<PipEventRow, "id" | "created_at">): Promise<void>;
  /** Module event log, newest first; optionally scoped to one PIP. */
  getPipEvents(opts?: { pipId?: string; limit?: number }): Promise<PipEventRow[]>;

  // ---- Commission Tracker (owner directive 2026-10-01, Phase A) ----
  /** Set/clear ONE rep's commission profile (Settings editor). Null clears (back to ineligible). */
  setUserCommissionProfile(repId: string, profile: CommissionProfileInput | null): Promise<void>;
  /**
   * Upsert ONE weekly record keyed (user_id, week_start) — the close job and the
   * historical backfill share it; re-running NEVER duplicates rows. Phase C
   * SUBMITTED-CYCLE LOCK: a rewrite of a record locked by a submitted cycle is
   * a no-op with an audit row (returns written:false, blocked:true) — stored
   * payroll freezes forever (spec §O/§19).
   */
  upsertCommissionWeeklyRecord(row: CommissionWeeklyRow): Promise<CommissionUpsertResult>;
  /** Weekly records, newest week first; any filter combination narrows the set. */
  getCommissionWeeklyRecords(filter?: { userId?: string; weekStart?: string; cycleId?: string; assignment?: CommissionAssignment }): Promise<CommissionWeeklyRow[]>;
  /**
   * Phase C corrections (spec §O/§20): the ONE audited way stored money moves
   * after approval — a dollars delta applied to manual_adjustment AND total
   * (the auto-calc fields stay frozen). Caller inserts the reason-required
   * adjustment row FIRST; this method only moves the money.
   */
  applyCommissionWeeklyCorrection(userId: string, weekStart: string, deltaDollars: number): Promise<void>;
  /**
   * Phase C week↔cycle membership (spec §S): targeted (user, week) update of
   * ONLY cycle_id/assignment — never money. The lifecycle layer validates +
   * audits; the store performs the surgical update (assignment flips at
   * submission and week re-assignment must not re-run the money upsert).
   */
  setCommissionRecordAssignment(userId: string, weekStart: string, patch: { cycleId: string | null; assignment: CommissionAssignment }): Promise<void>;
  /** Upsert a cycle by id (deterministic slugs; submission freezes the final snapshot, Phase C). */
  upsertCommissionCycle(cycle: CommissionCycleRow): Promise<void>;
  getCommissionCycle(cycleId: string): Promise<CommissionCycleRow | null>;
  /** All cycles, newest start_date first. */
  getCommissionCycles(): Promise<CommissionCycleRow[]>;
  /**
   * Append a corrections-audit row (§O: reason REQUIRED — both stores throw on
   * an empty/blank reason; who/what/old/new/reason/when is the contract).
   */
  insertCommissionAdjustment(row: CommissionAdjustmentInput): Promise<CommissionAdjustmentRow>;
  /** Adjustments, newest first; any filter combination narrows the set. */
  getCommissionAdjustments(filter?: { cycleId?: string; userId?: string; targetId?: string }): Promise<CommissionAdjustmentRow[]>;

  // ---- Availability feed cache (Acuity availability rebuild PR-1) ----
  /**
   * Full-month date-index cache: upsert per (calendar, appointmentType, month)
   * with REPLACE-of-the-row semantics (the fresh answer IS the month's truth,
   * including an EMPTY answer — that is the coverage horizon). Writer runs
   * inside the availability-feed advisory lock in pg (one writer at a time).
   * fetchedAt (optional) stamps the probe instant explicitly — the sweep-age
   * logic (feed-observed-closed vs not-yet-observed) keys off it, so tests pin
   * the fixture instant; production passes the run's own clock reading.
   */
  putAvailabilityDates(rows: AvailabilityDatesInput[], runId: string, fetchedAt?: string): Promise<void>;
  /** Cached month rows for the given months (empty list → []). */
  getAvailabilityDates(months: string[]): Promise<AvailabilityDatesRow[]>;
  /**
   * ONE (calendar, date) times-fetch result, REPLACE semantics for that
   * (calendar, date): the fresh feed answer is the current truth, so rows the
   * feed no longer offers are removed (a booked slot drops out of the feed —
   * the discrepancy detector compares against the CURRENT answer and the
   * mismatch history lives in availability_discrepancies, not in stale rows).
   * Returns the number of rows now present for the (calendar, date).
   */
  putAvailabilitySlotsForDate(calendarId: string, dateEt: string, times: { time_et: string; slots_available: number }[], runId: string): Promise<number>;
  /** Cached open-slot rows for the given ET dates (all calendars), date+time ascending. */
  getAvailabilitySlotsForDates(dates: string[]): Promise<AvailabilitySlotRow[]>;
  /** Open ONE detailed availability run (scope = months/dates/calendars/trigger; pairs with the generic sync_runs row). */
  insertAvailabilitySyncRun(scope: Record<string, unknown>): Promise<string>;
  finishAvailabilitySyncRun(id: string, status: string, callsMade: number, error: string | null): Promise<void>;
  /** Mark every 'running' detailed availability run started before cutoffMs as failed (reaper semantics). */
  reapStaleAvailabilitySyncRuns(cutoffMs: number, error: string): Promise<number>;
  /** Detailed availability-run rows, newest first. */
  getAvailabilitySyncRuns(limit: number): Promise<AvailabilitySyncRunRow[]>;
  /**
   * Apply ONE detector pass over the scanned (calendar, date) pairs (the pairs
   * whose feed state was freshly re-fetched this run): insert each mismatch
   * that has no UNRESOLVED row yet (dedupe on calendar+date+time+kind while
   * unresolved), and RESOLVE (set resolved_at) every still-unresolved row of
   * the scanned pairs that the current feed state no longer shows. Pairs not
   * in `scanned` are untouched (we did not look — never a resolution).
   */
  applyAvailabilityDiscrepancies(runId: string, scanned: { calendar_id: string; date_et: string }[], current: AvailabilityDiscrepancyInput[]): Promise<{ inserted: number; resolved: number }>;
  /** Discrepancy rows, newest detection first; unresolvedOnly narrows to the open list. */
  getAvailabilityDiscrepancies(opts?: { unresolvedOnly?: boolean; limit?: number }): Promise<AvailabilityDiscrepancyRow[]>;
  /**
   * Cache the /calendars + /appointment-types catalog (REPLACE-all — the fresh
   * answer is the truth). Written by every availability-feed run's catalog
   * step; read by the availability page's filter options (PR-3 §3).
   */
  putAvailabilityCatalog(catalog: AvailabilityCatalogInput, runId: string, fetchedAt?: string): Promise<void>;
  /** The cached catalog; empty arrays when no feed run has populated it yet. */
  getAvailabilityCatalog(): Promise<{ calendars: AvailabilityCalendarRow[]; types: AvailabilityTypeRow[] }>;

  // ---- RETENTION IDENTITY CHAIN (stage 2; plan §7; owner-approved D1–D14) ----
  // Idempotence contract shared by BOTH stores: clients are addressed by a
  // deterministic seed_key; link inserts are if-absent on the
  // (provider, entity, external_id) UNIQUE and NEVER update an existing row
  // (manual resolves are sticky — auto passes cannot override them); manual
  // resolveDataMatchException is the ONLY writer allowed to move a link, and
  // it stamps match_method='manual' + an audit trail. Exception inserts are
  // if-absent on dedupe_key. Re-running the backfill therefore mutates
  // nothing (the byte-identical gate criterion).
  /** Deterministic lookup by seed key ('hl-contact:<external_id>'). */
  getInternalClientBySeedKey(seedKey: string): Promise<InternalClientRow | null>;
  /** Insert one client; returns the row with its store-canonical id. Callers look up by seed key first. */
  insertInternalClient(input: InternalClientSeedInput): Promise<InternalClientRow>;
  getInternalClientsByIds(ids: string[]): Promise<InternalClientRow[]>;
  /** Every client (the matcher's candidate universe; production volumes are small — seeded clients only). */
  listInternalClients(): Promise<InternalClientRow[]>;
  /** Every link row (bulk prefetch for the backfill applier's read decisions). */
  listClientMatchLinks(): Promise<ClientMatchLinkRow[]>;
  /** STICKY link writer: insert-if-absent on (provider, entity, external_id); existing rows are returned UNCHANGED with created=false. */
  insertClientMatchLinkIfAbsent(link: ClientMatchLinkInput): Promise<{ link: ClientMatchLinkRow; created: boolean }>;
  getClientMatchLink(provider: string, entity: string, externalId: string): Promise<ClientMatchLinkRow | null>;
  getClientMatchLinksByInternalClient(internalClientId: string): Promise<ClientMatchLinkRow[]>;
  countClientMatchLinks(): Promise<number>;
  /** Dedupe on dedupe_key while open; an existing row is returned UNCHANGED with created=false. */
  insertDataMatchExceptionIfAbsent(input: DataMatchExceptionInput): Promise<{ exception: DataMatchExceptionRow; created: boolean }>;
  getDataMatchExceptions(opts?: { status?: string }): Promise<DataMatchExceptionRow[]>;
  countDataMatchExceptions(status?: string): Promise<number>;
  /** Manual resolution (management action; audited): resolves the exception AND writes/overrides the member link with match_method='manual' — the one writer allowed to move a link. */
  resolveDataMatchException(id: string, resolve: { internalClientId: string; method?: string; resolvedBy: string }): Promise<void>;
  /** Appointment → internal client (via the sticky acuity/appointment link). */
  getInternalClientForAppointment(acuityAppointmentId: string): Promise<InternalClientRow | null>;
  /** GHL contact external ids → internal clients (the call→client resolver core: call.contact_id → contacts.external_id → this). */
  getInternalClientsForContactExternalIds(externalIds: string[]): Promise<{ external_id: string; client: InternalClientRow | null }[]>;
  /** Call ids → internal client (join through contacts + the highlevel/contact link); null when the call has no resolvable client. */
  getInternalClientsForCallIds(callIds: string[]): Promise<{ call_id: string; internal_client_id: string | null }[]>;

  // ---- RETENTION ATTEMPT LEDGER + OUTCOMES (stage 3a; plan §9/§13) ----
  // Write API for the computation job. All reads are bulk (production volumes
  // are small — the 7-day excitement cohort only); all writes are content-
  // diffed by the CALLER (compute.ts) so an unchanged recompute writes nothing.
  /** Every attempt row (bulk read for the diff + tests). */
  listRetentionAttempts(): Promise<RetentionAttemptRow[]>;
  /** Batch insert of NEW attempt rows only (the core pre-dedupes). Returns the number actually inserted. */
  insertRetentionAttempts(rows: RetentionAttemptWrite[]): Promise<number>;
  /** Honest re-observation of ONE existing attempt row (same call — e.g. ringing → terminal); every field supplied is written. */
  updateRetentionAttempt(id: string, patch: Partial<Omit<RetentionAttemptWrite, "source" | "externalMessageId">>): Promise<void>;
  /** Every outcome row (bulk read for the diff + tests). */
  listRetentionAppointmentOutcomes(): Promise<RetentionOutcomeRow[]>;
  /** Batch insert of NEW outcome rows only (the core pre-dedupes). Returns the number actually inserted. */
  insertRetentionAppointmentOutcomes(rows: RetentionOutcomeWrite[]): Promise<number>;
  /** Content update of ONE existing outcome row (recomputed verdict); computed_at is set by the store. */
  updateRetentionAppointmentOutcome(row: RetentionOutcomeWrite): Promise<void>;

  // ---- RETENTION CANCELLATIONS LEDGER (stage 4a; plan §11) ----
  // Same discipline as the attempt/outcome ledger: bulk reads, content-diffed
  // by the CALLER so an unchanged recompute writes nothing.
  /** Every cancellation ledger row (bulk read for the diff + tests). */
  listRetentionCancellations(): Promise<RetentionCancellationRow[]>;
  /** Insert NEW ledger rows only (the engine pre-dedupes by appointment_id). Returns the number actually inserted. */
  insertRetentionCancellations(rows: RetentionCancellationWrite[]): Promise<number>;
  /** Content update of ONE existing ledger row (derived outcome advanced); computed stamp rides notes. */
  updateRetentionCancellation(row: RetentionCancellationWrite): Promise<void>;
  // ---- RETENTION NO-SHOW LEDGER (stage 4b; plan §16 + ruling D10) ----
  // Same discipline as the cancellations ledger: bulk reads, content-diffed
  // by the CALLER so an unchanged recompute writes nothing. session_at /
  // session_date_et / detected_at are WRITE-ONCE (the store COALESCEs them on
  // update); manual_overrides are never touched by the automatic writer.
  /** Every no-show ledger row (bulk read for the diff + the UI family). */
  listRetentionNoShows(): Promise<RetentionNoShowRow[]>;
  /** Insert NEW ledger rows only (the engine pre-dedupes by appointment_id). Returns the number actually inserted. */
  insertRetentionNoShows(rows: RetentionNoShowWrite[]): Promise<number>;
  /** Content update of ONE existing ledger row (follow-up state advanced); write-once fields are preserved. */
  updateRetentionNoShow(row: RetentionNoShowWrite): Promise<void>;
  // ---- RETENTION TRANSFERS LEDGER (stage 5; owner build order "transfers / original-booker exception") ----
  // Same discipline as the no-show/cancellations ledgers: bulk reads,
  // content-diffed by the CALLER so an unchanged recompute writes nothing.
  // detected_at / original_calendar_id / original_calendar_name are WRITE-ONCE
  // (the store COALESCEs them on update); manual_overrides are never touched
  // by the automatic writer.
  /** Every transfer ledger row (bulk read for the diff + the UI family). */
  listRetentionTransfers(): Promise<RetentionTransferRow[]>;
  /** Insert NEW transfer rows only (the engine pre-dedupes by appointment_id). Returns the number actually inserted. */
  insertRetentionTransfers(rows: RetentionTransferWrite[]): Promise<number>;
  /** Content update of ONE existing transfer row (receiving-side evidence advanced); write-once fields are preserved. */
  updateRetentionTransfer(row: RetentionTransferWrite): Promise<void>;
  /** Weekly scorecards (stage 3c): append-if-new storage — a stored week is never rewritten. */
  listRetentionScorecards(): Promise<RetentionScorecardRow[]>;
  getRetentionScorecard(weekStart: string): Promise<RetentionScorecardRow | null>;
  insertRetentionScorecardIfAbsent(row: RetentionScorecardWrite): Promise<{ created: boolean; row: RetentionScorecardRow | null }>;
  /** Management close of an exception WITHOUT a link write (audited via manual_overrides, like resolve). */
  dismissDataMatchException(id: string, opts: { resolvedBy: string }): Promise<void>;

  // ---- RETENTION OWNER HISTORY (read-only this stage; plan §12) ----
  /** Every role-history row, effective_start ascending (the Settings writer lands in the Settings delegation). */
  listRetentionOwnerHistory(): Promise<RetentionOwnerHistoryRow[]>;
}
