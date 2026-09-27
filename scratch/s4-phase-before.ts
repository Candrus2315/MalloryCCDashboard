/**
 * S4 BEFORE-baseline — times the HighLevel phase of one tick EXACTLY as the
 * current (pre-S4) scheduler.ts incremental branch runs it: watermark +
 * skip checks, harvestIncremental (real API), upsertUsers → getAllUsers →
 * upsertContacts → getContacts() (the 116k full read being retired) →
 * upsertCalls, watermark advance, connection row. Attribution + availability
 * are EXCLUDED on both sides of the before/after comparison (S4 does not
 * touch them and they dominate wall time).
 * Run: . /etc/profile.d/cto-env-vars.sh; nohup bun scratch/s4-phase-before.ts > /tmp/s4-phase-before.log 2>/dev/null &
 */
import { getStore } from "../src/server/store";
import { harvestIncremental, WATERMARK_OVERLAP_SECONDS } from "../src/server/sync/highlevel-incremental";
import { readHighLevelCreds } from "../src/server/sync/highlevel-live";
import { isRosterUser } from "../src/server/roster";

const store = await getStore();
const settings = await store.getSettings();
const creds = readHighLevelCreds();
if (!creds) { console.log(JSON.stringify({ error: "no creds" })); process.exit(1); }

const running = await store.getRunningSyncRun("highlevel");
if (running) {
  const startedMs = Date.parse(running.started_at);
  const stale = Number.isFinite(startedMs) && Date.now() - startedMs > 12 * 3_600_000;
  if (!stale) { console.log(JSON.stringify({ error: "sync-in-progress", started_at: running.started_at })); process.exit(2); }
}

// --- timed: the exact pre-S4 incremental phase ---
const t0 = performance.now();
const phase: Record<string, number> = {};

const watermark = await store.getSyncWatermark("highlevel");
const runId = await store.insertSyncRun("highlevel");
const sinceMs = Date.parse(watermark ?? "") - WATERMARK_OVERLAP_SECONDS * 1000;
const harvest = await harvestIncremental({ creds, fetchImpl: fetch, sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0 });
phase.harvestApi = Math.round(performance.now() - t0);

let t = performance.now();
await store.upsertUsers(harvest.users.map((u) => ({ id: "", provider: "highlevel", external_id: u.external_id, name: u.name, email: u.email, is_active: isRosterUser(u.name, u.email, settings.active_roster) })));
const storedUsers = await store.getAllUsers();
const userIdByExt = new Map(storedUsers.map((u) => [`${u.provider}:${u.external_id}`, u.id]));
if (harvest.contacts.length) {
  await store.upsertContacts(harvest.contacts.map((c) => ({ id: "", provider: "highlevel", external_id: c.external_id, name: c.name, phone: c.phone, email: c.email, assigned_rep_id: c.assignedRepExternalId ? userIdByExt.get(`highlevel:${c.assignedRepExternalId}`) ?? null : null })));
}
phase.upsertUsersContacts = Math.round(performance.now() - t);

t = performance.now();
const storedContacts = await store.getContacts();
phase.getContacts_FULL = Math.round(performance.now() - t);

t = performance.now();
const contactIdByExt = new Map(storedContacts.map((c) => [`${c.provider}:${c.external_id}`, c.id]));
if (harvest.calls.length) {
  await store.upsertCalls(harvest.calls.map((c) => ({ provider: "highlevel", external_call_id: c.external_call_id, rep_id: userIdByExt.get(`highlevel:${c.repExternalId}`) ?? null, contact_id: contactIdByExt.get(`highlevel:${c.contactExternalId}`) ?? null, started_at: c.startedAt, duration_seconds: c.durationSeconds, over_two_minutes: c.durationSeconds > settings.meaningful_call_threshold_seconds, direction: c.direction, call_status: c.status })));
}
phase.callsLinkUpsert = Math.round(performance.now() - t);

const records = harvest.calls.length + harvest.contacts.length + harvest.users.length;
await store.finishSyncRun(runId, "success", records, null);
const phaseMs = Math.round(performance.now() - t0);

console.log(JSON.stringify({
  when: new Date().toISOString(),
  head: "74de1de (pre-S4)",
  phaseMs,
  phaseBreakdown: phase,
  harvest: { users: harvest.users.length, contacts: harvest.contacts.length, calls: harvest.calls.length, conversationsVisited: harvest.conversationsVisited },
  contactsMaterialized: storedContacts.length,
  contactReadOp: { op: "getContacts() rows materialized per tick", rows: storedContacts.length },
}, null, 1));
process.exit(0);
