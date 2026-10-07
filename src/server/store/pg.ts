/**
 * Postgres Store (Tiger Cloud) — normalized schema per SPEC, with unique
 * indexes on provider external IDs so re-syncs UPSERT instead of duplicating.
 * Cancelled appointments keep history via status + cancelled flags.
 */
import postgres from "postgres";
import {
  type AppointmentRow,
  type AttributionRow,
  type AvailabilityRule,
  type BlockedTimeRow,
  type CallRow,
  type LeadRow,
  attributionDegradation,
} from "../metrics/compute";
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";
import type {
  AppSettings,
  ContactIdentityRow,
  AuditCallRow,
  CallContactBackfillUpdate,
  ConnectionRow,
  ContactExternalIdRow,
  ContactRow,
  DailyPrioritiesRow,
  HarvestCallRow,
  HarvestConvRow,
  HarvestProgressRow,
  LeadCountAdjustmentRow,
  ManualOverrideRow,
  MonthlyGoalRow,
  OpportunityRow,
  RepGoalRowFull,
  Store,
  SyncRunRow,
  TeamGoalRow,
  UserRow,
  WeeklyReportNotesRow,
  PipCheckinRow,
  PipCreateInput,
  PipDraftPatch,
  PipEvidenceSnapshotRow,
  PipEventRow,
  PipRow,
  PipStatus,
  PipTemplateCreateInput,
  PipTemplatePatch,
  PipTemplateRow,
  CommissionAdjustmentInput,
  CommissionAdjustmentRow,
  CommissionAssignment,
  CommissionCycleRow,
  CommissionProfileInput,
  CommissionWeeklyRow,
  CountedBookingSnapshot,
  HoleAuditSnapshot,
  CommissionUpsertResult,
  AvailabilityDatesInput,
  AvailabilityCalendarRow,
  AvailabilityCatalogInput,
  AvailabilityDatesRow,
  AvailabilityTypeRow,
  AvailabilityDiscrepancyInput,
  AvailabilityDiscrepancyRow,
  AvailabilitySlotRow,
  AvailabilitySyncRunRow,
} from "./types";
import { DEFAULT_SETTINGS, isPipStatus, normalizeAppSettings, normalizePipActionList, parseSyncStartedMs, STALE_RUN_REAP_MINUTES } from "./types";
import {
  applyPipDraftPatch,
  assertCancelRequirements,
  assertCheckinAllowed,
  assertCompleteRequirements,
  assertIssueRequirements,
  buildPipRow,
  pipAuditValue,
  pipDateString,
  assertAckRequirements,
  pipEventToManualOverride,
  pipOptionalInt,
  pipOptionalText,
  pipRequiredText,
} from "./pip-helpers";
import { TtlReadCache } from "./read-cache";

/*
 * The pips SELECT/RETURNING column list — ONE shared fragment interpolated
 * into every pips read (eleven identical copies of this list drifted the
 * moment new columns arrived; one fragment cannot drift). Built from the
 * INSTANCE sql so module import never touches a connection.
 */


