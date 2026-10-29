/**
 * MIGRATION RUNNER — versioned schema management (docs/MIGRATION-PLAN.md §2).
 *
 * Proves the runner contract end-to-end OFFLINE (statement-recording fake
 * io, house style — no real DB):
 *   - REGISTRY: version 1 is the frozen 140-statement baseline, byte-census
 *     pinned to the audited plan numbers (49/48/38/5), idempotency shapes
 *     intact, checksums deterministic.
 *   - FRESH-EMPTY: full apply in order, ending with the version stamp.
 *   - ALREADY-MIGRATED: ZERO migration statements — two round trips only
 *     (the entire point of the runner).
 *   - DRIFT: checksum mismatch / unknown recorded version / gap in recorded
 *     versions all refuse to boot with a NAMED error before running anything.
 *   - TRANSACTIONAL DISPATCH: transactional statement-list and programmatic
 *     migrations route through begin(); nonTransactional bypass it.
 *   - FAILURE-ATOMICITY: a failing migration writes no marker row.
 *   - STORE WIRING (PgStore, fake sql): cap + memoization + zero-DDL boot on
 *     an already-migrated database.
 *
 * The REAL-DB battery (fresh DB full-apply, marker row, guarded seeds on real
 * Postgres) lives at the bottom, gated on TEST_DATABASE_URL (skipped in CI —
 * established convention).
 */
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { PgStore, DEFAULT_SCHEMA_STMT_TIMEOUT_MS } from "../store/pg";
import {
  migrationChecksum,
  runMigrations,
  SCHEMA_MIGRATIONS_DDL,
  SchemaMigrationError,
  type Migration,
  type MigrationRecord,
  type MigrationRunnerIo,
} from "../store/migrations/runner";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "../store/migrations/registry";
import { migration as baseline } from "../store/migrations/000_baseline";

/* ------------------------------------------------------------------ */
/* fake io — records every statement, replays a marker table           */
/* ------------------------------------------------------------------ */
const isVersionSelect = (q: string) => q.startsWith("SELECT version, name, checksum");
const isMarkerCreate = (q: string) => q.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations");
const isMarkerInsert = (q: string) => q.startsWith("INSERT INTO schema_migrations");

interface FakeOpts {
  records?: MigrationRecord[];
  rejectOn?: (q: string) => boolean;
}
function makeIo(opts: FakeOpts = {}) {
  const executed: string[] = [];
  const insertParams: unknown[][] = [];
  const txExecuted: string[] = [];
  let beginCalls = 0;
  const io: MigrationRunnerIo & {
    readonly executed: string[];
    readonly insertParams: unknown[][];
    readonly beginCalls: number;
    readonly txExecuted: string[];
  } = {
    get executed() {
      return executed;
    },
    get insertParams() {
      return insertParams;
    },
    get beginCalls() {
      return beginCalls;
    },
    get txExecuted() {
      return txExecuted;
    },
    exec: async (q: string, params?: unknown[]) => {
      executed.push(q);
      if (opts.rejectOn?.(q)) throw new Error(`simulated migration failure: ${q.slice(0, 60)}`);
      if (isMarkerInsert(q)) insertParams.push([...(params ?? [])]);
      if (isVersionSelect(q)) return [...(opts.records ?? [])];
      return [];
    },
    begin: async (cb) => {
      beginCalls++;
      await cb({
        unsafe: async (q: string) => {
          txExecuted.push(q);
          if (opts.rejectOn?.(q)) throw new Error(`simulated migration failure: ${q.slice(0, 60)}`);
          return [];
        },
      });
    },
  };
  return io;
}
/* reconciled view: transactional statements run inside begin, not exec */
const migrationStatementsOf = (io: ReturnType<typeof makeIo>) => [
  ...io.executed.filter((q) => !isVersionSelect(q) && !isMarkerCreate(q) && !isMarkerInsert(q)),
  ...io.txExecuted,
];
const BASELINE_STMTS = baseline.statements ?? [];
const EXPECTED_CHECKSUM = migrationChecksum(baseline);

