import type { Migration } from "./runner";

/**
 * VERSION 2 — EVIDENCE MESSAGES (SMS EVIDENCE + CONTACT RE-RESOLUTION spec,
 * owner approved 2026-11-02).
 *
 * The attribution engine used harvested CALL messages only, so rep TEXT
 * conversations (SMS / live-chat) were invisible evidence — bookings whose
 * only real conversation was a rep-sent text got the false
 * "self-booked-no-conversation" verdict. This migration adds the PERSISTED
 * evidence ledger for non-call conversation messages:
 *
 *   - ONE row per message, upsert-deduped by message id (the same idempotency
 *     as the calls harvest) — re-seeing a message is harmless.
 *   - `direction` + `user_external_id` carry the rep-credit signal: an
 *     OUTBOUND message whose HL user resolves to a roster rep satisfies the
 *     2026-10-30 conversation-evidence requirement (engine side).
 *   - `body` kept for audit display (truncated at write time by the harvest).
 *   - NEVER written by or into the `calls` / `harvest_calls` pipelines —
 *     pickup rate, call counts, and over-2-min metrics stay bit-identical.
 *
 * Additive-only (§2.3): one new table + two indexes, no ALTERs, no seeds.
 */
export const migration: Migration = {
  version: 2,
  name: "evidence_messages",
  // Autocommit per statement (the baseline's mode): three idempotent CREATEs
  // against a LIVE database must never hold one transaction lock, and the
  // runner's statement-list path stays exercised identically.
  nonTransactional: true,
  statements: [
    `CREATE TABLE IF NOT EXISTS evidence_messages (
      message_id text PRIMARY KEY,
      conversation_id text,
      contact_external_id text,
      message_type text NOT NULL,
      direction text,
      user_external_id text,
      date_added timestamptz NOT NULL,
      body text,
      harvested_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_emsg_contact_date ON evidence_messages (contact_external_id, date_added)`,
    `CREATE INDEX IF NOT EXISTS idx_emsg_date ON evidence_messages (date_added)`,
  ],
};
