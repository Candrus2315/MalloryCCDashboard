/**
 * RETENTION OUTCOMES BACKFILL (stage 3a; plan §13 "Backfill scripts" +
 * ruling D13: "prospective from stage-2 go-live + backfill what the 30-day
 * call window and existing notes already cover").
 *
 *   bun run scripts/retention-outcomes-backfill.ts
 *
 * Runs the ONE computation core (src/server/retention/compute.ts) against the
 * live store exactly as the scheduler tick does (own sync_runs row, provider
 * "retention-outcomes-backfill"), then prints the honest class/status
 * distribution for the run. IDEMPOTENT: the core diff-writes; a re-run with
 * unchanged data writes nothing. Safe to run any time alongside the tick.
 */
import { getStore } from "../src/server/store";
import { computeRetention } from "../src/server/retention/compute";

const store = await getStore();
const runId = await store.insertSyncRun("retention-outcomes-backfill");
try {
  const res = await computeRetention(store);
  await store.finishSyncRun(runId, "success", res.appointmentsEvaluated, null);
  console.log(
    JSON.stringify(
      {
        outcome: res.outcome,
        window: res.window,
        due_days: res.dueDays,
        appointments_evaluated: res.appointmentsEvaluated,
        unlinked_appointments: res.unlinkedAppointments,
        unlinked_acuity_ids: res.unlinkedAcuityIds,
        attempts: { inserted: res.attemptsInserted, updated: res.attemptsUpdated, unchanged: res.attemptsUnchanged },
        outcomes: { inserted: res.outcomesInserted, updated: res.outcomesUpdated, unchanged: res.outcomesUnchanged },
        calls_without_client: res.callsWithoutClient,
        inbound_in_window_calls: res.inboundInWindowCalls,
        final_status_counts: res.finalStatusCounts,
        attempt_class_counts: res.attemptClassCounts,
      },
      null,
      1,
    ),
  );
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  await store.finishSyncRun(runId, "error", 0, msg);
  throw e;
}
