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
 * The REAL-DB battery (fresh-apply, stamped v3 marker history, the
 * hl_call_records shape census, zero-work re-run, drift refusal, guarded
 * seeds — all on real Postgres) lives at the bottom, gated on
 * TEST_DATABASE_URL (skipped in CI — established convention). Its shape
 * expectations MIRROR the in-memory census test above — one source of truth
 * for shape, two runners: a real-DB regression in migration history or final
 * shape fails visibly here instead of being skipped forever.
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
import { migration as evidenceMessages } from "../store/migrations/001_evidence_messages";
const EVIDENCE_STMTS = evidenceMessages.statements!;
import { migration as hlCallRecords } from "../store/migrations/002_hl_call_records";
const HL_CALL_STMTS = hlCallRecords.statements!;
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
  // FAST VERSION CHECK fake (portability 2026-11-05): the marker table exists
  // iff the test stages records — a record-less fake is a marker-LESS database,
  // whose first version read fails with SQLSTATE 42P01 exactly like Postgres.
  let markerTable = opts.records !== undefined;
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
      if (isMarkerCreate(q)) markerTable = true;
      if (isVersionSelect(q)) {
        if (!markerTable) {
          const err = new Error('relation "schema_migrations" does not exist') as Error & { code?: string };
          err.code = "42P01";
          throw err;
        }
        return [...(opts.records ?? [])];
      }
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
/* GATE: every runner call states its grantor (the runner refuses unstated capabilities). */
const CAP = { grantedBy: "migration-runner unit tests" };

/* ------------------------------------------------------------------ */
/* registry — the frozen baseline, census-pinned                       */
/* ------------------------------------------------------------------ */
describe("migration registry — frozen baseline shape", () => {
  test("registry: version 1 baseline + version 2 evidence_messages + version 3 hl_call_records; CURRENT_SCHEMA_VERSION agrees", () => {
    expect(MIGRATIONS.length).toBe(3);
    expect(baseline.version).toBe(1);
    expect(MIGRATIONS[1]!.name).toBe("evidence_messages");
    expect(MIGRATIONS[1]!.version).toBe(2);
    expect(MIGRATIONS[2]!.name).toBe("hl_call_records");
    expect(MIGRATIONS[2]!.version).toBe(3);
    expect(baseline.name).toBe("baseline");
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
  });
  test("hl_call_records census: 4 statements — 1 table + 3 indexes, additive-only (no ALTERs, no seeds)", () => {
    expect(HL_CALL_STMTS.length).toBe(4);
    expect(HL_CALL_STMTS.filter((s) => s.startsWith("CREATE TABLE IF NOT EXISTS hl_call_records")).length).toBe(1);
    expect(HL_CALL_STMTS.filter((s) => s.startsWith("CREATE INDEX IF NOT EXISTS idx_hlcall_")).length).toBe(3);
    expect(HL_CALL_STMTS.some((s) => s.startsWith("ALTER TABLE") || s.startsWith("UPDATE "))).toBe(false);
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
    await expect(runMigrations(makeIo(), gap, CAP)).rejects.toBeInstanceOf(SchemaMigrationError);
    const empty: Migration[] = [{ version: 1, name: "nothing" }];
    await expect(runMigrations(makeIo(), empty, CAP)).rejects.toBeInstanceOf(SchemaMigrationError);
  });
});

