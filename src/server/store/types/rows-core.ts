/**
 * CORE IDENTITY / REPORTING / SETTINGS ROW TYPES — moved verbatim from
 * src/server/store/types.ts (docs/DECOMPOSITION-PLAN.md step 4).
 * store/types.ts is the re-export shim: every import path (./types, ../types,
 * ../store/types, ~/server/store/types) resolves unchanged and the public
 * surface is identical. Seeds (DEFAULT_*) live in ./seeds; the liveness
 * constants live in ./sync-meta; the module rows live in ./rows-modules;
 * the Store interface lives in ./store-interface.
 */

import { LEAD_SOURCE_SHEETS } from "../../../components/lead-sources";
import { DEFAULT_ACTIVE_ROSTER, DEFAULT_COLUMN_MAPPING, DEFAULT_COLUMN_MAPPING_DAY_COUNT, DEFAULT_RETENTION_SETTINGS, DEFAULT_SETTINGS, DEFAULT_SHEET_IDS } from "./seeds";
import type { AvailabilityRule, RecurringBlock } from "../../metrics/compute";


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
  employment_type?: import("../../commission/engine").EmploymentType | null;
  /** 1–5; null = no tier assigned (never commission-eligible — e.g. Dan McKillop). */
  commission_tier?: number | null;
  /** The date the current tier took effect (ET). History uses the tier held that week (snapshot on the weekly record). */
  tier_effective_date?: string | null;
  /** When the tier ends (nullable) — a week qualifies for the tier only when [week_start, week_end] overlaps [effective, end]. */
  tier_end_date?: string | null;
  /** Master switch: false = never in the commission calc even with a tier. */
  commission_eligible?: boolean;
}


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
/**
 * PER-SOURCE BOOKING ATTRIBUTION join row (owner directive 2026-10-27, Steps
 * 3–5): a lead with exactly the identity columns the read-only booking→source
 * join needs — contact_id (primary), phone/email (the ingest-matching
 * fallback), source_sheet (THE source bucket), source_date (THE nearest-rule
 * key) and created_at (the exact-tie "most recently ingested" break). Pure
 * read materialization; nothing here is ever written back.
 */
export interface LeadJoinRow {
  id: string;
  contact_id: string | null;
  source_sheet: string;
  lead_type: string;
  /** YYYY-MM-DD — the sheet date. */
  source_date: string;
  phone: string | null;
  email: string | null;
  /** Ingest instant (leads.created_at, ISO). */
  created_at: string | null;
  /**
   * WORK-DATE COHORT fields (owner directive 2026-10-27, work-date alignment —
   * ADDITIVE projection). `work_date` is the ingest-applied
   * getWorkDate(source_date) — the lead's work-date cohort key (Team trends /
   * Reps / Today / Daily already consume it); `assigned_rep_id` credits the
   * lead to its assigned rep. Optional so existing literals stay valid; both
   * stores set them, letting the Weekly/REP cohort consumers slice the SAME
   * join rows by work_date and credit by lead assignment WITHOUT a second
   * fetch — matching engine and date logic untouched.
   */
  work_date?: string | null;
  assigned_rep_id?: string | null;
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
 * One NON-CALL conversation message persisted as attribution EVIDENCE
 * (evidence_messages table; written by the incremental harvest and the
 * evidence backfill — SMS EVIDENCE spec, owner approved 2026-11-02).
 *
 * An OUTBOUND row whose `user_external_id` resolves (users.external_id) to a
 * roster rep SATISFIES the 2026-10-30 conversation-evidence requirement inside
 * a booking's attribution window; inbound-only threads are never evidence.
 * This ledger is deliberately SEPARATE from `calls`/`harvest_calls`: writing
 * here never touches pickup rate, call counts, or over-2-min metrics.
 */
export interface EvidenceMessageRow {
  message_id: string;
  conversation_id: string | null;
  contact_external_id: string | null;
  /** Raw HL messageType, e.g. "TYPE_SMS" | "TYPE_LIVE_CHAT" — never "TYPE_CALL". */
  message_type: string;
  /** "outbound" | "inbound" | null (unknown). */
  direction: string | null;
  /** The sending HL user (present on outbound) — rep resolution key. */
  user_external_id: string | null;
  /** ISO. */
  date_added: string;
  /** Truncated message body (audit display). */
  body: string | null;
}

/**
 * ONE raw HighLevel call record (call-source implementation W1, owner
 * directive 2026-11-04) — the lossless landing zone for the
 * /conversations/messages/export (channel=Call) pull that becomes the SOURCE
 * OF TRUTH for call KPIs (W3 switch is a follow-up session). Idempotent upsert
 * by message_id. Deliberately SEPARATE from `calls`/`harvest_calls`: writing
 * here never touches pickup rate, call counts, or over-2-min metrics until W3.
 */
export interface HlCallRecordRow {
  /** HL message id — the unique upsert key. */
  message_id: string;
  /** RAW HighLevel userId (rep attribution key → users.external_id). NULL = team-level (inbound/unclaimed) — kept, never dropped. */
  user_external_id: string | null;
  /** HL contact id (external; W3 resolves links). */
  contact_external_id: string | null;
  /** HL conversation id (audit endpoint linkage). */
  conversation_id: string | null;
  /** "outbound" | "inbound" | null (unknown). */
  direction: string | null;
  /** meta.call.status: completed | no-answer | failed | busy | voicemail | ringing. */
  call_status: string | null;
  /** meta.call.duration seconds; NULL = the API reported no talk time (attempt without a connection) — distinct from a real 0. */
  duration_seconds: number | null;
  /** ISO — the W3 KPI day-bucket key (ET business day, never UTC drift). */
  date_added: string;
  /** "TYPE_CALL" | "TYPE_IVR_CALL" (W3 excludes IVR from rep/team totals). */
  message_type: string;
  /** API `source` (e.g. "calls" / "process-calls"). */
  source: string | null;
  from_number: string | null;
  to_number: string | null;
  /** The untouched API record (jsonb) for audit/re-derivation. */
  raw: Record<string, unknown> | null;
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
