/**
 * BOUNDED DB RETRY for read paths — production resilience against
 * pool-exhaustion / transient connection errors (the post-deploy transient
 * 500s on heavy pages while two servers + a sync tick compete for the managed
 * Postgres ceiling).
 *
 * Design rules (owner-facing hardening, never behavior change):
 * - RETRIES ONLY connection-class failures — server slot exhaustion
 *   (53300 "too many connections" / the pg_use_reserved_connections
 *   rejection, 08004 "sorry, too many clients already"), dead connection
 *   (08006), failed establish (08001/08003), admin termination (57P01), and
 *   the socket-level resets that surface as raw Node/Bun errors. A business
 *   error (constraint, SQL typo, empty result) is never retried and never
 *   masked — the first non-connection error is rethrown as-is.
 * - READ PATHS ONLY. Callers wrap read-only page-data loaders; a write (or
 *   anything with side effects) must never pass through here, because a
 *   retry could double-apply it.
 * - BOUNDED AND SHORT: RETRY_ATTEMPTS attempts total, linear-ish backoff
 *   (RETRY_BASE_DELAY_MS then ×3, +jitter) — worst added latency well under
 *   a second, so a healthy pool sees zero change and a saturated pool sheds
 *   within the sync tick's own finishing window instead of 500-ing.
 */

/** Postgres SQLSTATE codes that mean "transient connection problem". */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "53300", // too_many_connections (incl. the pg_use_reserved_connections slot rejection)
  "08004", // too_many_connections — server rejected the connection attempt
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "57P01", // admin termination (cloud managed host killed an idle connection)
]);

/** Message fragments for raw (non-SQLSTATE) socket errors worth one retry. */
const RETRYABLE_MESSAGE_RE =
  /too many connections|too many clients|connection slots are reserved|server closed the connection unexpectedly|terminating connection due to administrator command|\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b/i;

export function isTransientDbError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return RETRYABLE_MESSAGE_RE.test(msg);
}

export interface DbRetryOptions {
  /** Total attempts INCLUDING the first (default RETRY_ATTEMPTS). */
  attempts?: number;
  /** First backoff step in ms; each further attempt waits delay ×3 (+jitter). */
  baseDelayMs?: number;
  /** Injectable sleep for tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook — default: one console.warn per retry (no secrets). */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/** 1 initial + 2 retries. */
export const RETRY_ATTEMPTS = 3;
/** First backoff step; worst-case added latency ≈ 150 + 450 + jitter ≤ ~750ms. */
export const RETRY_BASE_DELAY_MS = 150;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withDbRetry<T>(fn: () => Promise<T>, opts?: DbRetryOptions): Promise<T> {
  const attempts = Math.max(1, opts?.attempts ?? RETRY_ATTEMPTS);
  const baseDelay = Math.max(0, opts?.baseDelayMs ?? RETRY_BASE_DELAY_MS);
  const sleep = opts?.sleep ?? defaultSleep;
  const onRetry =
    opts?.onRetry ??
    ((attempt: number, error: unknown, delayMs: number) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[db-retry] transient connection error (attempt ${attempt}/${attempts}) — retrying in ${delayMs}ms: ${msg}`);
    });
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt >= attempts || !isTransientDbError(e)) throw e;
      // (0.5 + jitter) × backoff curve — short, bounded, never exponential runaway
      const delayMs = Math.round((0.5 + Math.random() / 2) * baseDelay * Math.pow(3, attempt - 1));
      onRetry(attempt, e, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
