/**
 * S7 TICK CHECK — one manual availabilityTick against production with the
 * widened window (proves the scheduled tick path end-to-end), then idempotency
 * (row count unchanged after re-upsert) and recent acuity sync_runs health.
 * Run: bun run scratch/s7-tick-check.ts
 */
import { getStore } from "../src/server/store";
import { availabilityTick } from "../src/server/sync/acuity-live";

const store = await getStore();
const before = (await store.getAllAppointmentsSince("2000-01-01T00:00:00Z")).length;
const res = await availabilityTick({ store, trigger: "manual" });
const after = (await store.getAllAppointmentsSince("2000-01-01T00:00:00Z")).length;
const conn = (await store.getConnections()).find((c) => c.provider === "acuity");
const runsAll = await store.getSyncRuns(60);
const runs = runsAll.filter((r) => r.provider === "acuity").slice(0, 5).map((r) => ({ provider: r.provider, status: r.status, records_upserted: r.records_upserted, error: r.error, started_at: r.started_at }));
console.log(JSON.stringify({
  tick: res,
  appointments: { before, after, idempotent: before === after },
  connection: conn ? { status: conn.status, last_sync_at: conn.last_sync_at, note: conn.config?.note?.slice(0, 200) } : null,
  recentAcuityRuns: Array.isArray(runs) ? runs.slice(0, 5) : "getSyncRuns not available",
}, null, 2));
process.exit(0);