/* ------------------------------------------------------------------ */
/* registry — the frozen baseline, census-pinned                       */
/* ------------------------------------------------------------------ */
describe("migration registry — frozen baseline shape", () => {
  test("exactly one migration: version 1 'baseline'; CURRENT_SCHEMA_VERSION agrees", () => {
    expect(MIGRATIONS.length).toBe(1);
    expect(baseline.version).toBe(1);
    expect(baseline.name).toBe("baseline");
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
  test("140 statements, census identical to the audited MIGRATION-PLAN §1.1", () => {
    expect(BASELINE_STMTS.length).toBe(140);
    expect(BASELINE_STMTS.filter((s) => s.startsWith("CREATE TABLE IF NOT EXISTS")).length).toBe(49);
    expect(BASELINE_STMTS.filter((s) => s.startsWith("ALTER TABLE")).length).toBe(48);
    expect(BASELINE_STMTS.filter((s) => s.startsWith("ALTER TABLE") && s.includes("ADD COLUMN IF NOT EXISTS")).length).toBe(47);
    expect(BASELINE_STMTS.filter((s) => s.startsWith("ALTER TABLE") && s.includes("DROP CONSTRAINT IF EXISTS")).length).toBe(1);
    expect(BASELINE_STMTS.filter((s) => s.startsWith("CREATE INDEX IF NOT EXISTS")).length).toBe(35);
    expect(BASELINE_STMTS.filter((s) => s.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS")).length).toBe(3);
    // 5 guarded one-time seed UPDATEs — data, kept verbatim, never extended.
    expect(BASELINE_STMTS.filter((s) => s.startsWith("UPDATE ")).length).toBe(5);
  });
  test("idempotency intact: IF NOT EXISTS on every DDL statement, IS NULL guard on every seed", () => {
    for (const s of BASELINE_STMTS) {
      if (s.startsWith("UPDATE ")) expect(s).toContain(" IS NULL");
      // DROP CONSTRAINT carries IF EXISTS; every other DDL carries IF NOT EXISTS
      else if (s.includes("DROP CONSTRAINT")) expect(s).toContain("IF EXISTS");
      else expect(s).toContain("IF NOT EXISTS");
    }
    expect(BASELINE_STMTS.filter((s) => s.startsWith("UPDATE ")).every((s) => s.includes(" IS NULL"))).toBe(true);
  });
  test("order preserved: users table first, retention index last (dependency order)", () => {
    expect(BASELINE_STMTS[0].startsWith("CREATE TABLE IF NOT EXISTS users")).toBe(true);
    expect(BASELINE_STMTS[139].startsWith("CREATE INDEX IF NOT EXISTS ret_outcomes_status_idx")).toBe(true);
  });
  test("dependency order invariant: every ALTER/INDEX lands after its table's CREATE (fresh-DB contract)", () => {
    // The original array had exactly two misplaced ALTERs (leads, pip_templates)
    // — moved during the baseline snapshot; see 000_baseline.ts DEVIATION note.
    const created = new Set<string>();
    const problems: string[] = [];
    BASELINE_STMTS.forEach((s, i) => {
      const cm = s.match(/^CREATE TABLE IF NOT EXISTS (\w+)/);
      if (cm) {
        created.add(cm[1]);
        for (const fk of s.matchAll(/REFERENCES (\w+)/g)) {
          if (!created.has(fk[1])) problems.push(`#${i}: CREATE ${cm[1]} FK -> ${fk[1]} not yet created`);
        }
        return;
      }
      let m = s.match(/^ALTER TABLE (\w+)/);
      if (m && !created.has(m[1])) {
        problems.push(`#${i}: ALTER ${m[1]} before CREATE`);
        return;
      }
      m = s.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+ ON (\w+)/);
      if (m && !created.has(m[1])) problems.push(`#${i}: INDEX ON ${m[1]} before CREATE`);
    });
    expect(problems).toEqual([]);
  });
  test("checksum: deterministic 64-hex; any edit to any statement changes it", () => {
    expect(EXPECTED_CHECKSUM).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationChecksum(baseline)).toBe(EXPECTED_CHECKSUM);
    const edited: Migration = { ...baseline, statements: [...BASELINE_STMTS] };
    edited.statements![0] = edited.statements![0] + " ";
    expect(migrationChecksum(edited)).not.toBe(EXPECTED_CHECKSUM);
  });
  test("version table is the only new object and carries the documented shape", () => {
    expect(SCHEMA_MIGRATIONS_DDL).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
    expect(SCHEMA_MIGRATIONS_DDL).toContain("version int PRIMARY KEY");
    expect(SCHEMA_MIGRATIONS_DDL).toContain("applied_at timestamptz NOT NULL DEFAULT now()");
    expect(SCHEMA_MIGRATIONS_DDL).toContain("checksum text NOT NULL");
  });
  test("broken registry shapes refuse loudly (sequential versions, statement-or-up)", async () => {
    const gap: Migration[] = [
      baseline,
      { version: 3, name: "skips_two", statements: ["SELECT 1"] },
    ];
    await expect(runMigrations(makeIo(), gap)).rejects.toBeInstanceOf(SchemaMigrationError);
    const empty: Migration[] = [{ version: 1, name: "nothing" }];
    await expect(runMigrations(makeIo(), empty)).rejects.toBeInstanceOf(SchemaMigrationError);
  });
});

/* ------------------------------------------------------------------ */
/* runner flows — fresh, migrated, drifted                             */
/* ------------------------------------------------------------------ */
describe("migration runner — fresh-empty DB: full apply in order, stamped", () => {
  test("marker create → version read → 140 statements → INSERT stamp", async () => {
    const io = makeIo();
    const result = await runMigrations(io, MIGRATIONS);
    expect(result.applied).toEqual([1]);
    expect(result.appliedMax).toBe(1);
    expect(io.executed[0]).toBe(SCHEMA_MIGRATIONS_DDL);
    expect(isVersionSelect(io.executed[1])).toBe(true);
    expect(migrationStatementsOf(io)).toEqual([...BASELINE_STMTS]);
    // the stamp is the LAST write and carries version + name + checksum
    expect(io.insertParams.length).toBe(1);
    expect(io.insertParams[0]).toEqual([1, "baseline", EXPECTED_CHECKSUM]);
    expect(io.executed[io.executed.length - 1]).toBe(io.executed.find(isMarkerInsert));
  });
});

describe("migration runner — already-migrated DB: ZERO DDL work (the whole point)", () => {
  test("only marker bootstrap + version read run; no baseline statement, no INSERT", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const result = await runMigrations(io, MIGRATIONS);
    expect(result.applied).toEqual([]);
    expect(result.appliedMax).toBe(1);
    expect(io.executed.length).toBe(2); // create-if-not-exists + select
    for (const stmt of BASELINE_STMTS) expect(io.executed).not.toContain(stmt);
    expect(io.insertParams.length).toBe(0);
    expect(io.beginCalls).toBe(0);
  });
  test("boot log says up to date (fail-visible freshness, plan §2.5)", async () => {
    const logs: string[] = [];
    await runMigrations(
      { ...makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] }), log: (m) => logs.push(m) },
      MIGRATIONS,
    );
    expect(logs.some((m) => m.includes("up to date"))).toBe(true);
  });
});

