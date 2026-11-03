/**
 * MODULE ROW TYPES (PIP · Commission · Availability feed · Internal clients ·
 * Retention) — moved verbatim from src/server/store/types.ts
 * (docs/DECOMPOSITION-PLAN.md step 4), cut at the file's own banner comments.
 */

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
  employment_type: import("../../commission/engine").EmploymentType;
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
  employment_type: import("../../commission/engine").EmploymentType;
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