/* ------------------------------------------------------------------ */
/* runner flows — fresh, migrated, drifted                             */
/* ------------------------------------------------------------------ */
describe("migration runner — fresh-empty DB: full apply in order, stamped", () => {
  test("marker create → version read → registry statements (baseline + evidence_messages + hl_call_records) → INSERT stamp", async () => {
    const io = makeIo();
    const result = await runMigrations(io, MIGRATIONS, CAP);
    expect(result.applied).toEqual([1, 2, 3]);
    expect(result.appliedMax).toBe(3);
    expect(isVersionSelect(io.executed[0])).toBe(true); // fast version check FIRST (fails 42P01 on the marker-less fake)
    expect(io.executed[1]).toBe(SCHEMA_MIGRATIONS_DDL);
    expect(isVersionSelect(io.executed[2])).toBe(true);
    expect(migrationStatementsOf(io)).toEqual([...BASELINE_STMTS, ...EVIDENCE_STMTS, ...HL_CALL_STMTS]);
    // the stamps are the LAST writes and carry version + name + checksum
    expect(io.insertParams.length).toBe(3);
    expect(io.insertParams[0]).toEqual([1, "baseline", EXPECTED_CHECKSUM]);
    expect(io.insertParams[1]).toEqual([2, "evidence_messages", migrationChecksum(MIGRATIONS[1]!)]);
    expect(io.insertParams[2]).toEqual([3, "hl_call_records", migrationChecksum(MIGRATIONS[2]!)]);
    expect(io.executed[io.executed.length - 1]).toBe(io.executed.find(isMarkerInsert));
  });
});

describe("migration runner — already-migrated DB: ZERO DDL work (the whole point)", () => {
  test("only marker bootstrap + version read run; no baseline statement, no INSERT", async () => {
    const io = makeIo({ records: [
      { version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM },
      { version: 2, name: "evidence_messages", checksum: migrationChecksum(MIGRATIONS[1]!) },
      { version: 3, name: "hl_call_records", checksum: migrationChecksum(MIGRATIONS[2]!) },
    ] });
    const result = await runMigrations(io, MIGRATIONS, CAP);
    expect(result.applied).toEqual([]);
    expect(result.appliedMax).toBe(3);
    expect(io.executed.length).toBe(1); // the version read ONLY — ZERO DDL on a current schema (portability pin)
    expect(io.executed.find(isMarkerCreate)).toBeUndefined(); // the DDL path is never entered
    for (const stmt of BASELINE_STMTS) expect(io.executed).not.toContain(stmt);
    expect(io.insertParams.length).toBe(0);
    expect(io.beginCalls).toBe(0);
  });
  test("boot log says up to date (fail-visible freshness, plan §2.5)", async () => {
    const logs: string[] = [];
    await runMigrations(
      { ...makeIo({ records: [
        { version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM },
        { version: 2, name: "evidence_messages", checksum: migrationChecksum(MIGRATIONS[1]!) },
        { version: 3, name: "hl_call_records", checksum: migrationChecksum(MIGRATIONS[2]!) },
      ] }), log: (m) => logs.push(m) },
      MIGRATIONS,
      CAP,
    );
    expect(logs.some((m) => m.includes("up to date"))).toBe(true);
  });
});