describe("migration runner — drift refuses to boot with a named error", () => {
  test("checksum mismatch (a merged migration was edited)", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: "0".repeat(64) }] });
    const err: unknown = await runMigrations(io, MIGRATIONS).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(SchemaMigrationError);
    expect((err as Error).name).toBe("SchemaMigrationError");
    expect((err as Error).message).toContain("checksum mismatch");
    expect((err as Error).message).toContain("1 (baseline)");
    // nothing beyond the read ran — no DDL executed against a drifted DB
    expect(io.executed.length).toBe(2);
  });
  test("recorded version the registry does not contain (DB ahead of code / lost file)", async () => {
    // a v2 row with only the v1 registry entry: position 1 has no registry migration
    const io = makeIo({
      records: [
        { version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM },
        { version: 2, name: "future", checksum: EXPECTED_CHECKSUM },
      ],
    });
    await expect(runMigrations(io, MIGRATIONS)).rejects.toThrow(/does not contain/);
    expect(io.executed.length).toBe(2);
  });
  test("gap in recorded versions", async () => {
    const two: Migration[] = [baseline, { version: 2, name: "next", statements: ["SELECT 1"] }];
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }, { version: 3, name: "next", checksum: "x" }] });
    await expect(runMigrations(io, two)).rejects.toThrow(/contiguous prefix/);
  });
});

