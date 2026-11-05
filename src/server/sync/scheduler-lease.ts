/**
 * SCHEDULER LEASE — the single-scheduler guarantee at DB level (portability
 * 2026-11-05, PART 1 deliverable 4).
 *
 * PROBLEM: the sync scheduler is in-process. N app instances pointed at ONE
 * database (the two CTO serves today; N app replicas on a managed host
 * tomorrow) each start their own scheduler and each tick the same providers —
 * tolerated so far, never a production guarantee.
 *
 * CONTRACT: a lease is a mutually-exclusive right to tick.
 *   interface SchedulerLease { acquire(): Promise<boolean>; release(): Promise<void>; }
 *   - acquire() is IDEMPOTENT for the holder (calling it while held returns
 *     true) and is the per-round check the scheduler loop uses: the holder
 *     ticks, a non-holder logs once and does NOT tick but keeps retrying on
 *     its normal interval so a freed lease is picked up; a holder that LOSES
 *     the lock (dead connection) stops ticking until it re-acquires.
 *   - release() gives the lease up (shutdown path — SIGTERM/SIGINT).
 *
 * POSTGRES IMPLEMENTATION: a session-level advisory lock
 * (`pg_try_advisory_lock` on the fixed key SCHEDULER_LEASE_LOCK_KEY) held on
 * a DEDICATED postgres.js connection (its own `postgres(url, { max: 1 })`
 * instance) so the lock's lifetime is independent of the request pools —
 * the lock lives on that one session, dies with it, and is re-acquirable the
 * moment the session (or the process) is gone. Because the pool has exactly
 * one connection, try-lock and unlock always land on the SAME session; after
 * a connection death the fresh session simply re-runs try-lock: if another
 * instance grabbed the lease meanwhile we get false (ticking stops until
 * re-acquired — the exact contract), if it is free we re-acquire.
 *
 * The key 0x4D414C4C is ASCII "MALL" — a single documented bigint, chosen so
 * no other advisory-lock user in this database can collide with it. In-memory
 * implementation for tests/demo (no database → nothing to arbitrate; the
 * always-yes lease keeps single-process behavior byte-identical).
 */
import postgres from "postgres";
import { dbConnectTimeoutSeconds } from "../store/db-pool-config";
import { getSecret } from "../env";

/** The lease contract (see module doc). */
export interface SchedulerLease {
  /** Name for logs — who is arbitrating. */
  readonly name: string;
  /** Try to take the lease (idempotent for the current holder). */
  acquire(): Promise<boolean>;
  /** Give the lease up (best-effort; safe to call when not held). */
  release(): Promise<void>;
}

/**
 * The fixed session-level advisory-lock key: ASCII "MALL" = 0x4D414C4C.
 * DOCUMENTED AND FROZEN — every deployment of this app arbitrates its
 * scheduler on this exact key; a different key would silently fork the
 * guarantee. (Integer, positive, fits PostgreSQL's signed bigint keys.)
 */
export const SCHEDULER_LEASE_LOCK_KEY = 0x4d414c4c;

/** The one try-lock statement (session-level, bigint key parameter). */
export const LEASE_TRY_LOCK_SQL = "SELECT pg_try_advisory_lock($1) AS acquired";
/** The one unlock statement — MUST run on the same session that locked. */
export const LEASE_UNLOCK_SQL = "SELECT pg_advisory_unlock($1) AS released";

/** Minimal SQL surface (the dedicated one-connection postgres.js client). */
interface LeaseSql {
  unsafe: (query: string, params?: unknown[]) => PromiseLike<Array<Record<string, unknown>>>;
  end?: (opts?: unknown) => PromiseLike<unknown>;
}

/**
 * Postgres lease: session-level advisory lock on a dedicated max-1 pool.
 * `sql` is injectable for offline tests (unit-pins the SQL shape + key).
 */
export class PostgresSchedulerLease implements SchedulerLease {
  readonly name = `postgres-advisory:${String(SCHEDULER_LEASE_LOCK_KEY)} (0x4D414C4C "MALL")`;
  private sql: LeaseSql;
  private ownsSql: boolean;
  private held = false;

  constructor(databaseUrl: string, options?: { sql?: LeaseSql }) {
    if (options?.sql) {
      this.sql = options.sql;
      this.ownsSql = false;
      return;
    }
    // DEDICATED CONNECTION: its own pool with max 1 — NOT the request pool.
    // max 1 guarantees try-lock and unlock land on the same session (the
    // advisory lock is session-level), and the lock's lifetime is fully
    // independent of request traffic and the web pool profile.
    this.sql = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 0, // keep the session alive while we hold the lock
      connect_timeout: dbConnectTimeoutSeconds(),
      onnotice: () => {}, // silent — the lease never chatters
    }) as unknown as LeaseSql;
    this.ownsSql = true;
  }

  async acquire(): Promise<boolean> {
    try {
      const rows = (await this.sql.unsafe(LEASE_TRY_LOCK_SQL, [SCHEDULER_LEASE_LOCK_KEY])) as Array<{ acquired?: boolean | null }>;
      const got = Array.isArray(rows) && rows.length > 0 && rows[0]?.acquired === true;
      this.held = got;
      return got;
    } catch (e) {
      // Lease arbitration errors are NEVER tick failures: a dead/unreachable
      // lease connection means we cannot prove we hold the lock → not held.
      // The scheduler loop treats this exactly like a lost lease (stop
      // ticking, keep retrying acquisition on the normal interval).
      this.held = false;
      void e;
      return false;
    }
  }

  async release(): Promise<void> {
    if (!this.held) return;
    try {
      await this.sql.unsafe(LEASE_UNLOCK_SQL, [SCHEDULER_LEASE_LOCK_KEY]);
    } catch {
      // best-effort: a dead connection already dropped the session-level lock
    } finally {
      this.held = false;
    }
  }

  /** End the dedicated pool (process shutdown; also drops the session lock). */
  async close(): Promise<void> {
    await this.release();
    if (this.ownsSql) await this.sql.end?.({ timeout: 5 });
  }
}

/** Trivial always-yes lease: single-instance/demo posture (no DB to arbitrate). */
export class AlwaysAcquireLease implements SchedulerLease {
  readonly name = "always-yes (single instance)";
  async acquire(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {}
}

/** In-memory mutex lease for tests: exactly one acquirer holds it. */
export class InMemorySchedulerLease implements SchedulerLease {
  readonly name: string;
  private held = false;
  constructor(name = "in-memory") {
    this.name = name;
  }
  async acquire(): Promise<boolean> {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  async release(): Promise<void> {
    this.held = false;
  }
  /** Test hook: simulate the holder dying / the lock being lost. */
  forceReleaseForTests(): void {
    this.held = false;
  }
  /** Test hook. */
  isHeld(): boolean {
    return this.held;
  }
}

/**
 * The lease startScheduler runs under by default: a Postgres advisory-lock
 * lease when the business database is configured (N instances → one worker),
 * or the always-yes lease in demo/no-database mode (nothing to arbitrate —
 * today's single-process behavior, byte-identical).
 */
export function defaultSchedulerLease(): SchedulerLease {
  const url = getSecret("DATABASE_URL");
  if (!url) return new AlwaysAcquireLease();
  return new PostgresSchedulerLease(url);
}
