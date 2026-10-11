/**
 * SYNC WRITE RESILIENCE (2026-10-12) — bounded retry for the sync layer's
 * write paths against the DB provider's transient connection failures (the
 * 10/11 provider degradation: post-cap CONNECT_TIMEOUTs persisted on the live
 * server while raw TCP connected fine — sync runs failed mid-flight, e.g. GHL
 * last success 21:29Z while attribution kept failing after).
 *
 * Reuses the EXISTING read-path engine (store/pg-retry.ts) — the same
 * transient-error classification (isTransientDbError), the same bounded
 * constants (RETRY_ATTEMPTS = 3, RETRY_BASE_DELAY_MS = 150 → backoff 150/450ms
 * + jitter, worst-case added latency ≲ 750ms). No second engine, no new
 * constants; a business error is never retried and never masked, and a write
 * that exhausts its attempts FAILS HONESTLY with the original error.
 *
 * WHY A METHOD ALLOWLIST (the double-apply hazard, from pg-retry.ts):
 * retrying a write is only safe when re-applying it lands the same final
 * state. Every allowlisted method below is IDEMPOTENT by construction —
 * verified against the PgStore implementations:
 *  - content-keyed UPSERTs: INSERT ... ON CONFLICT (<natural key>) DO UPDATE
 *    (leads by provider+source_id, appointments by acuity id, calls by
 *    provider+external_call_id, contacts/users/opportunities/harvest
 *    conversations by their external ids, attributions by appointment_id,
 *    checkpoints/watermarks/progress by their keys, connections by provider,
 *    goals by week_start, blocked times by provider+external_id)
 *  - write-once updates: markAppointmentsCancelled (COALESCE cancelled_at +
 *    WHERE cancelled = false — a retry can only no-op)
 *  - fill-null-only updates: applyCallContactBackfill (COALESCE contact_id +
 *    CASE WHEN contact_id IS NULL — a committed first attempt makes the retry
 *    a no-op)
 *  - conflict-guarded inserts: applyAvailabilityDiscrepancies (ON CONFLICT
 *    DO NOTHING — history-preserving by design)
 *  - whole-set replaces keyed by date: putAvailabilityDates /
 *    putAvailabilitySlotsForDate / putAvailabilityCatalog
 *  - idempotent deletes: deleteLeadsBySourceIds / deleteDemoAcuityRows /
 *    deleteDemoHighLevelRows (re-deleting is a no-op)
 *  - update-by-id to a terminal status: finishSyncRun /
 *    finishAvailabilitySyncRun (same row, same final values)
 *  - conditional reap updates: reapStaleAvailabilitySyncRuns (the second pass
 *    only ever matches rows the first pass missed)
 *
 * EXCLUDED — NON-IDEMPOTENT, never retried (they pass through untouched):
 *  - insertSyncRun / insertAvailabilitySyncRun: plain INSERT — a
 *    committed-but-unacknowledged attempt followed by a retry would create a
 *    SECOND sync-run row (and a second RETURNING id).
 *  - markHarvestVisited: messages_scanned = messages_scanned + N — a counter
 *    INCREMENT; a retry after an unacknowledged commit would double-count.
 *  - everything the sync layer never calls: commission weekly-close writes,
 *    stored-week records, PIP rows, settings, audit trail, manual overrides —
 *    business-logic paths stay exactly as they are (transport-only hardening,
 *    zero business-logic change).
 *
 * USAGE: wrap the store once where a sync entry point resolves it —
 *   const store = withSyncWriteRetry(options?.store ?? (await getStore()));
 * All non-allowlisted members (reads, mode, excluded writes) pass through
 * unmodified. Wrapping is idempotent: an already-wrapped store is returned
 * as-is, so nested sync callers cannot stack retry counters.
 */
import { withDbRetry, type DbRetryOptions } from "./pg-retry";
import type { Store } from "./types";

/**
 * Store methods the sync layer calls whose writes are IDEMPOTENT (evidence
 * per method in the file comment above). Everything else passes through raw.
 */
export const SYNC_WRITE_RETRYABLE_METHODS = [
  // data upserts — content-keyed, ON CONFLICT <natural key>
  "upsertUsers",
  "upsertContacts",
  "upsertCalls",
  "upsertOpportunities",
  "upsertAppointments",
  "upsertAttributions",
  "upsertLeads",
  "upsertHarvestConversations",
  "upsertBlockedTimes",
  "upsertAvailabilityRules",
  "upsertTeamGoal",
  "upsertRepGoals",
  // guarded single-row updates — re-apply after an unacknowledged commit no-ops
  "markAppointmentsCancelled",
  "applyCallContactBackfill",
  "applyAvailabilityDiscrepancies",
  // whole-set replaces keyed by date/catalog
  "putAvailabilityDates",
  "putAvailabilitySlotsForDate",
  "putAvailabilityCatalog",
  // idempotent deletes — re-delete is a no-op
  "deleteLeadsBySourceIds",
  "deleteDemoAcuityRows",
  "deleteDemoHighLevelRows",
  // update-by-id to terminal status / conditional reap
  "finishSyncRun",
  "finishAvailabilitySyncRun",
  "reapStaleAvailabilitySyncRuns",
  // bookkeeping upserts keyed by natural keys
  "upsertConnection",
  "setSyncWatermark",
  "setSyncCheckpoint",
  "saveHarvestProgress",
] as const;

export type SyncWriteRetryableMethod = (typeof SYNC_WRITE_RETRYABLE_METHODS)[number];

const RETRYABLE_SET: ReadonlySet<string> = new Set<string>(SYNC_WRITE_RETRYABLE_METHODS);

/** Brand so an already-wrapped store is never wrapped twice (no stacked retries). */
const SYNC_WRITE_RETRY_WRAPPED = Symbol("syncWriteRetryWrapped");

/** True when the store already went through withSyncWriteRetry (test aid). */
export function isSyncWriteRetryWrapped(store: unknown): boolean {
  return (
    typeof store === "object" &&
    store !== null &&
    (store as Record<symbol, unknown>)[SYNC_WRITE_RETRY_WRAPPED] === true
  );
}

/**
 * Return a store-like object in which the allowlisted IDEMPOTENT write methods
 * retry transient connection-class failures (bounded: RETRY_ATTEMPTS total,
 * backoff 150/450ms + jitter — same engine + constants as the read path).
 * A write that exhausts its attempts rethrows the ORIGINAL error — no silent
 * swallowing, no fabricated success. All other members pass through
 * unchanged (reads keep their own retry, excluded writes never retry).
 */
export function withSyncWriteRetry<T extends Store>(store: T, opts?: DbRetryOptions): T {
  if (isSyncWriteRetryWrapped(store)) return store; // never stack retries
  const wrapped = new Proxy(store, {
    get(target, prop) {
      if (prop === SYNC_WRITE_RETRY_WRAPPED) return true;
      const value = Reflect.get(target, prop, target);
      if (typeof prop === "string" && RETRYABLE_SET.has(prop) && typeof value === "function") {
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) =>
          withDbRetry(() => Promise.resolve(method.apply(target, args)), opts);
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return wrapped as T;
}