describe("migration runner — dispatch + failure atomicity (synthetic migrations)", () => {
  const makeV2 = (over: Partial<Migration> = {}): Migration => ({
    version: 2,
    name: "add_thing",
    statements: ["CREATE TABLE IF NOT EXISTS thing (id int)"],
    ...over,
  });
  test("transactional statement-list migration routes through begin(); marker commits with it", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const result = await runMigrations(io, [baseline, makeV2()]);
    expect(result.applied).toEqual([2]);
    expect(io.beginCalls).toBe(1);
    expect(io.txExecuted).toEqual(["CREATE TABLE IF NOT EXISTS thing (id int)"]);
    expect(io.insertParams[0]).toEqual([2, "add_thing", migrationChecksum(makeV2())]);
  });
  test("nonTransactional statement-list runs per-statement autocommit (the baseline's mode)", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    await runMigrations(io, [baseline, makeV2({ nonTransactional: true })]);
    expect(io.beginCalls).toBe(0);
    expect(io.executed).toContain("CREATE TABLE IF NOT EXISTS thing (id int)");
  });
  test("programmatic up() transactional receives the transaction handle", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const v2 = makeV2({ statements: undefined, up: async (tx) => void (await tx.unsafe("ALTER TABLE thing ADD COLUMN IF NOT EXISTS y int")) });
    await runMigrations(io, [baseline, v2]);
    expect(io.beginCalls).toBe(1);
    expect(io.txExecuted).toContain("ALTER TABLE thing ADD COLUMN IF NOT EXISTS y int");
  });
  test("programmatic up() nonTransactional receives a capped-sql wrapper routed to exec", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const v2 = makeV2({ statements: undefined, nonTransactional: true, up: async (tx) => void (await tx.unsafe("SELECT 1")) });
    await runMigrations(io, [baseline, v2]);
    expect(io.beginCalls).toBe(0);
    expect(io.executed).toContain("SELECT 1");
  });
  test("a failing migration leaves NO marker row and propagates the error", async () => {
    const io = makeIo({ rejectOn: (q) => q.includes("thing") });
    const v2 = makeV2();
    const err: unknown = await runMigrations(io, [baseline, v2]).then(
      () => null,
      (e) => e,
    );
    expect((err as Error).message).toContain("simulated migration failure");
    // v1 applied and stamped; v2 did NOT stamp
    expect(io.insertParams.length).toBe(1);
    expect(io.insertParams[0][0]).toBe(1);
    // retry after the failure clears applies v2 (reset-on-failure at the runner level)
    const io2 = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const result = await runMigrations(io2, [baseline, v2]);
    expect(result.applied).toEqual([2]);
  });
});

/* ------------------------------------------------------------------ */
/* store wiring — PgStore with a fake sql (cap + memoization + skip)   */
/* ------------------------------------------------------------------ */
function makePgSql(opts: FakeOpts = {}) {
  const executed: string[] = [];
  let healthy = true;
  const sql = {
    unsafe: (q: string, _params?: unknown[]): Promise<unknown> => {
      executed.push(q);
      if (!healthy) return new Promise<never>(() => {}); // the wedge posture
      if (opts.rejectOn?.(q)) return Promise.reject(new Error("simulated DDL failure"));
      if (isVersionSelect(q)) return Promise.resolve([...(opts.records ?? [])]);
      return Promise.resolve([]);
    },
    end: async () => {},
  };
  return { sql, executed, setHealthy: (h: boolean) => (healthy = h) };
}
const makePg = (sql: unknown, capMs = DEFAULT_SCHEMA_STMT_TIMEOUT_MS) =>
  new PgStore("postgres://test:test@127.0.0.1:1/test", {
    sql: sql as { unsafe: (q: string, p?: unknown[]) => Promise<unknown>; end?: () => Promise<void> },
    schemaStmtTimeoutMs: capMs,
  });

