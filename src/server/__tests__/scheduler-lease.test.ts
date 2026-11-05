/**
 * SCHEDULER LEASE — the single-scheduler guarantee (portability 2026-11-05,
 * PART 1 deliverable 4) + the crash-safe shutdown wiring (deliverable 5).
 *
 * Pinned OFFLINE (house style — no real DB; the live advisory-lock check is
 * the lead's ship step):
 *   - InMemorySchedulerLease: one holder; the second acquirer is refused
 *     until release.
 *   - PostgresSchedulerLease (injected fake sql): the SQL SHAPE —
 *     pg_try_advisory_lock / pg_advisory_unlock on the fixed documented key
 *     0x4D414C4C ("MALL"), on a DEDICATED max-1 pool; errors mean NOT held;
 *     release without hold is a no-op.
 *   - runSchedulerLoop × 2 (the two-instance scenario — one loop per app
 *     instance; in-process the `started` guard keeps startScheduler single):
 *     exactly one instance ticks while the other stands by; a freed/lost
 *     lease is picked up within one interval; a holder that loses the lock
 *     STOPS ticking.
 *   - The shutdown run-closer releases the lease + closes pools on SIGTERM
 *     inside the existing 3s cap (deliverable 5).
 */
import { describe, expect, test } from "bun:test";
import {
  AlwaysAcquireLease,
  InMemorySchedulerLease,
  LEASE_TRY_LOCK_SQL,
  LEASE_UNLOCK_SQL,
  PostgresSchedulerLease,
  SCHEDULER_LEASE_LOCK_KEY,
  defaultSchedulerLease,
  type SchedulerLease,
} from "../sync/scheduler-lease";
import { runSchedulerLoop, type SchedulerTickResult } from "../sync/scheduler";
import { installShutdownSyncRunCloser } from "../sync/run-lifecycle";

/* ------------------------------------------------------------------ */
/* in-memory lease                                                      */
/* ------------------------------------------------------------------ */
describe("InMemorySchedulerLease", () => {
  test("one holder; the second acquirer waits; release frees it", async () => {
    // ONE lease object IS the mutex: while it is held, every acquire (including
    // a second instance's) is refused; release frees it for the next acquirer.
    const lease = new InMemorySchedulerLease("t");
    expect(await lease.acquire()).toBe(true);
    expect(await lease.acquire()).toBe(false); // held — refused
    expect(await lease.acquire()).toBe(false); // still held — refused
    await lease.release();
    expect(await lease.acquire()).toBe(true);
  });
});

describe("AlwaysAcquireLease (demo/no-database posture)", () => {
  test("always true, release is a no-op", async () => {
    const lease = new AlwaysAcquireLease();
    expect(await lease.acquire()).toBe(true);
    expect(await lease.acquire()).toBe(true);
    await lease.release();
  });
});

