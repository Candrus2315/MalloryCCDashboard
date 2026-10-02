/**
 * ATTRIBUTION RE-VERDICT RUNNER — deliberate, explicit recompute with a WIDER
 * appointment cohort than the background tick's rolling 30-day window.
 *
 * WHY (commission undercount, root-caused 10/2): the call-harvest window
 * started 2026-09-14, so every pre-9/14 booking had ZERO stored interaction
 * evidence and was honestly unattributed — under the owner's ruling they paid
 * no rep, cratering Allison's W1/W2 commission counts (35→6, 42→4). Once the
 * harvest floor is lowered (run-harvest.ts → 2026-08-22) and the harvest RUNS,
 * this runner re-evaluates the older bookings against the newly harvested
 * evidence so W1/W2 regain their verdicts BEFORE the commission re-backfill.
 *
 * WHAT IT DOES: computeAndPersistAttributions(store, settings, { since }) —
 * the ONE engine invocation shared with the background tick and manual SYNC
 * NOW, with the `since` override widening the appointment cohort start (the
 * call look-back widens with it). Writer-version guard and the store's PG
 * advisory lock + degradation guard all apply UNCHANGED; `--force` (optional)
 * is the deliberate owner-directed bypass of the writer-version check, exactly
 * as documented on the tick.
 *
 * MUTEX: holds an "attribution" sync_runs row for the duration (same running
 * guard the background tick honors; stale rows >12h are reclaimed), so the
 * 90s scheduler cannot interleave a narrower recompute mid-run.
 *
 * Run: bun scripts/attr-reverdict.ts --since=2026-08-22T04:00:00.000Z [--force]
 *      (--since also accepted as two args). Refuses to run without --since.
 * Env: DATABASE_URL (postgres store required).
 *
 * DO NOT run casually: it rewrites verdicts for every in-scope appointment in
 * the widened window. The data-operations session invokes it explicitly after
 * the widened harvest completes.
 */
import { readFileSync } from "node:fs";
import { computeAndPersistAttributions } from "../src/server/sync/attribution-tick";
import { getStore } from "../src/server/store";
import { attributionStateOf } from "../src/server/metrics/compute";

// env secrets may reach /proc/self/environ with odd casing; canonicalize before use.
const envOf = (k: string): string => {
  const m = readFileSync("/proc/self/environ", "utf8").split("\0").find((s) => s.toLowerCase().startsWith(k.toLowerCase() + "="));
  return m ? m.slice(k.length + 1) : "";
};
for (const canon of ["DATABASE_URL"] as const) {
  if (!process.env[canon]) {
    const v = envOf(canon);
    if (v) process.env[canon] = v;
  }
}

function parseArgs(argv: string[]): { since: string | null; force: boolean } {
  let since: string | null = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--since=")) since = a.slice("--since=".length);
    else if (a === "--since") since = argv[i + 1] ?? null;
    else if (a === "--force") force = true;
  }
  return { since, force };
}

async function main(): Promise<void> {
  const { since, force } = parseArgs(process.argv.slice(2));
  if (!since) {
    console.error("FATAL: --since=<ISO instant> is required (e.g. --since=2026-08-22T04:00:00.000Z) — this runner never widens implicitly.");
    process.exit(1);
  }
  if (!Number.isFinite(Date.parse(since))) {
    console.error(`FATAL: --since is not a parseable instant: ${since}`);
    process.exit(1);
  }
  const store = await getStore();
  if (store.mode !== "postgres") {
    console.error("FATAL: postgres store unavailable — re-verdicting the live attribution table needs the real database.");
    process.exit(1);
  }

  const before = await store.getAttributions();
  const beforeSplit = before.reduce(
    (acc, r) => {
      const st = attributionStateOf(r);
      if (st === "attributed") acc.attributed += 1;
      else acc.unattributed += 1;
      return acc;
    },
    { attributed: 0, unattributed: 0 },
  );

  // Mutex: hold the attribution sync_runs row (background tick's running guard
  // honors it). A LIVE run younger than the 12h stale cutoff → skip, never fight.
  const running = await store.getRunningSyncRun("attribution");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    if (Number.isFinite(startedMs) && Date.now() - startedMs < 12 * 3_600_000) {
      console.log(`SKIP: an attribution run is already in flight (started ${running.started_at}).`);
      return;
    }
    console.log(`reclaiming stale attribution sync_run ${running.id} (started ${running.started_at})`);
    await store.finishSyncRun(running.id, "error", 0, "reclaimed by attr-reverdict runner (stale running row)");
  }
  const runId = await store.insertSyncRun("attribution");

  console.log(`re-verdict: since=${since} force=${force}`);
  try {
    const res = await computeAndPersistAttributions(store, await store.getSettings(), { since, force });
    await store.finishSyncRun(runId, "success", (res.attributed ?? 0) + (res.unattributed ?? 0), null);
    const after = await store.getAttributions();
    const afterSplit = after.reduce(
      (acc, r) => {
        const st = attributionStateOf(r);
        if (st === "attributed") acc.attributed += 1;
        else acc.unattributed += 1;
        return acc;
      },
      { attributed: 0, unattributed: 0 },
    );
    console.log(`engine: appointments=${res.appointments} attributed=${res.attributed} unattributed=${res.unattributed} manuallyAssigned=${res.manuallyAssigned}`);
    console.log(`table split: attributed ${beforeSplit.attributed} → ${afterSplit.attributed}, unattributed ${beforeSplit.unattributed} → ${afterSplit.unattributed}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(runId, "error", 0, msg);
    console.error(`FAILED: ${msg}`);
    process.exit(1);
  }
}

await main();
