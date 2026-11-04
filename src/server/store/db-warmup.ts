/**
 * PASS-START DB WARMUP (2026-11-04 incident) — fast-fail a wedged database
 * connection at sync-pass start through the SAME bounded retry engine the
 * read/write paths already use, instead of parking the pass until the
 * 30-minute stale-run reaper.
 *
 * The 11/4 provider incident: two passes created their sync_runs row fine,
 * then hung a full STALE_RUN_REAP_MINUTES window (highlevel 20:30:12→21:00:22,
 * attribution 20:26:44→20:58:46) on a connection acquisition that never
 * finished — while OTHER passes failed honestly with "write CONNECT_TIMEOUT".
 * The per-run wall-clock budgets (highlevel/acuity) only check BETWEEN steps,
 * so a single hung step outlived them; the run rows sat 'running', the tick
 * guard blocked, and the owner watched the degraded banner for 30 minutes.
 *
 * The seam: EVERY sync pass starts with store.insertSyncRun(...) (outside any
 * try — a throw there would skip the auditable error row) and then enters its
 * body. Callers put warmDbConnectionForRun as the FIRST statement inside that
 * try, so a dead database now:
 *   1. fails each attempt within the shared connect budget — the pool's
 *      connect_timeout (db-pool-config.ts, ~10 s) for refused connects, and a
 *      client-side race cap for an acquisition/query that simply never
 *      settles (postgres.js disarms connect_timeout once a pooled connection
 *      is "ready"; a stale/half-open pooled connection has NO driver-side
 *      bound, which is exactly the wedge shape);
 *   2. retries through withDbRetry — attempt 1/3, 150/450 ms backoff — the
 *      IDENTICAL transient CONNECT_TIMEOUT classification
 *      (isTransientDbError) the driver's own connect-timeout failures get;
 *   3. lands in the pass's existing catch → finishSyncRun("error", …) — an
 *      auditable error row within ~31 s instead of a 30-minute reaper close.
 *
 * READ-ONLY: one `SELECT 1` through the store's own pool. No business rows,
 * no watermark movement — a retry can never double-apply anything.
 */
import { withDbRetry } from "./pg-retry";
import { dbConnectTimeoutMs } from "./db-pool-config";
import type { Store } from "./types";

/**
 * Honest, name-set error for a ping that outlived the connect budget — a
 * wedged acquisition/query on the store's pool. Tagged with the SAME code
 * postgres.js puts on its own connect timeouts ("CONNECT_TIMEOUT") so
 * isTransientDbError classifies it identically and the retry is the standard
 * attempt-1/3 backoff pattern, not a bespoke engine.
 */
export class DbWarmupStalledError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    const rendered = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    super(
      `db warmup ping did not settle within the connect budget (${rendered}) — wedged pooled connection; treated as CONNECT_TIMEOUT for retry`,
    );
    this.name = "DbWarmupStalledError";
    this.timeoutMs = timeoutMs;
    (this as { code?: string }).code = "CONNECT_TIMEOUT";
  }
}

/**
 * Race a promise against the connect budget. Fired cap does NOT cancel the
 * underlying query (nothing client-side can) — it stops the PASS from
 * waiting on it; the server-side statement_timeout (300 s, shared) and the
 * pool's idle/max_lifetime bounds reclaim the parked connection.
 */
function raceConnectBudget<T>(p: Promise<T>, budgetMs: number): Promise<T> {
  if (!(budgetMs > 0)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DbWarmupStalledError(budgetMs)), budgetMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Warm the store's pool with ONE bounded, retryable connectivity probe.
 * Skips stores without a ping (test fakes stay untouched — the warmup is
 * transport hardening, never a test-facing contract). Exports the resolved
 * budget for observability in tests.
 */
export async function warmDbConnectionForRun(store: Store, opts?: { connectTimeoutMs?: number }): Promise<void> {
  const ping = (store as { ping?: () => Promise<unknown> }).ping;
  if (typeof ping !== "function") return; // no probe surface (test fakes) — nothing to bound
  const budgetMs = opts?.connectTimeoutMs ?? dbConnectTimeoutMs();
  await withDbRetry(() => raceConnectBudget(Promise.resolve(ping.call(store)), budgetMs));
}