// Ordered DDL: each statement idempotent, safe to run on every cold start.
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    external_id text NOT NULL,
    name text NOT NULL,
    email text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    external_id text NOT NULL,
    name text,
    phone text,
    email text,
    assigned_rep_id uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS opportunities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    external_id text NOT NULL,
    name text,
    status text,
    monetary_value numeric,
    contact_id uuid REFERENCES contacts(id),
    rep_id uuid REFERENCES users(id),
    pipeline_id text,
    stage_id text,
    source_created_at timestamptz,
    source_updated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    external_call_id text NOT NULL,
    rep_id uuid REFERENCES users(id),
    contact_id uuid REFERENCES contacts(id),
    direction text,
    call_status text,
    started_at timestamptz NOT NULL,
    duration_seconds integer NOT NULL DEFAULT 0,
    over_two_minutes boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, external_call_id)
  )`,
  `CREATE INDEX IF NOT EXISTS calls_started_at_idx ON calls (started_at)`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL DEFAULT 'acuity',
    acuity_appointment_id text NOT NULL,
    contact_id uuid REFERENCES contacts(id),
    calendar_id text,
    calendar_name text,
    appointment_type text,
    appointment_datetime timestamptz NOT NULL,
    duration_minutes integer,
    created_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'scheduled',
    cancelled boolean NOT NULL DEFAULT false,
    client_name text,
    client_phone text,
    client_email text,
    raw jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (acuity_appointment_id)
  )`,
  `CREATE INDEX IF NOT EXISTS appt_created_idx ON appointments (created_at)`,
  `CREATE INDEX IF NOT EXISTS appt_datetime_idx ON appointments (appointment_datetime)`,
  // S7c AUTHORITATIVE CREATION TIME (owner directive 2026-09-28): the ET
  // business date the booking was made on + the original source string +
  // precision marker. created_at becomes the authoritative instant (Acuity
  // datetimeCreated with its stated offset); date-only rows keep the
  // documented midnight-UTC display encoding and are precision-marked.
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_business_date date`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_time_source text`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_time_precision text`,
  `CREATE INDEX IF NOT EXISTS appt_created_bdate_idx ON appointments (created_business_date)`,
  // BOOKING WIN PAYMENT MODEL (owner directive, rev 12): derived payment state
  // + the win bucket (ET date the deposit was received) + provenance + the
  // write-once first-seen stamp. Derived from appointments.raw by payments.ts;
  // the sync writes them on every pass (win fields are COALESCE-protected).
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_state text`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booking_win_business_date date`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_business_date_source text`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS first_seen_paid_at timestamptz`,
  // PENDING PAYMENT DISMISSAL (owner request 2026-09-30): the owner's ✕ on the
  // Today page's Pending Payments list. Written ONLY by the dismiss endpoint;
  // the Acuity sync's upsert never touches it (owner-controlled state).
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pending_dismissed_at timestamptz`,
  // CANCELLATION RECONCILIATION (owner report 2026-10-06): Acuity's list
  // endpoint never returns cancelled appointments, so the sync's upsert could
  // never flip a locally-scheduled row to cancelled — a deposit-paid booking
  // cancelled afterwards stayed a Booking Win forever. cancelled_at is WHEN
  // THIS SYSTEM CONFIRMED the cancellation via GET /appointments/{id} (Acuity
  // exposes no cancellation timestamp); cancellation_source is the
  // confirmation path. Both write-once (COALESCE): a later sync never clears
  // or moves them.
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_source text`,
  `CREATE INDEX IF NOT EXISTS appt_win_bdate_idx ON appointments (booking_win_business_date)`,
  `CREATE TABLE IF NOT EXISTS booking_attributions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
    call_id uuid REFERENCES calls(id),
    rep_id uuid REFERENCES users(id),
    method text NOT NULL DEFAULT 'none',
    confidence real NOT NULL DEFAULT 0,
    manual_override boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL DEFAULT 'google_sheets',
    source_id text NOT NULL,
    lead_type text NOT NULL,
    source_date date NOT NULL,
    work_date date NOT NULL,
    name text,
    phone text,
    email text,
    contact_id uuid REFERENCES contacts(id),
    assigned_rep_id uuid REFERENCES users(id),
    source_sheet text NOT NULL,
    raw jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, source_id)
  )`,
  `CREATE INDEX IF NOT EXISTS leads_work_date_idx ON leads (work_date)`,
  `CREATE TABLE IF NOT EXISTS rep_goals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rep_id uuid NOT NULL REFERENCES users(id),
    week_start date NOT NULL,
    goal integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (rep_id, week_start)
  )`,
  `CREATE TABLE IF NOT EXISTS team_goals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    week_start date NOT NULL UNIQUE,
    booking_goal integer NOT NULL DEFAULT 79,
    lead_budget integer NOT NULL DEFAULT 700,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // MONTHLY BOOKING GOAL (owner-approved 2026-09-29): month-grain goal keyed
  // 'YYYY-MM' — a month NEVER inherits another month's goal (October does not
  // inherit September's 316). Text key (not a date) keeps the month bucket
  // exact; the UNIQUE key is the upsert conflict target.
  `CREATE TABLE IF NOT EXISTS monthly_goals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    month text NOT NULL UNIQUE,
    goal integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // WEEKLY CC REPORT NARRATIVE (owner template, 2026-09-29): the editable
  // sections of the Monday report, persisted per week-start (Big-3 pattern at
  // week grain). jsonb map of section key → text so sections can be added
  // without DDL; every changed section still lands in manual_overrides.
  `CREATE TABLE IF NOT EXISTS weekly_report_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    week_start date NOT NULL UNIQUE,
    notes jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS availability_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    weekday integer NOT NULL,
    open_time text NOT NULL,
    close_time text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // TWO-BLOCK DAILY SCHEDULE (owner directive 2026-09-27): a weekday carries
  // SEVERAL hour-blocks (morning + afternoon), so the mirror's old per-weekday
  // UNIQUE (weekday) must become a (weekday, open_time) key. The legacy
  // constraint is dropped idempotently; a unique INDEX (ADD CONSTRAINT has no
  // IF NOT EXISTS) gives the upsert its conflict target.
  `ALTER TABLE availability_rules DROP CONSTRAINT IF EXISTS availability_rules_weekday_key`,
  `CREATE UNIQUE INDEX IF NOT EXISTS availability_rules_weekday_open_idx ON availability_rules (weekday, open_time)`,
  `CREATE TABLE IF NOT EXISTS blocked_times (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL DEFAULT 'acuity',
    external_id text NOT NULL,
    start_at timestamptz NOT NULL,
    end_at timestamptz NOT NULL,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS blocked_times_range_idx ON blocked_times (start_at, end_at)`,
  `CREATE TABLE IF NOT EXISTS daily_priorities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    date date NOT NULL UNIQUE,
    priority1 text,
    priority2 text,
    priority3 text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS integration_connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'disconnected',
    is_demo boolean NOT NULL DEFAULT false,
    last_sync_at timestamptz,
    last_successful_sync_at timestamptz,
    last_error text,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS manual_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    field text NOT NULL,
    previous_value text,
    new_value text NOT NULL,
    changed_by text NOT NULL DEFAULT 'christopher',
    changed_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS sync_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    records_upserted integer NOT NULL DEFAULT 0,
    error text
  )`,
  `CREATE INDEX IF NOT EXISTS sync_runs_provider_idx ON sync_runs (provider, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key text PRIMARY KEY DEFAULT 'app',
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS lead_count_adjustments (
    work_date date NOT NULL,
    sheet text NOT NULL,
    delta integer NOT NULL DEFAULT 0,
    reason text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (work_date, sheet)
  )`,
  // Incremental-sync watermark per provider: everything BEFORE this instant is
  // already stored, so background ticks only fetch newer activity.
  `CREATE TABLE IF NOT EXISTS sync_watermarks (
    provider text PRIMARY KEY,
    watermark timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Generic named checkpoints (jsonb) for resumable backfill jobs — the HL
  // contacts backfill persists its pagination cursor here after EVERY page so
  // an interrupted run resumes exactly where it stopped (never page 1).
  `CREATE TABLE IF NOT EXISTS sync_checkpoints (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Identity-program contact fields (owner-ratified attribution program,
  // Session 1): raw values stay in phone/email; normalized identity keys and
  // source timestamps live alongside. Upsert-only — nothing here ever deletes.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_name text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_name text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_raw text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_normalized text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_raw text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_normalized text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_created_at timestamptz`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_updated_at timestamptz`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_synced_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS contacts_phone_normalized_idx ON contacts (phone_normalized)`,
  `CREATE INDEX IF NOT EXISTS contacts_email_normalized_idx ON contacts (email_normalized)`,
  // Rep activation dates (design/data-terminology.md): explicit per-rep
  // "Not Yet Active" field. Owner's worked example: Dan starts 2026-09-28 —
  // backfilled when still unset, never overwriting an owner edit.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS call_start_date text`,
  `UPDATE users SET call_start_date = '2026-09-28' WHERE name = 'Dan McKillop' AND call_start_date IS NULL`,
  // COMMISSION TRACKER (owner directive 2026-10-01, spec §B): profile fields on
  // the rep row. Seed profiles are FILL-ONLY-WHEN-UNSET (commission_tier IS
  // NULL) so a later owner change in Settings never snaps back on cold start.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type text`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_tier integer`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_effective_date text`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_end_date text`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_eligible boolean NOT NULL DEFAULT false`,
  `UPDATE users SET employment_type = 'full_time', commission_tier = 5, tier_effective_date = '2026-08-31', commission_eligible = true WHERE name = 'Allison Wittner' AND commission_tier IS NULL`,
  `UPDATE users SET employment_type = 'part_time', commission_tier = 3, tier_effective_date = '2026-08-31', commission_eligible = true WHERE name = 'Laura Rivera' AND commission_tier IS NULL`,
  `UPDATE users SET employment_type = 'full_time', commission_tier = 1, tier_effective_date = '2026-08-31', commission_eligible = true WHERE name = 'Carmine Morgano' AND commission_tier IS NULL`,
  `UPDATE users SET employment_type = 'full_time', commission_tier = 1, tier_effective_date = '2026-08-31', commission_eligible = true WHERE name = 'Jennifer Stitt' AND commission_tier IS NULL`,
  // Harvest-side call columns: roster-external rep id (kept even when the rep is
  // not on the active roster) + the HighLevel conversation the call came from.
  `ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_rep_external_id text`,
  `ALTER TABLE calls ADD COLUMN IF NOT EXISTS conversation_id text`,
  `CREATE INDEX IF NOT EXISTS calls_provider_rep_ext_idx ON calls (provider_rep_external_id)`,
  // Call→contact restoration backfill (owner-ratified attribution program,
  // Session 2): provenance of HOW the call's contact was resolved and when.
  // The raw source ids are already preserved (external_call_id = HL message
  // id, conversation_id = HL conversation id, provider_rep_external_id = HL
  // userId); these two columns record the resolution itself. Fill-null-only —
  // an existing contact_id is never overwritten.
  `ALTER TABLE calls ADD COLUMN IF NOT EXISTS contact_resolution_method text`,
  `ALTER TABLE calls ADD COLUMN IF NOT EXISTS contact_resolved_at timestamptz`,
  // Attribution audit/debug note: the window limitation is persisted ON the
  // row ("date_granularity_window" + the exact window dates evaluated).
  `ALTER TABLE booking_attributions ADD COLUMN IF NOT EXISTS note text`,
  // S4b refined no-rep classification: the engine's triage category for
  // unattributed rows ("no-window-interaction" | "interaction-without-roster-rep" |
  // "no-matching-contact" | "no-contact-identity" | "bad-datetime") and
  // "ambiguous" on ambiguous rows; NULL on attributed/manual rows. A structured
  // column (not the freeform note) because the queue groups and counts by it.
  `ALTER TABLE booking_attributions ADD COLUMN IF NOT EXISTS reason_code text`,
  // Resumable HighLevel call harvest (uncapped accuracy layer — see
  // src/server/sync/call-harvest.ts). Conversations discovered by dateAdded
  // binary partitioning; visited flags make a stopped run resume exactly.
  `CREATE TABLE IF NOT EXISTS harvest_conversations (
    conv_id text PRIMARY KEY,
    last_message_date bigint NOT NULL,
    date_added bigint NOT NULL,
    message_types jsonb NOT NULL DEFAULT '[]'::jsonb,
    last_message_type text,
    contact_id text,
    assigned_to text,
    visited boolean NOT NULL DEFAULT false,
    visited_at timestamptz,
    calls_found int NOT NULL DEFAULT 0,
    messages_scanned int NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hconv_lmd ON harvest_conversations (last_message_date)`,
  `CREATE INDEX IF NOT EXISTS idx_hconv_unvisited ON harvest_conversations (visited, last_message_date)`,
  `CREATE TABLE IF NOT EXISTS harvest_progress (
    id text PRIMARY KEY,
    window_start_utc timestamptz NOT NULL,
    list_hi_exclusive bigint NOT NULL,
    list_complete boolean NOT NULL DEFAULT false,
    list_requests int NOT NULL DEFAULT 0,
    conversations_listed int NOT NULL DEFAULT 0,
    visits_done int NOT NULL DEFAULT 0,
    calls_found int NOT NULL DEFAULT 0,
    messages_scanned int NOT NULL DEFAULT 0,
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    last_error text
  )`,
  // Independent harvest-side ledger of every call message seen (used to recount
  // rep calls straight from the harvest pipeline, separate from the dashboard's
  // `calls` table).
  `CREATE TABLE IF NOT EXISTS harvest_calls (
    message_id text PRIMARY KEY,
    conversation_id text NOT NULL,
    user_external_id text,
    contact_external_id text,
    started_at timestamptz NOT NULL,
    duration_seconds integer,
    direction text,
    call_status text,
    harvested_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hcalls_user_day ON harvest_calls (user_external_id, started_at)`,
  // Pages/records actually fetched per harvest invocation (run stats ledger).
  `CREATE TABLE IF NOT EXISTS harvest_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_run_id uuid,
    window_start_utc timestamptz NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    list_requests int NOT NULL DEFAULT 0,
    conversations_listed int NOT NULL DEFAULT 0,
    visits_done int NOT NULL DEFAULT 0,
    calls_found int NOT NULL DEFAULT 0,
    messages_scanned int NOT NULL DEFAULT 0,
    stopped_reason text
  )`,
  // ================= PERFORMANCE MANAGEMENT (PIP module, Phase 1) =================
  // Owner directive 9/30: deterministic, evidence-based, manager-driven.
  // Lifecycle draft → issued (frozen evidence snapshot) → completed|cancelled.
  // History is never deleted. rep_id FK is ON DELETE SET NULL (NOT NULL is
  // enforced at the app layer) so the demo-user purge can never wedge on a PIP
  // row — the FK-safe-delete lesson from the demo-purge hotfixes.
  `CREATE TABLE IF NOT EXISTS pips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rep_id uuid REFERENCES users(id) ON DELETE SET NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    goal_text text,
    weekly_goal_min integer,
    hard_weekly_minimum boolean NOT NULL DEFAULT false,
    review_start_date date,
    review_end_date date,
    pip_start_date date,
    pip_end_date date,
    manager_observations text,
    action_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
    personal_development_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
    professional_development_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
    conclusion_category text,
    conclusion_notes text,
    issued_at timestamptz,
    issued_by text,
    completed_at timestamptz,
    cancelled_at timestamptz,
    cancelled_by text,
    cancellation_reason text,
    employee_visible boolean NOT NULL DEFAULT false,
    current_version integer NOT NULL DEFAULT 1,
    employee_acked_at timestamptz,
    employee_acked_by text,
    manager_acked_at timestamptz,
    manager_acked_by text,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    template_id uuid,
    template_version integer,
    checkin_cadence_days integer
  )`,
  // PHASE 2 MIGRATIONS (additive, idempotent): template provenance on the
  // PIP row + the check-in cadence + template versioning. ALTER ... IF NOT
  // EXISTS runs on every boot and is a no-op after the first.
  `ALTER TABLE pips ADD COLUMN IF NOT EXISTS template_id uuid`,
  `ALTER TABLE pips ADD COLUMN IF NOT EXISTS template_version integer`,
  `ALTER TABLE pips ADD COLUMN IF NOT EXISTS checkin_cadence_days integer`,
  `CREATE INDEX IF NOT EXISTS pips_template_idx ON pips (template_id)`,
  `ALTER TABLE pip_templates ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`,
  `CREATE INDEX IF NOT EXISTS pips_status_idx ON pips (status)`,
  `CREATE INDEX IF NOT EXISTS pips_rep_idx ON pips (rep_id)`,
  // Frozen-evidence snapshots: written ONLY at issue time (amendments later
  // add NEW version rows). Write-once enforced by UNIQUE (pip_id, version);
  // nothing in the store ever UPDATEs these rows.
  `CREATE TABLE IF NOT EXISTS pip_evidence_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pip_id uuid NOT NULL REFERENCES pips(id) ON DELETE CASCADE,
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (pip_id, version)
  )`,
  // Manager check-ins during an ISSUED review (append-only; never updated).
  `CREATE TABLE IF NOT EXISTS pip_checkins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pip_id uuid NOT NULL REFERENCES pips(id) ON DELETE CASCADE,
    checkin_date date NOT NULL,
    manager_name text,
    employee_name text,
    current_performance text,
    topics_discussed text,
    coaching_provided text,
    employee_comments text,
    manager_notes text,
    next_actions text,
    next_checkin_date date,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS pip_checkins_pip_idx ON pip_checkins (pip_id)`,
  // Manager-created reusable templates (applying them to drafts is a later phase).
  `CREATE TABLE IF NOT EXISTS pip_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    category text,
    default_goal_text text,
    default_action_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
    default_personal jsonb NOT NULL DEFAULT '[]'::jsonb,
    default_professional jsonb NOT NULL DEFAULT '[]'::jsonb,
    default_checkin_cadence_days integer,
    default_duration_weeks integer,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Typed module event log (primary PIP audit trail; every event is ALSO
  // mirrored compactly into manual_overrides for the existing Audit page).
  // History never deleted — deliberately NO FK on pip_id so log rows outlive
  // everything else.
  `CREATE TABLE IF NOT EXISTS pip_event_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pip_id uuid,
    template_id uuid,
    event_type text NOT NULL,
    actor text,
    field text,
    previous_value text,
    new_value text,
    details jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS pip_event_log_pip_idx ON pip_event_log (pip_id, created_at DESC)`,
  // COMMISSION WEEKLY RECORD (spec §F): one row per (user, week) — the close
  // job writes it at the Sunday ET cutoff, the historical backfill writes past
  // weeks deliberately. UNIQUE(user_id, week_start) makes re-runs idempotent.
  // Money columns are dollars (numeric 12,2 — cents precision internal).
  `CREATE TABLE IF NOT EXISTS commission_weekly (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    rep_name text NOT NULL,
    week_start date NOT NULL,
    week_end date NOT NULL,
    employment_type text NOT NULL,
    tier integer NOT NULL,
    tier_effective_date_used text,
    qualifying_bookings integer NOT NULL,
    base_commission numeric(12,2) NOT NULL DEFAULT 0,
    additional_commission numeric(12,2) NOT NULL DEFAULT 0,
    pool_bonus numeric(12,2) NOT NULL DEFAULT 0,
    hole_bonus numeric(12,2) NOT NULL DEFAULT 0,
    manual_adjustment numeric(12,2) NOT NULL DEFAULT 0,
    total numeric(12,2) NOT NULL DEFAULT 0,
    calc_date timestamptz NOT NULL,
    calc_version integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'final',
    cycle_id text,
    assignment text NOT NULL DEFAULT 'unassigned',
    counted_bookings jsonb NOT NULL DEFAULT '[]'::jsonb,
    hole_audit jsonb NOT NULL DEFAULT '[]'::jsonb,
    hole_bonus_capped boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, week_start)
  )`,
  `CREATE INDEX IF NOT EXISTS commission_weekly_week_idx ON commission_weekly (week_start)`,
  // MIGRATION (Phase B, 10/2): deployments whose commission_weekly was created
  // by an earlier Phase A iteration lack the narrowed RULING-3 audit column —
  // CREATE TABLE IF NOT EXISTS skips existing tables, so reads crash with
  // "column hole_audit does not exist". Same fill-only ALTER pattern as the
  // users commission columns above.
  `ALTER TABLE commission_weekly ADD COLUMN IF NOT EXISTS hole_audit jsonb NOT NULL DEFAULT '[]'::jsonb`,
  // MIGRATION (RULING 5, 10/2): the owner's hole-bonus cap flag (week began
  // with >8 open slots → hole_bonus 0 for every rep). Same fill-only ALTER.
  `ALTER TABLE commission_weekly ADD COLUMN IF NOT EXISTS hole_bonus_capped boolean NOT NULL DEFAULT false`,
  // COMMISSION CYCLE (spec §S): stored composition, preserved forever. Text
  // slug id so the historical backfill is deterministic.
  `CREATE TABLE IF NOT EXISTS commission_cycles (
    id text PRIMARY KEY,
    label text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    submission_date date NOT NULL,
    payroll_date date NOT NULL,
    status text NOT NULL DEFAULT 'in_progress',
    submitted_date date,
    submitted_by text,
    final_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // CORRECTIONS AUDIT (spec §O/§29): reason REQUIRED (store-enforced).
  `CREATE TABLE IF NOT EXISTS commission_adjustments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id text,
    user_id uuid,
    target text NOT NULL,
    target_id text NOT NULL,
    field text NOT NULL,
    old_value text,
    new_value text,
    reason text NOT NULL,
    changed_by text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS commission_adjustments_cycle_idx ON commission_adjustments (cycle_id, changed_at DESC)`,
  // ---- AVAILABILITY FEED CACHE (availability rebuild PR-1, 2026-10-06) ----
  // Blueprint: design/availability-rebuild-investigation.md §3 — four NEW
  // tables, additive only; the appointments table schema is untouched.
  // Live-only data: demo mode never writes or reads these tables.
  // Cached Acuity OPEN (bookable) slot per (calendar, ET date, ET time).
  // REPLACE-per-(calendar,date) via putAvailabilitySlotsForDate: the fresh
  // feed answer is the current truth; first_seen_at is preserved on upsert.
  `CREATE TABLE IF NOT EXISTS availability_slots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    calendar_id text NOT NULL,
    date_et date NOT NULL,
    time_et text NOT NULL,
    slots_available int NOT NULL DEFAULT 1,
    source text NOT NULL DEFAULT 'acuity',
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_confirmed_at timestamptz NOT NULL DEFAULT now(),
    run_id uuid NOT NULL,
    UNIQUE (calendar_id, date_et, time_et)
  )`,
  `CREATE INDEX IF NOT EXISTS availability_slots_date_idx ON availability_slots (date_et)`,
  // Full-month date-index cache per (calendar × representative appointment
  // type) — the cheap index that answers "does this month have any
  // availability" and IS the coverage horizon when the month answers [].
  `CREATE TABLE IF NOT EXISTS availability_dates (
    calendar_id text NOT NULL,
    appointment_type_id text NOT NULL,
    month text NOT NULL,
    dates_et date[] NOT NULL,
    fetched_at timestamptz NOT NULL,
    run_id uuid NOT NULL,
    PRIMARY KEY (calendar_id, appointment_type_id, month)
  )`,
  `CREATE INDEX IF NOT EXISTS availability_dates_month_idx ON availability_dates (month)`,
  // Detailed availability-run record (the generic sync_runs row for provider
  // "acuity_availability" rides the existing machinery; this one carries the
  // scope + pacing-audit the sync panel shows).
  `CREATE TABLE IF NOT EXISTS availability_sync_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL,
    scope jsonb NOT NULL,
    calls_made int,
    started_at timestamptz,
    finished_at timestamptz,
    error text
  )`,
  // Detected feed-vs-truth mismatches. PARTIAL unique index: while a
  // discrepancy is UNRESOLVED it is stored once per (calendar, date, time,
  // kind); after resolution a later re-detection inserts a NEW row (history
  // preserved). putAvailabilitySlotsForDate + applyAvailabilityDiscrepancies
  // run inside the availability-feed advisory lock (see methods below).
  `CREATE TABLE IF NOT EXISTS availability_discrepancies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL,
    calendar_id text NOT NULL,
    date_et date NOT NULL,
    time_et text NOT NULL,
    kind text NOT NULL,
    detail jsonb NOT NULL,
    detected_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS availability_discrepancies_key_idx ON availability_discrepancies (calendar_id, date_et, time_et)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS availability_discrepancies_open_unique_idx
     ON availability_discrepancies (calendar_id, date_et, time_et, kind) WHERE resolved_at IS NULL`
];

/**
 * S7c: normalize a pg `date` cell into the YYYY-MM-DD calendar string the
 * metrics layer compares. postgres.js parses `date` columns into JS Date
 * objects (midnight), so the value must go through ISO formatting — a bare
 * String(date).slice(0,10) produces "Tue Sep 08" and every downstream
 * DATE_ONLY_RE / range comparison silently fails. Strings already in
 * YYYY-MM-DD shape pass through; anything else is null (never a guess).
 */
export function normalizePgBusinessDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * ---------------------------------------------------------------------------
 * POOL PROFILES — the connection budget under the managed Postgres ceiling.
 *
 * Measured on the managed host (2026-10-06, SHOW): max_connections=105,
 * reserved_connections=5, superuser_reserved_connections=12 → a regular role
 * can hold 105 − 5 − 12 = **88 slots**; once those are gone new connections
 * are rejected with SQLSTATE 53300 (the "pg_use_reserved_connections"
 * rejection seen during the Oct 2026 transient-500 window).
 *
 * Connection math (worst case → headroom):
 *   2 web servers (dev :3000 vite SSR + published serve.ts) × max 12 = 24
 *   sync jobs (scheduler tick, SYNC NOW, ops scripts) share the process
 *     store — 0 extra in web processes; a standalone job-profile process = 4
 *   test batteries (bun test, parallel files, NODE_ENV=test) × max 4 ≈ ≤ 40
 *     transiently
 *   platform exporter + managed-host background workers ≈ 2–4 (not ours)
 *   → steady-state ≈ 28, transient peak ≈ ≤ 68 of 88 — ≥ 20 slots of
 *     headroom at all times. The old config (max 16, idle_timeout 240s, no
 *     documented max_lifetime) warmed ~16 idle conns per pool generation
 *     across both servers plus per-instance probe/CLI pools and crossed the
 *     ceiling during the dual-restart + sync window.
 *
 * idle_timeout 60s (was 240s): a heavy page fills the pool with 15–30
 * parallel queries; after the burst the pool sheds within a minute instead
 * of holding up to max warm conns for 4 minutes per server. The 90s
 * scheduler cadence re-warms the 1–2 conns a tick needs (TLS handshake is
 * tens of ms; postgres.js already backs off internally on connect). For
 * tests idle_timeout is 10s so parallel test files shed conns immediately
 * after their battery.
 * max_lifetime 1800s (30 min, was the library's implicit 30–60 min random):
 * explicit cap — managed proxies/host balancers recycle long-lived conns.
 * ---------------------------------------------------------------------------
 */
export type PoolProfile = "web" | "job" | "test";

export interface PoolProfileOptions {
  max: number;
  idle_timeout: number;
  max_lifetime: number;
}

export const POOL_PROFILES: Record<PoolProfile, PoolProfileOptions> = {
  web: { max: 12, idle_timeout: 60, max_lifetime: 1800 },
  job: { max: 4, idle_timeout: 60, max_lifetime: 1800 },
  test: { max: 4, idle_timeout: 10, max_lifetime: 300 },
};

/**
 * Resolve the pool options for a profile. `profile` absent → test profile
 * under NODE_ENV=test (bun test), web otherwise — so every `new PgStore(url)`
 * call site (tests construct directly, per-file) is automatically bounded
 * without touching dozens of files.
 */
export function resolvePoolOptions(profile?: PoolProfile): { profile: PoolProfile } & PoolProfileOptions {
  const p = profile ?? (process.env.NODE_ENV === "test" ? "test" : "web");
  return { profile: p, ...POOL_PROFILES[p] };
}

export class PgStore implements Store {
  /** The pips column-list fragment (per-instance; see module-level comment). */
  private get pipCols() {
    return this.sql`id::text AS id, rep_id::text AS rep_id, title, status, goal_text, weekly_goal_min, hard_weekly_minimum,
     review_start_date::text AS review_start_date, review_end_date::text AS review_end_date,
     pip_start_date::text AS pip_start_date, pip_end_date::text AS pip_end_date,
     manager_observations, action_plan, personal_development_actions, professional_development_actions,
     conclusion_category, conclusion_notes, issued_at::text AS issued_at, issued_by,
     completed_at::text AS completed_at, cancelled_at::text AS cancelled_at, cancelled_by, cancellation_reason,
     employee_visible, current_version, employee_acked_at::text AS employee_acked_at, employee_acked_by,
     manager_acked_at::text AS manager_acked_at, manager_acked_by, created_by, created_at::text AS created_at, updated_at::text AS updated_at,
     template_id::text AS template_id, template_version, checkin_cadence_days
    `;
  }
  mode = "postgres" as const;
  private sql: ReturnType<typeof postgres>;
  private schemaReady: Promise<void> | null = null;
  /** PERF: short-TTL (20s) read cache — bumped by every write; see store/read-cache.ts. */
  private cache = new TtlReadCache();

  constructor(databaseUrl: string, options?: { profile?: PoolProfile }) {
    // Managed Postgres (Tiger Cloud) requires TLS. If the URL carries its own
    // sslmode param, let postgres.js honor it; otherwise default to ssl
    // "require" so managed hosts connect out of the box.
    let needsSsl = false;
    try {
      const u = new URL(databaseUrl);
      needsSsl = u.searchParams.get("sslmode") === null && u.protocol.startsWith("postgres");
    } catch {
      // probePg validates the URL before constructing; ignore here
    }
    // POOL HARDENING (2026-10-06): one profile-sized pool per process (see the
    // POOL PROFILES math above — 2 servers × 12 stays under the managed 88-slot
    // ceiling with headroom; tests/CLI jobs take the smaller profiles). Page
    // loaders fire 15–30 parallel queries: 12 conns = 2–3 RTT-bound waves vs
    // the old 16 — a ≤1-wave difference, and the ceiling no longer 500s pages.
    const pool = resolvePoolOptions(options?.profile);
    this.sql = postgres(databaseUrl, {
      max: pool.max,
      idle_timeout: pool.idle_timeout,
      max_lifetime: pool.max_lifetime,
      connect_timeout: 10,
      ...(needsSsl ? { ssl: "require" } : {}),
    });
  }

  /**
   * Close the underlying pool — store/index.ts closes failed probe pools so an
   * abandoned probe can never leak connections until process exit. Idempotent
   * (postgres.js end() on a closed pool is a no-op).
   */
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        for (const stmt of DDL) await this.sql.unsafe(stmt);
      })();
    }
    return this.schemaReady;
  }

  async getSettings(): Promise<AppSettings> {
    return this.cache.wrap("getSettings", () => this.getSettingsCached());
  }
  private async getSettingsCached(): Promise<AppSettings> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT value FROM app_settings WHERE key = 'app' LIMIT 1`;
    if (!rows.length) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    // Deep-merge the nested groups so settings saved before a newer default
    // field existed (e.g. studio.recurring_blocks, sheets.<sheet>.mode) still
    // see that default. Shared with the memory store via normalizeAppSettings.
    return normalizeAppSettings(rows[0].value);
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    const current = await this.getSettings();
    const next: AppSettings = {
      ...current,
      ...patch,
      studio: { ...current.studio, ...(patch.studio ?? {}) },
      sheets: { ...current.sheets, ...(patch.sheets ?? {}) },
      acuity: { ...current.acuity, ...(patch.acuity ?? {}) },
    };
    await this.sql`
      INSERT INTO app_settings (key, value) VALUES ('app', ${this.sql.json(next)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = ${this.sql.json(next)}::jsonb, updated_at = now()
    `;
    return next;
  }

  async upsertTeamGoal(row: TeamGoalRow): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`
      INSERT INTO team_goals (week_start, booking_goal, lead_budget)
      VALUES (${row.week_start}::date, ${row.booking_goal}, ${row.lead_budget})
      ON CONFLICT (week_start) DO UPDATE SET booking_goal = EXCLUDED.booking_goal, lead_budget = EXCLUDED.lead_budget, updated_at = now()
    `;
  }
  async getTeamGoal(weekStart: string): Promise<TeamGoalRow | null> {
    return this.cache.wrap("getTeamGoal:" + JSON.stringify([weekStart]), () => this.getTeamGoalCached(weekStart));
  }
  private async getTeamGoalCached(weekStart: string): Promise<TeamGoalRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT week_start::text::date::text AS week_start, booking_goal, lead_budget FROM team_goals WHERE week_start = ${weekStart}::date`;
    return rows[0] ? { week_start: String(rows[0].week_start), booking_goal: Number(rows[0].booking_goal), lead_budget: Number(rows[0].lead_budget) } : null;
  }
  async getTeamGoals(): Promise<TeamGoalRow[]> {
    return this.cache.wrap("getTeamGoals", () => this.getTeamGoalsCached());
  }
  private async getTeamGoalsCached(): Promise<TeamGoalRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT week_start::text::date::text AS week_start, booking_goal, lead_budget FROM team_goals ORDER BY week_start`;
    return rows.map((r) => ({ week_start: String(r.week_start), booking_goal: Number(r.booking_goal), lead_budget: Number(r.lead_budget) }));
  }
  async upsertRepGoals(rows: RepGoalRowFull[]): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    if (!rows.length) return;
    for (const r of rows) {
      await this.sql`
        INSERT INTO rep_goals (rep_id, week_start, goal) VALUES (${r.rep_id}::uuid, ${r.week_start}::date, ${r.goal})
        ON CONFLICT (rep_id, week_start) DO UPDATE SET goal = EXCLUDED.goal, updated_at = now()
      `;
    }
  }
  async getRepGoals(weekStart: string): Promise<RepGoalRowFull[]> {
    return this.cache.wrap("getRepGoals:" + JSON.stringify([weekStart]), () => this.getRepGoalsCached(weekStart));
  }
  private async getRepGoalsCached(weekStart: string): Promise<RepGoalRowFull[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT rep_id::text, week_start::text AS week_start, goal FROM rep_goals WHERE week_start = ${weekStart}::date`;
    return rows.map((r) => ({ rep_id: String(r.rep_id), week_start: String(r.week_start), goal: Number(r.goal) }));
  }
  async deleteRepGoal(repId: string, weekStart: string): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`DELETE FROM rep_goals WHERE rep_id = ${repId}::uuid AND week_start = ${weekStart}::date`;
  }

  async upsertMonthlyGoal(row: MonthlyGoalRow): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`
      INSERT INTO monthly_goals (month, goal) VALUES (${row.month}, ${row.goal})
      ON CONFLICT (month) DO UPDATE SET goal = EXCLUDED.goal, updated_at = now()
    `;
  }
  async getMonthlyGoal(month: string): Promise<MonthlyGoalRow | null> {
    return this.cache.wrap("getMonthlyGoal:" + JSON.stringify([month]), () => this.getMonthlyGoalCached(month));
  }
  private async getMonthlyGoalCached(month: string): Promise<MonthlyGoalRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT month, goal FROM monthly_goals WHERE month = ${month}`;
    if (rows.length === 0) return null;
    return { month: String(rows[0].month), goal: Number(rows[0].goal) };
  }
  async deleteMonthlyGoal(month: string): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`DELETE FROM monthly_goals WHERE month = ${month}`;
  }

  async getWeeklyReportNotes(weekStart: string): Promise<WeeklyReportNotesRow | null> {
    return this.cache.wrap("getWeeklyReportNotes:" + JSON.stringify([weekStart]), () => this.getWeeklyReportNotesCached(weekStart));
  }
  private async getWeeklyReportNotesCached(weekStart: string): Promise<WeeklyReportNotesRow | null> {
    await this.ensureSchema();
    // jsonb param passes the OBJECT (never a pre-stringified value) — stringifying
    // would store a quoted STRING and re-upserts would double-wrap.
    const rows = await this.sql`SELECT week_start::text AS week_start, notes FROM weekly_report_notes WHERE week_start = ${weekStart}::date`;
    if (rows.length === 0) return null;
    return {
      week_start: String(rows[0].week_start),
      notes: (rows[0].notes ?? {}) as Record<string, string>,
    };
  }
  async upsertWeeklyReportNotes(row: WeeklyReportNotesRow): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`
      INSERT INTO weekly_report_notes (week_start, notes) VALUES (${row.week_start}::date, ${row.notes}::jsonb)
      ON CONFLICT (week_start) DO UPDATE SET notes = EXCLUDED.notes, updated_at = now()
    `;
  }

  async upsertUsers(rows: UserRow[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO users (provider, external_id, name, email, is_active)
        VALUES (${r.provider}, ${r.external_id}, ${r.name}, ${r.email}, ${r.is_active})
        ON CONFLICT (provider, external_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, is_active = EXCLUDED.is_active, updated_at = now()
      `;
    }
    return rows.length;
  }
  async setUserCallStartDate(repId: string, date: string | null): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`UPDATE users SET call_start_date = ${date}, updated_at = now() WHERE id = ${repId}::uuid`;
  }
  private userRow(r: Record<string, unknown>): UserRow {
    const employmentType = r.employment_type == null ? null : String(r.employment_type);
    return {
      id: String(r.id),
      provider: String(r.provider),
      external_id: String(r.external_id),
      name: String(r.name),
      email: r.email == null ? null : String(r.email),
      is_active: Boolean(r.is_active),
      call_start_date: r.call_start_date == null ? null : String(r.call_start_date),
      // COMMISSION TRACKER profile (owner directive 2026-10-01) — always
      // populated on read; defaults = ineligible.
      employment_type: employmentType === "full_time" || employmentType === "part_time" ? employmentType : null,
      commission_tier: r.commission_tier == null ? null : Number(r.commission_tier),
      tier_effective_date: normalizePgBusinessDate(r.tier_effective_date),
      tier_end_date: normalizePgBusinessDate(r.tier_end_date),
      commission_eligible: Boolean(r.commission_eligible),
    };
  }
  async getUsers(): Promise<UserRow[]> {
    return this.cache.wrap("getUsers", () => this.getUsersCached());
  }
  private async getUsersCached(): Promise<UserRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, provider, external_id, name, email, is_active, call_start_date, employment_type, commission_tier, tier_effective_date::text::date::text AS tier_effective_date, tier_end_date::text::date::text AS tier_end_date, commission_eligible FROM users WHERE is_active ORDER BY name`;
    return rows.map((r) => this.userRow(r as Record<string, unknown>));
  }
  async getAllUsers(): Promise<UserRow[]> {
    return this.cache.wrap("getAllUsers", () => this.getAllUsersCached());
  }
  private async getAllUsersCached(): Promise<UserRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, provider, external_id, name, email, is_active, call_start_date, employment_type, commission_tier, tier_effective_date::text::date::text AS tier_effective_date, tier_end_date::text::date::text AS tier_end_date, commission_eligible FROM users ORDER BY name`;
    return rows.map((r) => this.userRow(r as Record<string, unknown>));
  }

  async upsertContacts(rows: ContactRow[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      // Canonical normalizers at the store boundary: raw stays verbatim in
      // phone/email/phone_raw/email_raw; identity keys are always derived.
      const phoneNorm = r.phone_normalized ?? normalizeUSPhone(r.phone);
      const emailNorm = r.email_normalized ?? normalizeEmail(r.email);
      await this.sql`
        INSERT INTO contacts (provider, external_id, name, phone, email, assigned_rep_id, first_name, last_name, phone_raw, phone_normalized, email_raw, email_normalized, source_created_at, source_updated_at, last_synced_at)
        VALUES (${r.provider}, ${r.external_id}, ${r.name}, ${r.phone}, ${r.email}, ${r.assigned_rep_id}, ${r.first_name ?? null}, ${r.last_name ?? null}, ${r.phone_raw ?? r.phone}, ${phoneNorm}, ${r.email_raw ?? r.email}, ${emailNorm}, ${r.source_created_at ?? null}, ${r.source_updated_at ?? null}, ${r.last_synced_at ?? null})
        ON CONFLICT (provider, external_id) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, contacts.name), phone = EXCLUDED.phone, email = EXCLUDED.email,
          assigned_rep_id = COALESCE(EXCLUDED.assigned_rep_id, contacts.assigned_rep_id),
          first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
          last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
          phone_raw = COALESCE(EXCLUDED.phone_raw, contacts.phone_raw), phone_normalized = COALESCE(EXCLUDED.phone_normalized, contacts.phone_normalized),
          email_raw = COALESCE(EXCLUDED.email_raw, contacts.email_raw), email_normalized = COALESCE(EXCLUDED.email_normalized, contacts.email_normalized),
          source_created_at = COALESCE(EXCLUDED.source_created_at, contacts.source_created_at),
          source_updated_at = COALESCE(EXCLUDED.source_updated_at, contacts.source_updated_at),
          last_synced_at = COALESCE(EXCLUDED.last_synced_at, contacts.last_synced_at),
          updated_at = now()
      `;
    }
    return rows.length;
  }
  async getContacts(): Promise<ContactRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, external_id, name, phone, email, assigned_rep_id::text, created_at::text, first_name, last_name, phone_raw, phone_normalized, email_raw, email_normalized, source_created_at::text, source_updated_at::text, last_synced_at::text FROM contacts`;
    return rows.map((r: Record<string, unknown>) => ({
      ...r,
      id: String(r.id),
      assigned_rep_id: r.assigned_rep_id ? String(r.assigned_rep_id) : null,
      created_at: String(r.created_at),
      first_name: r.first_name == null ? null : String(r.first_name),
      last_name: r.last_name == null ? null : String(r.last_name),
      phone_raw: r.phone_raw == null ? null : String(r.phone_raw),
      phone_normalized: r.phone_normalized == null ? null : String(r.phone_normalized),
      email_raw: r.email_raw == null ? null : String(r.email_raw),
      email_normalized: r.email_normalized == null ? null : String(r.email_normalized),
      source_created_at: r.source_created_at == null ? null : String(r.source_created_at),
      source_updated_at: r.source_updated_at == null ? null : String(r.source_updated_at),
      last_synced_at: r.last_synced_at == null ? null : String(r.last_synced_at),
    })) as unknown as ContactRow[];
  }
  async countContacts(provider: string): Promise<number> {
    await this.ensureSchema();
    const [{ n }] = await this.sql`SELECT count(*)::int AS n FROM contacts WHERE provider = ${provider}`;
    return Number(n);
  }
  async getContactExternalIds(provider: string, only?: string[]): Promise<ContactExternalIdRow[]> {
    await this.ensureSchema();
    // Two columns only — the S4 per-tick read that retires the full-row
    // materialization. `only` narrows to specific external ids (targeted
    // linkage lookup; empty list → empty result, never a full scan).
    const rows = only
      ? only.length
        ? await this.sql`SELECT id::text AS id, external_id FROM contacts WHERE provider = ${provider} AND external_id = ANY(${only})`
        : []
      : await this.sql`SELECT id::text AS id, external_id FROM contacts WHERE provider = ${provider}`;
    return (rows as Record<string, unknown>[]).map((r) => ({ id: String(r.id), external_id: String(r.external_id) }));
  }

  /**
   * PERF (identity slice): the Settings page and the attribution engine's
   * identity resolution only consume id/phone/email/assigned_rep_id. The full
   * getContacts() materializes 18 columns × ~116k rows over the remote wire
   * (~1s RTT-bound); this reads only the consumed columns. Row VALUES are
   * identical for those fields — no semantics change.
   */
  async getContactIdentityRows(): Promise<ContactIdentityRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, phone, email, assigned_rep_id::text AS assigned_rep_id FROM contacts`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      phone: r.phone == null ? null : String(r.phone),
      email: r.email == null ? null : String(r.email),
      assigned_rep_id: r.assigned_rep_id ? String(r.assigned_rep_id) : null,
    }));
  }
  async upsertCalls(
    rows: (CallRow & { external_call_id: string; provider: string; contact_resolution_method?: string | null; contact_resolved_at?: string | null })[],
  ): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO calls (provider, external_call_id, rep_id, contact_id, direction, call_status, started_at, duration_seconds, over_two_minutes, provider_rep_external_id, conversation_id)
        VALUES (${r.provider}, ${r.external_call_id}, ${r.rep_id}, ${r.contact_id}, ${r.direction ?? null}, ${r.call_status ?? null}, ${r.started_at}, ${r.duration_seconds}, ${r.duration_seconds > 120}, ${r.provider_rep_external_id ?? null}, ${r.conversation_id ?? null})
        ON CONFLICT (provider, external_call_id) DO UPDATE SET
          rep_id = COALESCE(EXCLUDED.rep_id, calls.rep_id), contact_id = COALESCE(EXCLUDED.contact_id, calls.contact_id), direction = EXCLUDED.direction,
          call_status = EXCLUDED.call_status, started_at = EXCLUDED.started_at,
          duration_seconds = EXCLUDED.duration_seconds, over_two_minutes = EXCLUDED.over_two_minutes,
          provider_rep_external_id = COALESCE(EXCLUDED.provider_rep_external_id, calls.provider_rep_external_id),
          conversation_id = COALESCE(EXCLUDED.conversation_id, calls.conversation_id), updated_at = now()
      `;
    }
    return rows.length;
  }
  private callRow(r: Record<string, unknown>): CallRow {
    return {
      id: String(r.id),
      rep_id: r.rep_id ? String(r.rep_id) : null,
      contact_id: r.contact_id ? String(r.contact_id) : null,
      started_at: new Date(r.started_at as string).toISOString(),
      duration_seconds: Number(r.duration_seconds),
      over_two_minutes: Boolean(r.over_two_minutes),
      // HL call id — the attribution engine's candidate id (external↔internal
      // resolution for manual assignment; tie-breaks identical re-runs).
      external_call_id: r.external_call_id == null ? null : String(r.external_call_id),
      // RAW HL user id — mapping-driven eligibility is computed from it at
      // query time; the stored row is never rewritten.
      provider_rep_external_id: r.provider_rep_external_id == null ? null : String(r.provider_rep_external_id),
      // RAW HL conversation id — the call→contact backfill's parent tier.
      conversation_id: r.conversation_id == null ? null : String(r.conversation_id),
      // Resolution provenance (call→contact backfill; null = never backfilled).
      contact_resolution_method: r.contact_resolution_method == null ? null : String(r.contact_resolution_method),
    };
  }
  async getCallsBetween(startUtc: string, endUtc: string): Promise<CallRow[]> {
    return this.cache.wrap("getCallsBetween:" + JSON.stringify([startUtc, endUtc]), () => this.getCallsBetweenCached(startUtc, endUtc));
  }
  private async getCallsBetweenCached(startUtc: string, endUtc: string): Promise<CallRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, rep_id, contact_id, started_at, duration_seconds, over_two_minutes, external_call_id, provider_rep_external_id, conversation_id, contact_resolution_method FROM calls WHERE started_at >= ${startUtc} AND started_at < ${endUtc}`;
    return rows.map((r) => this.callRow(r as Record<string, unknown>));
  }
  async getAllCallsSince(startUtc: string): Promise<CallRow[]> {
    return this.cache.wrap("getAllCallsSince:" + JSON.stringify([startUtc]), () => this.getAllCallsSinceCached(startUtc));
  }
  private async getAllCallsSinceCached(startUtc: string): Promise<CallRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, rep_id, contact_id, started_at, duration_seconds, over_two_minutes, external_call_id, provider_rep_external_id, conversation_id, contact_resolution_method FROM calls WHERE started_at >= ${startUtc}`;
    return rows.map((r) => this.callRow(r as Record<string, unknown>));
  }
  async getAuditCalls(startUtc: string, endUtc: string, repSpec: string | null, thresholdSeconds: number): Promise<AuditCallRow[]> {
    await this.ensureSchema();
    // repSpec is one of the endpoint-validated buckets. Ownership resolves in
    // TWO steps (both stores must agree — memory.ts mirrors this exactly):
    //   1. rep_id linkage: c.rep_id → users u (the linked owner, any provider).
    //   2. raw HL user id: provider_rep_external_id → users pu (owner known
    //      even when the row was stored with rep_id NULL — the shape the live
    //      harvest writes for calls whose user row did not exist yet).
    //   "non-roster"   = Non Roster Calls: owner KNOWN and NOT on the active
    //                    roster (linked-inactive OR resolved-from-raw-id).
    //   "unattributed" = Unattributed: NO determinable owner (rep_id NULL and
    //                    the raw HL user id missing or resolving to no user).
    //   "unassigned"   = legacy alias = the union of both buckets.
    // Roster-linked rows (owner active) stay in every bucket's complement.
    const repFilter =
      repSpec === "non-roster"
        ? this.sql`((c.rep_id IS NOT NULL AND (u.id IS NULL OR u.is_active = false))
             OR (c.rep_id IS NULL AND pu.id IS NOT NULL AND pu.is_active = false))`
        : repSpec === "unattributed"
          ? this.sql`(c.rep_id IS NULL AND pu.id IS NULL)`
          : repSpec === "unassigned"
            ? this.sql`((c.rep_id IS NOT NULL AND (u.id IS NULL OR u.is_active = false))
             OR (c.rep_id IS NULL AND (pu.id IS NULL OR pu.is_active = false)))`
            : repSpec && repSpec !== "all"
              ? this.sql`c.rep_id = ${repSpec}::uuid`
              : this.sql`TRUE`;
    const rows = await this.sql`
      SELECT c.external_call_id, c.conversation_id, c.provider_rep_external_id,
             c.rep_id::text AS rep_id, u.name AS rep_name, u.is_active AS rep_is_active,
             pu.name AS prov_rep_name, pu.is_active AS prov_is_active,
             c.contact_id::text AS contact_id, ct.name AS contact_name, ct.external_id AS contact_external_id,
             c.contact_resolution_method,
             c.direction, c.call_status, c.started_at::text AS started_at, c.duration_seconds,
             (c.duration_seconds > ${thresholdSeconds}) AS over_threshold
      FROM calls c
      LEFT JOIN users u ON u.id = c.rep_id
      LEFT JOIN users pu ON pu.provider = c.provider AND pu.external_id = c.provider_rep_external_id
      LEFT JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.started_at >= ${startUtc} AND c.started_at < ${endUtc} AND ${repFilter}
      ORDER BY c.started_at DESC, c.external_call_id`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      external_call_id: String(r.external_call_id),
      conversation_id: r.conversation_id == null ? null : String(r.conversation_id),
      rep_id: r.rep_id == null ? null : String(r.rep_id),
      // Raw linkage first; rows resolved from the raw HL user id show that
      // owner's name/state so Non Roster Calls are human-readable.
      rep_name: (r.rep_name ?? r.prov_rep_name) == null ? null : String(r.rep_name ?? r.prov_rep_name),
      rep_is_active: (r.rep_is_active ?? r.prov_is_active) == null ? null : Boolean(r.rep_is_active ?? r.prov_is_active),
      provider_rep_external_id: r.provider_rep_external_id == null ? null : String(r.provider_rep_external_id),
      contact_id: r.contact_id == null ? null : String(r.contact_id),
      contact_name: r.contact_name == null ? null : String(r.contact_name),
      contact_external_id: r.contact_external_id == null ? null : String(r.contact_external_id),
      contact_resolution_method: r.contact_resolution_method == null ? null : String(r.contact_resolution_method),
      direction: r.direction == null ? null : String(r.direction),
      call_status: r.call_status == null ? null : String(r.call_status),
      started_at: new Date(r.started_at as string).toISOString(),
      duration_seconds: Number(r.duration_seconds),
      over_threshold: Boolean(r.over_threshold),
    }));
  }

  /**
   * BATCHED upsert (pool discipline, 2026-09-29): the full opportunity
   * snapshot is ~10k rows — one statement per row floods the pg pool with
   * sequential round-trips (the 9/29 500s were pool exhaustion). Rows go up in
   * 500-row multi-VALUES INSERT ... ON CONFLICT statements (5.5k params per
   * statement, far under PG's param ceiling); each chunk is one round-trip on
   * one pooled connection.
   */
  async upsertOpportunities(rows: OpportunityRow[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    // DEFENSIVE (lead review 9/29): the live dataset shifts between fetch and
    // write (a GHL-side import landed mid-run and postgres.js hard-throws
    // UNDEFINED_VALUE on any undefined bind). Every non-key column is nullable
    // in the schema — coerce undefined to null at the boundary instead of
    // letting one transient row kill a whole snapshot write.
    const norm = rows.map((r) => ({
      provider: r.provider,
      external_id: r.external_id,
      name: r.name ?? null,
      status: r.status ?? null,
      monetary_value: r.monetary_value ?? null,
      contact_id: r.contact_id ?? null,
      rep_id: r.rep_id ?? null,
      pipeline_id: r.pipeline_id ?? null,
      stage_id: r.stage_id ?? null,
      source_created_at: r.source_created_at ?? null,
      source_updated_at: r.source_updated_at ?? null,
    }));
    const CHUNK = 500;
    for (let i = 0; i < norm.length; i += CHUNK) {
      const chunk = norm.slice(i, i + CHUNK);
      // Per-row explicit binds — the SAME proven pattern as upsertContacts.
      // (The sql(array, cols) object helper AND sql.join of fragments BOTH
      // threw UNDEFINED_VALUE under this runtime even on fully-defined rows;
      // reproduced 2026-09-29.) Small concurrent waves keep wall time sane
      // over the network RTT while staying well under the pool ceiling.
      const WAVE = 8;
      for (let j = 0; j < chunk.length; j += WAVE) {
        await Promise.all(chunk.slice(j, j + WAVE).map((r) => this.sql`
          INSERT INTO opportunities (provider, external_id, name, status, monetary_value, contact_id, rep_id, pipeline_id, stage_id, source_created_at, source_updated_at)
          VALUES (${r.provider}, ${r.external_id}, ${r.name}, ${r.status}, ${r.monetary_value}, ${r.contact_id}, ${r.rep_id}, ${r.pipeline_id}, ${r.stage_id}, ${r.source_created_at}, ${r.source_updated_at})
          ON CONFLICT (provider, external_id) DO UPDATE SET
            name = EXCLUDED.name, status = EXCLUDED.status, monetary_value = EXCLUDED.monetary_value,
            contact_id = EXCLUDED.contact_id, rep_id = EXCLUDED.rep_id,
            pipeline_id = EXCLUDED.pipeline_id, stage_id = EXCLUDED.stage_id,
            source_created_at = EXCLUDED.source_created_at, source_updated_at = EXCLUDED.source_updated_at, updated_at = now()
        `));
      }
    }
    return rows.length;
  }
  /** Mirror of MemoryStore: drop the demo generator's Acuity rows — appointments
   * with acuity_appointment_id prefixed "demo-" and demo blocked rows (provider
   * acuity). Manual and recurring blocks stay. Idempotent. */
  async deleteDemoAcuityRows(): Promise<{ appointments: number; blocked: number }> {
    const a = await this.sql`DELETE FROM appointments WHERE acuity_appointment_id LIKE 'demo-%' RETURNING id`;
    const b = await this.sql`DELETE FROM blocked_times WHERE provider = 'acuity' AND external_id LIKE 'demo-%' RETURNING id`;
    return { appointments: a.length, blocked: b.length };
  }

  /** Mirror of MemoryStore: demo rows are GHL rows whose external ids are prefixed
   * "demo-". References (appointments/leads/opportunities/contacts/rep_goals) are
   * nulled BEFORE the demo rows go so FK constraints hold and history survives;
   * attribution rows keep history with just the call link nulled. Idempotent. */
  async deleteDemoHighLevelRows(): Promise<{ users: number; contacts: number; calls: number }> {
    await this.sql`UPDATE booking_attributions SET call_id = NULL
      WHERE call_id IN (SELECT id FROM calls WHERE provider = 'highlevel' AND external_call_id LIKE 'demo-%')`;
    const calls = await this.sql`DELETE FROM calls WHERE provider = 'highlevel' AND external_call_id LIKE 'demo-%' RETURNING id`;
    await this.sql`UPDATE appointments SET contact_id = NULL
      WHERE contact_id IN (SELECT id FROM contacts WHERE provider = 'highlevel' AND external_id LIKE 'demo-%')`;
    await this.sql`UPDATE leads SET contact_id = NULL
      WHERE contact_id IN (SELECT id FROM contacts WHERE provider = 'highlevel' AND external_id LIKE 'demo-%')`;
    await this.sql`UPDATE leads SET assigned_rep_id = NULL
      WHERE assigned_rep_id IN (SELECT id FROM users WHERE provider = 'highlevel' AND external_id LIKE 'demo-%')`;
    await this.sql`UPDATE opportunities SET contact_id = NULL
      WHERE contact_id IN (SELECT id FROM contacts WHERE provider = 'highlevel' AND external_id LIKE 'demo-%')`;
    await this.sql`UPDATE opportunities SET rep_id = NULL
      WHERE rep_id IN (SELECT id FROM users WHERE provider = 'highlevel' AND external_id LIKE 'demo-%')`;
    await this.sql`UPDATE contacts SET assigned_rep_id = NULL
      WHERE assigned_rep_id IN (SELECT id FROM users WHERE provider = 'highlevel' AND external_id LIKE 'demo-%')`;
    await this.sql`DELETE FROM rep_goals
      WHERE rep_id IN (SELECT id FROM users WHERE provider = 'highlevel' AND external_id LIKE 'demo-%')`;
    const contacts = await this.sql`DELETE FROM contacts WHERE provider = 'highlevel' AND external_id LIKE 'demo-%' RETURNING id`;
    const users = await this.sql`DELETE FROM users WHERE provider = 'highlevel' AND external_id LIKE 'demo-%' RETURNING id`;
    return { users: users.length, contacts: contacts.length, calls: calls.length };
  }

  async getOpportunities(): Promise<OpportunityRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, external_id, name, status, monetary_value, contact_id::text, rep_id::text, pipeline_id, stage_id, source_created_at::text, source_updated_at::text FROM opportunities`;
    return rows.map((r) => this.opportunityRow(r));
  }
  /** Opportunities on specific GHL pipelines (Alliance/Auction lead counts — no full-table scan on page loads). */
  async getOpportunitiesByPipelines(pipelineIds: string[]): Promise<OpportunityRow[]> {
    if (pipelineIds.length === 0) return [];
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, external_id, name, status, monetary_value, contact_id::text, rep_id::text, pipeline_id, stage_id, source_created_at::text, source_updated_at::text FROM opportunities WHERE pipeline_id IN ${this.sql(pipelineIds)}`;
    return rows.map((r) => this.opportunityRow(r));
  }
  private opportunityRow(r: Record<string, unknown>): OpportunityRow {
    return {
      id: String(r.id),
      provider: String(r.provider),
      external_id: String(r.external_id),
      name: r.name === null ? null : String(r.name),
      status: r.status === null ? null : String(r.status),
      monetary_value: r.monetary_value === null ? null : Number(r.monetary_value),
      contact_id: r.contact_id === null ? null : String(r.contact_id),
      rep_id: r.rep_id === null ? null : String(r.rep_id),
      pipeline_id: r.pipeline_id === null ? null : String(r.pipeline_id),
      stage_id: r.stage_id === null ? null : String(r.stage_id),
      source_created_at: r.source_created_at === null ? null : String(r.source_created_at),
      source_updated_at: r.source_updated_at === null ? null : String(r.source_updated_at),
    };
  }
  // RESTORED 9/29 (PR #18 follow-up): PR #17's refactor dropped PgStore's only
  // appointments writer — every Acuity sync then crashed at
  // "store.upsertAppointments is not a function" once the demo-purge hotfix
  // unblocked it. Recovered verbatim from pre-#17 main (e2f3412).
  async upsertAppointments(rows: (AppointmentRow & { acuity_appointment_id: string; client_name?: string | null; client_phone?: string | null; client_email?: string | null; created_business_date?: string | null; created_time_source?: string | null; created_time_precision?: string | null; raw?: Record<string, unknown> | null; payment_state?: string | null; booking_win_business_date?: string | null; payment_business_date_source?: string | null; first_seen_paid_at?: string | null })[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO appointments (acuity_appointment_id, contact_id, calendar_id, calendar_name, appointment_type, appointment_datetime, duration_minutes, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, cancelled_at, cancellation_source, client_name, client_phone, client_email)
        VALUES (${r.acuity_appointment_id}, ${r.contact_id}, ${r.calendar_id}, ${r.calendar_name ?? null}, ${r.appointment_type}, ${r.appointment_datetime}, ${r.duration_minutes ?? null}, ${r.created_at}, ${r.created_business_date ?? null}, ${r.created_time_source ?? null}, ${r.created_time_precision ?? null}, ${r.payment_state ?? null}, ${r.booking_win_business_date ?? null}, ${r.payment_business_date_source ?? null}, ${r.first_seen_paid_at ?? null}, ${r.raw ?? null}, ${r.status}, ${r.cancelled}, ${r.cancelled_at ?? null}, ${r.cancellation_source ?? null}, ${r.client_name ?? null}, ${r.client_phone ?? null}, ${r.client_email ?? null})
        ON CONFLICT (acuity_appointment_id) DO UPDATE SET
          contact_id = EXCLUDED.contact_id, calendar_id = EXCLUDED.calendar_id, calendar_name = EXCLUDED.calendar_name,
          appointment_type = EXCLUDED.appointment_type, appointment_datetime = EXCLUDED.appointment_datetime,
          duration_minutes = EXCLUDED.duration_minutes, created_at = EXCLUDED.created_at,
          created_business_date = EXCLUDED.created_business_date, created_time_source = EXCLUDED.created_time_source,
          created_time_precision = EXCLUDED.created_time_precision,
          -- BOOKING WIN (rev 12): payment state always follows the latest raw
          -- derivation; the WIN evidence (win date, provenance, first-seen
          -- stamp) is WRITE-ONCE — an existing non-null value is never
          -- overwritten, so an appointment never counts twice and its win date
          -- never moves after the fact.
          payment_state = EXCLUDED.payment_state,
          booking_win_business_date = COALESCE(appointments.booking_win_business_date, EXCLUDED.booking_win_business_date),
          payment_business_date_source = COALESCE(appointments.payment_business_date_source, EXCLUDED.payment_business_date_source),
          first_seen_paid_at = COALESCE(appointments.first_seen_paid_at, EXCLUDED.first_seen_paid_at),
          -- PENDING PAYMENT DISMISSAL (owner request 9/30): pending_dismissed_at is
          -- NOT in this SET list on purpose — the owner's ✕ dismissal is
          -- owner-controlled state; the Acuity sync never overwrites or clears it.
          raw = EXCLUDED.raw,
          -- CANCELLATION (owner report 10/6): write-once — a row confirmed
          -- cancelled (by the reconciliation or the provider payload) is never
          -- un-cancelled by a later upsert, and cancelled_at/source never move.
          cancelled = appointments.cancelled OR EXCLUDED.cancelled,
          cancelled_at = COALESCE(appointments.cancelled_at, EXCLUDED.cancelled_at),
          cancellation_source = COALESCE(appointments.cancellation_source, EXCLUDED.cancellation_source),
          status = CASE WHEN (appointments.cancelled OR EXCLUDED.cancelled) THEN 'cancelled' ELSE EXCLUDED.status END,
          client_name = EXCLUDED.client_name, client_phone = EXCLUDED.client_phone, client_email = EXCLUDED.client_email, updated_at = now()
      `;
    }
    return rows.length;
  }
  private apptRow(r: Record<string, unknown>): AppointmentRow {
    return {
      id: String(r.id),
      contact_id: r.contact_id ? String(r.contact_id) : null,
      calendar_id: r.calendar_id ? String(r.calendar_id) : null,
      appointment_type: String(r.appointment_type ?? ""),
      appointment_datetime: new Date(r.appointment_datetime as string).toISOString(),
      created_at: new Date(r.created_at as string).toISOString(),
      // S7c: the ET business date arrives as a pg `date` — postgres.js parses
      // that into a JS Date (UTC midnight), so String().slice(0,10) yields
      // "Tue Sep 08" garbage and every downstream DATE_ONLY_RE check fails.
      // Normalize to the YYYY-MM-DD calendar string the metrics layer compares.
      created_business_date: normalizePgBusinessDate(r.created_business_date),
      created_time_source: r.created_time_source == null ? null : String(r.created_time_source),
      created_time_precision: r.created_time_precision == null ? null : String(r.created_time_precision),
      // BOOKING WIN payment model (rev 12): same pg-date normalization for the
      // win bucket; the first-seen stamp is a real timestamptz → ISO.
      payment_state: r.payment_state == null ? null : String(r.payment_state),
      booking_win_business_date: normalizePgBusinessDate(r.booking_win_business_date),
      payment_business_date_source: r.payment_business_date_source == null ? null : String(r.payment_business_date_source),
      first_seen_paid_at: r.first_seen_paid_at == null ? null : new Date(r.first_seen_paid_at as string).toISOString(),
      raw: (r.raw ?? null) as Record<string, unknown> | null,
      acuity_appointment_id: r.acuity_appointment_id == null ? null : String(r.acuity_appointment_id),
      client_name: r.client_name == null ? null : String(r.client_name),
      status: String(r.status),
      cancelled: Boolean(r.cancelled),
      cancelled_at: r.cancelled_at == null ? null : new Date(r.cancelled_at as string).toISOString(),
      cancellation_source: r.cancellation_source == null ? null : String(r.cancellation_source),
    };
  }
  async getAppointmentsCreatedBusinessDateBetween(start: string, end: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    // S7c: created-based metrics bucket on the ET BUSINESS DATE column.
    const rows = await this.sql`SELECT id, contact_id, calendar_id, acuity_appointment_id::text AS acuity_appointment_id, client_name, appointment_type, appointment_datetime, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, cancelled_at, cancellation_source FROM appointments WHERE created_business_date >= ${start}::date AND created_business_date <= ${end}::date`;
    return rows.map((r) => this.apptRow(r as Record<string, unknown>));
  }
  async getAppointmentsByWinBusinessDateBetween(start: string, end: string): Promise<AppointmentRow[]> {
    return this.cache.wrap("getAppointmentsByWinBusinessDateBetween:" + JSON.stringify([start, end]), () => this.getAppointmentsByWinBusinessDateBetweenCached(start, end));
  }
  private async getAppointmentsByWinBusinessDateBetweenCached(start: string, end: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    // BOOKING WIN bucket (rev 12): the win-date SUPERSET — wins by the date
    // the deposit was received, UNION not-yet-derived/legacy rows by created
    // date (the metrics layer applies the win filters + fallback rules; unpaid
    // rows returned here never count).
    const rows = await this.sql`SELECT id, contact_id, calendar_id, acuity_appointment_id::text AS acuity_appointment_id, client_name, appointment_type, appointment_datetime, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, cancelled_at, cancellation_source FROM appointments WHERE (booking_win_business_date >= ${start}::date AND booking_win_business_date <= ${end}::date) OR (booking_win_business_date IS NULL AND created_business_date >= ${start}::date AND created_business_date <= ${end}::date)`;
    return rows.map((r) => this.apptRow(r as Record<string, unknown>));
  }
  async getAppointmentsOverlapping(startUtc: string, endUtc: string): Promise<AppointmentRow[]> {
    return this.cache.wrap("getAppointmentsOverlapping:" + JSON.stringify([startUtc, endUtc]), () => this.getAppointmentsOverlappingCached(startUtc, endUtc));
  }
  private async getAppointmentsOverlappingCached(startUtc: string, endUtc: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    // Availability path: carries the per-appointment duration (session length),
    // calendar name (scope matching), acuity id AND the client contact fields
    // (the attribution engine's phone/email tiers read them from this selector)
    // — the lean selectors used by the booking metrics keep their original columns.
    const rows = await this.sql`SELECT id, contact_id, calendar_id, calendar_name, acuity_appointment_id, appointment_type, appointment_datetime, duration_minutes, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, cancelled_at, cancellation_source, client_name, client_phone, client_email FROM appointments WHERE appointment_datetime >= ${startUtc} AND appointment_datetime < ${endUtc}`;
    return rows.map((r) => ({
      ...this.apptRow(r as Record<string, unknown>),
      calendar_name: r.calendar_name ? String(r.calendar_name) : null,
      acuity_appointment_id: r.acuity_appointment_id ? String(r.acuity_appointment_id) : null,
      duration_minutes: r.duration_minutes == null ? null : Number(r.duration_minutes),
      client_name: r.client_name ? String(r.client_name) : null,
      client_phone: r.client_phone ? String(r.client_phone) : null,
      client_email: r.client_email ? String(r.client_email) : null,
    }));
  }
  async getAllAppointmentsSince(startUtc: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, contact_id, calendar_id, appointment_type, appointment_datetime, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, cancelled_at, cancellation_source FROM appointments WHERE appointment_datetime >= ${startUtc} OR created_at >= ${startUtc}`;
    return rows.map((r) => this.apptRow(r as Record<string, unknown>));
  }
  async getAppointmentsWithClientsSince(startUtc: string, opts?: { excludePendingDismissed?: boolean }): Promise<(AppointmentRow & {
    acuity_appointment_id: string | null;
    client_name: string | null;
    client_phone: string | null;
    client_email: string | null;
    calendar_name: string | null;
  })[]> {
    return this.cache.wrap("getAppointmentsWithClientsSince:" + JSON.stringify([startUtc, opts]), () => this.getAppointmentsWithClientsSinceCached(startUtc, opts));
  }
  private async getAppointmentsWithClientsSinceCached(startUtc: string, opts?: { excludePendingDismissed?: boolean }): Promise<(AppointmentRow & {
    acuity_appointment_id: string | null;
    client_name: string | null;
    client_phone: string | null;
    client_email: string | null;
    calendar_name: string | null;
  })[]> {
    await this.ensureSchema();
    // excludePendingDismissed (owner request 9/30): the Today page's PENDING
    // LIST uses this to drop owner-dismissed pending payments permanently —
    // the dismissal is owner-controlled state the sync never touches. Only
    // the pending list passes the flag; the attribution tick + unattributed
    // queue use the default (dismissed appointments stay in the engine), and
    // wins/metrics are unaffected (they read the win-bucket selectors).
    // Two explicit query forms — postgres.js treats every ${} as a bound
    // parameter, so the conditional filter must live in the template itself.
    const rows = opts?.excludePendingDismissed
      ? await this.sql`SELECT id, contact_id, calendar_id, calendar_name, acuity_appointment_id, appointment_type, appointment_datetime, duration_minutes, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, pending_dismissed_at, raw, status, cancelled, cancelled_at, cancellation_source, client_name, client_phone, client_email FROM appointments WHERE (appointment_datetime >= ${startUtc} OR created_at >= ${startUtc}) AND pending_dismissed_at IS NULL`
      : await this.sql`SELECT id, contact_id, calendar_id, calendar_name, acuity_appointment_id, appointment_type, appointment_datetime, duration_minutes, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, pending_dismissed_at, raw, status, cancelled, cancelled_at, cancellation_source, client_name, client_phone, client_email FROM appointments WHERE appointment_datetime >= ${startUtc} OR created_at >= ${startUtc}`;
    return rows.map((r) => ({
      ...this.apptRow(r as Record<string, unknown>),
      acuity_appointment_id: r.acuity_appointment_id ? String(r.acuity_appointment_id) : null,
      client_name: r.client_name ? String(r.client_name) : null,
      client_phone: r.client_phone ? String(r.client_phone) : null,
      client_email: r.client_email ? String(r.client_email) : null,
      calendar_name: r.calendar_name ? String(r.calendar_name) : null,
      pending_dismissed_at: r.pending_dismissed_at == null ? null : new Date(r.pending_dismissed_at as string).toISOString(),
    }));
  }

  async dismissPendingPayment(appointmentId: string): Promise<void> {
    this.cache.bump(); // write invalidates the short-TTL read cache
    await this.ensureSchema();
    // KEEP-FIRST (idempotent): a re-dismiss never moves the original
    // timestamp. The appointment row itself is NEVER deleted — Acuity is the
    // source of truth and the sync would re-create it; this only hides the
    // row from the pending list. Callers guard: paid wins are never dismissed.
    await this.sql`UPDATE appointments SET pending_dismissed_at = COALESCE(pending_dismissed_at, now()) WHERE id = ${appointmentId}::uuid`;
  }
  /**
   * CANCELLATION RECONCILIATION (owner report 2026-10-06): mark appointments
   * whose cancellation was CONFIRMED via the Acuity single-appointment GET.
   * Monotone + write-once: only false→true flips, cancelled_at/source are
   * COALESCE-kept (a re-run never moves the first confirmation), and the win
   * evidence (booking_win_business_date etc.) is NEVER touched — already-
   * counted wins stay in their stored records and surface on the flag list
   * instead. WRITER PROTECTION: ONE advisory-locked transaction (the same
   * lock the attribution writer holds) serializes concurrent reconciliation
   * passes. Returns the number of rows actually flipped.
   */
  async markAppointmentsCancelled(acuityIds: string[], cancelledAtIso: string, source: string): Promise<number> {
    if (acuityIds.length === 0) return 0;
    this.cache.bump(); // write invalidates the short-TTL read cache
    await this.ensureSchema();
    const ids = [...new Set(acuityIds.map((s) => String(s)))];
    return await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(72240901)`;
      const rows = await tx`
        UPDATE appointments SET cancelled = true, status = 'cancelled',
          cancelled_at = COALESCE(cancelled_at, ${cancelledAtIso}::timestamptz),
          cancellation_source = COALESCE(cancellation_source, ${source}),
          updated_at = now()
        WHERE acuity_appointment_id = ANY(${ids}::text[])
          AND cancelled = false
          AND acuity_appointment_id NOT LIKE 'demo-%'
        RETURNING id`;
      return rows.length;
    });
  }
  /**
   * FLAG LIST (owner report 2026-10-06): appointments that were counted as
   * Booking Wins (a persisted win bucket) and are NOW confirmed cancelled —
   * the honest report-only surface for already-counted wins. Stored closed
   * records are never rewritten; corrections go through the audited
   * reason-required manual path only on the owner's direction.
   */
  async getCancelledWinAppointments(): Promise<(AppointmentRow & { acuity_appointment_id: string | null })[]> {
    return this.cache.wrap("getCancelledWinAppointments", () => this.getCancelledWinAppointmentsCached());
  }
  private async getCancelledWinAppointmentsCached(): Promise<(AppointmentRow & { acuity_appointment_id: string | null })[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, contact_id, calendar_id, acuity_appointment_id::text AS acuity_appointment_id, client_name, appointment_type, appointment_datetime, duration_minutes, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, cancelled_at, cancellation_source FROM appointments WHERE cancelled = true AND booking_win_business_date IS NOT NULL ORDER BY booking_win_business_date`;
    return rows.map((r) => ({
      ...this.apptRow(r as Record<string, unknown>),
      acuity_appointment_id: r.acuity_appointment_id ? String(r.acuity_appointment_id) : null,
      duration_minutes: r.duration_minutes == null ? null : Number(r.duration_minutes),
      client_name: r.client_name == null ? null : String(r.client_name),
    }));
  }
  async upsertAttributions(rows: AttributionRow[], opts?: { force?: boolean }): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    if (rows.length === 0) return 0;
    // WRITER PROTECTION (owner directive 2026-09-27): ONE advisory-locked
    // transaction holds the read-check-write, so concurrent writers serialize
    // (no interleaved rewrites, no check-then-write race) and a write that
    // would strip a large share of currently-attributed rows (the 49→3
    // stale-writer shape) is REFUSED — the table keeps its verdicts and the
    // caller (the tick) records an error sync_run. Blocking lock, no busy
    // loop; it releases at transaction end.
    const ids = rows.map((r) => r.appointment_id);
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(72240901)`;
      const existingRows = await tx`
        SELECT appointment_id::text, rep_id::text, manual_override
        FROM booking_attributions WHERE appointment_id = ANY(${ids}::uuid[])`;
      if (!opts?.force) {
        const degrade = attributionDegradation(
          existingRows.map((r: Record<string, unknown>) => ({
            id: "",
            appointment_id: String(r.appointment_id),
            call_id: null,
            rep_id: r.rep_id == null ? null : String(r.rep_id),
            method: "",
            confidence: 0,
            manual_override: Boolean(r.manual_override),
          })),
          rows,
        );
        if (degrade) {
          throw new Error(
            `attribution degradation guard: this write would strip ${degrade.stripped} of ${degrade.touched} currently-attributed bookings — refusing the rewrite (stale/buggy writer shape). Recovery: fix the writer, bump the writer version, or pass force.`,
          );
        }
      }
      for (const r of rows) {
        // appointment_id is UNIQUE — re-syncs replace attributions instead of duplicating.
        // Never overwrite a manual override automatically.
        await tx`
        INSERT INTO booking_attributions (appointment_id, call_id, rep_id, method, confidence, manual_override, note, reason_code)
        VALUES (${r.appointment_id}::uuid, ${r.call_id}, ${r.rep_id}, ${r.method}, ${r.confidence}, ${r.manual_override}, ${r.note ?? null}, ${r.reason_code ?? null})
        ON CONFLICT (appointment_id) DO UPDATE SET
          call_id = EXCLUDED.call_id, rep_id = EXCLUDED.rep_id, method = EXCLUDED.method,
          confidence = EXCLUDED.confidence, manual_override = booking_attributions.manual_override,
          note = EXCLUDED.note, reason_code = EXCLUDED.reason_code, updated_at = now()
        WHERE booking_attributions.manual_override = false
      `;
      }
    });
    return rows.length;
  }
  async getAttributions(): Promise<AttributionRow[]> {
    return this.cache.wrap("getAttributions", () => this.getAttributionsCached());
  }
  private async getAttributionsCached(): Promise<AttributionRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, appointment_id::text, call_id::text, rep_id::text, method, confidence, manual_override, note, reason_code FROM booking_attributions`;
    return rows.map((r) => ({
      id: String(r.id),
      appointment_id: String(r.appointment_id),
      call_id: r.call_id ? String(r.call_id) : null,
      rep_id: r.rep_id ? String(r.rep_id) : null,
      method: String(r.method),
      confidence: Number(r.confidence),
      manual_override: Boolean(r.manual_override),
      note: r.note == null ? null : String(r.note),
      reason_code: r.reason_code == null ? null : String(r.reason_code),
    }));
  }
  async setManualAttribution(row: AttributionRow): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    // Manual assignment wins over the engine and survives re-syncs (engine
    // upserts skip rows with manual_override = true). The triage category is
    // CLEARED: an assigned booking is no longer waiting on a manual decision.
    await this.sql`
      INSERT INTO booking_attributions (appointment_id, call_id, rep_id, method, confidence, manual_override, reason_code)
      VALUES (${row.appointment_id}::uuid, ${row.call_id}, ${row.rep_id}, 'manual', 1, true, NULL)
      ON CONFLICT (appointment_id) DO UPDATE SET
        call_id = EXCLUDED.call_id, rep_id = EXCLUDED.rep_id, method = 'manual',
        confidence = 1, manual_override = true, reason_code = NULL, updated_at = now()
    `;
  }
  async deleteAttribution(appointmentId: string): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    // Manual UNASSIGN: the row is derived data — delete it and the next
    // attribution tick recomputes the appointment from raw rows.
    await this.sql`DELETE FROM booking_attributions WHERE appointment_id = ${appointmentId}::uuid`;
  }

  async upsertLeads(rows: (LeadRow & { source_id: string; provider: string; name?: string | null; phone?: string | null; email?: string | null })[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO leads (provider, source_id, lead_type, source_date, work_date, name, phone, email, contact_id, assigned_rep_id, source_sheet)
        VALUES (${r.provider}, ${r.source_id}, ${r.lead_type}, ${r.source_date}::date, ${r.work_date}::date, ${r.name ?? null}, ${r.phone ?? null}, ${r.email ?? null}, ${r.contact_id}, ${r.assigned_rep_id}, ${r.source_sheet})
        ON CONFLICT (provider, source_id) DO UPDATE SET
          lead_type = EXCLUDED.lead_type, source_date = EXCLUDED.source_date, work_date = EXCLUDED.work_date,
          name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email,
          contact_id = EXCLUDED.contact_id, assigned_rep_id = EXCLUDED.assigned_rep_id, source_sheet = EXCLUDED.source_sheet, updated_at = now()
      `;
    }
    return rows.length;
  }
  async deleteLeadsForSheet(sourceSheet: string): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`DELETE FROM leads WHERE provider = 'google_sheets' AND source_sheet = ${sourceSheet}`;
  }
  async getLeadsByProvider(provider: string): Promise<(LeadRow & { source_id: string; provider: string; name: string | null; phone: string | null; email: string | null })[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, source_id, lead_type, source_date::text, work_date::text, name, phone, email, contact_id::text, assigned_rep_id::text, source_sheet FROM leads WHERE provider = ${provider} ORDER BY id`;
    return rows.map((r) => ({
      id: String(r.id),
      source_id: String(r.source_id),
      provider: String(r.provider),
      lead_type: String(r.lead_type),
      source_date: String(r.source_date),
      work_date: String(r.work_date),
      name: r.name ?? null,
      phone: r.phone ?? null,
      email: r.email ?? null,
      contact_id: r.contact_id ? String(r.contact_id) : null,
      assigned_rep_id: r.assigned_rep_id ? String(r.assigned_rep_id) : null,
      source_sheet: String(r.source_sheet),
    }));
  }
  async deleteLeadsBySourceIds(provider: string, sourceIds: string[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    let n = 0;
    for (let i = 0; i < sourceIds.length; i += 500) {
      const chunk = sourceIds.slice(i, i + 500);
      const res = await this.sql`
        DELETE FROM leads WHERE provider = ${provider} AND source_id = ANY(${chunk}::text[])
        RETURNING id
      `;
      n += res.length;
    }
    return n;
  }
  async countLeads(provider: string): Promise<number> {
    await this.ensureSchema();
    const [{ n }] = await this.sql`SELECT count(*)::int AS n FROM leads WHERE provider = ${provider}`;
    return Number(n);
  }
  async getLeadsByWorkDates(dates: string[]): Promise<LeadRow[]> {
    return this.cache.wrap("getLeadsByWorkDates:" + JSON.stringify([dates]), () => this.getLeadsByWorkDatesCached(dates));
  }
  private async getLeadsByWorkDatesCached(dates: string[]): Promise<LeadRow[]> {
    await this.ensureSchema();
    if (!dates.length) return [];
    const rows = await this.sql`SELECT id::text, lead_type, source_date::text, work_date::text, contact_id::text, assigned_rep_id::text, source_sheet FROM leads WHERE work_date = ANY(${dates}::date[])`;
    return rows.map((r) => ({
      id: String(r.id),
      lead_type: String(r.lead_type),
      source_date: String(r.source_date),
      work_date: String(r.work_date),
      contact_id: r.contact_id ? String(r.contact_id) : null,
      assigned_rep_id: r.assigned_rep_id ? String(r.assigned_rep_id) : null,
      source_sheet: String(r.source_sheet),
    }));
  }
  async getLeadsBySourceDates(dates: string[]): Promise<LeadRow[]> {
    return this.cache.wrap("getLeadsBySourceDates:" + JSON.stringify([dates]), () => this.getLeadsBySourceDatesCached(dates));
  }
  private async getLeadsBySourceDatesCached(dates: string[]): Promise<LeadRow[]> {
    await this.ensureSchema();
    if (!dates.length) return [];
    const rows = await this.sql`SELECT id::text, lead_type, source_date::text, work_date::text, contact_id::text, assigned_rep_id::text, source_sheet FROM leads WHERE source_date = ANY(${dates}::date[])`;
    return rows.map((r) => ({
      id: String(r.id),
      lead_type: String(r.lead_type),
      source_date: String(r.source_date),
      work_date: String(r.work_date),
      contact_id: r.contact_id ? String(r.contact_id) : null,
      assigned_rep_id: r.assigned_rep_id ? String(r.assigned_rep_id) : null,
      source_sheet: String(r.source_sheet),
    }));
  }
  async updateLeadWorkDate(id: string, workDate: string): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    const res = await this.sql`UPDATE leads SET work_date = ${workDate}::date, updated_at = now() WHERE id = ${id}::uuid RETURNING id::text`;
    if (!res.length) throw new Error(`Lead ${id} not found`);
  }

  async upsertLeadCountAdjustment(row: Omit<LeadCountAdjustmentRow, "updated_at">): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    if (!row.delta) {
      // corrected back to the observed count → the adjustment disappears
      await this.sql`DELETE FROM lead_count_adjustments WHERE work_date = ${row.work_date}::date AND sheet = ${row.sheet}`;
      return;
    }
    await this.sql`
      INSERT INTO lead_count_adjustments (work_date, sheet, delta, reason)
      VALUES (${row.work_date}::date, ${row.sheet}, ${row.delta}, ${row.reason})
      ON CONFLICT (work_date, sheet) DO UPDATE SET delta = EXCLUDED.delta, reason = EXCLUDED.reason, updated_at = now()
    `;
  }
  async getLeadCountAdjustments(dates: string[]): Promise<LeadCountAdjustmentRow[]> {
    return this.cache.wrap("getLeadCountAdjustments:" + JSON.stringify([dates]), () => this.getLeadCountAdjustmentsCached(dates));
  }
  private async getLeadCountAdjustmentsCached(dates: string[]): Promise<LeadCountAdjustmentRow[]> {
    await this.ensureSchema();
    if (!dates.length) return [];
    const rows = await this.sql`SELECT work_date::text, sheet, delta, reason, updated_at::text FROM lead_count_adjustments WHERE work_date = ANY(${dates}::date[])`;
    return rows.map((r) => ({
      work_date: String(r.work_date),
      sheet: String(r.sheet),
      delta: Number(r.delta),
      reason: r.reason ? String(r.reason) : null,
      updated_at: String(r.updated_at),
    }));
  }

  /**
   * Mirror settings.studio.hours into availability_rules with REPLACE
   * semantics: the passed list is the COMPLETE rule set (saveStudioRules sends
   * every rule), so the mirror is refreshed to match it exactly — stale rows
   * (e.g. a retired interim schedule) never survive a save. Multi-block safe:
   * conflicts on (weekday, open_time) — the two-block schedule stores two rows
   * per weekday.
   */
  async upsertAvailabilityRules(rows: AvailabilityRule[]): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`DELETE FROM availability_rules`;
    for (const r of rows) {
      await this.sql`
        INSERT INTO availability_rules (weekday, open_time, close_time, active) VALUES (${r.weekday}, ${r.open_time}, ${r.close_time}, ${r.active})
        ON CONFLICT (weekday, open_time) DO UPDATE SET close_time = EXCLUDED.close_time, active = EXCLUDED.active, updated_at = now()
      `;
    }
  }
  async getAvailabilityRules(): Promise<AvailabilityRule[]> {
    return this.cache.wrap("getAvailabilityRules", () => this.getAvailabilityRulesCached());
  }
  private async getAvailabilityRulesCached(): Promise<AvailabilityRule[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT weekday, open_time, close_time, active FROM availability_rules ORDER BY weekday, open_time`;
    return rows.map((r) => ({ weekday: Number(r.weekday), open_time: String(r.open_time), close_time: String(r.close_time), active: Boolean(r.active) }));
  }

  async upsertBlockedTimes(rows: (BlockedTimeRow & { provider: string; external_id: string })[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO blocked_times (provider, external_id, start_at, end_at, reason)
        VALUES (${r.provider}, ${r.external_id}, ${r.start_at}, ${r.end_at}, ${r.reason})
        ON CONFLICT (provider, external_id) DO UPDATE SET start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at, reason = EXCLUDED.reason
      `;
    }
    return rows.length;
  }
  async getBlockedTimesBetween(startUtc: string, endUtc: string): Promise<BlockedTimeRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, start_at, end_at, reason FROM blocked_times WHERE start_at < ${endUtc} AND end_at > ${startUtc}`;
    return rows.map((r) => ({
      id: String(r.id),
      start_at: new Date(r.start_at as string).toISOString(),
      end_at: new Date(r.end_at as string).toISOString(),
      reason: r.reason ? String(r.reason) : null,
    }));
  }
  async insertBlockedTime(row: { start_at: string; end_at: string; reason: string | null }): Promise<BlockedTimeRow> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    const rows = await this.sql`
      INSERT INTO blocked_times (provider, external_id, start_at, end_at, reason)
      VALUES ('manual', gen_random_uuid()::text, ${row.start_at}, ${row.end_at}, ${row.reason})
      RETURNING id::text, start_at, end_at, reason
    `;
    const r = rows[0];
    return {
      id: String(r.id),
      start_at: new Date(r.start_at as string).toISOString(),
      end_at: new Date(r.end_at as string).toISOString(),
      reason: r.reason ? String(r.reason) : null,
    };
  }
  async deleteBlockedTime(id: string): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`DELETE FROM blocked_times WHERE id = ${id}::uuid`;
  }

  // ---- AVAILABILITY FEED CACHE (availability rebuild PR-1, 2026-10-06) ----
  // WRITER PROTECTION (the established pattern): every write below holds ONE
  // advisory-locked transaction (lock 72240902 — the availability-feed writer;
  // 72240901 is the attribution writer's), so the background tick, a manual
  // refresh and a page-loader top-up can never interleave cache rewrites.

  /**
   * Full-month date-index cache upsert: the fresh answer IS the month's truth
   * (including EMPTY — a [] month is the cached coverage horizon, not "no
   * data"). Row-level REPLACE per (calendar, type, month).
   */
  async putAvailabilityDates(rows: AvailabilityDatesInput[], runId: string, fetchedAt?: string): Promise<void> {
    this.cache.bump();
    await this.ensureSchema();
    if (rows.length === 0) return;
    // date[] as an explicit literal (dates are YYYY-MM-DD — no quoting hazards;
    // an empty answer stores '{}' exactly as Acuity's [] deserves).
    const pgDateArray = (dates: string[]) => `{${dates.join(",")}}`;
    const stamp = fetchedAt ?? new Date().toISOString();
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(72240902)`;
      for (const r of rows) {
        await tx`
          INSERT INTO availability_dates (calendar_id, appointment_type_id, month, dates_et, fetched_at, run_id)
          VALUES (${r.calendar_id}, ${r.appointment_type_id}, ${r.month}, ${pgDateArray(r.dates_et)}::date[], ${stamp}::timestamptz, ${runId}::uuid)
          ON CONFLICT (calendar_id, appointment_type_id, month)
          DO UPDATE SET dates_et = EXCLUDED.dates_et, fetched_at = ${stamp}::timestamptz, run_id = EXCLUDED.run_id
        `;
      }
    });
  }

  async getAvailabilityDates(months: string[]): Promise<AvailabilityDatesRow[]> {
    if (months.length === 0) return [];
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT calendar_id, appointment_type_id, month, dates_et, fetched_at, run_id::text AS run_id
      FROM availability_dates WHERE month = ANY(${months}::text[]) ORDER BY month, calendar_id, appointment_type_id`;
    return rows.map((r) => ({
      calendar_id: String(r.calendar_id),
      appointment_type_id: String(r.appointment_type_id),
      month: String(r.month),
      dates_et: (r.dates_et as unknown[]).map((d) => normalizePgBusinessDate(d) ?? "").filter((d) => d !== ""),
      fetched_at: new Date(r.fetched_at as string).toISOString(),
      run_id: String(r.run_id),
    }));
  }

  /**
   * ONE (calendar, date) times-fetch answer, REPLACE semantics for that
   * (calendar, date): rows the fresh feed no longer offers are DELETED (the
   * mismatch history lives in availability_discrepancies, not in stale feed
   * rows); fresh rows upsert with last_confirmed_at refreshed and
   * first_seen_at preserved. Duplicate time rows in one answer are deduped
   * (the highest slots_available wins — same slot, best remaining capacity).
   */
  async putAvailabilitySlotsForDate(calendarId: string, dateEt: string, times: { time_et: string; slots_available: number }[], runId: string): Promise<number> {
    this.cache.bump();
    await this.ensureSchema();
    // dedupe by time (upsert key), best capacity wins
    const byTime = new Map<string, number>();
    for (const t of times) {
      if (!t.time_et) continue;
      const prev = byTime.get(t.time_et);
      if (prev == null || t.slots_available > prev) byTime.set(t.time_et, t.slots_available);
    }
    const keep = [...byTime.entries()].map(([time_et, slots_available]) => ({ time_et, slots_available }));
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(72240902)`;
      // remove stale feed rows NOT in the fresh answer (empty answer ⇒ all go)
      if (keep.length > 0) {
        await tx`
          DELETE FROM availability_slots
          WHERE calendar_id = ${calendarId} AND date_et = ${dateEt}::date
            AND time_et <> ALL(${keep.map((k) => k.time_et)}::text[])`;
      } else {
        await tx`
          DELETE FROM availability_slots WHERE calendar_id = ${calendarId} AND date_et = ${dateEt}::date`;
      }
      for (const k of keep) {
        await tx`
          INSERT INTO availability_slots (calendar_id, date_et, time_et, slots_available, source, run_id)
          VALUES (${calendarId}, ${dateEt}::date, ${k.time_et}, ${k.slots_available}, 'acuity', ${runId}::uuid)
          ON CONFLICT (calendar_id, date_et, time_et) DO UPDATE SET
            slots_available = EXCLUDED.slots_available, last_confirmed_at = now(), run_id = EXCLUDED.run_id`;
      }
    });
    return keep.length;
  }

  async getAvailabilitySlotsForDates(dates: string[]): Promise<AvailabilitySlotRow[]> {
    if (dates.length === 0) return [];
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT id::text, calendar_id, date_et, time_et, slots_available, source, first_seen_at, last_confirmed_at, run_id::text AS run_id
      FROM availability_slots WHERE date_et = ANY(${dates}::date[]) ORDER BY date_et, calendar_id, time_et`;
    return rows.map((r) => ({
      id: String(r.id),
      calendar_id: String(r.calendar_id),
      date_et: normalizePgBusinessDate(r.date_et) ?? "",
      time_et: String(r.time_et),
      slots_available: Number(r.slots_available),
      source: String(r.source),
      first_seen_at: new Date(r.first_seen_at as string).toISOString(),
      last_confirmed_at: new Date(r.last_confirmed_at as string).toISOString(),
      run_id: String(r.run_id),
    }));
  }

  async insertAvailabilitySyncRun(scope: Record<string, unknown>): Promise<string> {
    await this.ensureSchema();
    const rows = await this.sql`
      INSERT INTO availability_sync_runs (status, scope, started_at) VALUES ('running', ${JSON.stringify(scope)}::jsonb, now())
      RETURNING id::text`;
    return String(rows[0].id);
  }

  async finishAvailabilitySyncRun(id: string, status: string, callsMade: number, error: string | null): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      UPDATE availability_sync_runs SET status = ${status}, calls_made = ${callsMade}, finished_at = now(), error = ${error}
      WHERE id = ${id}::uuid`;
  }

  async getAvailabilitySyncRuns(limit: number): Promise<AvailabilitySyncRunRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT id::text, status, scope, calls_made, started_at, finished_at, error
      FROM availability_sync_runs ORDER BY started_at DESC, id DESC LIMIT ${Math.max(1, Math.min(500, limit))}`;
    return rows.map((r) => ({
      id: String(r.id),
      status: String(r.status),
      scope: (r.scope ?? {}) as Record<string, unknown>,
      calls_made: r.calls_made == null ? null : Number(r.calls_made),
      started_at: r.started_at == null ? "" : new Date(r.started_at as string).toISOString(),
      finished_at: r.finished_at == null ? null : new Date(r.finished_at as string).toISOString(),
      error: r.error == null ? null : String(r.error),
    }));
  }

  /**
   * Apply ONE detector pass (see applyAvailabilityDiscrepancies in types.ts
   * for the contract). The partial unique index enforces the dedupe at the DB
   * level; resolution touches ONLY the scanned pairs' still-unresolved rows.
   */
  async applyAvailabilityDiscrepancies(runId: string, scanned: { calendar_id: string; date_et: string }[], current: AvailabilityDiscrepancyInput[]): Promise<{ inserted: number; resolved: number }> {
    this.cache.bump();
    await this.ensureSchema();
    // resolve ONLY unresolved rows of scanned pairs whose (time, kind) is no
    // longer in the current mismatch set (a resolved-then-reseen row re-inserts
    // as a NEW row — history preserved)
    const pairFilter = scanned.map((p) => `${p.calendar_id}|${p.date_et}`);
    const currentKeys = new Set(current.map((c) => `${c.calendar_id}|${c.date_et}|${c.time_et}|${c.kind}`));
    let resolved = 0;
    let inserted = 0;
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(72240902)`;
      if (pairFilter.length > 0) {
        const unresolved = await tx`
          SELECT id::text, calendar_id, date_et, time_et, kind FROM availability_discrepancies
          WHERE resolved_at IS NULL`;
        for (const row of unresolved) {
          const pair = `${String(row.calendar_id)}|${normalizePgBusinessDate(row.date_et) ?? ""}`;
          if (!pairFilter.includes(pair)) continue;
          const key = `${pair}|${String(row.time_et)}|${String(row.kind)}`;
          if (!currentKeys.has(key)) {
            await tx`UPDATE availability_discrepancies SET resolved_at = now() WHERE id = ${row.id}::uuid`;
            resolved += 1;
          }
        }
      }
      for (const c of current) {
        const ins = await tx`
          INSERT INTO availability_discrepancies (run_id, calendar_id, date_et, time_et, kind, detail)
          VALUES (${runId}::uuid, ${c.calendar_id}, ${c.date_et}::date, ${c.time_et}, ${c.kind}, ${JSON.stringify(c.detail)}::jsonb)
          ON CONFLICT (calendar_id, date_et, time_et, kind) WHERE resolved_at IS NULL DO NOTHING
          RETURNING id`;
        inserted += ins.length;
      }
    });
    return { inserted, resolved };
  }

  async getAvailabilityDiscrepancies(opts?: { unresolvedOnly?: boolean; limit?: number }): Promise<AvailabilityDiscrepancyRow[]> {
    await this.ensureSchema();
    const limit = Math.max(1, Math.min(500, opts?.limit ?? 200));
    const rows = opts?.unresolvedOnly
      ? await this.sql`
          SELECT id::text, run_id::text AS run_id, calendar_id, date_et, time_et, kind, detail, detected_at, resolved_at
          FROM availability_discrepancies WHERE resolved_at IS NULL ORDER BY detected_at DESC, id LIMIT ${limit}`
      : await this.sql`
          SELECT id::text, run_id::text AS run_id, calendar_id, date_et, time_et, kind, detail, detected_at, resolved_at
          FROM availability_discrepancies ORDER BY detected_at DESC, id LIMIT ${limit}`;
    return rows.map((r) => ({
      id: String(r.id),
      run_id: String(r.run_id),
      calendar_id: String(r.calendar_id),
      date_et: normalizePgBusinessDate(r.date_et) ?? "",
      time_et: String(r.time_et),
      kind: String(r.kind) as AvailabilityDiscrepancyRow["kind"],
      detail: (r.detail ?? {}) as Record<string, unknown>,
      detected_at: new Date(r.detected_at as string).toISOString(),
      resolved_at: r.resolved_at == null ? null : new Date(r.resolved_at as string).toISOString(),
    }));
  }

  /**
   * Cache the /calendars + /appointment-types catalog (REPLACE-all: the fresh
   * answer is the truth). Same availability-feed advisory lock as the other
   * feed writers — catalog + dates + slots + discrepancies move together.
   */
  async putAvailabilityCatalog(catalog: AvailabilityCatalogInput, runId: string, fetchedAt?: string): Promise<void> {
    this.cache.bump();
    await this.ensureSchema();
    const stamp = fetchedAt ?? new Date().toISOString();
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(72240902)`;
      await tx`DELETE FROM availability_calendars`;
      await tx`DELETE FROM availability_appointment_types`;
      for (const c of catalog.calendars) {
        if (!c.calendar_id) continue;
        await tx`
          INSERT INTO availability_calendars (calendar_id, name, fetched_at, run_id)
          VALUES (${c.calendar_id}, ${c.name}, ${stamp}::timestamptz, ${runId}::uuid)
          ON CONFLICT (calendar_id) DO UPDATE SET name = EXCLUDED.name, fetched_at = EXCLUDED.fetched_at, run_id = EXCLUDED.run_id`;
      }
      for (const t of catalog.types) {
        if (!t.appointment_type_id) continue;
        await tx`
          INSERT INTO availability_appointment_types (appointment_type_id, name, calendar_ids, duration_minutes, fetched_at, run_id)
          VALUES (${t.appointment_type_id}, ${t.name}, ${JSON.stringify(t.calendar_ids)}::jsonb, ${t.duration_minutes}, ${stamp}::timestamptz, ${runId}::uuid)
          ON CONFLICT (appointment_type_id) DO UPDATE SET
            name = EXCLUDED.name, calendar_ids = EXCLUDED.calendar_ids, duration_minutes = EXCLUDED.duration_minutes,
            fetched_at = EXCLUDED.fetched_at, run_id = EXCLUDED.run_id`;
      }
    });
  }

  async getAvailabilityCatalog(): Promise<{ calendars: AvailabilityCalendarRow[]; types: AvailabilityTypeRow[] }> {
    await this.ensureSchema();
    const [cals, types] = await Promise.all([
      this.sql`SELECT calendar_id, name, fetched_at, run_id::text AS run_id FROM availability_calendars ORDER BY name, calendar_id`,
      this.sql`SELECT appointment_type_id, name, calendar_ids, duration_minutes, fetched_at, run_id::text AS run_id FROM availability_appointment_types ORDER BY name, appointment_type_id`,
    ]);
    return {
      calendars: cals.map((r) => ({
        calendar_id: String(r.calendar_id),
        name: String(r.name),
        fetched_at: new Date(r.fetched_at as string).toISOString(),
        run_id: String(r.run_id),
      })),
      types: types.map((r) => ({
        appointment_type_id: String(r.appointment_type_id),
        name: String(r.name),
        calendar_ids: Array.isArray(r.calendar_ids) ? (r.calendar_ids as unknown[]).map(String) : [],
        duration_minutes: r.duration_minutes == null ? null : Number(r.duration_minutes),
        fetched_at: new Date(r.fetched_at as string).toISOString(),
        run_id: String(r.run_id),
      })),
    };
  }

  async upsertDailyPriorities(row: DailyPrioritiesRow): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`
      INSERT INTO daily_priorities (date, priority1, priority2, priority3) VALUES (${row.date}::date, ${row.priority1}, ${row.priority2}, ${row.priority3})
      ON CONFLICT (date) DO UPDATE SET priority1 = EXCLUDED.priority1, priority2 = EXCLUDED.priority2, priority3 = EXCLUDED.priority3, updated_at = now()
    `;
  }
  async getDailyPriorities(date: string): Promise<DailyPrioritiesRow | null> {
    return this.cache.wrap("getDailyPriorities:" + JSON.stringify([date]), () => this.getDailyPrioritiesCached(date));
  }
  private async getDailyPrioritiesCached(date: string): Promise<DailyPrioritiesRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT date::text, priority1, priority2, priority3, updated_at::text FROM daily_priorities WHERE date = ${date}::date`;
    return rows[0]
      ? { date: String(rows[0].date), priority1: rows[0].priority1, priority2: rows[0].priority2, priority3: rows[0].priority3, updated_at: String(rows[0].updated_at) }
      : null;
  }

  async upsertConnection(row: ConnectionRow): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`
      INSERT INTO integration_connections (provider, status, is_demo, last_sync_at, last_successful_sync_at, last_error, config)
      VALUES (${row.provider}, ${row.status}, ${row.is_demo}, ${row.last_sync_at}, ${row.last_successful_sync_at}, ${row.last_error}, ${this.sql.json(row.config)}::jsonb)
      ON CONFLICT (provider) DO UPDATE SET status = EXCLUDED.status, is_demo = EXCLUDED.is_demo,
        last_sync_at = EXCLUDED.last_sync_at, last_successful_sync_at = EXCLUDED.last_successful_sync_at,
        last_error = EXCLUDED.last_error, config = EXCLUDED.config, updated_at = now()
    `;
  }
  async getConnections(): Promise<ConnectionRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT provider, status, is_demo, last_sync_at::text, last_successful_sync_at::text, last_error, config FROM integration_connections`;
    return rows.map((r) => ({
      provider: String(r.provider),
      status: String(r.status),
      is_demo: Boolean(r.is_demo),
      last_sync_at: r.last_sync_at ? String(r.last_sync_at) : null,
      last_successful_sync_at: r.last_successful_sync_at ? String(r.last_successful_sync_at) : null,
      last_error: r.last_error ? String(r.last_error) : null,
      config: (r.config ?? {}) as Record<string, unknown>,
    }));
  }

  async insertSyncRun(provider: string): Promise<string> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    const rows = await this.sql`INSERT INTO sync_runs (provider) VALUES (${provider}) RETURNING id::text`;
    return String(rows[0].id);
  }
  async finishSyncRun(id: string, status: string, recordsUpserted: number, error: string | null): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.sql`UPDATE sync_runs SET status = ${status}, records_upserted = ${recordsUpserted}, error = ${error}, finished_at = now() WHERE id = ${id}::uuid`;
  }
  async getSyncRuns(limit: number): Promise<SyncRunRow[]> {
    return this.cache.wrap("getSyncRuns:" + JSON.stringify([limit]), () => this.getSyncRunsCached(limit));
  }
  private async getSyncRunsCached(limit: number): Promise<SyncRunRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, status, started_at::text, finished_at::text, records_upserted, error FROM sync_runs ORDER BY started_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: String(r.id),
      provider: String(r.provider),
      status: String(r.status),
      started_at: String(r.started_at),
      finished_at: r.finished_at ? String(r.finished_at) : null,
      records_upserted: Number(r.records_upserted),
      error: r.error ? String(r.error) : null,
    }));
  }
  async getRunningSyncRuns(): Promise<SyncRunRow[]> {
    await this.ensureSchema();
    // FULL scan by status — deliberately no LIMIT and no recency filter: this
    // feeds the stale-run reaper, which must see zombies hiding BELOW the
    // recent-N window that getSyncRuns(200) reads (the 37h HighLevel zombie).
    const rows = await this.sql`SELECT id::text, provider, status, started_at::text, finished_at::text, records_upserted, error
      FROM sync_runs WHERE status = 'running' AND finished_at IS NULL
      ORDER BY started_at ASC`;
    return rows.map((r) => ({
      id: String(r.id),
      provider: String(r.provider),
      status: String(r.status),
      started_at: String(r.started_at),
      finished_at: r.finished_at ? String(r.finished_at) : null,
      records_upserted: Number(r.records_upserted),
      error: r.error ? String(r.error) : null,
    }));
  }
  async getRunningSyncRun(provider: string): Promise<SyncRunRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, status, started_at::text, finished_at::text, records_upserted, error
      FROM sync_runs WHERE provider = ${provider} AND status = 'running' AND finished_at IS NULL
      ORDER BY started_at DESC LIMIT 1`;
    if (rows.length === 0) return null;
    const r = rows[0];
    const run: SyncRunRow = {
      id: String(r.id),
      provider: String(r.provider),
      status: String(r.status),
      started_at: String(r.started_at),
      finished_at: r.finished_at ? String(r.finished_at) : null,
      records_upserted: Number(r.records_upserted),
      error: r.error ? String(r.error) : null,
    };
    // FRESHNESS BOUND: a zombie (or unparsable) started_at is NOT a live run —
    // report null so it can't wedge the header's "Syncing…" or the tick guards.
    const startedMs = parseSyncStartedMs(run.started_at);
    if (!Number.isFinite(startedMs)) return null;
    if (Date.now() - startedMs > STALE_RUN_REAP_MINUTES * 60_000) return null;
    return run;
  }
  async getSyncWatermark(provider: string): Promise<string | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT watermark::text FROM sync_watermarks WHERE provider = ${provider}`;
    return rows.length ? String(rows[0].watermark) : null;
  }
  async setSyncWatermark(provider: string, watermarkIso: string): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`INSERT INTO sync_watermarks (provider, watermark, updated_at) VALUES (${provider}, ${watermarkIso}, now())
      ON CONFLICT (provider) DO UPDATE SET watermark = EXCLUDED.watermark, updated_at = now()`;
  }
  async getSyncCheckpoint(key: string): Promise<string | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT value::text FROM sync_checkpoints WHERE key = ${key}`;
    return rows.length ? String(rows[0].value) : null;
  }
  async setSyncCheckpoint(key: string, value: string): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`INSERT INTO sync_checkpoints (key, value, updated_at) VALUES (${key}, ${value}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }

  async insertManualOverride(row: Omit<ManualOverrideRow, "id" | "changed_at">): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`INSERT INTO manual_overrides (entity_type, entity_id, field, previous_value, new_value, changed_by) VALUES (${row.entity_type}, ${row.entity_id}, ${row.field}, ${row.previous_value}, ${row.new_value}, ${row.changed_by})`;
  }
  async getManualOverrides(limit: number): Promise<ManualOverrideRow[]> {
    return this.cache.wrap("getManualOverrides:" + JSON.stringify([limit]), () => this.getManualOverridesCached(limit));
  }
  private async getManualOverridesCached(limit: number): Promise<ManualOverrideRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, entity_type, entity_id, field, previous_value, new_value, changed_by, changed_at::text FROM manual_overrides ORDER BY changed_at DESC LIMIT ${limit}`;
    return rows as unknown as ManualOverrideRow[];
  }

  // ---- call harvest (resumable; see src/server/sync/call-harvest.ts) ----
  async getHarvestProgress(id = "highlevel-calls"): Promise<HarvestProgressRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT * FROM harvest_progress WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      id: String(r.id),
      window_start_utc: new Date(r.window_start_utc as string).toISOString(),
      list_hi_exclusive: Number(r.list_hi_exclusive),
      list_complete: Boolean(r.list_complete),
      list_requests: Number(r.list_requests),
      conversations_listed: Number(r.conversations_listed),
      visits_done: Number(r.visits_done),
      calls_found: Number(r.calls_found),
      messages_scanned: Number(r.messages_scanned),
      started_at: new Date(r.started_at as string).toISOString(),
      updated_at: new Date(r.updated_at as string).toISOString(),
      completed_at: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
      last_error: (r.last_error as string | null) ?? null,
    };
  }
  async saveHarvestProgress(p: HarvestProgressRow): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`
      INSERT INTO harvest_progress (id, window_start_utc, list_hi_exclusive, list_complete, list_requests, conversations_listed, visits_done, calls_found, messages_scanned, started_at, updated_at, completed_at, last_error)
      VALUES (${p.id}, ${p.window_start_utc}, ${p.list_hi_exclusive}, ${p.list_complete}, ${p.list_requests}, ${p.conversations_listed}, ${p.visits_done}, ${p.calls_found}, ${p.messages_scanned}, ${p.started_at}, ${p.updated_at}, ${p.completed_at}, ${p.last_error})
      ON CONFLICT (id) DO UPDATE SET
        window_start_utc = EXCLUDED.window_start_utc, list_hi_exclusive = EXCLUDED.list_hi_exclusive,
        list_complete = EXCLUDED.list_complete, list_requests = EXCLUDED.list_requests,
        conversations_listed = EXCLUDED.conversations_listed, visits_done = EXCLUDED.visits_done,
        calls_found = EXCLUDED.calls_found, messages_scanned = EXCLUDED.messages_scanned,
        started_at = EXCLUDED.started_at, updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at, last_error = EXCLUDED.last_error`;
  }
  async upsertHarvestConversations(rows: HarvestConvRow[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO harvest_conversations (conv_id, last_message_date, date_added, message_types, last_message_type, contact_id, assigned_to, updated_at)
        VALUES (${r.conv_id}, ${r.last_message_date}, ${r.date_added}, ${this.sql.json(r.message_types)}::jsonb, ${r.last_message_type}, ${r.contact_id}, ${r.assigned_to}, now())
        ON CONFLICT (conv_id) DO UPDATE SET
          last_message_date = EXCLUDED.last_message_date, date_added = EXCLUDED.date_added,
          message_types = harvest_conversations.message_types || EXCLUDED.message_types,
          last_message_type = COALESCE(EXCLUDED.last_message_type, harvest_conversations.last_message_type),
          contact_id = COALESCE(EXCLUDED.contact_id, harvest_conversations.contact_id),
          assigned_to = COALESCE(EXCLUDED.assigned_to, harvest_conversations.assigned_to),
          updated_at = now()`;
    }
    return rows.length;
  }
  async getUnvisitedInWindow(windowStartMs: number, limit: number, callFlaggedFirst: boolean): Promise<HarvestConvRow[]> {
    await this.ensureSchema();
    const rows = callFlaggedFirst
      ? await this.sql`
          SELECT conv_id, last_message_date::text AS lmd, date_added::text AS da, message_types, last_message_type, contact_id, assigned_to
          FROM harvest_conversations
          WHERE visited = false AND last_message_date >= ${windowStartMs}
          ORDER BY (message_types @> '[1]'::jsonb OR last_message_type = 'TYPE_CALL') DESC, last_message_date DESC
          LIMIT ${limit}`
      : await this.sql`
          SELECT conv_id, last_message_date::text AS lmd, date_added::text AS da, message_types, last_message_type, contact_id, assigned_to
          FROM harvest_conversations
          WHERE visited = false AND last_message_date >= ${windowStartMs}
          ORDER BY last_message_date DESC
          LIMIT ${limit}`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      conv_id: String(r.conv_id),
      last_message_date: Number(r.lmd),
      date_added: Number(r.da),
      message_types: (r.message_types ?? []) as number[],
      last_message_type: (r.last_message_type as string | null) ?? null,
      contact_id: (r.contact_id as string | null) ?? null,
      assigned_to: (r.assigned_to as string | null) ?? null,
    }));
  }
  async markHarvestVisited(convIds: string[], callsFoundByConv: Record<string, number>, messagesScannedByConv?: Record<string, number>): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const id of convIds) {
      await this.sql`UPDATE harvest_conversations SET visited = true, visited_at = now(), calls_found = ${callsFoundByConv[id] ?? 0}, messages_scanned = messages_scanned + ${messagesScannedByConv?.[id] ?? 0}, updated_at = now() WHERE conv_id = ${id}`;
    }
  }
  async getHarvestCoverageSummary(windowStartMs: number): Promise<{ total: number; visited: number; callFlagged: number; byDay: { day: string; total: number; visited: number }[] }> {
    await this.ensureSchema();
    const [tot] = (await this.sql`
      SELECT count(*)::int AS total, COALESCE(SUM(visited::int), 0)::int AS visited,
        COALESCE(SUM((message_types @> '[1]'::jsonb OR last_message_type = 'TYPE_CALL')::int), 0)::int AS flagged
      FROM harvest_conversations WHERE last_message_date >= ${windowStartMs}`) as Record<string, unknown>[];
    const byDayRows = (await this.sql`
      SELECT to_char(to_timestamp(last_message_date / 1000.0) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS day,
        count(*)::int AS total, COALESCE(SUM(visited::int), 0)::int AS visited
      FROM harvest_conversations WHERE last_message_date >= ${windowStartMs}
      GROUP BY 1 ORDER BY 1 DESC`) as Record<string, unknown>[];
    return {
      total: Number(tot?.total ?? 0),
      visited: Number(tot?.visited ?? 0),
      callFlagged: Number(tot?.flagged ?? 0),
      byDay: byDayRows.map((r) => ({ day: String(r.day), total: Number(r.total), visited: Number(r.visited) })),
    };
  }
  async getHarvestConversationsByIds(convIds: string[]): Promise<HarvestConvRow[]> {
    await this.ensureSchema();
    if (!convIds.length) return [];
    const rows = await this.sql`
      SELECT conv_id, last_message_date::text AS lmd, date_added::text AS da, message_types, last_message_type, contact_id, assigned_to
      FROM harvest_conversations WHERE conv_id = ANY(${convIds})`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      conv_id: String(r.conv_id),
      last_message_date: Number(r.lmd),
      date_added: Number(r.da),
      message_types: (r.message_types ?? []) as number[],
      last_message_type: (r.last_message_type as string | null) ?? null,
      contact_id: (r.contact_id as string | null) ?? null,
      assigned_to: (r.assigned_to as string | null) ?? null,
    }));
  }
  async upsertHarvestCalls(rows: HarvestCallRow[]): Promise<number> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO harvest_calls (message_id, conversation_id, user_external_id, contact_external_id, started_at, duration_seconds, direction, call_status)
        VALUES (${r.message_id}, ${r.conversation_id ?? ""}, ${r.user_external_id}, ${r.contact_external_id}, ${r.started_at}, ${r.duration_seconds}, ${r.direction}, ${r.call_status})
        ON CONFLICT (message_id) DO UPDATE SET
          conversation_id = EXCLUDED.conversation_id, user_external_id = EXCLUDED.user_external_id,
          contact_external_id = EXCLUDED.contact_external_id, started_at = EXCLUDED.started_at,
          duration_seconds = EXCLUDED.duration_seconds, direction = EXCLUDED.direction,
          call_status = EXCLUDED.call_status, harvested_at = now()`;
    }
    return rows.length;
  }
  async getHarvestCallsByMessageIds(messageIds: string[]): Promise<HarvestCallRow[]> {
    await this.ensureSchema();
    if (!messageIds.length) return [];
    const rows = await this.sql`
      SELECT message_id, conversation_id, user_external_id, contact_external_id, started_at::text AS started_at, duration_seconds, direction, call_status
      FROM harvest_calls WHERE message_id = ANY(${messageIds})`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      message_id: String(r.message_id),
      conversation_id: (r.conversation_id as string | null) ?? null,
      user_external_id: (r.user_external_id as string | null) ?? null,
      contact_external_id: (r.contact_external_id as string | null) ?? null,
      started_at: new Date(r.started_at as string).toISOString(),
      duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
      direction: (r.direction as string | null) ?? null,
      call_status: (r.call_status as string | null) ?? null,
    }));
  }
  async getHarvestCallsSince(startUtc: string): Promise<HarvestCallRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT message_id, conversation_id, user_external_id, contact_external_id, started_at::text AS started_at, duration_seconds, direction, call_status
      FROM harvest_calls WHERE started_at >= ${startUtc}::timestamptz`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      message_id: String(r.message_id),
      conversation_id: (r.conversation_id as string | null) ?? null,
      user_external_id: (r.user_external_id as string | null) ?? null,
      contact_external_id: (r.contact_external_id as string | null) ?? null,
      started_at: new Date(r.started_at as string).toISOString(),
      duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
      direction: (r.direction as string | null) ?? null,
      call_status: (r.call_status as string | null) ?? null,
    }));
  }
  async applyCallContactBackfill(rows: CallContactBackfillUpdate[]): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    for (const r of rows) {
      // FILL-NULL-ONLY (owner rule): an existing non-null contact_id is NEVER
      // overwritten — direct source data always wins, inheritance only fills
      // NULL. The provenance columns land only when this run made the call's
      // contact decision (ambiguous/unresolved keep contact_id NULL but still
      // record WHY — a rerun after the contacts backfill completes resolves them).
      await this.sql`
        UPDATE calls SET
          contact_id = COALESCE(contact_id, ${r.contact_id}::uuid),
          contact_resolution_method = CASE WHEN contact_id IS NULL THEN ${r.resolution_method} ELSE contact_resolution_method END,
          contact_resolved_at = CASE WHEN contact_id IS NULL THEN ${r.contact_resolved_at}::timestamptz ELSE contact_resolved_at END,
          updated_at = now()
        WHERE id = ${r.call_id}::uuid`;
    }
  }

  // ---- Performance Management (PIP module — mirrors MemoryStore semantics exactly) ----
  private pipRowFromDb(r: Record<string, unknown>): PipRow {
    return {
      id: String(r.id),
      rep_id: r.rep_id == null ? null : String(r.rep_id),
      title: String(r.title),
      status: (isPipStatus(r.status) ? r.status : "draft") as PipStatus,
      goal_text: r.goal_text == null ? null : String(r.goal_text),
      weekly_goal_min: r.weekly_goal_min == null ? null : Number(r.weekly_goal_min),
      hard_weekly_minimum: r.hard_weekly_minimum === true,
      review_start_date: r.review_start_date == null ? null : String(r.review_start_date).slice(0, 10),
      review_end_date: r.review_end_date == null ? null : String(r.review_end_date).slice(0, 10),
      pip_start_date: r.pip_start_date == null ? null : String(r.pip_start_date).slice(0, 10),
      pip_end_date: r.pip_end_date == null ? null : String(r.pip_end_date).slice(0, 10),
      manager_observations: r.manager_observations == null ? null : String(r.manager_observations),
      action_plan: normalizePipActionList(r.action_plan),
      personal_development_actions: normalizePipActionList(r.personal_development_actions),
      professional_development_actions: normalizePipActionList(r.professional_development_actions),
      conclusion_category: r.conclusion_category == null ? null : String(r.conclusion_category),
      conclusion_notes: r.conclusion_notes == null ? null : String(r.conclusion_notes),
      issued_at: r.issued_at == null ? null : new Date(r.issued_at as string).toISOString(),
      issued_by: r.issued_by == null ? null : String(r.issued_by),
      completed_at: r.completed_at == null ? null : new Date(r.completed_at as string).toISOString(),
      cancelled_at: r.cancelled_at == null ? null : new Date(r.cancelled_at as string).toISOString(),
      cancelled_by: r.cancelled_by == null ? null : String(r.cancelled_by),
      cancellation_reason: r.cancellation_reason == null ? null : String(r.cancellation_reason),
      employee_visible: r.employee_visible === true,
      current_version: Number(r.current_version ?? 1),
      employee_acked_at: r.employee_acked_at == null ? null : new Date(r.employee_acked_at as string).toISOString(),
      employee_acked_by: r.employee_acked_by == null ? null : String(r.employee_acked_by),
      manager_acked_at: r.manager_acked_at == null ? null : new Date(r.manager_acked_at as string).toISOString(),
      manager_acked_by: r.manager_acked_by == null ? null : String(r.manager_acked_by),
      created_by: r.created_by == null ? null : String(r.created_by),
      created_at: r.created_at == null ? "" : new Date(r.created_at as string).toISOString(),
      updated_at: r.updated_at == null ? "" : new Date(r.updated_at as string).toISOString(),
      template_id: r.template_id == null ? null : String(r.template_id),
      template_version: r.template_version == null ? null : Number(r.template_version),
      checkin_cadence_days: r.checkin_cadence_days == null ? null : Number(r.checkin_cadence_days),
    };
  }


  /** Both audit sinks inside ONE transaction (typed log + manual_overrides mirror). */
  private static async recordPipEventTx(
    sql: ReturnType<typeof postgres>,
    event: Omit<PipEventRow, "id" | "created_at">,
  ): Promise<void> {
    await sql`INSERT INTO pip_event_log (pip_id, template_id, event_type, actor, field, previous_value, new_value, details)
      VALUES (${event.pip_id}, ${event.template_id}, ${event.event_type}, ${event.actor}, ${event.field}, ${event.previous_value}, ${event.new_value},
        ${event.details}::jsonb)`;
    const mirror = pipEventToManualOverride(event.event_type, {
      entityId: event.pip_id ?? event.template_id ?? "",
      field: event.field,
      previousValue: event.previous_value,
      newValue: event.new_value,
      actor: event.actor,
    });
    await sql`INSERT INTO manual_overrides (entity_type, entity_id, field, previous_value, new_value, changed_by)
      VALUES (${mirror.entity_type}, ${mirror.entity_id}, ${mirror.field}, ${mirror.previous_value}, ${mirror.new_value}, ${mirror.changed_by})`;
  }

  async createPip(input: PipCreateInput): Promise<PipRow> {
    await this.ensureSchema();
    const nowIso = new Date().toISOString();
    const row = buildPipRow(input, crypto.randomUUID(), nowIso);
    this.cache.bump();
    await this.sql`INSERT INTO pips (id, rep_id, title, status, goal_text, weekly_goal_min, hard_weekly_minimum,
        review_start_date, review_end_date, pip_start_date, pip_end_date, manager_observations,
        action_plan, personal_development_actions, professional_development_actions,
        created_by, created_at, updated_at, template_id, template_version, checkin_cadence_days)
      VALUES (${row.id}::uuid, ${row.rep_id}::uuid, ${row.title}, ${row.status}, ${row.goal_text}, ${row.weekly_goal_min},
        ${row.hard_weekly_minimum}, ${row.review_start_date}::date, ${row.review_end_date}::date,
        ${row.pip_start_date}::date, ${row.pip_end_date}::date, ${row.manager_observations},
        ${row.action_plan}::jsonb, ${row.personal_development_actions}::jsonb,
        ${row.professional_development_actions}::jsonb,
        ${row.created_by}, ${row.created_at}, ${row.updated_at},
        ${row.template_id}::uuid, ${row.template_version}, ${row.checkin_cadence_days})`;
    await this.sql.begin(async (sql) => {
      await PgStore.recordPipEventTx(sql, {
        pip_id: row.id,
        template_id: null,
        event_type: "pip_created",
        actor: row.created_by,
        field: "status",
        previous_value: null,
        new_value: "draft",
        details: { title: row.title, rep_id: row.rep_id },
      });
    });
    return row;
  }

  async updatePipDraft(id: string, patch: PipDraftPatch): Promise<PipRow> {
    await this.ensureSchema();
    this.cache.bump();
    return this.sql.begin(async (sql) => {
      const rows = await sql`SELECT ${this.pipCols} FROM pips WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new Error(`PIP not found: ${id}`);
      const current = this.pipRowFromDb(rows[0] as unknown as Record<string, unknown>);
      const { next, changed, observationsBefore } = applyPipDraftPatch(current, patch);
      if (changed.length === 0) return current;
      const actor = patch.actor ? String(patch.actor).trim() || null : null;
      const updated = await sql`UPDATE pips SET rep_id = ${next.rep_id}::uuid, title = ${next.title},
          goal_text = ${next.goal_text}, weekly_goal_min = ${next.weekly_goal_min},
          hard_weekly_minimum = ${next.hard_weekly_minimum},
          review_start_date = ${next.review_start_date}::date, review_end_date = ${next.review_end_date}::date,
          pip_start_date = ${next.pip_start_date}::date, pip_end_date = ${next.pip_end_date}::date,
          manager_observations = ${next.manager_observations},
          action_plan = ${next.action_plan}::jsonb,
          personal_development_actions = ${next.personal_development_actions}::jsonb,
          professional_development_actions = ${next.professional_development_actions}::jsonb,
          checkin_cadence_days = ${next.checkin_cadence_days},
          updated_at = now()
        WHERE id = ${id}::uuid RETURNING ${this.pipCols}`;
      await PgStore.recordPipEventTx(sql, {
        pip_id: id,
        template_id: null,
        event_type: "pip_edited",
        actor,
        field: "draft",
        previous_value: null,
        new_value: changed.join(", "),
        details: { changed },
      });
      if (changed.includes("manager_observations")) {
        await PgStore.recordPipEventTx(sql, {
          pip_id: id,
          template_id: null,
          event_type: "pip_observation_changed",
          actor,
          field: "manager_observations",
          previous_value: pipAuditValue(observationsBefore),
          new_value: pipAuditValue(next.manager_observations),
          details: null,
        });
      }
      return this.pipRowFromDb(updated[0] as unknown as Record<string, unknown>);
    });
  }

  async getPip(id: string): Promise<PipRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT ${this.pipCols} FROM pips WHERE id = ${id}::uuid`;
    return rows.length ? this.pipRowFromDb(rows[0] as unknown as Record<string, unknown>) : null;
  }

  async listPips(status?: PipStatus | null): Promise<PipRow[]> {
    await this.ensureSchema();
    const rows = status
      ? await this.sql`SELECT ${this.pipCols} FROM pips WHERE status = ${status} ORDER BY created_at DESC`
      : await this.sql`SELECT ${this.pipCols} FROM pips ORDER BY created_at DESC`;
    return rows.map((r) => this.pipRowFromDb(r as unknown as Record<string, unknown>));
  }

  async issuePip(id: string, opts: { issuedBy: string; snapshotExtras?: Record<string, unknown> }): Promise<PipRow> {
    await this.ensureSchema();
    this.cache.bump();
    return this.sql.begin(async (sql) => {
      const rows = await sql`SELECT ${this.pipCols} FROM pips WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new Error(`PIP not found: ${id}`);
      const row = this.pipRowFromDb(rows[0] as unknown as Record<string, unknown>);
      assertIssueRequirements(row);
      // FROZEN EVIDENCE: the version-1 snapshot is the exact document being
      // issued, written in the SAME transaction as the status flip. Snapshot
      // rows are never updated afterwards (write-once, UNIQUE (pip_id, version)).
      // PHASE 2 shape: the frozen document carries the pip row AS IT STOOD
      // plus the pre-computed evidence extras (employee as of issue, weekly
      // rows, goal provenance, verbatim factual statements, template
      // provenance) — never recomputed, never rewritten.
      const doc = JSON.parse(
        JSON.stringify({
          snapshot_schema: 2,
          captured_at: new Date().toISOString(),
          captured_by: opts.issuedBy || null,
          pip: row,
          ...(opts.snapshotExtras ?? {}),
        }),
      ) as Record<string, unknown>;
      await sql`INSERT INTO pip_evidence_snapshots (pip_id, version, snapshot, created_by)
        VALUES (${id}::uuid, 1, ${doc}::jsonb, ${opts.issuedBy || null})`;
      const updated = await sql`UPDATE pips SET status = 'issued', issued_at = now(), issued_by = ${opts.issuedBy || null},
          updated_at = now()
        WHERE id = ${id}::uuid AND status = 'draft' RETURNING ${this.pipCols}`;
      if (updated.length === 0) throw new Error(`Only DRAFT PIPs can be issued — this PIP is "${row.status}"`);
      await PgStore.recordPipEventTx(sql, {
        pip_id: id,
        template_id: null,
        event_type: "pip_issued",
        actor: opts.issuedBy || null,
        field: "status",
        previous_value: "draft",
        new_value: "issued",
        details: { version: 1, snapshot: "pip_evidence_snapshots v1 written" },
      });
      return this.pipRowFromDb(updated[0] as unknown as Record<string, unknown>);
    });
  }

  async completePip(id: string, opts: { conclusionCategory: string; conclusionNotes: string; actor: string }): Promise<PipRow> {
    await this.ensureSchema();
    this.cache.bump();
    return this.sql.begin(async (sql) => {
      const rows = await sql`SELECT ${this.pipCols} FROM pips WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new Error(`PIP not found: ${id}`);
      const row = this.pipRowFromDb(rows[0] as unknown as Record<string, unknown>);
      const { category, notes } = assertCompleteRequirements(row, opts.conclusionCategory, opts.conclusionNotes);
      const updated = await sql`UPDATE pips SET status = 'completed', conclusion_category = ${category},
          conclusion_notes = ${notes}, completed_at = now(), manager_acked_at = now(),
          manager_acked_by = ${opts.actor || null}, updated_at = now()
        WHERE id = ${id}::uuid AND status = 'issued' RETURNING ${this.pipCols}`;
      if (updated.length === 0) throw new Error(`Only ISSUED PIPs can be completed — this PIP is "${row.status}"`);
      await PgStore.recordPipEventTx(sql, {
        pip_id: id,
        template_id: null,
        event_type: "pip_completed",
        actor: opts.actor || null,
        field: "status",
        previous_value: "issued",
        new_value: "completed",
        details: { conclusion_category: category },
      });
      return this.pipRowFromDb(updated[0] as unknown as Record<string, unknown>);
    });
  }

  async cancelPip(id: string, opts: { cancelledBy: string; reason: string }): Promise<PipRow> {
    await this.ensureSchema();
    this.cache.bump();
    return this.sql.begin(async (sql) => {
      const rows = await sql`SELECT ${this.pipCols} FROM pips WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new Error(`PIP not found: ${id}`);
      const row = this.pipRowFromDb(rows[0] as unknown as Record<string, unknown>);
      const reason = assertCancelRequirements(row, opts.reason);
      const updated = await sql`UPDATE pips SET status = 'cancelled', cancellation_reason = ${reason},
          cancelled_at = now(), cancelled_by = ${opts.cancelledBy || null}, updated_at = now()
        WHERE id = ${id}::uuid AND status = 'issued' RETURNING ${this.pipCols}`;
      if (updated.length === 0) throw new Error(`Only ISSUED PIPs can be cancelled — this PIP is "${row.status}"`);
      await PgStore.recordPipEventTx(sql, {
        pip_id: id,
        template_id: null,
        event_type: "pip_cancelled",
        actor: opts.cancelledBy || null,
        field: "status",
        previous_value: "issued",
        new_value: "cancelled",
        details: { reason: pipAuditValue(reason) },
      });
      return this.pipRowFromDb(updated[0] as unknown as Record<string, unknown>);
    });
  }

  /**
   * PHASE 4 — the acknowledgment ACTION (who/when audited via pip_ack_recorded
   * + the manual_overrides mirror). Stamps ONLY the two ack columns in the
   * guard transaction; the document, its frozen evidence snapshot, and the
   * status stay untouched, and the existing ack_awaiting derivation clears as
   * a pure consequence.
   */
  async recordPipAck(id: string, opts: { ackedBy: string }): Promise<PipRow> {
    await this.ensureSchema();
    this.cache.bump();
    return this.sql.begin(async (sql) => {
      const rows = await sql`SELECT ${this.pipCols} FROM pips WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new Error(`PIP not found: ${id}`);
      const row = this.pipRowFromDb(rows[0] as unknown as Record<string, unknown>);
      assertAckRequirements(row);
      const updated = await sql`UPDATE pips SET manager_acked_at = now(), manager_acked_by = ${opts.ackedBy || null},
          updated_at = now()
        WHERE id = ${id}::uuid AND status = 'issued' RETURNING ${this.pipCols}`;
      if (updated.length === 0) throw new Error(`Acknowledgment can only be recorded on an ISSUED PIP — this PIP is "${row.status}"`);
      await PgStore.recordPipEventTx(sql, {
        pip_id: id,
        template_id: null,
        event_type: "pip_ack_recorded",
        actor: opts.ackedBy || null,
        field: "manager_acked_at",
        previous_value: null,
        new_value: new Date().toISOString(),
        details: null,
      });
      return this.pipRowFromDb(updated[0] as unknown as Record<string, unknown>);
    });
  }

  async addPipCheckin(row: Omit<PipCheckinRow, "id" | "created_at">): Promise<PipCheckinRow> {
    await this.ensureSchema();
    this.cache.bump();
    return this.sql.begin(async (sql) => {
      const rows = await sql`SELECT status FROM pips WHERE id = ${row.pip_id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new Error(`PIP not found: ${row.pip_id}`);
      assertCheckinAllowed({ status: rows[0].status as PipStatus } as PipRow);
      const checkinDate = pipDateString(row.checkin_date, "checkin_date") ?? new Date().toISOString().slice(0, 10);
      const nextCheckin = pipDateString(row.next_checkin_date, "next_checkin_date");
      const inserted = await sql`INSERT INTO pip_checkins (pip_id, checkin_date, manager_name, employee_name,
          current_performance, topics_discussed, coaching_provided, employee_comments, manager_notes,
          next_actions, next_checkin_date)
        VALUES (${row.pip_id}::uuid, ${checkinDate}::date, ${row.manager_name ?? null}, ${row.employee_name ?? null},
          ${row.current_performance ?? null}, ${row.topics_discussed ?? null}, ${row.coaching_provided ?? null},
          ${row.employee_comments ?? null}, ${row.manager_notes ?? null}, ${row.next_actions ?? null}, ${nextCheckin}::date)
        RETURNING id::text AS id, pip_id::text AS pip_id, checkin_date::text AS checkin_date,
          manager_name, employee_name, current_performance, topics_discussed, coaching_provided,
          employee_comments, manager_notes, next_actions, next_checkin_date::text AS next_checkin_date,
          created_at::text AS created_at`;
      await PgStore.recordPipEventTx(sql, {
        pip_id: row.pip_id,
        template_id: null,
        event_type: "pip_checkin_added",
        actor: row.manager_name || null,
        field: "checkin",
        previous_value: null,
        new_value: checkinDate,
        details: null,
      });
      const r = inserted[0] as unknown as Record<string, unknown>;
      return {
        id: String(r.id),
        pip_id: String(r.pip_id),
        checkin_date: String(r.checkin_date).slice(0, 10),
        manager_name: r.manager_name == null ? null : String(r.manager_name),
        employee_name: r.employee_name == null ? null : String(r.employee_name),
        current_performance: r.current_performance == null ? null : String(r.current_performance),
        topics_discussed: r.topics_discussed == null ? null : String(r.topics_discussed),
        coaching_provided: r.coaching_provided == null ? null : String(r.coaching_provided),
        employee_comments: r.employee_comments == null ? null : String(r.employee_comments),
        manager_notes: r.manager_notes == null ? null : String(r.manager_notes),
        next_actions: r.next_actions == null ? null : String(r.next_actions),
        next_checkin_date: r.next_checkin_date == null ? null : String(r.next_checkin_date).slice(0, 10),
        created_at: new Date(r.created_at as string).toISOString(),
      };
    });
  }

  async getPipCheckins(pipId: string): Promise<PipCheckinRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, pip_id::text AS pip_id, checkin_date::text AS checkin_date,
        manager_name, employee_name, current_performance, topics_discussed, coaching_provided,
        employee_comments, manager_notes, next_actions, next_checkin_date::text AS next_checkin_date,
        created_at::text AS created_at
      FROM pip_checkins WHERE pip_id = ${pipId}::uuid ORDER BY created_at`;
    return rows.map((r0) => {
      const r = r0 as unknown as Record<string, unknown>;
      return {
        id: String(r.id),
        pip_id: String(r.pip_id),
        checkin_date: String(r.checkin_date).slice(0, 10),
        manager_name: r.manager_name == null ? null : String(r.manager_name),
        employee_name: r.employee_name == null ? null : String(r.employee_name),
        current_performance: r.current_performance == null ? null : String(r.current_performance),
        topics_discussed: r.topics_discussed == null ? null : String(r.topics_discussed),
        coaching_provided: r.coaching_provided == null ? null : String(r.coaching_provided),
        employee_comments: r.employee_comments == null ? null : String(r.employee_comments),
        manager_notes: r.manager_notes == null ? null : String(r.manager_notes),
        next_actions: r.next_actions == null ? null : String(r.next_actions),
        next_checkin_date: r.next_checkin_date == null ? null : String(r.next_checkin_date).slice(0, 10),
        created_at: new Date(r.created_at as string).toISOString(),
      };
    });
  }

  async getPipEvidenceSnapshots(pipId: string): Promise<PipEvidenceSnapshotRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, pip_id::text AS pip_id, version, snapshot,
        created_by, created_at::text AS created_at
      FROM pip_evidence_snapshots WHERE pip_id = ${pipId}::uuid ORDER BY version`;
    return rows.map((r0) => {
      const r = r0 as unknown as Record<string, unknown>;
      return {
        id: String(r.id),
        pip_id: String(r.pip_id),
        version: Number(r.version),
        snapshot: (r.snapshot ?? {}) as Record<string, unknown>,
        created_by: r.created_by == null ? null : String(r.created_by),
        created_at: new Date(r.created_at as string).toISOString(),
      };
    });
  }

  async createPipTemplate(input: PipTemplateCreateInput): Promise<PipTemplateRow> {
    await this.ensureSchema();
    const name = pipRequiredText(input.name, "template name", 200);
    const nowIso = new Date().toISOString();
    const row: PipTemplateRow = {
      id: crypto.randomUUID(),
      name,
      category: pipOptionalText(input.category ?? null, 120),
      default_goal_text: pipOptionalText(input.default_goal_text ?? null),
      default_action_plan: normalizePipActionList(input.default_action_plan ?? []),
      default_personal: normalizePipActionList(input.default_personal ?? []),
      default_professional: normalizePipActionList(input.default_professional ?? []),
      default_checkin_cadence_days: pipOptionalInt(input.default_checkin_cadence_days ?? null, "default_checkin_cadence_days"),
      default_duration_weeks: pipOptionalInt(input.default_duration_weeks ?? null, "default_duration_weeks"),
      version: 1,
      created_by: input.created_by ? String(input.created_by).trim() || null : null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.cache.bump();
    await this.sql`INSERT INTO pip_templates (id, name, category, default_goal_text, default_action_plan,
        default_personal, default_professional, default_checkin_cadence_days, default_duration_weeks,
        version, created_by, created_at, updated_at)
      VALUES (${row.id}::uuid, ${row.name}, ${row.category}, ${row.default_goal_text},
        ${row.default_action_plan}::jsonb, ${row.default_personal}::jsonb,
        ${row.default_professional}::jsonb, ${row.default_checkin_cadence_days},
        ${row.default_duration_weeks}, 1, ${row.created_by}, ${row.created_at}, ${row.updated_at})`;
    await this.sql.begin(async (sql) => {
      await PgStore.recordPipEventTx(sql, {
        pip_id: null,
        template_id: row.id,
        event_type: "pip_template_created",
        actor: row.created_by,
        field: "name",
        previous_value: null,
        new_value: row.name,
        details: null,
      });
    });
    return row;
  }

  async updatePipTemplate(id: string, patch: PipTemplatePatch): Promise<PipTemplateRow> {
    await this.ensureSchema();
    this.cache.bump();
    return this.sql.begin(async (sql) => {
      const rows = await sql`SELECT id::text AS id, name, category, default_goal_text, default_action_plan,
          default_personal, default_professional, default_checkin_cadence_days, default_duration_weeks,
          created_by, created_at::text AS created_at, updated_at::text AS updated_at
        FROM pip_templates WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new Error(`PIP template not found: ${id}`);
      const r = rows[0] as unknown as Record<string, unknown>;
      const name = patch.name !== undefined ? pipRequiredText(patch.name, "template name", 200) : String(r.name);
      const category = patch.category !== undefined ? pipOptionalText(patch.category, 120) : r.category == null ? null : String(r.category);
      const goalText = patch.default_goal_text !== undefined ? pipOptionalText(patch.default_goal_text) : r.default_goal_text == null ? null : String(r.default_goal_text);
      const actionPlan = patch.default_action_plan !== undefined ? normalizePipActionList(patch.default_action_plan) : normalizePipActionList(r.default_action_plan);
      const personal = patch.default_personal !== undefined ? normalizePipActionList(patch.default_personal) : normalizePipActionList(r.default_personal);
      const professional = patch.default_professional !== undefined ? normalizePipActionList(patch.default_professional) : normalizePipActionList(r.default_professional);
      const cadence = patch.default_checkin_cadence_days !== undefined ? pipOptionalInt(patch.default_checkin_cadence_days, "default_checkin_cadence_days") : r.default_checkin_cadence_days == null ? null : Number(r.default_checkin_cadence_days);
      const duration = patch.default_duration_weeks !== undefined ? pipOptionalInt(patch.default_duration_weeks, "default_duration_weeks") : r.default_duration_weeks == null ? null : Number(r.default_duration_weeks);
      const updated = await sql`UPDATE pip_templates SET name = ${name}, category = ${category},
          default_goal_text = ${goalText}, default_action_plan = ${actionPlan}::jsonb,
          default_personal = ${personal}::jsonb, default_professional = ${professional}::jsonb,
          default_checkin_cadence_days = ${cadence}, default_duration_weeks = ${duration},
          version = version + 1, updated_at = now()
        WHERE id = ${id}::uuid RETURNING id::text AS id, name, category, default_goal_text,
          default_action_plan, default_personal, default_professional, default_checkin_cadence_days,
          default_duration_weeks, version, created_by, created_at::text AS created_at, updated_at::text AS updated_at`;
      await PgStore.recordPipEventTx(sql, {
        pip_id: null,
        template_id: id,
        event_type: "pip_template_updated",
        actor: patch.actor || null,
        field: "template",
        previous_value: null,
        new_value: name,
        details: null,
      });
      const u = updated[0] as unknown as Record<string, unknown>;
      return {
        id: String(u.id),
        name: String(u.name),
        category: u.category == null ? null : String(u.category),
        default_goal_text: u.default_goal_text == null ? null : String(u.default_goal_text),
        default_action_plan: normalizePipActionList(u.default_action_plan),
        default_personal: normalizePipActionList(u.default_personal),
        default_professional: normalizePipActionList(u.default_professional),
        default_checkin_cadence_days: u.default_checkin_cadence_days == null ? null : Number(u.default_checkin_cadence_days),
        default_duration_weeks: u.default_duration_weeks == null ? null : Number(u.default_duration_weeks),
        version: Number(u.version ?? 1),
        created_by: u.created_by == null ? null : String(u.created_by),
        created_at: new Date(u.created_at as string).toISOString(),
        updated_at: new Date(u.updated_at as string).toISOString(),
      };
    });
  }

  async deletePipTemplate(id: string): Promise<void> {
    await this.ensureSchema();
    this.cache.bump();
    await this.sql.begin(async (sql) => {
      const rows = await sql`DELETE FROM pip_templates WHERE id = ${id}::uuid RETURNING name`;
      if (rows.length > 0) {
        await PgStore.recordPipEventTx(sql, {
          pip_id: null,
          template_id: id,
          event_type: "pip_template_deleted",
          actor: null,
          field: "name",
          previous_value: String((rows[0] as Record<string, unknown>).name ?? ""),
          new_value: null,
          details: null,
        });
      }
    });
  }

  async getPipTemplate(id: string): Promise<PipTemplateRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, name, category, default_goal_text, default_action_plan,
        default_personal, default_professional, default_checkin_cadence_days, default_duration_weeks,
        version, created_by, created_at::text AS created_at, updated_at::text AS updated_at
      FROM pip_templates WHERE id = ${id}::uuid`;
    if (rows.length === 0) return null;
    const u = rows[0] as unknown as Record<string, unknown>;
    return {
      id: String(u.id),
      name: String(u.name),
      category: u.category == null ? null : String(u.category),
      default_goal_text: u.default_goal_text == null ? null : String(u.default_goal_text),
      default_action_plan: normalizePipActionList(u.default_action_plan),
      default_personal: normalizePipActionList(u.default_personal),
      default_professional: normalizePipActionList(u.default_professional),
      default_checkin_cadence_days: u.default_checkin_cadence_days == null ? null : Number(u.default_checkin_cadence_days),
      default_duration_weeks: u.default_duration_weeks == null ? null : Number(u.default_duration_weeks),
      version: Number(u.version ?? 1),
      created_by: u.created_by == null ? null : String(u.created_by),
      created_at: new Date(u.created_at as string).toISOString(),
      updated_at: new Date(u.updated_at as string).toISOString(),
    };
  }

  async listPipTemplates(): Promise<PipTemplateRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, name, category, default_goal_text, default_action_plan,
        default_personal, default_professional, default_checkin_cadence_days, default_duration_weeks,
        version, created_by, created_at::text AS created_at, updated_at::text AS updated_at
      FROM pip_templates ORDER BY name`;
    return rows.map((r0) => {
      const u = r0 as unknown as Record<string, unknown>;
      return {
        id: String(u.id),
        name: String(u.name),
        category: u.category == null ? null : String(u.category),
        default_goal_text: u.default_goal_text == null ? null : String(u.default_goal_text),
        default_action_plan: normalizePipActionList(u.default_action_plan),
        default_personal: normalizePipActionList(u.default_personal),
        default_professional: normalizePipActionList(u.default_professional),
        default_checkin_cadence_days: u.default_checkin_cadence_days == null ? null : Number(u.default_checkin_cadence_days),
        default_duration_weeks: u.default_duration_weeks == null ? null : Number(u.default_duration_weeks),
        version: Number(u.version ?? 1),
        created_by: u.created_by == null ? null : String(u.created_by),
        created_at: new Date(u.created_at as string).toISOString(),
        updated_at: new Date(u.updated_at as string).toISOString(),
      };
    });
  }

  async getPipTemplateUsage(): Promise<Map<string, number>> {
    await this.ensureSchema();
    // ACTIVE plans only (Phase 4): draft + issued reference a live template;
    // completed/cancelled are closed records whose snapshots already froze the
    // template provenance.
    const rows = await this.sql`SELECT template_id::text AS tid, count(*)::int AS n
      FROM pips WHERE template_id IS NOT NULL AND status IN ('draft', 'issued')
      GROUP BY template_id`;
    const out = new Map<string, number>();
    for (const r of rows as unknown as Record<string, unknown>[]) {
      out.set(String(r.tid), Number(r.n));
    }
    return out;
  }
  async insertPipEvent(row: Omit<PipEventRow, "id" | "created_at">): Promise<void> {
    await this.ensureSchema();
    this.cache.bump();
    await this.sql.begin(async (sql) => {
      await PgStore.recordPipEventTx(sql, row);
    });
  }

  async getPipEvents(opts?: { pipId?: string; limit?: number }): Promise<PipEventRow[]> {
    await this.ensureSchema();
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);
    const rows = opts?.pipId
      ? await this.sql`SELECT id::text AS id, pip_id::text AS pip_id, template_id::text AS template_id,
          event_type, actor, field, previous_value, new_value, details, created_at::text AS created_at
        FROM pip_event_log WHERE pip_id = ${opts.pipId}::uuid ORDER BY created_at DESC LIMIT ${limit}`
      : await this.sql`SELECT id::text AS id, pip_id::text AS pip_id, template_id::text AS template_id,
          event_type, actor, field, previous_value, new_value, details, created_at::text AS created_at
        FROM pip_event_log ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r0) => {
      const r = r0 as unknown as Record<string, unknown>;
      return {
        id: String(r.id),
        pip_id: r.pip_id == null ? null : String(r.pip_id),
        template_id: r.template_id == null ? null : String(r.template_id),
        event_type: String(r.event_type) as PipEventRow["event_type"],
        actor: r.actor == null ? null : String(r.actor),
        field: r.field == null ? null : String(r.field),
        previous_value: r.previous_value == null ? null : String(r.previous_value),
        new_value: r.new_value == null ? null : String(r.new_value),
        details: (r.details ?? null) as Record<string, unknown> | null,
        created_at: new Date(r.created_at as string).toISOString(),
      };
    });
  }

  // ---- Commission Tracker (owner directive 2026-10-01, Phase A) ----

  async setUserCommissionProfile(repId: string, profile: CommissionProfileInput | null): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    if (profile === null) {
      await this.sql`UPDATE users SET employment_type = NULL, commission_tier = NULL, tier_effective_date = NULL, tier_end_date = NULL, commission_eligible = false, updated_at = now() WHERE id = ${repId}::uuid`;
      return;
    }
    await this.sql`
      UPDATE users SET employment_type = ${profile.employment_type}, commission_tier = ${profile.commission_tier},
        tier_effective_date = ${profile.tier_effective_date}, tier_end_date = ${profile.tier_end_date},
        commission_eligible = ${profile.commission_eligible}, updated_at = now()
      WHERE id = ${repId}::uuid
    `;
  }

  /**
   * Phase C SUBMITTED-CYCLE LOCK (spec §O/§19): a record whose assignment is
   * 'previously_submitted' — or whose cycle row is status 'submitted' — can
   * NEVER be rewritten (no tier/rate/setting/backfill re-run may touch stored
   * payroll). The attempted rewrite no-ops and lands in the audit trail so the
   * attempt is visible forever. Unlocked records keep the Phase-A idempotent
   * replace behavior.
   */
async upsertCommissionWeeklyRecord(row: CommissionWeeklyRow): Promise<CommissionUpsertResult> {

    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    // Idempotent by (user_id, week_start): the close job and the backfill can
    // both run; re-runs REPLACE the same logical record (never duplicates) —
    // UNLESS the stored record is locked by a submitted cycle (Phase C guard).
    const lockRows = await this.sql`
      SELECT cycle_id, assignment, qualifying_bookings, total, calc_version
      FROM commission_weekly WHERE user_id = ${row.user_id}::uuid AND week_start = ${row.week_start}::date
    `;
    const lockExisting = lockRows[0] as Record<string, unknown> | undefined;
    if (lockExisting) {
      const lockCycleId = lockExisting.cycle_id == null ? null : String(lockExisting.cycle_id);
      const lockAssignment = String(lockExisting.assignment);
      const lockCycle = lockCycleId ? await this.getCommissionCycle(lockCycleId) : null;
      const locked = lockAssignment === "previously_submitted" || lockCycle?.status === "submitted";
      if (locked) {
        await this.insertCommissionAdjustment({
          cycle_id: lockCycleId,
          user_id: row.user_id,
          target: "weekly_record",
          target_id: `${row.user_id}:${row.week_start}`,
          field: "rewrite_blocked",
          old_value: `bookings ${Number(lockExisting.qualifying_bookings)} · total ${Number(lockExisting.total).toFixed(2)} · calc v${Number(lockExisting.calc_version)}`,
          new_value: `attempted bookings ${row.qualifying_bookings} · total ${row.total.toFixed(2)} · calc v${row.calc_version}`,
          reason: `Blocked by submitted-cycle lock: record belongs to ${lockAssignment === "previously_submitted" ? "a previously submitted" : `submitted cycle ${lockCycleId ?? ""}`} — stored payroll is frozen (spec §19).`,
          changed_by: "system:write-guard",
        });
        return { written: false, blocked: true };
      }
    }
    await this.sql`
      INSERT INTO commission_weekly (user_id, rep_name, week_start, week_end, employment_type, tier,
        tier_effective_date_used, qualifying_bookings, base_commission, additional_commission, pool_bonus,
        hole_bonus, manual_adjustment, total, calc_date, calc_version, status, cycle_id, assignment, counted_bookings, hole_audit, hole_bonus_capped)
      VALUES (${row.user_id}::uuid, ${row.rep_name}, ${row.week_start}::date, ${row.week_end}::date,
        ${row.employment_type}, ${row.tier}, ${row.tier_effective_date_used}, ${row.qualifying_bookings},
        ${row.base_commission}, ${row.additional_commission}, ${row.pool_bonus}, ${row.hole_bonus},
        ${row.manual_adjustment}, ${row.total}, ${row.calc_date}::timestamptz, ${row.calc_version},
        ${row.status}, ${row.cycle_id}, ${row.assignment}, ${this.sql.json(row.counted_bookings ?? [])}::jsonb, ${this.sql.json(row.hole_audit ?? [])}::jsonb, ${row.hole_bonus_capped})
      ON CONFLICT (user_id, week_start) DO UPDATE SET
        rep_name = EXCLUDED.rep_name, week_end = EXCLUDED.week_end, employment_type = EXCLUDED.employment_type,
        tier = EXCLUDED.tier, tier_effective_date_used = EXCLUDED.tier_effective_date_used,
        qualifying_bookings = EXCLUDED.qualifying_bookings, base_commission = EXCLUDED.base_commission,
        additional_commission = EXCLUDED.additional_commission, pool_bonus = EXCLUDED.pool_bonus,
        hole_bonus = EXCLUDED.hole_bonus, manual_adjustment = EXCLUDED.manual_adjustment,
        total = EXCLUDED.total, calc_date = EXCLUDED.calc_date, calc_version = EXCLUDED.calc_version,
        status = EXCLUDED.status, cycle_id = EXCLUDED.cycle_id, assignment = EXCLUDED.assignment,
        counted_bookings = EXCLUDED.counted_bookings, hole_audit = EXCLUDED.hole_audit,
        hole_bonus_capped = EXCLUDED.hole_bonus_capped, updated_at = now()
    `;
    return { written: true, blocked: false };
  }
  /** §O/§20: move ONLY the audited money fields (manual_adjustment, total) by a dollars delta. */
  async applyCommissionWeeklyCorrection(userId: string, weekStart: string, deltaDollars: number): Promise<void> {
    this.cache.bump();
    await this.ensureSchema();
    const upd = await this.sql`
      UPDATE commission_weekly
      SET manual_adjustment = manual_adjustment + ${deltaDollars}, total = total + ${deltaDollars}, updated_at = now()
      WHERE user_id = ${userId}::uuid AND week_start = ${weekStart}::date
      RETURNING user_id
    `;
    if (upd.length === 0) {
      throw new Error(`No stored weekly record for ${userId}:${weekStart} — corrections target stored records only.`);
    }
  }
  /** §S membership update: cycle_id/assignment only — money columns untouched. */
  async setCommissionRecordAssignment(userId: string, weekStart: string, patch: { cycleId: string | null; assignment: CommissionAssignment }): Promise<void> {
    this.cache.bump();
    await this.ensureSchema();
    const upd = await this.sql`
      UPDATE commission_weekly
      SET cycle_id = ${patch.cycleId}, assignment = ${patch.assignment}, updated_at = now()
      WHERE user_id = ${userId}::uuid AND week_start = ${weekStart}::date
      RETURNING user_id
    `;
    if (upd.length === 0) {
      throw new Error(`No stored weekly record for ${userId}:${weekStart} — membership updates target stored records only.`);
    }
  }

  private commissionWeeklyRow(r: Record<string, unknown>): CommissionWeeklyRow {
    return {
      id: String(r.id),
      user_id: String(r.user_id),
      rep_name: String(r.rep_name),
      week_start: normalizePgBusinessDate(r.week_start) as string,
      week_end: normalizePgBusinessDate(r.week_end) as string,
      employment_type: String(r.employment_type) as CommissionWeeklyRow["employment_type"],
      tier: Number(r.tier),
      tier_effective_date_used: normalizePgBusinessDate(r.tier_effective_date_used),
      qualifying_bookings: Number(r.qualifying_bookings),
      base_commission: Number(r.base_commission),
      additional_commission: Number(r.additional_commission),
      pool_bonus: Number(r.pool_bonus),
      hole_bonus: Number(r.hole_bonus),
      manual_adjustment: Number(r.manual_adjustment),
      total: Number(r.total),
      calc_date: new Date(r.calc_date as string).toISOString(),
      calc_version: Number(r.calc_version),
      status: String(r.status) as CommissionWeeklyRow["status"],
      cycle_id: r.cycle_id == null ? null : String(r.cycle_id),
      assignment: String(r.assignment) as CommissionWeeklyRow["assignment"],
      counted_bookings: (r.counted_bookings ?? []) as CountedBookingSnapshot[],
      hole_audit: (r.hole_audit ?? []) as HoleAuditSnapshot[],
      hole_bonus_capped: Boolean(r.hole_bonus_capped),
    };
  }
  private get commissionWeeklyCols() {
    return this.sql`user_id::text AS user_id, rep_name, week_start::text::date::text AS week_start, week_end::text::date::text AS week_end, employment_type, tier, tier_effective_date_used::text::date::text AS tier_effective_date_used, qualifying_bookings, base_commission, additional_commission, pool_bonus, hole_bonus, manual_adjustment, total, calc_date, calc_version, status, cycle_id, assignment, counted_bookings, hole_audit, hole_bonus_capped`;
  }

  async getCommissionWeeklyRecords(filter?: { userId?: string; weekStart?: string; cycleId?: string; assignment?: CommissionAssignment }): Promise<CommissionWeeklyRow[]> {
    await this.ensureSchema();
    const f = filter ?? {};
    // Explicit query forms per filter combination (postgres.js treats every ${}
    // as a bound parameter — conditional SQL must live in the template itself).
    const rows =
      f.userId && f.weekStart
        ? await this.sql`SELECT ${this.commissionWeeklyCols} FROM commission_weekly WHERE user_id = ${f.userId}::uuid AND week_start = ${f.weekStart}::date ORDER BY week_start DESC`
        : f.userId
          ? await this.sql`SELECT ${this.commissionWeeklyCols} FROM commission_weekly WHERE user_id = ${f.userId}::uuid ORDER BY week_start DESC`
          : f.weekStart
            ? await this.sql`SELECT ${this.commissionWeeklyCols} FROM commission_weekly WHERE week_start = ${f.weekStart}::date ORDER BY week_start DESC`
            : f.cycleId
              ? await this.sql`SELECT ${this.commissionWeeklyCols} FROM commission_weekly WHERE cycle_id = ${f.cycleId} ORDER BY week_start DESC`
              : f.assignment
                ? await this.sql`SELECT ${this.commissionWeeklyCols} FROM commission_weekly WHERE assignment = ${f.assignment} ORDER BY week_start DESC`
                : await this.sql`SELECT ${this.commissionWeeklyCols} FROM commission_weekly ORDER BY week_start DESC`;
    let out = rows.map((r) => this.commissionWeeklyRow(r as Record<string, unknown>));
    // In-memory narrowing for combined filters not covered above (rare; keeps semantics total).
    if (f.cycleId && (f.userId || f.weekStart)) out = out.filter((r) => r.cycle_id === f.cycleId);
    if (f.assignment && (f.userId || f.weekStart || f.cycleId)) out = out.filter((r) => r.assignment === f.assignment);
    return out;
  }

  async upsertCommissionCycle(cycle: CommissionCycleRow): Promise<void> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    await this.sql`
      INSERT INTO commission_cycles (id, label, start_date, end_date, submission_date, payroll_date, status, submitted_date, submitted_by, final_snapshot)
      VALUES (${cycle.id}, ${cycle.label}, ${cycle.start_date}::date, ${cycle.end_date}::date, ${cycle.submission_date}::date,
        ${cycle.payroll_date}::date, ${cycle.status}, ${cycle.submitted_date}::date, ${cycle.submitted_by},
        ${cycle.final_snapshot == null ? null : this.sql.json(cycle.final_snapshot)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        label = EXCLUDED.label, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
        submission_date = EXCLUDED.submission_date, payroll_date = EXCLUDED.payroll_date, status = EXCLUDED.status,
        submitted_date = EXCLUDED.submitted_date, submitted_by = EXCLUDED.submitted_by,
        final_snapshot = EXCLUDED.final_snapshot, updated_at = now()
    `;
  }

  private commissionCycleRow(r: Record<string, unknown>): CommissionCycleRow {
    return {
      id: String(r.id),
      label: String(r.label),
      start_date: normalizePgBusinessDate(r.start_date) as string,
      end_date: normalizePgBusinessDate(r.end_date) as string,
      submission_date: normalizePgBusinessDate(r.submission_date) as string,
      payroll_date: normalizePgBusinessDate(r.payroll_date) as string,
      status: String(r.status) as CommissionCycleRow["status"],
      submitted_date: normalizePgBusinessDate(r.submitted_date),
      submitted_by: r.submitted_by == null ? null : String(r.submitted_by),
      final_snapshot: (r.final_snapshot ?? null) as Record<string, unknown> | null,
      created_at: new Date(r.created_at as string).toISOString(),
      updated_at: new Date(r.updated_at as string).toISOString(),
    };
  }
  private get commissionCycleCols() {
    return this.sql`id, label, start_date::text::date::text AS start_date, end_date::text::date::text AS end_date, submission_date::text::date::text AS submission_date, payroll_date::text::date::text AS payroll_date, status, submitted_date::text::date::text AS submitted_date, submitted_by, final_snapshot, created_at, updated_at`;
  }

  async getCommissionCycle(cycleId: string): Promise<CommissionCycleRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT ${this.commissionCycleCols} FROM commission_cycles WHERE id = ${cycleId}`;
    return rows[0] ? this.commissionCycleRow(rows[0] as Record<string, unknown>) : null;
  }

  async getCommissionCycles(): Promise<CommissionCycleRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT ${this.commissionCycleCols} FROM commission_cycles ORDER BY start_date DESC`;
    return rows.map((r) => this.commissionCycleRow(r as Record<string, unknown>));
  }

  async insertCommissionAdjustment(row: CommissionAdjustmentInput): Promise<CommissionAdjustmentRow> {
    this.cache.bump(); // PERF: any write invalidates the short-TTL read cache
    await this.ensureSchema();
    // §O/§29: the reason is REQUIRED — enforced HERE (both stores), so no UI
    // path can bypass it. old_value/new_value may be null (add/remove).
    if (typeof row.reason !== "string" || row.reason.trim().length === 0) {
      throw new Error("A correction reason is required (who/what/old/new/reason/when audit).");
    }
    const rows = await this.sql`
      INSERT INTO commission_adjustments (cycle_id, user_id, target, target_id, field, old_value, new_value, reason, changed_by)
      VALUES (${row.cycle_id}, ${row.user_id == null ? null : row.user_id}::uuid, ${row.target}, ${row.target_id},
        ${row.field}, ${row.old_value}, ${row.new_value}, ${row.reason.trim()}, ${row.changed_by})
      RETURNING id::text AS id, changed_at
    `;
    return {
      ...row,
      reason: row.reason.trim(),
      id: String(rows[0].id),
      changed_at: new Date(rows[0].changed_at as string).toISOString(),
    };
  }

  async getCommissionAdjustments(filter?: { cycleId?: string; userId?: string; targetId?: string }): Promise<CommissionAdjustmentRow[]> {
    await this.ensureSchema();
    const f = filter ?? {};
    const rows =
      f.cycleId && f.targetId
        ? await this.sql`SELECT id::text AS id, cycle_id, user_id::text AS user_id, target, target_id, field, old_value, new_value, reason, changed_by, changed_at FROM commission_adjustments WHERE cycle_id = ${f.cycleId} AND target_id = ${f.targetId} ORDER BY changed_at DESC`
        : f.cycleId
          ? await this.sql`SELECT id::text AS id, cycle_id, user_id::text AS user_id, target, target_id, field, old_value, new_value, reason, changed_by, changed_at FROM commission_adjustments WHERE cycle_id = ${f.cycleId} ORDER BY changed_at DESC`
          : f.userId
            ? await this.sql`SELECT id::text AS id, cycle_id, user_id::text AS user_id, target, target_id, field, old_value, new_value, reason, changed_by, changed_at FROM commission_adjustments WHERE user_id = ${f.userId}::uuid ORDER BY changed_at DESC`
            : f.targetId
              ? await this.sql`SELECT id::text AS id, cycle_id, user_id::text AS user_id, target, target_id, field, old_value, new_value, reason, changed_by, changed_at FROM commission_adjustments WHERE target_id = ${f.targetId} ORDER BY changed_at DESC`
              : await this.sql`SELECT id::text AS id, cycle_id, user_id::text AS user_id, target, target_id, field, old_value, new_value, reason, changed_by, changed_at FROM commission_adjustments ORDER BY changed_at DESC`;
    return rows.map((r) => {
      const base = r as Record<string, unknown>;
      return {
        id: String(base.id),
        cycle_id: base.cycle_id == null ? null : String(base.cycle_id),
        user_id: base.user_id == null ? null : String(base.user_id),
        target: String(base.target),
        target_id: String(base.target_id),
        field: String(base.field),
        old_value: base.old_value == null ? null : String(base.old_value),
        new_value: base.new_value == null ? null : String(base.new_value),
        reason: String(base.reason),
        changed_by: String(base.changed_by),
        changed_at: new Date(base.changed_at as string).toISOString(),
      };
    });
  }
}
