/**
 * RETENTION IDENTITY BACKFILL (stage 2, plan §7.5) — idempotent seeder for the
 * canonical client chain over the LIVE database.
 *
 *   bun run scripts/internal-clients-backfill.ts
 *
 * What it does (additive only; never touches appointments/contacts/calls):
 *   A. seeds one internal client per distinct GHL contact referenced by any
 *      appointment's resolved contact_id (99.7% live), linking BOTH sides
 *      exact_id (the appointments→contacts chain IS the cross-system id);
 *   B. contacts with calls in the last 90 days not yet covered → phone/email
 *      match against existing clients, else create-new, else exception;
 *   C. appointments with NO resolved contact → identity fallback, else
 *      Data Match Exception (never guessed);
 *   D. calls that cannot reach any client (null contact_id / missing contact
 *      row) → Data Match Exceptions — nothing silent.
 *
 * IDEMPOTENCE PROOF: the script runs the applier TWICE in one invocation and
 * compares canonical dumps of the three tables after each run (sha256). A
 * re-run MUST be byte-identical (run 2 writes nothing) — that is the
 * chain-proof gate's idempotence criterion, executed live here.
 *
 * Fail-honest: requires Postgres mode (never runs against the memory store),
 * records a sync_runs row (provider 'retention-identity-backfill'), and
 * writes a machine-readable summary to /home/team/shared/retention/backfill-run.json.
 */
import postgres from "postgres";
import { getStore } from "../src/server/store";
import { getSecret } from "../src/server/env";
import { applyInternalClientBackfill, type BackfillInput, type BackfillResult } from "../src/server/retention/backfill";
import { writeFileSync } from "fs";
import { createHash } from "crypto";

const OUT_JSON = "/home/team/shared/retention/backfill-run.json";

const url = getSecret("DATABASE_URL");
if (!url) throw new Error("DATABASE_URL secret is required (script refuses to run without the live DB)");
const store = await getStore();
if (store.mode !== "postgres") {
  throw new Error(`STORE_NOT_POSTGRES: refusing to backfill against ${store.mode} store — check DATABASE_URL`);
}

// Read-only gather client (separate from the store pool; small max).
const ro = postgres(url, { max: 2, idle_timeout: 5, connect_timeout: 30 });

const runId = await store.insertSyncRun("retention-identity-backfill");

// ---- gather (read-only) ----
const apptRows = await ro`
  SELECT acuity_appointment_id, contact_id::text AS contact_id,
         client_name, client_phone, client_email, status
  FROM appointments
  ORDER BY acuity_appointment_id`;
const recentContactIdRows = await ro`
  SELECT DISTINCT contact_id::text AS id FROM calls
  WHERE contact_id IS NOT NULL AND started_at >= now() - interval '90 days'`;
const recentSet = new Set(recentContactIdRows.map((r) => String(r.id)));
const apptContactIds = [...new Set(apptRows.map((r) => r.contact_id).filter((x): x is string => !!x))];
const neededIds = [...new Set([...apptContactIds, ...recentSet])];
const contactRows = neededIds.length
  ? await ro`SELECT id::text AS id, external_id, name, phone, email FROM contacts WHERE id::text = ANY(${neededIds}::text[])`
  : [];
const contactById = new Map(contactRows.map((r) => [String(r.id), r]));
const orphanCallRows = await ro`
  SELECT c.provider, c.external_call_id, c.started_at::text AS started_at, c.direction,
         c.call_status, c.duration_seconds, c.contact_id::text AS contact_id
  FROM calls c LEFT JOIN contacts ct ON ct.id = c.contact_id
  WHERE c.contact_id IS NULL OR ct.id IS NULL
  ORDER BY c.provider, c.external_call_id`;

const missingAcuityId = apptRows.filter((r) => !r.acuity_appointment_id).length;

