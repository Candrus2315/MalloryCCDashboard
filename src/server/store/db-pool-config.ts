/**
 * SHARED DB CONNECTION BUDGET (2026-11-04 incident) — ONE place owns the
 * connection-timeout numbers every postgres() construction site uses.
 *
 * The 11/4 provider incident (managed host refused NEW connections ~20:13–21:00
 * UTC) left two sync passes WEDGED for the full 30-minute stale-run reap window
 * (highlevel 20:30:12→21:00:22, attribution 20:26:44→20:58:46) while the owner
 * watched the "last sync error … retrying" banner. postgres.js defaults
 * connect_timeout to 30 s and several secondary pools (ops/backfill scripts)
 * carried no explicit bound at all, and nothing at pass start bounded a wedged
 * connection acquisition — a pass could hang a step far past its own run
 * budget because the budget is only checked BETWEEN steps.
 *
 * This module gives every construction site ONE shared, env-overridable
 * budget instead of scattered literals:
 *   - connect timeout  ~10 s by default (was 30 s in the app pool, absent or
 *     15–30 s literals elsewhere) — a refused/hung connect fails as an
 *     ordinary error in seconds, so the existing db-retry layer
 *     (store/pg-retry.ts, attempt 1/3 backoff) bounds a persistently dead
 *     host to ~31 s at pass level instead of a 30-minute wedge.
 *   - statement timeout 300 s — the same server-side session cap the app pool
 *     already carried (2026-10-12 hardening), now shared with the secondary
 *     pools so a query parked on a stalled connection is cancelled there too.
 *   - idle timeout 60 s + max_lifetime 1800 s for the secondary pools (the
 *     app pool keeps its profile-specific values in POOL_PROFILES, pinned by
 *     pool-retry.test.ts).
 *
 * ENV OVERRIDE: DB_CONNECT_TIMEOUT_MS (milliseconds, the unit the incident
 * tooling speaks) — validated, rounded, and clamped to [1 s, 60 s]; an absent
 * or invalid value silently falls back to the safe default, so the default is
 * safe without env. postgres.js takes connect_timeout/idle_timeout/
 * max_lifetime in SECONDS (installed 3.4.9 cjs/src/index.js:447 "ints" list,
 * :453 default 30) — dbConnectTimeoutSeconds() does the conversion once so no
 * call site repeats the unit math.
 */
export const DEFAULT_DB_CONNECT_TIMEOUT_MS = 10_000;

/** Env var name — set in ms (e.g. 30000 restores the pre-11/4 30 s patience). */
export const DB_CONNECT_TIMEOUT_MS_ENV = "DB_CONNECT_TIMEOUT_MS";

/** Clamp floor/ceiling: never sub-second (pointless churn), never ≥ 1 min
 * (a 60 s+ connect stall is exactly the wedge this module exists to close). */
export const DB_CONNECT_TIMEOUT_MS_MIN = 1_000;
export const DB_CONNECT_TIMEOUT_MS_MAX = 60_000;

/**
 * The connect budget in ms — env DB_CONNECT_TIMEOUT_MS when valid, the 10 s
 * default otherwise. Pure function of the passed env string (tests inject);
 * production reads process.env.
 */
export function dbConnectTimeoutMs(env: string | undefined = process.env[DB_CONNECT_TIMEOUT_MS_ENV]): number {
  const raw = Number(env);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DB_CONNECT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(raw), DB_CONNECT_TIMEOUT_MS_MIN), DB_CONNECT_TIMEOUT_MS_MAX);
}

/**
 * The SAME budget in SECONDS — the unit postgres.js's connect_timeout option
 * speaks. Always ≥ 1 s so a fractional-ms env value can never produce 0
 * (which in postgres.js means "wait indefinitely" — the wedge, not a bound).
 */
export function dbConnectTimeoutSeconds(env?: string): number {
  return Math.max(1, Math.ceil(dbConnectTimeoutMs(env) / 1000));
}

/**
 * Server-side per-statement cap (ms), shared by every pool: a session-level
 * startup parameter so a query parked on a stalled DB connection is cancelled
 * by the SERVER after 5 min. ≥ 5× the worst legit statement observed (the
 * ~65 s ensureSchema sweep is ~204 individual DDL statements; page-loader and
 * script statements are sub-second to low minutes). Was a pg.ts literal —
 * moved here so the secondary pools inherit the same protection.
 */
export const DB_STATEMENT_TIMEOUT_MS = 300_000;

/** Secondary-pool idle shed (seconds) — matches the app pool's web/job value. */
export const DB_IDLE_TIMEOUT_SECONDS = 60;

/** Secondary-pool connection recycle (seconds) — matches the app pool. */
export const DB_MAX_LIFETIME_SECONDS = 1800;

/**
 * The bounds block for SECONDARY pools (ops/backfill/report scripts): spread
 * it into every postgres() options object so no script re-derives the numbers
 * (the pre-11/4 scripts mixed absent, 10, 15 and 30 s literals). The caller
 * keeps ownership of max / ssl / prepare — only the SHARED bounds live here.
 */
export function dbConnectionBudget(): {
  connect_timeout: number;
  idle_timeout: number;
  max_lifetime: number;
  connection: { statement_timeout: number };
} {
  return {
    connect_timeout: dbConnectTimeoutSeconds(),
    idle_timeout: DB_IDLE_TIMEOUT_SECONDS,
    max_lifetime: DB_MAX_LIFETIME_SECONDS,
    connection: { statement_timeout: DB_STATEMENT_TIMEOUT_MS },
  };
}