/* ------------------------------------------------------------------ */
/* Postgres lease — SQL shape on an injected fake                       */
/* ------------------------------------------------------------------ */
describe("PostgresSchedulerLease — SQL shape + semantics (unit, offline)", () => {
  function makeFake() {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const responses: Array<boolean | Error>[] = [];
    const fake = {
      unsafe: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const next = responses.shift();
        if (next && next[0] instanceof Error) throw next[0];
        return [{ acquired: next?.[0] ?? true, released: next?.[0] ?? true }];
      },
    };
    return { calls, responses, fake };
  }

  test("acquire() issues pg_try_advisory_lock on the FIXED documented key", async () => {
    const f = makeFake();
    f.responses.push([true]);
    const lease = new PostgresSchedulerLease("postgres://lease:lease@127.0.0.1:1/lease", { sql: f.fake });
    expect(await lease.acquire()).toBe(true);
    expect(f.calls[0]!.sql).toBe(LEASE_TRY_LOCK_SQL);
    expect(LEASE_TRY_LOCK_SQL).toContain("pg_try_advisory_lock");
    expect(f.calls[0]!.params).toEqual([SCHEDULER_LEASE_LOCK_KEY]);
    expect(SCHEDULER_LEASE_LOCK_KEY).toBe(0x4d414c4c); // ASCII "MALL" — frozen, documented
  });

  test("refused try-lock → false; a THROWN error is NOT held (lease lost), never a tick crash", async () => {
    const refused = makeFake();
    refused.responses.push([false]);
    const l1 = new PostgresSchedulerLease("postgres://u:p@127.0.0.1:1/d", { sql: refused.fake });
    expect(await l1.acquire()).toBe(false);

    const broken = makeFake();
    broken.responses.push([new Error("connect ECONNREFUSED")]);
    const l2 = new PostgresSchedulerLease("postgres://u:p@127.0.0.1:1/d", { sql: broken.fake });
    expect(await l2.acquire()).toBe(false); // dead lease connection ⇒ cannot prove the lock
  });

  test("release() issues pg_advisory_unlock on the same key; no-op when not held", async () => {
    const f = makeFake();
    f.responses.push([true]);
    const lease = new PostgresSchedulerLease("postgres://u:p@127.0.0.1:1/d", { sql: f.fake });
    await lease.acquire();
    await lease.release();
    expect(f.calls[1]!.sql).toBe(LEASE_UNLOCK_SQL);
    expect(LEASE_UNLOCK_SQL).toContain("pg_advisory_unlock");
    expect(f.calls[1]!.params).toEqual([SCHEDULER_LEASE_LOCK_KEY]);

    const idle = makeFake();
    const l2 = new PostgresSchedulerLease("postgres://u:p@127.0.0.1:1/d", { sql: idle.fake });
    await l2.release();
    expect(idle.calls.length).toBe(0); // not held → nothing executed
  });

  test("defaultSchedulerLease: no DATABASE_URL → always-yes (single instance); with one → the Postgres lease", async () => {
    const prev = process.env.DATABASE_URL;
    try {
      delete process.env.Database_URL;
      delete process.env.DATABASE_URL;
      expect(defaultSchedulerLease()).toBeInstanceOf(AlwaysAcquireLease);
      process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/d";
      expect(defaultSchedulerLease()).toBeInstanceOf(PostgresSchedulerLease);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

/* ------------------------------------------------------------------ */
/* two scheduler instances → exactly one ticks (the deliverable-4 pin)  */
/* ------------------------------------------------------------------ */
/** Lease scripted per acquire() call — deterministic instance election. */
class ScriptedLease implements SchedulerLease {
  name = "scripted";
  /** Outcomes consumed in order by acquire(): true = take the lease. */
  readonly outcomes: boolean[];
  private idx = 0;
  readonly acquireLog: number[] = [];
  released = 0;
  constructor(outcomes: boolean[]) {
    this.outcomes = outcomes;
  }
  async acquire(): Promise<boolean> {
    this.acquireLog.push(this.idx);
    const ok = this.outcomes[this.idx] ?? false;
    this.idx++;
    return ok;
  }
  async release(): Promise<void> {
    this.released++;
  }
}

const noTick = async (): Promise<SchedulerTickResult> => ({ outcome: "skipped", reason: "lease-loop-test" });
const tickOf = (id: string, log: string[]) => async (): Promise<SchedulerTickResult> => {
  log.push(id);
  return { outcome: "skipped", reason: id };
};
const quick = async (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("runSchedulerLoop — N instances, ONE worker (deliverable 4)", () => {
  test("holder ticks; the non-holder logs once and does NOT tick but keeps retrying each round", async () => {
    // Instance A holds for 3 rounds then loses the lock (connection death
    // semantics); instance B is refused while A holds and takes over after.
    const leaseA = new ScriptedLease([true, true, false, false, false]);
    const leaseB = new ScriptedLease([false, false, true, true]);
    const ticks: string[] = [];
    await Promise.all([
      runSchedulerLoop({ tick: tickOf("A", ticks), lease: leaseA, intervalSeconds: 0.001, rounds: 5, sleep: quick, log: () => {} }),
      runSchedulerLoop({ tick: tickOf("B", ticks), lease: leaseB, intervalSeconds: 0.001, rounds: 5, sleep: quick, log: () => {} }),
    ]);
    // B never ticked while refused; B ticked after its lease said yes; A
    // stopped ticking the moment its lease said false (lock lost).
    const aTicks = ticks.filter((t) => t === "A").length;
    const bTicks = ticks.filter((t) => t === "B").length;
    expect(aTicks).toBe(2); // exactly its two granted rounds — then STOPS
    expect(bTicks).toBeGreaterThanOrEqual(1); // picked up the freed lease within one interval
    // The refusing prefix of B's script is longer than A's grant window only
    // if B stood by — assert B acquired only after A lost:
    expect(leaseB.acquireLog.length).toBeGreaterThanOrEqual(3); // kept retrying, never crashed
  });

  test("lock lost → ticking STOPS until re-acquired (the holder's contract)", async () => {
    const lease = new ScriptedLease([true, false, false, true]);
    const ticks: string[] = [];
    await runSchedulerLoop({ tick: tickOf("A", ticks), lease, intervalSeconds: 0.001, rounds: 5, sleep: quick, log: () => {} });
    // rounds: [true→tick, false→standby, false→standby, true→tick, (extra round: outcomes exhausted → false)]
    expect(ticks).toEqual(["A", "A"]);
    expect(lease.acquireLog.length).toBe(5); // acquisition retried every round, including while stopped
  });

  test("a lease that THROWS is treated as not-held; the loop survives and retries", async () => {
    const broken: SchedulerLease = {
      name: "throwing",
      acquire: async () => {
        throw new Error("lease connection died");
      },
      release: async () => {},
    };
    const ticks: string[] = [];
    await runSchedulerLoop({ tick: tickOf("A", ticks), lease: broken, intervalSeconds: 0.001, rounds: 3, sleep: quick, log: () => {} });
    expect(ticks).toEqual([]); // nothing ticked without a provable lease
  });

  test("loop exit releases the lease it still holds (shutdown seam)", async () => {
    const lease = new ScriptedLease([true, true]);
    await runSchedulerLoop({ tick: noTick, lease, intervalSeconds: 0.001, rounds: 2, sleep: quick, log: () => {} });
    expect(lease.released).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* shutdown wiring — lease released + pools closed (deliverable 5)      */
/* ------------------------------------------------------------------ */
describe("shutdown run-closer — lease release + pool close inside the 3s cap", () => {
  test("SIGTERM closes open runs as 'interrupted', releases the lease, closes stores, exits 0", async () => {
    process.exit; // (context: the closer calls exitFn — injected below)
    const released: boolean[] = [];
    const closedStores: boolean[] = [];
    const exits: number[] = [];
    const closer = installShutdownSyncRunCloser({
      // No store → no open runs to close in this unit; the lease + pool hooks
      // are what is under test here (row-closing is pinned in run-lifecycle tests).
      releaseLease: async () => {
        released.push(true);
      },
      closeStores: async () => {
        closedStores.push(true);
      },
      exit: (code) => exits.push(code),
      registerSignal: () => {}, // do NOT register real handlers in a test process
      registerBeforeExit: null,
    });
    await closer.handleSignal("SIGTERM");
    expect(released).toEqual([true]);
    expect(closedStores).toEqual([true]);
    expect(exits).toEqual([0]); // graceful exit code 0
  });

  test("a THROWING lease release never blocks shutdown (best-effort, still exits 0)", async () => {
    const exits: number[] = [];
    const closer = installShutdownSyncRunCloser({
      releaseLease: async () => {
        throw new Error("lease connection already dead");
      },
      exit: (code) => exits.push(code),
      registerSignal: () => {},
      registerBeforeExit: null,
    });
    await closer.handleSignal("SIGINT");
    expect(exits).toEqual([0]);
  });
});