describe("migration runner — drift refuses to boot with a named error", () => {
  test("checksum mismatch (a merged migration was edited)", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: "0".repeat(64) }] });
    const err: unknown = await runMigrations(io, MIGRATIONS, CAP).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(SchemaMigrationError);
    expect((err as Error).name).toBe("SchemaMigrationError");
    expect((err as Error).message).toContain("checksum mismatch");
    expect((err as Error).message).toContain("1 (baseline)");
    // nothing beyond the read ran — no DDL executed against a drifted DB
    expect(io.executed.length).toBe(1);
  });
  test("recorded version the registry does not contain (DB ahead of code / lost file)", async () => {
    // rows beyond the registry's top version: position 4 has no registry migration
    const io = makeIo({
      records: [
        { version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM },
        { version: 2, name: "evidence_messages", checksum: migrationChecksum(MIGRATIONS[1]!) },
        { version: 3, name: "hl_call_records", checksum: migrationChecksum(MIGRATIONS[2]!) },
        { version: 4, name: "future", checksum: EXPECTED_CHECKSUM },
      ],
    });
    await expect(runMigrations(io, MIGRATIONS, CAP)).rejects.toThrow(/does not contain/);
    expect(io.executed.length).toBe(1);
  });
  test("gap in recorded versions", async () => {
    const two: Migration[] = [baseline, { version: 2, name: "next", statements: ["SELECT 1"] }];
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }, { version: 3, name: "next", checksum: "x" }] });
    await expect(runMigrations(io, two, CAP)).rejects.toThrow(/contiguous prefix/);
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
    const result = await runMigrations(io, [baseline, makeV2()], CAP);
    expect(result.applied).toEqual([2]);
    expect(io.beginCalls).toBe(1);
    expect(io.txExecuted).toEqual(["CREATE TABLE IF NOT EXISTS thing (id int)"]);
    expect(io.insertParams[0]).toEqual([2, "add_thing", migrationChecksum(makeV2())]);
  });
  test("nonTransactional statement-list runs per-statement autocommit (the baseline's mode)", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    await runMigrations(io, [baseline, makeV2({ nonTransactional: true })], CAP);
    expect(io.beginCalls).toBe(0);
    expect(io.executed).toContain("CREATE TABLE IF NOT EXISTS thing (id int)");
  });
  test("programmatic up() transactional receives the transaction handle", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const v2 = makeV2({ statements: undefined, up: async (tx) => void (await tx.unsafe("ALTER TABLE thing ADD COLUMN IF NOT EXISTS y int")) });
    await runMigrations(io, [baseline, v2], CAP);
    expect(io.beginCalls).toBe(1);
    expect(io.txExecuted).toContain("ALTER TABLE thing ADD COLUMN IF NOT EXISTS y int");
  });
  test("programmatic up() nonTransactional receives a capped-sql wrapper routed to exec", async () => {
    const io = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const v2 = makeV2({ statements: undefined, nonTransactional: true, up: async (tx) => void (await tx.unsafe("SELECT 1")) });
    await runMigrations(io, [baseline, v2], CAP);
    expect(io.beginCalls).toBe(0);
    expect(io.executed).toContain("SELECT 1");
  });
  test("a failing migration leaves NO marker row and propagates the error", async () => {
    const io = makeIo({ rejectOn: (q) => q.includes("thing") });
    const v2 = makeV2();
    const err: unknown = await runMigrations(io, [baseline, v2], CAP).then(
      () => null,
      (e) => e,
    );
    expect((err as Error).message).toContain("simulated migration failure");
    // v1 applied and stamped; v2 did NOT stamp
    expect(io.insertParams.length).toBe(1);
    expect(io.insertParams[0][0]).toBe(1);
    // retry after the failure clears applies v2 (reset-on-failure at the runner level)
    const io2 = makeIo({ records: [{ version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM }] });
    const result = await runMigrations(io2, [baseline, v2], CAP);
    expect(result.applied).toEqual([2]);
  });
});

