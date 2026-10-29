import type { Migration } from "./runner";

/**
 * VERSION 1 — BASELINE (FROZEN on merge; docs/MIGRATION-PLAN.md §2.2).
 *
 * The pre-runner PgStore cold-start DDL array (140 statements: 49 CREATE
 * TABLE / 48 ALTER TABLE / 38 CREATE INDEX / 5 guarded seed UPDATEs) moved
 * here with byte-identical statement text — same order EXCEPT two statements
 * (see DEVIATION below), same idempotency guarantees. It is the append-only
 * log of everything the schema ever needed, and after this migration merges
 * it may NEVER be edited: the runner records a sha256 checksum of these
 * statements at stamp time and REFUSES TO BOOT on mismatch
 * (SchemaMigrationError), so any accidental edit surfaces as a named error
 * instead of a silent drift (§1.2 risk 6).
 *
 * DEVIATION (the only one, documented): two ALTER statements were misplaced
 * BEFORE their table's CREATE in the original array —
 *   `ALTER TABLE leads ADD COLUMN …source_raw_date` (was before CREATE leads)
 *   `ALTER TABLE pip_templates ADD COLUMN …version` (was before CREATE pip_templates)
 * Harmless on prod (every object exists; both are no-ops at any position)
 * but they made a FRESH empty DB fail (`relation "leads" does not exist`),
 * breaking MIGRATION-PLAN §1.1's own ordering rule ("base tables before the
 * ALTERs that extend them") and the runner's fresh-install contract. The
 * two statements were MOVED (text untouched, count untouched) to directly
 * after their CREATE TABLE. A registry invariant test pins dependency order
 * so this can never regress.
 *
 * Baseline semantics against the three DB states:
 *   - Production (all objects exist): every statement is a no-op —
 *     `IF NOT EXISTS` skips, the 5 guarded seed UPDATEs fail their
 *     `AND <col> IS NULL` conditions. The first boot with the runner
 *     stamps version 1 WITHOUT executing destructive or duplicate DDL.
 *   - Fresh empty DB (tests / new installs): the full 140 apply in order,
 *     ending with the version stamp.
 *   - Already-stamped DB: the runner reads the marker and runs NONE of
 *     these statements (zero-DDL cold start — the point of the runner).
 *
 * Statement-list migrations with nonTransactional: true run one statement
 * at a time in autocommit (each under the caller's per-statement cap), so
 * the lock profile against a LIVE production DB is identical to the
 * pre-runner sweep — no lock accumulates across 140 statements. This is
 * the deliberate non-transactional choice for v1 (MIGRATION-PLAN §2.1's
 * transactional default is for future migrations on new objects).
 *
 * FUTURE SEEDS ARE FORBIDDEN HERE: the 5 guarded UPDATEs are data, kept
 * only because the baseline snapshot is verbatim. New data seeds belong to
 * an app-level guarded step, never to a migration file (§2.3).
 */
