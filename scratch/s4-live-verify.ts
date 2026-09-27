/**
 * S4 FINAL live-verify (one tick, after the incremental-contacts change).
 * Runs ONE background schedulerTick against the LIVE store (real creds, real
 * DB), with retry when another writer (dev/live server ticks) holds the
 * in-progress slot. Captures: tick timings, S4 walk/reconciliation results,
 * both S4 checkpoints, the HL connection row, recent sync_runs, and a
 * demo-row census (raw SQL) for the bundled purge decision.
 *
 *   nohup bun scratch/s4-live-verify.ts > /tmp/s4v.json 2>/tmp/s4v.err &
 *   (stdout from the ===S4VERIFY-JSON=== sentinel on is pure JSON; pg DDL
 *   NOTICEs precede it)
 */
import { getStore } from "../src/server/store";
import { schedulerTick } from "../src/server/sync/scheduler";
import { CONTACTS_INCREMENTAL_CHECKPOINT_KEY, CONTACTS_RECONCILIATION_CHECKPOINT_KEY } from "../src/server/sync/contacts-incremental";
import postgres from "postgres";

const store = await getStore();

// Demo-row census (read-only) FIRST — a census failure must never cost the
// tick evidence. blocked_times keys on external_id (NOT acuity_blocked_time_id).
let demoCensus: Record<string, unknown> | null = null;
let censusError: string | null = null;
let futureDays: unknown = null;
try {
  const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1, onnotice: () => {} });
  const demoCounts = await sql`
    select
      (select count(*) from appointments where acuity_appointment_id like 'demo-%') as demo_appts,
      (select count(*) from appointments where acuity_appointment_id not like 'demo-%') as provider_appts,
      (select count(*) from blocked_times where external_id like 'demo-%') as demo_blocked,
      (select count(*) from contacts where external_id like 'demo-%') as demo_contacts,
      (select count(*) from users where external_id like 'demo-%') as demo_users,
      (select count(*) from calls where external_call_id like 'demo-%') as demo_calls`;
  const days = await sql`
    select (appointment_datetime at time zone 'America/New_York')::date as day,
           count(*) as total,
           count(*) filter (where acuity_appointment_id like 'demo-%') as demo_rows,
           count(*) filter (where cancelled) as cancelled
    from appointments
    where (appointment_datetime at time zone 'America/New_York')::date >= (now() at time zone 'America/New_York')::date
    group by 1 order by 1 asc limit 21`;
  await sql.end();
  demoCensus = demoCounts[0];
  futureDays = days;
} catch (e) {
  censusError = e instanceof Error ? e.message : String(e);
}

// Light 2-col identity read that REPLACED the old full materialization.
const t0 = performance.now();
const ids = await store.getContactExternalIds("highlevel");
const lightMs = Math.round(performance.now() - t0);

// The retired op, timed once for an honest before/after comparison.
const t2 = performance.now();
const fullRows = await store.getContacts();
const fullMs = Math.round(performance.now() - t2);

// ONE tick; retry when a concurrent server tick is mid-flight.
let attempts = 0;
let tickMs = 0;
let res: Awaited<ReturnType<typeof schedulerTick>> | null = null;
while (attempts < 4) {
  attempts += 1;
  const t1 = performance.now();
  const r = await schedulerTick({ trigger: "background" });
  tickMs = Math.round(performance.now() - t1);
  res = r;
  if (r.outcome === "synced" || r.outcome === "error") break;
  if (r.outcome === "skipped" && r.reason === "sync-in-progress") {
    await new Promise((ok) => setTimeout(ok, 15_000));
    continue;
  }
  break;
}

let walkCkpt: unknown = null;
let reconCkpt: unknown = null;
let hl: Record<string, unknown> | null = null;
let recentRuns: unknown = null;
let storeError: string | null = null;
try {
  const walkCkptRaw = await store.getSyncCheckpoint(CONTACTS_INCREMENTAL_CHECKPOINT_KEY);
  const reconCkptRaw = await store.getSyncCheckpoint(CONTACTS_RECONCILIATION_CHECKPOINT_KEY);
  walkCkpt = walkCkptRaw ? JSON.parse(walkCkptRaw) : null;
  reconCkpt = reconCkptRaw ? JSON.parse(reconCkptRaw) : null;
  const conn = (await store.getConnections()).find((c) => c.provider === "highlevel");
  hl = conn ? { status: conn.status, lastError: conn.last_error, note: conn.config?.note ?? null, contactsReconciliation: conn.config?.contactsReconciliation ?? null } : null;
  const cutoff = new Date(Date.now() - 25 * 60_000).toISOString();
  const runs = await store.getSyncRuns(80);
  recentRuns = runs
    .filter((r) => (r.started_at ?? "") > cutoff)
    .map((r) => ({ provider: r.provider, status: r.status, records: r.records, started_at: r.started_at, error: r.error ? String(r.error).slice(0, 140) : null }));
} catch (e) {
  storeError = e instanceof Error ? e.message : String(e);
}

console.log("===S4VERIFY-JSON===");
console.log(JSON.stringify({
  when: new Date().toISOString(),
  lightRead: { op: "getContactExternalIds(all)", ms: lightMs, rows: ids.length },
  retiredRead: { op: "getContacts()", ms: fullMs, rows: fullRows.length },
  tickAttempts: attempts,
  tick: {
    outcome: res?.outcome, mode: res?.mode, reason: res?.reason, error: res?.error ?? null,
    calls: res?.calls, contacts: res?.contacts, users: res?.users, attributions: res?.attributions,
    ms: tickMs,
    availability: res?.availability?.outcome ?? null, attribution: res?.attribution?.outcome ?? null,
    contactsWalk: res?.contactsWalk ?? null,
    contactsReconciliation: res?.contactsReconciliation ?? null,
  },
  walkCheckpoint: walkCkpt,
  reconciliationCheckpoint: reconCkpt,
  connection: hl,
  recentSyncRunsWindow25min: recentRuns,
  demoCensus, censusError, futureDays, storeError,
}, null, 1));
