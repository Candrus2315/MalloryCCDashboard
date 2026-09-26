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
} from "../metrics/compute";
import type {
  AppSettings,
  AuditCallRow,
  ConnectionRow,
  ContactRow,
  DailyPrioritiesRow,
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
import { DEFAULT_SETTINGS, normalizeAppSettings } from "./types";

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
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (weekday)
  )`,
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
      await this.sql`
        INSERT INTO contacts (provider, external_id, name, phone, email, assigned_rep_id)
        VALUES (${r.provider}, ${r.external_id}, ${r.name}, ${r.phone}, ${r.email}, ${r.assigned_rep_id})
        ON CONFLICT (provider, external_id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email, assigned_rep_id = EXCLUDED.assigned_rep_id, updated_at = now()
      `;
    }
    return rows.length;
  }
  async getContacts(): Promise<ContactRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, external_id, name, phone, email, assigned_rep_id::text, created_at::text FROM contacts`;
    return rows.map((r) => ({ ...r, id: String(r.id), assigned_rep_id: r.assigned_rep_id ? String(r.assigned_rep_id) : null, created_at: String(r.created_at) })) as unknown as ContactRow[];
  }

  async upsertCalls(rows: (CallRow & { external_call_id: string; provider: string })[]): Promise<number> {
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
      // RAW HL user id — mapping-driven eligibility is computed from it at
      // query time; the stored row is never rewritten.
      provider_rep_external_id: r.provider_rep_external_id == null ? null : String(r.provider_rep_external_id),
    };
  }
  async getCallsBetween(startUtc: string, endUtc: string): Promise<CallRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, rep_id, contact_id, started_at, duration_seconds, over_two_minutes, provider_rep_external_id FROM calls WHERE started_at >= ${startUtc} AND started_at < ${endUtc}`;
    return rows.map((r) => this.callRow(r as Record<string, unknown>));
  }
  async getAllCallsSince(startUtc: string): Promise<CallRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, rep_id, contact_id, started_at, duration_seconds, over_two_minutes, provider_rep_external_id FROM calls WHERE started_at >= ${startUtc}`;
    return rows.map((r) => this.callRow(r as Record<string, unknown>));
  }
  async getAuditCalls(startUtc: string, endUtc: string, repSpec: string | null, thresholdSeconds: number): Promise<AuditCallRow[]> {
    await this.ensureSchema();
    // repSpec is one of the endpoint-validated buckets: "non-roster" = a KNOWN
    // user outside the active roster; "unattributed" = no determinable owner
    // (rep NULL); "unassigned" (legacy alias) = the union of both — the exact
    // complement of the roster-kept call set.
    const repFilter =
      repSpec === "non-roster"
        ? this.sql`(c.rep_id IS NOT NULL AND u.is_active = false)`
        : repSpec === "unattributed"
          ? this.sql`(c.rep_id IS NULL)`
          : repSpec === "unassigned"
            ? this.sql`(c.rep_id IS NULL OR u.is_active = false)`
            : repSpec && repSpec !== "all"
              ? this.sql`c.rep_id = ${repSpec}::uuid`
              : this.sql`TRUE`;
    const rows = await this.sql`
      SELECT c.external_call_id, c.conversation_id, c.provider_rep_external_id,
             c.rep_id::text AS rep_id, u.name AS rep_name, u.is_active AS rep_is_active,
             c.contact_id::text AS contact_id, ct.name AS contact_name, ct.external_id AS contact_external_id,
             c.direction, c.call_status, c.started_at::text AS started_at, c.duration_seconds,
             (c.duration_seconds > ${thresholdSeconds}) AS over_threshold
      FROM calls c
      LEFT JOIN users u ON u.id = c.rep_id
      LEFT JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.started_at >= ${startUtc} AND c.started_at < ${endUtc} AND ${repFilter}
      ORDER BY c.started_at DESC, c.external_call_id`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      external_call_id: String(r.external_call_id),
      conversation_id: r.conversation_id == null ? null : String(r.conversation_id),
      rep_id: r.rep_id == null ? null : String(r.rep_id),
      rep_name: r.rep_name == null ? null : String(r.rep_name),
      rep_is_active: r.rep_is_active == null ? null : Boolean(r.rep_is_active),
      provider_rep_external_id: r.provider_rep_external_id == null ? null : String(r.provider_rep_external_id),
      contact_id: r.contact_id == null ? null : String(r.contact_id),
      contact_name: r.contact_name == null ? null : String(r.contact_name),
      contact_external_id: r.contact_external_id == null ? null : String(r.contact_external_id),
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

  async upsertAppointments(rows: (AppointmentRow & { acuity_appointment_id: string; client_name?: string | null; client_phone?: string | null; client_email?: string | null })[]): Promise<number> {
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO appointments (acuity_appointment_id, contact_id, calendar_id, calendar_name, appointment_type, appointment_datetime, duration_minutes, created_at, status, cancelled, client_name, client_phone, client_email)
        VALUES (${r.acuity_appointment_id}, ${r.contact_id}, ${r.calendar_id}, ${r.calendar_name ?? null}, ${r.appointment_type}, ${r.appointment_datetime}, ${r.duration_minutes ?? null}, ${r.created_at}, ${r.status}, ${r.cancelled}, ${r.client_name ?? null}, ${r.client_phone ?? null}, ${r.client_email ?? null})
        ON CONFLICT (acuity_appointment_id) DO UPDATE SET
          contact_id = EXCLUDED.contact_id, calendar_id = EXCLUDED.calendar_id, calendar_name = EXCLUDED.calendar_name,
          appointment_type = EXCLUDED.appointment_type, appointment_datetime = EXCLUDED.appointment_datetime,
          duration_minutes = EXCLUDED.duration_minutes, created_at = EXCLUDED.created_at,
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
      status: String(r.status),
      cancelled: Boolean(r.cancelled),
    };
  }
  async getAppointmentsCreatedBetween(startUtc: string, endUtc: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, contact_id, calendar_id, appointment_type, appointment_datetime, created_at, status, cancelled FROM appointments WHERE created_at >= ${startUtc} AND created_at < ${endUtc}`;
    return rows.map((r) => this.apptRow(r as Record<string, unknown>));
  }
  async getAppointmentsOverlapping(startUtc: string, endUtc: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, contact_id, calendar_id, appointment_type, appointment_datetime, created_at, status, cancelled FROM appointments WHERE appointment_datetime >= ${startUtc} AND appointment_datetime < ${endUtc}`;
    return rows.map((r) => this.apptRow(r as Record<string, unknown>));
  }
  async getAllAppointmentsSince(startUtc: string): Promise<AppointmentRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id, contact_id, calendar_id, appointment_type, appointment_datetime, created_at, status, cancelled FROM appointments WHERE appointment_datetime >= ${startUtc} OR created_at >= ${startUtc}`;
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
    const rows = await this.sql`SELECT id, contact_id, calendar_id, calendar_name, acuity_appointment_id, appointment_type, appointment_datetime, created_at, status, cancelled, client_name, client_phone, client_email FROM appointments WHERE appointment_datetime >= ${startUtc} OR created_at >= ${startUtc}`;
    return rows.map((r) => ({
      ...this.apptRow(r as Record<string, unknown>),
      acuity_appointment_id: r.acuity_appointment_id ? String(r.acuity_appointment_id) : null,
      client_name: r.client_name ? String(r.client_name) : null,
      client_phone: r.client_phone ? String(r.client_phone) : null,
      client_email: r.client_email ? String(r.client_email) : null,
      calendar_name: r.calendar_name ? String(r.calendar_name) : null,
    }));
  }

  async upsertAttributions(rows: AttributionRow[]): Promise<number> {
    await this.ensureSchema();
    for (const r of rows) {
      // appointment_id is UNIQUE — re-syncs replace attributions instead of duplicating.
      // Never overwrite a manual override automatically.
      await this.sql`
        INSERT INTO booking_attributions (appointment_id, call_id, rep_id, method, confidence, manual_override)
        VALUES (${r.appointment_id}::uuid, ${r.call_id}, ${r.rep_id}, ${r.method}, ${r.confidence}, ${r.manual_override})
        ON CONFLICT (appointment_id) DO UPDATE SET
          call_id = EXCLUDED.call_id, rep_id = EXCLUDED.rep_id, method = EXCLUDED.method,
          confidence = EXCLUDED.confidence, manual_override = booking_attributions.manual_override, updated_at = now()
        WHERE booking_attributions.manual_override = false
      `;
    }
    return rows.length;
  }
  async getAttributions(): Promise<AttributionRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, appointment_id::text, call_id::text, rep_id::text, method, confidence, manual_override FROM booking_attributions`;
    return rows.map((r) => ({
      id: String(r.id),
      appointment_id: String(r.appointment_id),
      call_id: r.call_id ? String(r.call_id) : null,
      rep_id: r.rep_id ? String(r.rep_id) : null,
      method: String(r.method),
      confidence: Number(r.confidence),
      manual_override: Boolean(r.manual_override),
    }));
  }
  async setManualAttribution(row: AttributionRow): Promise<void> {
    await this.ensureSchema();
    // Manual assignment wins over the engine and survives re-syncs (engine
    // upserts skip rows with manual_override = true).
    await this.sql`
      INSERT INTO booking_attributions (appointment_id, call_id, rep_id, method, confidence, manual_override)
      VALUES (${row.appointment_id}::uuid, ${row.call_id}, ${row.rep_id}, 'manual', 1, true)
      ON CONFLICT (appointment_id) DO UPDATE SET
        call_id = EXCLUDED.call_id, rep_id = EXCLUDED.rep_id, method = 'manual',
        confidence = 1, manual_override = true, updated_at = now()
    `;
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

  async upsertAvailabilityRules(rows: AvailabilityRule[]): Promise<void> {
    await this.ensureSchema();
    for (const r of rows) {
      await this.sql`
        INSERT INTO availability_rules (weekday, open_time, close_time, active) VALUES (${r.weekday}, ${r.open_time}, ${r.close_time}, ${r.active})
        ON CONFLICT (weekday) DO UPDATE SET open_time = EXCLUDED.open_time, close_time = EXCLUDED.close_time, active = EXCLUDED.active, updated_at = now()
      `;
    }
  }
  async getAvailabilityRules(): Promise<AvailabilityRule[]> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT weekday, open_time, close_time, active FROM availability_rules ORDER BY weekday`;
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
  async getRunningSyncRun(provider: string): Promise<SyncRunRow | null> {
    await this.ensureSchema();
    const rows = await this.sql`SELECT id::text, provider, status, started_at::text, finished_at::text, records_upserted, error
      FROM sync_runs WHERE provider = ${provider} AND status = 'running' AND finished_at IS NULL
      ORDER BY started_at DESC LIMIT 1`;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: String(r.id),
      provider: String(r.provider),
      status: String(r.status),
      started_at: String(r.started_at),
      finished_at: r.finished_at ? String(r.finished_at) : null,
      records_upserted: Number(r.records_upserted),
      error: r.error ? String(r.error) : null,
    };
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
}
