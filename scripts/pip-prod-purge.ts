/**
 * PART 5 — DELETE THE ENGINEER-SEEDED TEST ROWS FROM PROD (owner feedback #3:
 * "REMOVE all probe/test records from production-facing UI ... never touch
 * real reps/appointments"). The match list was enumerated READ-ONLY first
 * (scripts/pip-prod-probe.ts, 10/1) and is EXACTLY:
 *
 *   PIP  c544ad60-2023-4181-a272-3c0677ae14d1  "Probe title"  (issued 2026-09-30, rep = probe user)
 *   USER f453f9f8-d09c-4bb9-b734-c1e83a8d2c34  "Probe 1790811256404"  (external_id probe-1790811256404, active)
 *
 * Nothing else matches. Every delete is by EXPLICIT id + a content guard
 * (title / external_id must equal the probe marker) inside ONE transaction;
 * counts are asserted before deleting; the removal is audit-logged FIRST in
 * the same transaction via the dual-write manual_overrides pattern (visible
 * on Settings → Audit). Real users/appointments/calls/leads are untouched.
 *
 * Run: bun /home/team/shared/site/scripts/pip-prod-purge.ts
 */
import postgres from "postgres";
import { getSecret } from "../src/server/env";

const url = getSecret("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL not resolvable — aborted, nothing deleted.");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

const PIP_ID = "c544ad60-2023-4181-a272-3c0677ae14d1";
const USER_ID = "f453f9f8-d09c-4bb9-b734-c1e83a8d2c34";
const AUDIT_NOTE = "DELETED — engineer-seeded probe/test row (PIP refinement pass part 5; enumerated read-only first)";

const result = await sql.begin(async (tx) => {
  // ---- pre-flight guards: the rows must look exactly like the probe list ----
  const pip = await tx`
    SELECT id::text AS id, title, status FROM pips WHERE id = ${PIP_ID}::uuid AND title = 'Probe title'`;
  const user = await tx`
    SELECT id::text AS id, name, external_id FROM users WHERE id = ${USER_ID}::uuid AND external_id = 'probe-1790811256404' AND name LIKE 'Probe %'`;
  if ((pip as unknown[]).length !== 1 || (user as unknown[]).length !== 1) {
    throw new Error(`GUARD FAILED — probe rows no longer match the enumerated list (pip=${(pip as unknown[]).length}, user=${(user as unknown[]).length}); NOTHING deleted.`);
  }

  // Dependent test artifacts of the probe user (calls/leads attributed to it
  // can only be test data — the probe rep is not a real employee).
  const probeCalls = await tx`SELECT id::text AS id FROM calls WHERE rep_id = ${USER_ID}::uuid`;
  const probeCallIds = (probeCalls as unknown as { id: string }[]).map((r) => r.id);
  const probeLeads = await tx`SELECT id::text AS id FROM leads WHERE assigned_rep_id = ${USER_ID}::uuid`;

  // ---- dual-write audit mirror FIRST (same transaction; survives the deletes) ----
  await tx`
    INSERT INTO manual_overrides (entity_type, entity_id, field, previous_value, new_value, changed_by)
    VALUES ('pip', ${PIP_ID}, 'row', ${"Probe title (issued 2026-09-30; rep = Probe 1790811256404; engineer-seeded test record)"}, ${AUDIT_NOTE}, 'christopher')`;
  await tx`
    INSERT INTO manual_overrides (entity_type, entity_id, field, previous_value, new_value, changed_by)
    VALUES ('user', ${USER_ID}, 'row', ${"Probe 1790811256404 (external_id probe-1790811256404; engineer-seeded test roster user)"}, ${AUDIT_NOTE}, 'christopher')`;

  // ---- delete children explicitly, then the rows, all inside the transaction ----
  const ev = await tx`DELETE FROM pip_event_log WHERE pip_id = ${PIP_ID}::uuid RETURNING id`;
  const sn = await tx`DELETE FROM pip_evidence_snapshots WHERE pip_id = ${PIP_ID}::uuid RETURNING id`;
  const ck = await tx`DELETE FROM pip_checkins WHERE pip_id = ${PIP_ID}::uuid RETURNING id`;
  const pi = await tx`DELETE FROM pips WHERE id = ${PIP_ID}::uuid AND title = 'Probe title' RETURNING id`;
  const at = probeCallIds.length
    ? await tx`DELETE FROM booking_attributions WHERE call_id IN (SELECT id FROM calls WHERE rep_id = ${USER_ID}::uuid) RETURNING id`
    : [];
  const ca = probeCallIds.length ? await tx`DELETE FROM calls WHERE rep_id = ${USER_ID}::uuid RETURNING id` : [];
  const le = (probeLeads as unknown[]).length ? await tx`DELETE FROM leads WHERE assigned_rep_id = ${USER_ID}::uuid RETURNING id` : [];
  const ov = await tx`DELETE FROM manual_overrides WHERE entity_type = 'user' AND entity_id = ${USER_ID} AND id NOT IN (SELECT id FROM manual_overrides WHERE new_value = ${AUDIT_NOTE}) RETURNING id`;
  const us = await tx`DELETE FROM users WHERE id = ${USER_ID}::uuid AND external_id = 'probe-1790811256404' RETURNING id`;

  return {
    pips: (pi as unknown[]).length, events: (ev as unknown[]).length, snapshots: (sn as unknown[]).length,
    checkins: (ck as unknown[]).length, attributions: (at as unknown[]).length, calls: (ca as unknown[]).length,
    leads: (le as unknown[]).length, probeOverrides: (ov as unknown[]).length, users: (us as unknown[]).length,
  };
});

console.log("PURGE COMPLETE (one transaction, audit mirror written first):", JSON.stringify(result));
await sql.end();
process.exit(0);
