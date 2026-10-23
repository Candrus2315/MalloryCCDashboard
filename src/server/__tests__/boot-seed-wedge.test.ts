/**
 * BOOT-SEED WEDGE REGRESSION (reliability 2b/3, forensics §3
 * "POST-PUBLISH-WEDGE (boot-seed)") — the third reliability finding.
 *
 * THE HOLE (pre-fix): PgStore.ensureSchema memoized a `schemaReady` promise
 * with NO timeout and NEVER reset it on failure:
 *   ensureSchema() → if (!schemaReady) schemaReady = DDL loop;
 * Every store method awaits ensureSchema, so ONE hung DDL statement (an
 * ACCESS EXCLUSIVE lock blocker on `users` — the boot seed UPDATEs at
 * pg.ts:395/:404-407 — a stalled TLS write, a provider flap) wedged the WHOLE
 * process forever: SSR loaders, sync ticks, and /health all hung behind it.
 * The wedge amplifier: store/index.ts probePg had no knob either, and
 * getStore()'s in-flight dedup made every concurrent caller share the same
 * hung promise. Field chain: serve.ts:11-17 — publish swaps files but never
 * restarts, the wedged old runtime stayed live serving 500s.
 *
 * THE FIX, pinned here:
 *   ② BOUNDED + RESET (scenario ②): every DDL statement races a client-side
 *     JS-timer cap (DEFAULT_SCHEMA_STMT_TIMEOUT_MS = 90s — >30× the healthy
 *     worst statement, same dependable-bound pattern as fetch-timeout.ts) and
 *     ANY failure — cap or rejection — resets schemaReady so the NEXT
 *     ensureSchema call retries from the top (recovery without restart).
 *     Healthy path byte-identical: same statements, same order, same pool.
 *   ③ HONEST MEMORY FALLBACK (scenario ③): probePg/getStore gain a whole-probe
 *     backstop (DEFAULT_PROBE_TIMEOUT_MS = 300s) + a storeFactory test seam —
 *     a hung probe now falls back to the MemoryStore within the cap instead of
 *     hanging forever, and the degradation is SURFACED (boot-log warn line +
 *     getDbStatus reason, read by the sync banner), never silent.
 *   ① REAL-DB LOCK REPRO (scenario ①): lives in
 *     scratch/boot-seed-lock-probe.ts (a disposable database on the team
 *     instance + a real ACCESS EXCLUSIVE lock on users; evidence in
 *     scratch/boot-seed-lock-probe-out.txt, quoted in the PR body). Not a CI
 *     test: it needs a real Postgres and deliberate lock contention.
 *
 * All tests offline: PgStore's new `sql` test seam (forensics §3 "missing
 * seam") injects a stubbed/hung runner — no real DB, no real waiting beyond
 * sub-second caps. Real timers, house style (fetch-timeout.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { PgStore, DEFAULT_SCHEMA_STMT_TIMEOUT_MS, SchemaAcquireTimeoutError } from "../store/pg";
import {
  probePg,
  getStore,
  getDbStatus,
  __resetStoreProbeStateForTests,
  DEFAULT_PROBE_TIMEOUT_MS,
  ProbeTimeoutError,
  type ProbeOptions,
  type Store,
} from "../store/index";
import { MemoryStore } from "../store/memory";

/* ------------------------------------------------------------------ */
/* fake sql harness — the injected runner (PgStore's new test seam)    */
/* ------------------------------------------------------------------ */

interface FakeOpts {
  /** Statements whose promise never settles (the hung DDL). */
  hangOn?: (stmt: string) => boolean;
  /** Statements that reject (a failed DDL pass). */
  rejectOn?: (stmt: string) => boolean;
}

function makeFakeSql(opts: FakeOpts = {}) {
  const executed: string[] = [];
  let healthy = false; // false = the blocker is in place; flip to simulate it clearing
  const sql = {
    unsafe: (stmt: string): Promise<unknown> => {
      executed.push(stmt);
      if (healthy) return Promise.resolve([]);
      if (opts.rejectOn?.(stmt)) return Promise.reject(new Error("simulated DDL failure"));
      if (opts.hangOn?.(stmt)) return new Promise<never>(() => {});
      return Promise.resolve([]);
    },
    end: async () => {},
  };
  return {
    sql,
    executed,
    setHealthy: (h: boolean) => {
      healthy = h;
    },
  };
}

/** Incident-faithful hang target: the boot-time seed writes against `users`. */
const isUsersSeed = (stmt: string) => /UPDATE users SET/.test(stmt);

/** Sub-second sleep (real timers, house style). */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makePg(fakeSql: unknown, schemaStmtTimeoutMs: number): PgStore {
  return new PgStore("postgres://test:test@127.0.0.1:1/test", {
    sql: fakeSql as { unsafe: (stmt: string) => Promise<unknown>; end?: (o?: unknown) => Promise<unknown> },
    schemaStmtTimeoutMs,
  });
}