const input: BackfillInput = {
  appointments: apptRows
    .filter((r) => !!r.acuity_appointment_id)
    .map((r) => ({
      acuityAppointmentId: String(r.acuity_appointment_id),
      status: String(r.status ?? "scheduled"),
      clientName: r.client_name ?? null,
      clientPhone: r.client_phone ?? null,
      clientEmail: r.client_email ?? null,
      contactExternalId: r.contact_id ? (contactById.get(r.contact_id)?.external_id ?? null) : null,
    })),
  contacts: contactRows.map((r) => ({
    externalId: String(r.external_id),
    name: r.name ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    hasRecentCall: recentSet.has(String(r.id)),
  })),
  callsWithoutClient: orphanCallRows.map((r) => ({
    provider: String(r.provider),
    externalCallId: String(r.external_call_id),
    startedAtIso: r.started_at ? new Date(r.started_at).toISOString() : null,
    direction: r.direction == null ? null : String(r.direction),
    callStatus: r.call_status == null ? null : String(r.call_status),
    durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
    contactInternalId: r.contact_id == null ? null : String(r.contact_id),
    reason: r.contact_id == null ? ("null_contact_id" as const) : ("contact_row_missing" as const),
  })),
};

// ---- canonical dumps (for the byte-identical proof) ----
async function dump(): Promise<string> {
  const clients = await ro`
    SELECT id::text AS id, seed_key, display_name, normalized_phone, normalized_email,
           ghl_contact_external_id, match_state, created_at, updated_at
    FROM internal_clients ORDER BY id`;
  const links = await ro`
    SELECT internal_client_id::text AS internal_client_id, provider, entity, external_id,
           match_method, confidence, evidence, resolved_by, resolved_at
    FROM client_match_links ORDER BY provider, entity, external_id`;
  const exceptions = await ro`
    SELECT id::text AS id, kind, dedupe_key, payload, context, status,
           resolved_internal_client_id::text AS resolved_internal_client_id,
           resolved_method, resolved_by, resolved_at, first_seen_at
    FROM data_match_exceptions ORDER BY dedupe_key`;
  const iso = (_k: string, v: unknown) => (v instanceof Date ? v.toISOString() : v);
  return JSON.stringify({ clients, links, exceptions }, iso, 1);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- run 1 ----
let run1: BackfillResult;
try {
  run1 = await applyInternalClientBackfill(store, input);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  await store.finishSyncRun(runId, "error", 0, msg);
  await ro.end({ timeout: 2 }).catch(() => undefined);
  throw e;
}
const dump1 = await dump();
const sha1 = sha(dump1);

// ---- run 2 (idempotence proof) ----
const run2 = await applyInternalClientBackfill(store, input);
const dump2 = await dump();
const sha2 = sha(dump2);

const byteIdentical = sha1 === sha2;
const run2Clean = run2.clientsCreated === 0 && run2.contactLinksCreated === 0 && run2.appointmentLinksCreated === 0 && run2.fallbackLinksCreated === 0 && run2.exceptionsCreated === 0;

const summary = {
  when: new Date().toISOString(),
  run_id: runId,
  gathered: {
    appointments: input.appointments.length,
    missing_acuity_id_skipped: missingAcuityId,
    contacts_considered: input.contacts.length,
    contacts_with_recent_calls: input.contacts.filter((c) => c.hasRecentCall).length,
    orphan_calls: input.callsWithoutClient.length,
  },
  run1: run1,
  run2: run2,
  idempotence: {
    run2_wrote_nothing: run2Clean,
    dump_sha_run1: sha1,
    dump_sha_run2: sha2,
    byte_identical: byteIdentical,
  },
  final_state: {
    internal_clients: (await ro`SELECT count(*)::int AS n FROM internal_clients`)[0].n,
    client_match_links: (await ro`SELECT count(*)::int AS n FROM client_match_links`)[0].n,
    data_match_exceptions_total: (await ro`SELECT count(*)::int AS n FROM data_match_exceptions`)[0].n,
    data_match_exceptions_open: (await ro`SELECT count(*)::int AS n FROM data_match_exceptions WHERE status = 'open'`)[0].n,
  },
};
await store.finishSyncRun(runId, "success", run1.clientsCreated + run1.contactLinksCreated + run1.appointmentLinksCreated + run1.fallbackLinksCreated + run1.exceptionsCreated, null);
writeFileSync(OUT_JSON, JSON.stringify(summary, null, 1));
await ro.end({ timeout: 2 }).catch(() => undefined);
console.log(JSON.stringify(summary, null, 1));
if (!byteIdentical || !run2Clean) {
  console.error("IDEMPOTENCE FAILURE — re-run mutated rows; see " + OUT_JSON);
  process.exit(2);
}
