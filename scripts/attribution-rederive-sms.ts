/**
 * WIDENED-SINCE ATTRIBUTION RE-DERIVE (SMS EVIDENCE spec workstream 4).
 * Runs the ONE shared computation core (computeAndPersistAttributions) with a
 * `since` override covering the 2026-10-01 evidence floor so every repaired /
 * SMS-affected booking re-derives against full evidence. Holds the
 * 'attribution' sync_runs mutex exactly like attributionTick.
 *
 * Run: bun scripts/attribution-rederive-sms.ts
 */
import { readFileSync } from "node:fs";
import { getStore } from "../src/server/store";
import { withSyncWriteRetry } from "../src/server/store/sync-write-retry";
import { computeAndPersistAttributions } from "../src/server/sync/attribution-tick";

// 2026-09-26 ET start — covers the earliest self-booked window (2026-09-28 ET)
// with the 2-day call margin; evidence back to the Oct-1 SMS floor loads too.
const SINCE = "2026-09-26T04:00:00.000Z";

const envOf = (k: string): string => {
  const m = readFileSync("/proc/self/environ", "utf8").split("\0").find((s) => s.toLowerCase().startsWith(k.toLowerCase() + "="));
  return m ? m.slice(k.length + 1) : "";
};
if (!process.env.DATABASE_URL) {
  const v = envOf("DATABASE_URL");
  if (v) process.env.DATABASE_URL = v;
}

const store = withSyncWriteRetry(getStore());
const settings = await store.getSettings();
const runId = await store.insertSyncRun("attribution");
try {
  const res = await computeAndPersistAttributions(store, settings, { since: SINCE });
  await store.finishSyncRun(runId, "success", res.attributed + res.unattributed, null);
  console.log("RE-DERIVE RESULT:", JSON.stringify(res));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  await store.finishSyncRun(runId, "error", 0, msg.slice(0, 400)).catch(() => {});
  console.error("RE-DERIVE ERROR:", msg);
  process.exitCode = 1;
}