/* ------------------------------------------------------------------ */
/* scenario ② — bounded cap + reset                                    */
/* ------------------------------------------------------------------ */

describe("boot-seed wedge ② — ensureSchema bounded cap + reset", () => {
  test("DEFAULT_SCHEMA_STMT_TIMEOUT_MS is the documented 90s cap", () => {
    expect(DEFAULT_SCHEMA_STMT_TIMEOUT_MS).toBe(90_000);
  });

  test("healthy path byte-compatible: full sweep runs in order, resolves, stays memoized", async () => {
    const { sql, executed } = makeFakeSql();
    const pg = makePg(sql, DEFAULT_SCHEMA_STMT_TIMEOUT_MS);
    await pg.ensureSchema();
    // the real DDL sweep is ~80-200 statements starting with the users table
    expect(executed.length).toBeGreaterThan(50);
    expect(executed[0]).toContain("CREATE TABLE IF NOT EXISTS users");
    // memoized: a second call re-runs NOTHING
    await pg.ensureSchema();
    expect(executed.length).toBeGreaterThan(50); // unchanged by the second call
    expect(executed.filter((s) => s === executed[0]).length).toBe(1);
    await pg.close();
  });

  test("a hung DDL statement rejects within the cap — bounded, not forever", async () => {
    const { sql } = makeFakeSql({ hangOn: isUsersSeed });
    const pg = makePg(sql, 50);
    const start = Date.now();
    const err: unknown = await pg.ensureSchema().then(
      () => null,
      (e) => e,
    );
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(SchemaAcquireTimeoutError);
    expect((err as Error).name).toBe("SchemaAcquireTimeoutError");
    expect((err as Error).message).toContain("schema statement timeout");
    expect((err as Error).message).toContain("schemaReady reset for retry");
    // pre-fix this promise NEVER settled; now it rejects within the 50ms cap
    expect(elapsed).toBeLessThan(2_000);
    await pg.close();
  });

  test("schemaReady RESETS: the next ensureSchema retries from the top after the blocker clears", async () => {
    const { sql, executed, setHealthy } = makeFakeSql({ hangOn: isUsersSeed });
    const pg = makePg(sql, 50);
    await expect(pg.ensureSchema()).rejects.toBeInstanceOf(SchemaAcquireTimeoutError);
    // the blocker clears (lock released / stall healed)…
    setHealthy(true);
    // …and the NEXT call must retry the WHOLE sweep, not return the dead promise
    await pg.ensureSchema();
    // retry started from the top: first statement ran again
    const first = executed[0];
    expect(executed.filter((s) => s === first).length).toBe(2);
    // the previously-hung users seed statement completed this time
    const seedWrites = executed.filter((s) => isUsersSeed(s));
    expect(seedWrites.length).toBeGreaterThanOrEqual(2); // hung attempt + completed retry
    await pg.close();
  });

  test("a REJECTED DDL pass also resets — recovery without restart (assert iv)", async () => {
    const { sql, executed, setHealthy } = makeFakeSql({ rejectOn: isUsersSeed });
    const pg = makePg(sql, DEFAULT_SCHEMA_STMT_TIMEOUT_MS);
    const err: unknown = await pg.ensureSchema().then(
      () => null,
      (e) => e,
    );
    expect((err as Error).message).toBe("simulated DDL failure");
    setHealthy(true);
    await pg.ensureSchema(); // no restart needed — the retry just works
    const first = executed[0];
    expect(executed.filter((s) => s === first).length).toBe(2);
    await pg.close();
  });

  test("concurrent callers share ONE attempt while it is live; all get the rejection", async () => {
    const { sql, executed, setHealthy } = makeFakeSql({ hangOn: isUsersSeed });
    const pg = makePg(sql, 60);
    const results = await Promise.allSettled([pg.ensureSchema(), pg.ensureSchema(), pg.ensureSchema()]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SchemaAcquireTimeoutError);
    }
    // dedup held: the hung users seed statement was invoked exactly once
    expect(executed.filter((s) => isUsersSeed(s)).length).toBe(1);
    // and a later caller retries cleanly
    setHealthy(true);
    await pg.ensureSchema();
    await pg.close();
  });

  test("cap 0 disables the seam — the pre-fix wedge behavior stays reachable (lock-probe mode)", async () => {
    const { sql } = makeFakeSql({ hangOn: isUsersSeed });
    const pg = makePg(sql, 0);
    const verdict = await Promise.race([
      pg.ensureSchema().then(
        () => "resolved",
        () => "rejected",
      ),
      sleep(150).then(() => "still-hanging"),
    ]);
    expect(verdict).toBe("still-hanging"); // exactly what the lock probe observes pre-fix
    await pg.close();
  });
});