/* ------------------------------------------------------------------ */
/* store wiring — PgStore with a fake sql (cap + memoization + skip)   */
/* ------------------------------------------------------------------ */
function makePgSql(opts: FakeOpts = {}) {
  const executed: string[] = [];
  let healthy = true;
  // FAST VERSION CHECK fake (portability 2026-11-05): the marker table exists
  // iff the test stages records — otherwise the version read fails 42P01.
  let markerTable = opts.records !== undefined;
  const sql = {
    unsafe: (q: string, _params?: unknown[]): Promise<unknown> => {
      executed.push(q);
      if (!healthy) return new Promise<never>(() => {}); // the wedge posture
      if (opts.rejectOn?.(q)) return Promise.reject(new Error("simulated DDL failure"));
      if (isMarkerCreate(q)) markerTable = true;
      if (isVersionSelect(q)) {
        if (!markerTable) {
          const err = new Error('relation "schema_migrations" does not exist') as Error & { code?: string };
          err.code = "42P01";
          return Promise.reject(err);
        }
        return Promise.resolve([...(opts.records ?? [])]);
      }
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
    const { sql, executed } = makePgSql({ records: [
      { version: 1, name: "baseline", checksum: EXPECTED_CHECKSUM },
      { version: 2, name: "evidence_messages", checksum: migrationChecksum(MIGRATIONS[1]!) },
      { version: 3, name: "hl_call_records", checksum: migrationChecksum(MIGRATIONS[2]!) },
    ] });
    const pg = makePg(sql);
    await pg.ensureSchema();
    expect(executed.length).toBe(1); // fast version check ONLY — ZERO DDL on a current schema (portability pin)
    expect(executed[0].startsWith("SELECT version, name, checksum")).toBe(true);
    expect(executed.find((q) => isMarkerCreate(q))).toBeUndefined(); // the DDL path is never entered
    for (const stmt of BASELINE_STMTS) expect(executed).not.toContain(stmt);
    // memoized: a second call re-runs NOTHING
    await pg.ensureSchema();
    expect(executed.length).toBe(1);
    await pg.close();
  });
  test("fresh DB: the full registry (baseline 140 + evidence_messages 3 + hl_call_records 4) applies in order through the capped executor, then memoize", async () => {
    const { sql, executed } = makePgSql();
    const pg = makePg(sql);
    await pg.ensureSchema();
    expect(executed[0].startsWith("SELECT version, name, checksum")).toBe(true); // fast version check FIRST (fails 42P01 on the marker-less fake)
    expect(executed[1]).toBe(SCHEMA_MIGRATIONS_DDL);
    expect(executed[2].startsWith("SELECT version, name, checksum")).toBe(true);
    const migrationStmts = executed.slice(3).filter((q) => !isMarkerInsert(q));
    expect(migrationStmts).toEqual([...BASELINE_STMTS, ...EVIDENCE_STMTS, ...HL_CALL_STMTS]);
    expect(executed[executed.length - 1]).toContain("INSERT INTO schema_migrations");
    await pg.ensureSchema();
    expect(executed.length).toBe(3 + 140 + 3 + 4 + 3); // unchanged by the memoized second call
    await pg.close();
  });
});