export const migration: Migration = {
  version: 1,
  name: "baseline",
  nonTransactional: true,
  statements: [
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
  // AUDIT FIDELITY (10/23): the sheet's raw Date-column text, nullable, populated going forward only — never backfilled.
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
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_raw_date text`,
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
  `ALTER TABLE pip_templates ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`,
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
     ON availability_discrepancies (calendar_id, date_et, time_et, kind) WHERE resolved_at IS NULL`,
  // PR-1's cached /calendars + /appointment-types catalog - REPLACE-all cache
  // (truth = the fresh answer; the runs table audits when it was fetched).
  // 2026-10-07 outage fix: these two DDL entries were missing from this list
  // while putAvailabilityCatalog/getAvailabilityCatalog already referenced the
  // tables - every pg-mode catalog read/write threw "relation does not exist",
  // which 500-failed the availability page loader (tests never caught it: the
  // memory store backs the catalog with Maps, no schema involved).
  `CREATE TABLE IF NOT EXISTS availability_calendars (
    calendar_id text PRIMARY KEY,
    name text NOT NULL,
    fetched_at timestamptz NOT NULL,
    run_id uuid NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS availability_appointment_types (
    appointment_type_id text PRIMARY KEY,
    name text NOT NULL,
    calendar_ids jsonb NOT NULL,
    duration_minutes int,
    fetched_at timestamptz NOT NULL,
    run_id uuid NOT NULL
  )`,
  // ---- RETENTION IDENTITY CHAIN (stage 2; owner-approved D1–D14, 2026-10-19) ----
  // Additive-only per IMPLEMENTATION-PLAN.md §13: canonical internal clients,
  // sticky per-system member links, Data Match Exceptions queue, plus the
  // attempt-evidence tables the next stage's ledger/outcomes jobs write.
  // Nothing here ALTERs an existing table; uniqueness lives on the LINK table.
  // Deviations from the §13 sketch (needed for re-run idempotence + the
  // owner's "every link records evidence" requirement): internal_clients
  // gains a deterministic seed_key UNIQUE; client_match_links gains an
  // evidence jsonb; data_match_exceptions gains a dedupe_key UNIQUE.
  `CREATE TABLE IF NOT EXISTS internal_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    display_name text,
    normalized_phone text,
    normalized_email text,
    ghl_contact_external_id text,
    match_state text NOT NULL DEFAULT 'auto_matched',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS internal_clients_phone_idx ON internal_clients (normalized_phone)`,
  `CREATE INDEX IF NOT EXISTS internal_clients_email_idx ON internal_clients (normalized_email)`,
  `CREATE TABLE IF NOT EXISTS client_match_links (
    internal_client_id uuid NOT NULL REFERENCES internal_clients(id),
    provider text NOT NULL,
    entity text NOT NULL,
    external_id text NOT NULL,
    match_method text NOT NULL,
    confidence text,
    evidence jsonb,
    resolved_by text NOT NULL DEFAULT 'auto',
    resolved_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, entity, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS client_match_links_client_idx ON client_match_links (internal_client_id)`,
  `CREATE INDEX IF NOT EXISTS client_match_links_ext_idx ON client_match_links (provider, entity, external_id)`,
  `CREATE TABLE IF NOT EXISTS data_match_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    context jsonb,
    status text NOT NULL DEFAULT 'open',
    resolved_internal_client_id uuid REFERENCES internal_clients(id),
    resolved_method text,
    resolved_by text,
    resolved_at timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS retention_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_client_id uuid NOT NULL REFERENCES internal_clients(id),
    appointment_id uuid REFERENCES appointments(id),
    call_id uuid REFERENCES calls(id),
    source text NOT NULL,
    external_message_id text NOT NULL,
    employee_user_id uuid REFERENCES users(id),
    employee_external_id text,
    attempt_at timestamptz NOT NULL,
    call_status text,
    duration_seconds int,
    direction text,
    attempt_class text NOT NULL,
    evidence jsonb NOT NULL,
    attribution text NOT NULL DEFAULT 'window',
    UNIQUE (source, external_message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS retention_appointment_outcomes (
    appointment_id uuid PRIMARY KEY REFERENCES appointments(id),
    internal_client_id uuid NOT NULL,
    contact_due_date date NOT NULL,
    eligible boolean NOT NULL,
    eligibility_basis text,
    attempts_count int NOT NULL DEFAULT 0,
    first_attempt_at timestamptz,
    last_attempt_at timestamptz,
    any_answered boolean NOT NULL DEFAULT false,
    final_status text NOT NULL,
    evidence jsonb NOT NULL,
    needs_review_reason text,
    computed_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS retention_cancellations (
    appointment_id uuid PRIMARY KEY REFERENCES appointments(id),
    internal_client_id uuid,
    ghl_contact_external_id text,
    cancelled_at timestamptz,
    attempts_count int DEFAULT 0,
    any_answered boolean DEFAULT false,
    final_contact_status text,
    outcome text NOT NULL DEFAULT 'pending',
    successor_appointment_id uuid,
    recovered boolean NOT NULL DEFAULT false,
    recovered_at timestamptz,
    manual_overrides jsonb,
    notes jsonb
  )`,
  // RETENTION NO-SHOW LEDGER (stage 4b — the no-show pipeline; plan §16 +
  // ruling D10): one row per DETECTED no-show appointment (PK appointment_id).
  // Detection is the owner-ratified proxy — the session's start passed while
  // the appointment was still scheduled and not cancelled, as OBSERVED by the
  // no-shows engine on a pass. session_at / session_date_et / detected_at are
  // write-once (UPDATEs COALESCE them): a later cancellation or reschedule of
  // the same appointment never moves or deletes the missed-session record —
  // the state column carries what came after. Management overrides (the
  // Settings stage) survive every automatic pass, exactly like §11's ledger.
  `CREATE TABLE IF NOT EXISTS retention_no_shows (
    appointment_id uuid PRIMARY KEY REFERENCES appointments(id),
    internal_client_id uuid,
    ghl_contact_external_id text,
    session_at timestamptz,
    session_date_et date,
    detected_at timestamptz NOT NULL,
    attempts_count int DEFAULT 0,
    any_answered boolean DEFAULT false,
    final_contact_status text,
    state text NOT NULL DEFAULT 'open',
    successor_appointment_id uuid,
    manual_overrides jsonb,
    notes jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS ret_no_shows_session_idx ON retention_no_shows (session_date_et DESC)`,
  `CREATE INDEX IF NOT EXISTS ret_no_shows_state_idx ON retention_no_shows (state)`,
  `CREATE TABLE IF NOT EXISTS retention_transfers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id uuid REFERENCES appointments(id),
    handler_user_id uuid REFERENCES users(id),
    original_booker text,
    reason text,
    outcome text,
    detected_at timestamptz NOT NULL DEFAULT now(),
    details jsonb
  )`,
  // STAGE 5 (retention transfers engine — owner build order "transfers /
  // original-booker exception"): additive columns on the §13-declared table
  // + the content key (ONE row per ORIGINAL appointment — UNIQUE
  // appointment_id). The §13 shape stays: outcome is filled 'transferred',
  // original_booker carries the original calendar's human label (the
  // ORIGINAL booker side of the exception), reason carries the detection
  // rule, details carries the evidence notes. The structured columns below
  // are what the engine + surfaces read. Write-once fields (detected_at,
  // original_calendar_id/name) are COALESCEd by the UPDATE path — a later
  // re-derivation never moves the original side of a confirmed transfer.
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS internal_client_id uuid`,
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS ghl_contact_external_id text`,
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS original_calendar_id text`,
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS original_calendar_name text`,
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS receiving_appointment_id uuid`,
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS receiving_calendar_id text`,
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS receiving_calendar_name text`,
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS basis text`,
  `ALTER TABLE retention_transfers ADD COLUMN IF NOT EXISTS manual_overrides jsonb`,
  `CREATE UNIQUE INDEX IF NOT EXISTS retention_transfers_appt_key ON retention_transfers (appointment_id)`,
  `CREATE INDEX IF NOT EXISTS retention_transfers_client_idx ON retention_transfers (internal_client_id)`,
  `CREATE TABLE IF NOT EXISTS retention_owner_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_user_id uuid NOT NULL REFERENCES users(id),
    name text,
    initials text,
    active boolean NOT NULL DEFAULT true,
    effective_start date NOT NULL,
    effective_end date
  )`,
  `CREATE TABLE IF NOT EXISTS ret_scorecards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    week_start date NOT NULL UNIQUE,
    week_end date NOT NULL,
    due_days integer NOT NULL,
    owner_user_id uuid REFERENCES users(id),
    owner_name text,
    owner_initials text,
    eligible integer NOT NULL,
    called integer NOT NULL,
    spoken_with integer NOT NULL,
    unreached integer NOT NULL,
    compliance_appointment double precision,
    compliance_attempt double precision,
    cancellations_worked integer,
    saves integer,
    reschedules integer,
    recoveries integer,
    recovery_rate double precision,
    no_shows integer,
    no_shows_spoken integer,
    no_shows_not_spoken integer,
    transfers integer,
    needs_review integer NOT NULL,
    match_exceptions integer NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    compute_version text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ret_scorecards_week_idx ON ret_scorecards (week_start DESC)`,
  `CREATE INDEX IF NOT EXISTS ret_attempts_appt_idx ON retention_attempts (appointment_id)`,
  `CREATE INDEX IF NOT EXISTS ret_attempts_client_idx ON retention_attempts (internal_client_id, attempt_at)`,
  `CREATE INDEX IF NOT EXISTS ret_outcomes_status_idx ON retention_appointment_outcomes (final_status, contact_due_date)`
  ],
};