describe("PgStore wiring — ensureSchema is now 'ensure migrations applied'", () => {
  test("already-migrated DB: ZERO migration statements on cold boot", async () => {
    const { sql, executed } = makePgSql({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const pg = makePg(sql);
    await pg.ensureSchema();
    expect(executed.length).toBe(2); // marker bootstrap + version read
    for (const stmt of BASELINE_STMTS) expect(executed).not.toContain(stmt);
    // memoized: a second call re-runs NOTHING
    await pg.ensureSchema();
    expect(executed.length).toBe(2);
    await pg.close();
  });
  test("fresh DB: the full 140 apply in order through the capped executor, then memoize", async () => {
    const { sql, executed } = makePgSql();
    const pg = makePg(sql);
    await pg.ensureSchema();
    expect(executed[0]).toBe(SCHEMA_MIGRATIONS_DDL);
    expect(executed[1].startsWith("SELECT version, name, checksum")).toBe(true);
    const migrationStmts = executed.slice(2).filter((q) => !isMarkerInsert(q));
    expect(migrationStmts).toEqual([...BASELINE_STMTS]);
    expect(executed[executed.length - 1]).toContain("INSERT INTO schema_migrations");
    await pg.ensureSchema();
    expect(executed.length).toBe(2 + 140 + 1); // unchanged by the memoized second call
    await pg.close();
  });
});

/* ------------------------------------------------------------------ */
/* REAL-DB battery — skipped unless TEST_DATABASE_URL (CI convention)  */
/* ------------------------------------------------------------------ */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!TEST_DATABASE_URL)("migration runner — real Postgres (fresh + migrated + drift + guarded seeds)", () => {
  const url = TEST_DATABASE_URL!;
  test("fresh marker drop → full apply → stamped; second run → zero work; drift refuses", async () => {
    const sql = postgres(url, { max: 1, ...(url.includes("sslmode=") ? {} : { ssl: "require" }) });
    try {
      // 1. FRESH-EMPTY PATH: remove ONLY the runner's own marker, then run.
      await sql.unsafe(`DROP TABLE IF EXISTS schema_migrations`);
      let count = 0;
      const io = {
        exec: async (q: string, params?: unknown[]) => {
          count++;
          return sql.unsafe(q, params as never);
        },
        log: () => {},
      };
      const result = await runMigrations(io, MIGRATIONS);
      expect(result.applied).toEqual([1]);
      expect(count).toBe(143); // create + select + 140 statements + insert
      const rows = (await sql`SELECT version, name, checksum FROM schema_migrations`) as MigrationRecord[];
      expect(rows.length).toBe(1);
      expect(rows[0].version).toBe(1);
      expect(rows[0].name).toBe("baseline");
      expect(rows[0].checksum).toBe(EXPECTED_CHECKSUM);
      // 2. ALREADY-MIGRATED PATH: zero migration statements.
      count = 0;
      const result2 = await runMigrations(io, MIGRATIONS);
      expect(result2.applied).toEqual([]);
      expect(count).toBe(2);
      // 3. GUARDED SEEDS: still guarded — the users seed UPDATE matched 0 rows
      //    on the fresh apply (no rep named in the guard exists here).
      const seeded = (await sql`SELECT count(*)::int AS n FROM users WHERE name = 'Dan McKillop' AND call_start_date = '2026-09-28'`) as { n: number }[];
      expect(seeded[0].n).toBe(0);
      // 4. DRIFT PATH: a tampered checksum refuses to boot.
      await sql`UPDATE schema_migrations SET checksum = '0'`;
      await expect(runMigrations(io, MIGRATIONS)).rejects.toBeInstanceOf(SchemaMigrationError);
      // restore the marker so other suites see a healthy stamped DB
      await sql`UPDATE schema_migrations SET checksum = ${EXPECTED_CHECKSUM} WHERE version = 1`;
      // 5. PGSTORE END-TO-END on the stamped DB: boots with zero migration DDL
      //    (observable as: the second store's ensureSchema only re-reads).
      const store = new PgStore(url, { profile: "test" });
      try {
        await store.ensureSchema();
        const stamped = (await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 1 AND name = 'baseline'`) as { n: number }[];
        expect(stamped[0].n).toBe(1);
      } finally {
        await store.close();
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