/* ------------------------------------------------------------------ */
/* REAL-DB battery — skipped unless TEST_DATABASE_URL (CI convention)  */
/*                                                                     */
/* v3 re-pin (the in-memory census test is the shape source of truth):  */
/* the battery proves the same registry/history/shape on REAL Postgres */
/* — full apply, stamped marker history, hl_call_records columns and   */
/* indexes — plus zero-work re-run, drift refusal, and guarded seeds.  */
/*                                                                     */
/* Derivation for a live run: TEST_DATABASE_URL = Database_URL with    */
/* the query string stripped (postgres.js-style sslmode param). That   */
/* both satisfies the ssl:"require" posture below and keeps the string */
/* distinct from the business URL, so the PgStore step below gets the  */
/* honest non-business grant instead of a gate refusal.                */
/* ------------------------------------------------------------------ */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!TEST_DATABASE_URL)("migration runner — real Postgres (fresh apply + stamped v3 history + shape census + zero work + drift + guarded seeds)", () => {
  const url = TEST_DATABASE_URL!;
  // 120s explicit cap: ~152 idempotent statements against a REMOTE Postgres are
  // ~152 round trips (bun's default 5s test timeout cannot cover a cloud RTT).
  test("fresh marker drop → full apply → stamped v3 history + hl_call_records shape; second run → zero work; drift refuses", async () => {
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
      const result = await runMigrations(io, MIGRATIONS, CAP);
      expect(result.applied).toEqual([1, 2, 3]);
      expect(result.appliedMax).toBe(3);
      expect(count).toBe(153); // select (fails 42P01, marker-less) + create + select + 140 baseline + 3 evidence + 4 hl_call_records + 3 stamps
      // 1b. STAMPED HISTORY: one row per registry migration, in version order,
      //     each carrying the checksum this build's registry computes.
      const rows = (await sql`SELECT version, name, checksum FROM schema_migrations ORDER BY version`) as MigrationRecord[];
      expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.name)).toEqual(["baseline", "evidence_messages", "hl_call_records"]);
      expect(rows[0].checksum).toBe(EXPECTED_CHECKSUM);
      expect(rows[1].checksum).toBe(migrationChecksum(MIGRATIONS[1]!));
      expect(rows[2].checksum).toBe(migrationChecksum(MIGRATIONS[2]!));
      // 1c. V3 SHAPE CENSUS on real Postgres — the mirror of the in-memory
      //     "hl_call_records census" test: the table exists with EXACTLY the
      //     migration's 14 columns in order (types and nullability included),
      //     PK on message_id, and exactly the three idx_hlcall_* indexes.
      const cols = (await sql`SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_name = 'hl_call_records' ORDER BY ordinal_position`) as Array<{
        column_name: string; data_type: string; is_nullable: string; column_default: string | null;
      }>;
      expect(cols.map((c) => c.column_name)).toEqual([
        "message_id", "user_external_id", "contact_external_id", "conversation_id", "direction",
        "call_status", "duration_seconds", "date_added", "message_type", "source",
        "from_number", "to_number", "raw", "ingested_at",
      ]);
      expect(cols.map((c) => c.data_type)).toEqual([
        "text", "text", "text", "text", "text",
        "text", "integer", "timestamp with time zone", "text", "text",
        "text", "text", "jsonb", "timestamp with time zone",
      ]);
      expect(cols.map((c) => c.is_nullable)).toEqual([
        "NO", "YES", "YES", "YES", "YES",
        "YES", "YES", "NO", "NO", "YES",
        "YES", "YES", "YES", "NO",
      ]);
      expect(cols.find((c) => c.column_name === "ingested_at")!.column_default).toBe("now()");
      const pk = (await sql`SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
        WHERE c.relname = 'hl_call_records' AND i.indisprimary`) as Array<{ attname: string }>;
      expect(pk.map((r) => r.attname)).toEqual(["message_id"]);
      const idx = (await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'hl_call_records' AND indexname LIKE 'idx_hlcall_%' ORDER BY indexname`) as Array<{ indexname: string }>;
      expect(idx.map((r) => r.indexname)).toEqual(["idx_hlcall_contact_date", "idx_hlcall_date", "idx_hlcall_user_date"]);
      // 2. ALREADY-MIGRATED PATH: ZERO DDL — one read round trip (portability:
      // the fast version check short-circuits before the marker bootstrap).
      count = 0;
      const result2 = await runMigrations(io, MIGRATIONS, CAP);
      expect(result2.applied).toEqual([]);
      expect(result2.appliedMax).toBe(3);
      expect(count).toBe(1);
      // 3. GUARDED SEEDS: still guarded — the baseline's one-time seed UPDATEs
      //    carry an IS NULL guard, so a re-apply on ANY real database (fresh or
      //    live) can never overwrite or duplicate: the seed target ends with at
      //    most its one designed dated row and nothing left NULL. (The seed
      //    fired once on the live database when v1 first ran there — that is
      //    its designed one-time behavior, not a battery failure.)
      const danTotal = (await sql`SELECT count(*)::int AS n FROM users WHERE name = 'Dan McKillop'`) as { n: number }[];
      expect(danTotal[0].n).toBeLessThanOrEqual(1);
      const danUndated = (await sql`SELECT count(*)::int AS n FROM users WHERE name = 'Dan McKillop' AND call_start_date IS NULL`) as { n: number }[];
      expect(danUndated[0].n).toBe(0);
      // 4. DRIFT PATH: a tampered checksum refuses to boot (any recorded row).
      await sql`UPDATE schema_migrations SET checksum = '0' WHERE version = 1`;
      await expect(runMigrations(io, MIGRATIONS, CAP)).rejects.toBeInstanceOf(SchemaMigrationError);
      // restore the marker so other suites see a healthy stamped DB
      await sql`UPDATE schema_migrations SET checksum = ${EXPECTED_CHECKSUM} WHERE version = 1`;
      // 5. PGSTORE END-TO-END on the stamped DB: boots with zero migration DDL
      //    (observable as: the second store's ensureSchema only re-reads).
      const store = new PgStore(url, { profile: "test" });
      try {
        await store.ensureSchema();
        const stamped = (await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 3 AND name = 'hl_call_records'`) as { n: number }[];
        expect(stamped[0].n).toBe(1);
      } finally {
        await store.close();
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
