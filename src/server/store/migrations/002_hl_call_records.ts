import type { Migration } from "./runner";

/**
 * VERSION 3 — HL CALL RECORDS (call-source implementation W1, owner directive
 * approved 2026-11-04; diagnostic /home/team/shared/call-source-diagnostic-2026-11-04.md).
 *
 * HighLevel's raw call export (/conversations/messages/export, channel=Call)
 * becomes the SOURCE OF TRUTH for call KPIs (W3 switch is a follow-up). This
 * table is the raw, lossless landing zone:
 *
 *   - ONE row per HL call message, upsert-deduped by message id (the same
 *     idempotency as evidence_messages) — re-seeing a record is harmless and
 *     the 5-min watermark overlap can never duplicate.
 *   - `user_external_id` is the RAW HighLevel userId (rep attribution key →
 *     users.external_id); NULL = team-level (inbound/unclaimed) — those rows
 *     are KEPT, never dropped.
 *   - `message_type` keeps TYPE_CALL vs TYPE_IVR_CALL distinct so the KPI
 *     switch (W3) can exclude IVR from rep/team totals without a re-pull.
 *   - `duration_seconds` stays NULL when HighLevel reports no talk time
 *     (attempts without a connection) — distinct from a real 0.
 *   - `raw` jsonb preserves the untouched API record for audit/re-derivation.
 *
 * NEVER written by or into the `calls` / `harvest_calls` pipelines: until the
 * W3 switch lands, every existing call metric stays bit-identical.
 *
 * Additive-only (§2.3): one new table + three indexes, no ALTERs, no seeds.
 */
export const migration: Migration = {
  version: 3,
  name: "hl_call_records",
  // Autocommit per statement (the baseline's mode): three idempotent CREATEs
  // against a LIVE database must never hold one transaction lock.
  nonTransactional: true,
  statements: [
    `CREATE TABLE IF NOT EXISTS hl_call_records (
      message_id text PRIMARY KEY,
      user_external_id text,
      contact_external_id text,
      conversation_id text,
      direction text,
      call_status text,
      duration_seconds integer,
      date_added timestamptz NOT NULL,
      message_type text NOT NULL,
      source text,
      from_number text,
      to_number text,
      raw jsonb,
      ingested_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_hlcall_user_date ON hl_call_records (user_external_id, date_added)`,
    `CREATE INDEX IF NOT EXISTS idx_hlcall_date ON hl_call_records (date_added)`,
    `CREATE INDEX IF NOT EXISTS idx_hlcall_contact_date ON hl_call_records (contact_external_id, date_added)`,
  ],
};
