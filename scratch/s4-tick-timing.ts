/**
 * S4 live-tick evidence runner (before AND after the incremental-contacts change).
 * Times N background-trigger schedulerTicks against the LIVE store (real creds,
 * real DB) + times the contact-read op being retired/replaced. JSON to stdout.
 *
 *   bun scratch/s4-tick-timing.ts 3 > scratch/s4-baseline.json
 */
import { getStore } from "../src/server/store";
import { schedulerTick } from "../src/server/sync/scheduler";

const runs = Number(process.argv[2] ?? "2");
const store = await getStore();

// The op the change retires (full 18-col materialization) / replaces (2-col ids).
async function timeContactsRead(): Promise<{ op: string; ms: number; rows: number }> {
  const t0 = performance.now();
  const rows = await store.getContacts();
  return { op: "getContacts()", ms: Math.round(performance.now() - t0), rows: rows.length };
}

const ticks: { outcome: string; mode?: string; reason?: string; calls?: number; contacts?: number; users?: number; attributions?: number; error?: string; ms: number; availability?: string; attribution?: string }[] = [];
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  const res = await schedulerTick({ trigger: "background" });
  const ms = Math.round(performance.now() - t0);
  ticks.push({
    outcome: res.outcome, mode: res.mode, reason: res.reason, calls: res.calls, contacts: res.contacts,
    users: res.users, attributions: res.attributions, error: res.error, ms,
    availability: res.availability?.outcome, attribution: res.attribution?.outcome,
  });
  if (i < runs - 1) await new Promise((r) => setTimeout(r, 1500));
}

const read = await timeContactsRead();

// error runs recorded by this exercise (window: anything finished in the last 10 min)
const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
const recent = await store.getSyncRuns(40);
const errorRuns = recent.filter((r) => r.status === "error" && (r.started_at ?? "") > cutoff).map((r) => ({ provider: r.provider, error: (r.error ?? "").slice(0, 120) }));

const watermark = await store.getSyncWatermark("highlevel");
console.log(JSON.stringify({ when: new Date().toISOString(), head: process.env.GIT_HEAD ?? "unknown", contactRead: read, ticks, errorRunsLast10min: errorRuns, watermark }, null, 1));