/* ------------------------------------------------------------------ */
/* scenario ③ — probe backstop: bounded, honest memory fallback        */
/* ------------------------------------------------------------------ */

describe("boot-seed wedge ③ — probePg/getStore bounded + honest memory fallback", () => {
  const FAKE_URL = "postgres://probe:probe@127.0.0.1:1/probe";
  let realUrl: string | undefined;

  // The pgRegistry is module-global and keyed by URL — clear it per test so
  // probes are independent (the registry-memoizes test intentionally seeds it).
  const clearRegistry = () => {
    const g = globalThis as unknown as Record<string, Map<string, unknown> | undefined>;
    delete g["__malloryPgStores"];
  };

  // probePg reads the env at call time via getSecret; set a valid-shape URL so
  // the url-validation gate passes and the (injected) factory path runs. The
  // module probe cache is reset before AND after: bun test shares one process,
  // so an earlier file's cached postgres store would otherwise satisfy
  // getStore's sticky rule and hide the fallback path this scenario pins.
  const withProbeUrl = <T>(fn: () => Promise<T>): Promise<T> => {
    realUrl = process.env.Database_URL;
    process.env.Database_URL = FAKE_URL;
    clearRegistry();
    __resetStoreProbeStateForTests();
    return fn().finally(() => {
      if (realUrl === undefined) delete process.env.Database_URL;
      else process.env.Database_URL = realUrl;
      __resetStoreProbeStateForTests();
    });
  };

  test("DEFAULT_PROBE_TIMEOUT_MS is the documented 300s backstop", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(300_000);
  });

  test("a hung probe returns null within the backstop; getDbStatus reports the honest reason", async () => {
    await withProbeUrl(async () => {
      const { sql } = makeFakeSql({ hangOn: isUsersSeed });
      const hung = new PgStore(FAKE_URL, { sql: sql as never, schemaStmtTimeoutMs: 0 }); // cap disabled — backstop must carry
      const start = Date.now();
      const res: Store | null = await probePg({ probeTimeoutMs: 80, storeFactory: () => hung });
      expect(res).toBeNull();
      expect(Date.now() - start).toBeLessThan(2_000);
      const status = getDbStatus();
      expect(status.mode).toBe("memory");
      expect(status.ok).toBe(false);
      expect(status.reason).toContain("schema probe timeout");
      expect(status.reason).toContain("falling back to in-memory store");
    });
  });

  test("getStore falls back to the MemoryStore instead of hanging (the amplifier chain closed)", async () => {
    await withProbeUrl(async () => {
      const { sql } = makeFakeSql({ hangOn: isUsersSeed });
      const hung = new PgStore(FAKE_URL, { sql: sql as never, schemaStmtTimeoutMs: 0 });
      const opts: ProbeOptions = { probeTimeoutMs: 80, storeFactory: () => hung };
      const store = await getStore(opts);
      // pre-fix: every concurrent getStore() caller shared ONE hung promise forever
      expect(store).toBeInstanceOf(MemoryStore);
      expect(getDbStatus().reason).toContain("schema probe timeout");
    });
  });

  test("a healthy probe succeeds and the registry memoizes it (healthy path byte-compatible)", async () => {
    await withProbeUrl(async () => {
      const { sql } = makeFakeSql();
      const healthy = new PgStore(FAKE_URL, { sql: sql as never });
      const res = await probePg({ storeFactory: () => healthy });
      expect(res).toBe(healthy);
      // second probe for the same URL is served from the registry — the factory must not run again
      const res2 = await probePg({
        storeFactory: () => {
          throw new Error("factory must not run twice");
        },
      });
      expect(res2).toBe(healthy);
    });
  });

  test("recovery without restart: a timed-out probe succeeds on re-probe after the blocker clears", async () => {
    await withProbeUrl(async () => {
      const { sql } = makeFakeSql({ hangOn: isUsersSeed });
      const hung = new PgStore(FAKE_URL, { sql: sql as never, schemaStmtTimeoutMs: 0 });
      const first = await probePg({ probeTimeoutMs: 80, storeFactory: () => hung });
      expect(first).toBeNull();
      // the DB recovers (lock released / stall healed): a fresh probe succeeds
      // and gets registered — no process restart needed
      const healthy = new PgStore(FAKE_URL, { sql: makeFakeSql().sql as never });
      const second = await probePg({ storeFactory: () => healthy });
      expect(second).toBe(healthy);
    });
  });

  test("ProbeTimeoutError carries the honest name and message shape", () => {
    const e = new ProbeTimeoutError(300_000);
    expect(e.name).toBe("ProbeTimeoutError");
    expect(e.message).toContain("schema probe timeout");
    expect(e.message).toContain("falling back to in-memory store");
  });
});
