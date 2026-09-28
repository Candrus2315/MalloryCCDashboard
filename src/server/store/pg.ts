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
  OpportunityRow,
  RepGoalRowFull,
  Store,
  SyncRunRow,
  TeamGoalRow,
  UserRow,
} from "./types";
import { DEFAULT_SETTINGS, normalizeAppSettings, parseSyncStartedMs, STALE_RUN_REAP_MINUTES } from "./types";

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

export class PgStore implements Store {
  mode = "postgres" as const;
  private sql: ReturnType<typeof postgres>;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string) {
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
    this.sql = postgres(databaseUrl, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      ...(needsSsl ? { ssl: "require" } : {}),
    });
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
    await this.ensureSchema();
    const rows = await this.sql`SELECT value FROM app_settings WHERE key = 'app' LIMIT 1`;
    if (!rows.length) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    // Deep-merge the nested groups so settings saved before a newer default
    // field existed (e.g. studio.recurring_blocks, sheets.<sheet>.mode) still
    // see that default. Shared with the memory store via normalizeAppSettings.
    return normalizeAppSettings(rows[0].value);
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
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
    await this.ensureSchema();
    await this.sql`
      INSERT INTO team_goals (week_start, booking_goal, lead_budget)
      VALUES (${row.week_start}::date, ${row.booking_goal}, ${row.lead_budget})
      ON CONFLICT (week_start) DO UPDATE SET booking_goal = EXCLUDED.booking_goal, lead_budget = EXCLUDED.lead_budget, updated_at = now()
    `;
  }
  async getTeamGoal(weekStart: string): Promise<TeamGoalRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT week_start::text::date::text AS week_start, booking_goal, lead_budget FROM team_goals WHERE week_start = ${weekStart}::date`;
    return rows[0] ? { week_start: String(rows[0].week_start), booking_goal: Number(rows[0].booking_goal), lead_budget: Number(rows[0].lead_budget) } : null;
  }
  async getTeamGoals(): Promise<TeamGoalRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT week_start::text::date::text AS week_start, booking_goal, lead_budget FROM team_goals ORDER BY week_start`;
    return rows.map((r) => ({ week_start: String(r.week_start), booking_goal: Number(r.booking_goal), lead_budget: Number(r.lead_budget) }));
  }
  async upsertRepGoals(rows: RepGoalRowFull[]): Promise<void> {
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
    await this.ensureSchema();
    const rows = await this.sql`SELECT rep_id::text, week_start::text AS week_start, goal FROM rep_goals WHERE week_start = ${weekStart}::date`;
    return rows.map((r) => ({ rep_id: String(r.rep_id), week_start: String(r.week_start), goal: Number(r.goal) }));
  }
  async deleteRepGoal(repId: string, weekStart: string): Promise<void> {
    await this.ensureSchema();
    await this.sql`DELETE FROM rep_goals WHERE rep_id = ${repId}::uuid AND week_start = ${weekStart}::date`;
  }

  async upsertUsers(rows: UserRow[]): Promise<number> {
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
    await this.ensureSchema();
    await this.sql`UPDATE users SET call_start_date = ${date}, updated_at = now() WHERE id = ${repId}::uuid`;
  }
  private userRow(r: Record<string, unknown>): UserRow {
    return {
      id: String(r.id),
      provider: String(r.provider),
      external_id: String(r.external_id),
      name: String(r.name),
      email: r.email == null ? null : String(r.email),
      is_active: Boolean(r.is_active),
      call_start_date: r.call_start_date == null ? null : String(r.call_start_date),
    };
  }
  async getUsers(): Promise<UserRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, provider, external_id, name, email, is_active, call_start_date FROM users WHERE is_active ORDER BY name`;
    return rows.map((r) => this.userRow(r as Record<string, unknown>));
  }
  async getAllUsers(): Promise<UserRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text AS id, provider, external_id, name, email, is_active, call_start_date FROM users ORDER BY name`;
    return rows.map((r) => this.userRow(r as Record<string, unknown>));
  }

  async upsertContacts(rows: ContactRow[]): Promise<number> {
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

  async upsertCalls(
    rows: (CallRow & { external_call_id: string; provider: string; contact_resolution_method?: string | null; contact_resolved_at?: string | null })[],
  ): Promise<number> {
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
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, rep_id, contact_id, started_at, duration_seconds, over_two_minutes, external_call_id, provider_rep_external_id, conversation_id, contact_resolution_method FROM calls WHERE started_at >= ${startUtc} AND started_at < ${endUtc}`;
    return rows.map((r) => this.callRow(r as Record<string, unknown>));
  }
  async getAllCallsSince(startUtc: string): Promise<CallRow[]> {
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

  async upsertOpportunities(rows: OpportunityRow[]): Promise<number> {
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO opportunities (provider, external_id, name, status, monetary_value, contact_id, rep_id, pipeline_id, stage_id, source_created_at, source_updated_at)
        VALUES (${r.provider}, ${r.external_id}, ${r.name}, ${r.status}, ${r.monetary_value}, ${r.contact_id}, ${r.rep_id}, ${r.pipeline_id}, ${r.stage_id}, ${r.source_created_at}, ${r.source_updated_at})
        ON CONFLICT (provider, external_id) DO UPDATE SET
          name = EXCLUDED.name, status = EXCLUDED.status, monetary_value = EXCLUDED.monetary_value,
          contact_id = EXCLUDED.contact_id, rep_id = EXCLUDED.rep_id,
          pipeline_id = EXCLUDED.pipeline_id, stage_id = EXCLUDED.stage_id,
          source_created_at = EXCLUDED.source_created_at, source_updated_at = EXCLUDED.source_updated_at, updated_at = now()
      `;
    }
    return rows.length;
  }
  async getOpportunities(): Promise<OpportunityRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, external_id, name, status, monetary_value, contact_id::text, rep_id::text, pipeline_id, stage_id, source_created_at::text, source_updated_at::text FROM opportunities`;
    return rows.map((r) => ({
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
    }));
  }

  /**
   * Replace demo HighLevel content with live data: rows the demo generator
   * seeded all carry external ids prefixed "demo-". FK-safe ordered cleanup —
   * null out references first (attributions, appointments, leads, contacts,
   * rep_goals), then delete calls → contacts → users. Idempotent.
   */
  async deleteDemoHighLevelRows(): Promise<{ users: number; contacts: number; calls: number }> {
    await this.ensureSchema();
    // Shared predicates (subqueries keep every statement consistent + idempotent)
    const demoUsers = this.sql`SELECT id FROM users WHERE provider = 'highlevel' AND external_id LIKE 'demo-%'`;
    const demoContacts = this.sql`SELECT id FROM contacts WHERE provider = 'highlevel' AND external_id LIKE 'demo-%'`;
    const demoCalls = this.sql`SELECT id FROM calls WHERE provider = 'highlevel' AND external_call_id LIKE 'demo-%'`;
    const [{ n: calls }] = await this.sql`
      WITH cleared AS (
        UPDATE booking_attributions SET call_id = NULL
        WHERE call_id IN (${demoCalls}) RETURNING 1
      ), deleted AS (
        DELETE FROM calls WHERE id IN (${demoCalls}) RETURNING 1
      )
      SELECT (SELECT count(*) FROM deleted) AS n`;
    const [{ n: contacts }] = await this.sql`
      WITH nulled_appts AS (
        UPDATE appointments SET contact_id = NULL WHERE contact_id IN (${demoContacts}) RETURNING 1
      ), nulled_leads AS (
        UPDATE leads SET contact_id = NULL WHERE contact_id IN (${demoContacts}) RETURNING 1
      ), nulled_opps AS (
        UPDATE opportunities SET contact_id = NULL WHERE contact_id IN (${demoContacts}) RETURNING 1
      ), nulled_reps AS (
        UPDATE contacts SET assigned_rep_id = NULL WHERE assigned_rep_id IN (${demoUsers}) RETURNING 1
      ), deleted AS (
        DELETE FROM contacts WHERE id IN (${demoContacts}) RETURNING 1
      )
      SELECT (SELECT count(*) FROM deleted) AS n`;
    const [{ n: users }] = await this.sql`
      WITH nulled_leads AS (
        UPDATE leads SET assigned_rep_id = NULL WHERE assigned_rep_id IN (${demoUsers}) RETURNING 1
      ), nulled_opps AS (
        UPDATE opportunities SET rep_id = NULL WHERE rep_id IN (${demoUsers}) RETURNING 1
      ), deleted_goals AS (
        DELETE FROM rep_goals WHERE rep_id IN (${demoUsers}) RETURNING 1
      ), deleted AS (
        DELETE FROM users WHERE id IN (${demoUsers}) RETURNING 1
      )
      SELECT (SELECT count(*) FROM deleted) AS n`;
    return { users: Number(users), contacts: Number(contacts), calls: Number(calls) };
  }
  async deleteDemoAcuityRows(): Promise<{ appointments: number; blocked: number }> {
    await this.ensureSchema();
    // Demo Acuity rows: appointment ids prefixed "demo-" + demo blocked-time
    // rows (provider acuity). Manual blocks (provider 'manual') and recurring
    // blocks (settings) are untouched. FK: attributions cascade with their
    // appointment. Idempotent.
    const [{ n: appointments }] = await this.sql`SELECT count(*)::int AS n FROM appointments WHERE acuity_appointment_id LIKE 'demo-%'`;
    await this.sql`DELETE FROM appointments WHERE acuity_appointment_id LIKE 'demo-%'`;
    const [{ n: blocked }] = await this.sql`SELECT count(*)::int AS n FROM blocked_times WHERE provider = 'acuity' AND external_id LIKE 'demo-%'`;
    await this.sql`DELETE FROM blocked_times WHERE provider = 'acuity' AND external_id LIKE 'demo-%'`;
    return { appointments: Number(appointments), blocked: Number(blocked) };
  }

  async upsertAppointments(rows: (AppointmentRow & { acuity_appointment_id: string; client_name?: string | null; client_phone?: string | null; client_email?: string | null; created_business_date?: string | null; created_time_source?: string | null; created_time_precision?: string | null; raw?: Record<string, unknown> | null; payment_state?: string | null; booking_win_business_date?: string | null; payment_business_date_source?: string | null; first_seen_paid_at?: string | null })[]): Promise<number> {
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO appointments (acuity_appointment_id, contact_id, calendar_id, calendar_name, appointment_type, appointment_datetime, duration_minutes, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, client_name, client_phone, client_email)
        VALUES (${r.acuity_appointment_id}, ${r.contact_id}, ${r.calendar_id}, ${r.calendar_name ?? null}, ${r.appointment_type}, ${r.appointment_datetime}, ${r.duration_minutes ?? null}, ${r.created_at}, ${r.created_business_date ?? null}, ${r.created_time_source ?? null}, ${r.created_time_precision ?? null}, ${r.payment_state ?? null}, ${r.booking_win_business_date ?? null}, ${r.payment_business_date_source ?? null}, ${r.first_seen_paid_at ?? null}, ${r.raw ?? null}, ${r.status}, ${r.cancelled}, ${r.client_name ?? null}, ${r.client_phone ?? null}, ${r.client_email ?? null})
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
          raw = EXCLUDED.raw,
          status = EXCLUDED.status, cancelled = EXCLUDED.cancelled,
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
      status: String(r.status),
      cancelled: Boolean(r.cancelled),
    };
  }
  async getAppointmentsCreatedBusinessDateBetween(start: string, end: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    // S7c: created-based metrics bucket on the ET BUSINESS DATE column.
    const rows = await this.sql`SELECT id, contact_id, calendar_id, appointment_type, appointment_datetime, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw FROM appointments WHERE created_business_date >= ${start}::date AND created_business_date <= ${end}::date`;
    return rows.map((r) => this.apptRow(r as Record<string, unknown>));
  }
  async getAppointmentsByWinBusinessDateBetween(start: string, end: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    // BOOKING WIN bucket (rev 12): the win-date SUPERSET — wins by the date
    // the deposit was received, UNION not-yet-derived/legacy rows by created
    // date (the metrics layer applies the win filters + fallback rules; unpaid
    // rows returned here never count).
    const rows = await this.sql`SELECT id, contact_id, calendar_id, appointment_type, appointment_datetime, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw FROM appointments WHERE (booking_win_business_date >= ${start}::date AND booking_win_business_date <= ${end}::date) OR (booking_win_business_date IS NULL AND created_business_date >= ${start}::date AND created_business_date <= ${end}::date)`;
    return rows.map((r) => this.apptRow(r as Record<string, unknown>));
  }
  async getAppointmentsOverlapping(startUtc: string, endUtc: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    // Availability path: carries the per-appointment duration (session length),
    // calendar name (scope matching), acuity id AND the client contact fields
    // (the attribution engine's phone/email tiers read them from this selector)
    // — the lean selectors used by the booking metrics keep their original columns.
    const rows = await this.sql`SELECT id, contact_id, calendar_id, calendar_name, acuity_appointment_id, appointment_type, appointment_datetime, duration_minutes, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, client_name, client_phone, client_email FROM appointments WHERE appointment_datetime >= ${startUtc} AND appointment_datetime < ${endUtc}`;
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
    const rows = await this.sql`SELECT id, contact_id, calendar_id, appointment_type, appointment_datetime, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled FROM appointments WHERE appointment_datetime >= ${startUtc} OR created_at >= ${startUtc}`;
    return rows.map((r) => this.apptRow(r as Record<string, unknown>));
  }
  async getAppointmentsWithClientsSince(startUtc: string): Promise<(AppointmentRow & {
    acuity_appointment_id: string | null;
    client_name: string | null;
    client_phone: string | null;
    client_email: string | null;
    calendar_name: string | null;
  })[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, contact_id, calendar_id, calendar_name, acuity_appointment_id, appointment_type, appointment_datetime, duration_minutes, created_at, created_business_date, created_time_source, created_time_precision, payment_state, booking_win_business_date, payment_business_date_source, first_seen_paid_at, raw, status, cancelled, client_name, client_phone, client_email FROM appointments WHERE appointment_datetime >= ${startUtc} OR created_at >= ${startUtc}`;
    return rows.map((r) => ({
      ...this.apptRow(r as Record<string, unknown>),
      acuity_appointment_id: r.acuity_appointment_id ? String(r.acuity_appointment_id) : null,
      client_name: r.client_name ? String(r.client_name) : null,
      client_phone: r.client_phone ? String(r.client_phone) : null,
      client_email: r.client_email ? String(r.client_email) : null,
      calendar_name: r.calendar_name ? String(r.calendar_name) : null,
    }));
  }

  async upsertAttributions(rows: AttributionRow[], opts?: { force?: boolean }): Promise<number> {
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
    await this.ensureSchema();
    // Manual UNASSIGN: the row is derived data — delete it and the next
    // attribution tick recomputes the appointment from raw rows.
    await this.sql`DELETE FROM booking_attributions WHERE appointment_id = ${appointmentId}::uuid`;
  }

  async upsertLeads(rows: (LeadRow & { source_id: string; provider: string; name?: string | null; phone?: string | null; email?: string | null })[]): Promise<number> {
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
  async updateLeadWorkDate(id: string, workDate: string): Promise<void> {
    await this.ensureSchema();
    const res = await this.sql`UPDATE leads SET work_date = ${workDate}::date, updated_at = now() WHERE id = ${id}::uuid RETURNING id::text`;
    if (!res.length) throw new Error(`Lead ${id} not found`);
  }

  async upsertLeadCountAdjustment(row: Omit<LeadCountAdjustmentRow, "updated_at">): Promise<void> {
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
    await this.ensureSchema();
    const rows = await this.sql`SELECT weekday, open_time, close_time, active FROM availability_rules ORDER BY weekday, open_time`;
    return rows.map((r) => ({ weekday: Number(r.weekday), open_time: String(r.open_time), close_time: String(r.close_time), active: Boolean(r.active) }));
  }

  async upsertBlockedTimes(rows: (BlockedTimeRow & { provider: string; external_id: string })[]): Promise<number> {
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
    await this.ensureSchema();
    await this.sql`DELETE FROM blocked_times WHERE id = ${id}::uuid`;
  }

  async upsertDailyPriorities(row: DailyPrioritiesRow): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO daily_priorities (date, priority1, priority2, priority3) VALUES (${row.date}::date, ${row.priority1}, ${row.priority2}, ${row.priority3})
      ON CONFLICT (date) DO UPDATE SET priority1 = EXCLUDED.priority1, priority2 = EXCLUDED.priority2, priority3 = EXCLUDED.priority3, updated_at = now()
    `;
  }
  async getDailyPriorities(date: string): Promise<DailyPrioritiesRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT date::text, priority1, priority2, priority3, updated_at::text FROM daily_priorities WHERE date = ${date}::date`;
    return rows[0]
      ? { date: String(rows[0].date), priority1: rows[0].priority1, priority2: rows[0].priority2, priority3: rows[0].priority3, updated_at: String(rows[0].updated_at) }
      : null;
  }

  async upsertConnection(row: ConnectionRow): Promise<void> {
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
    await this.ensureSchema();
    const rows = await this.sql`INSERT INTO sync_runs (provider) VALUES (${provider}) RETURNING id::text`;
    return String(rows[0].id);
  }
  async finishSyncRun(id: string, status: string, recordsUpserted: number, error: string | null): Promise<void> {
    await this.sql`UPDATE sync_runs SET status = ${status}, records_upserted = ${recordsUpserted}, error = ${error}, finished_at = now() WHERE id = ${id}::uuid`;
  }
  async getSyncRuns(limit: number): Promise<SyncRunRow[]> {
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
    await this.ensureSchema();
    await this.sql`INSERT INTO sync_checkpoints (key, value, updated_at) VALUES (${key}, ${value}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }

  async insertManualOverride(row: Omit<ManualOverrideRow, "id" | "changed_at">): Promise<void> {
    await this.ensureSchema();
    await this.sql`INSERT INTO manual_overrides (entity_type, entity_id, field, previous_value, new_value, changed_by) VALUES (${row.entity_type}, ${row.entity_id}, ${row.field}, ${row.previous_value}, ${row.new_value}, ${row.changed_by})`;
  }
  async getManualOverrides(limit: number): Promise<ManualOverrideRow[]> {
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
}
