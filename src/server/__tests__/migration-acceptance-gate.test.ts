/**
 * MIGRATION-ACCEPTANCE GATE — regression tests for the checksum-acceptance
 * class (owner mandate, 2026-10-30; durable record:
 * docs/migrations-acceptance/2026-10-30-migration-1-baseline-acceptance.md).
 *
 * Pins, with the LITERAL checksum pair the incident produced:
 *   (a) an intermediate/foreign checksum stamp refuses with BOTH checksums
 *       named, and the store degrades to the in-memory fallback (honest);
 *   (b) a non-serve context cannot stamp/execute migrations on the business
 *       database — the gate refuses with a named error BEFORE any statement;
 *   (c) the acceptance record exists and records both checksums;
 *   (d) fresh-empty and already-migrated zero-work behaviors hold under the
 *       gate (the real-Postgres battery in migration-runner.test.ts covers the
 *       real-DB variants; here the zero-work posture is pinned on the seam).
 *
 * Entirely offline: the PgStore sql seam injects a recording fake — no real
 * connection, never mind the business database.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { PgStore } from "../store/pg";
import { probePg, type ProbeOptions } from "../store";
import {
  clearManagedMigrationContextForTests,
  isBusinessDatabaseUrl,
  managedMigrationSource,
  markManagedMigrationContext,
} from "../store/migration-gate";
import { MIGRATIONS } from "../store/migrations/registry";
import { migration as baseline } from "../store/migrations/000_baseline";
import {
  migrationChecksum,
  MigrationGateError,
  runMigrations,
  SchemaMigrationError,
  SCHEMA_MIGRATIONS_DDL,
  type MigrationRunnerIo,
} from "../store/migrations/runner";

/* The literal pair from the 2026-10-29 incident / 2026-10-30 acceptance. */
const ACCEPTED_OLD_CHECKSUM = "752992ad3fe2903ba716bf52e80bcc5f9c6d0602b104e0eaa0c46446973fb954";
const ACCEPTED_NEW_CHECKSUM = "94ceeb1fa88edf10f73afb6397676be57a35b2addc5d37f3f5a3f6f1e615a87b";
const GATE_CAP = { grantedBy: "migration-acceptance-gate tests (offline seams)" };

/* ------------------------------------------------------------------ */
/* Recording sql seam — same shape as the boot-seed-wedge fake         */
/* ------------------------------------------------------------------ */
interface FakeSql {
  executed: string[];
  unsafe: (stmt: string, params?: unknown[]) => Promise<unknown>;
  end?: (opts?: unknown) => Promise<unknown>;
}
function makeFakeSql(opts?: { records?: Array<{ version: number; name: string; checksum: string }> }): FakeSql & { sql: { unsafe: (s: string) => Promise<unknown>; end?: (o?: unknown) => Promise<unknown> } } {
  const executed: string[] = [];
  const isVersionSelect = (q: string) => q.includes("SELECT version, name, checksum");
  const sql = {
    unsafe: (stmt: string, _params?: unknown[]): Promise<unknown> => {
      executed.push(stmt);
      if (isVersionSelect(stmt)) return Promise.resolve([...(opts?.records ?? [])]);
      return Promise.resolve([]);
    },
    end: async () => {},
  };
  return { executed, sql, unsafe: sql.unsafe, end: sql.end };
}

const makeIo = (records?: Array<{ version: number; name: string; checksum: string }>): MigrationRunnerIo => {
  const executed: string[] = [];
  const isVersionSelect = (q: string) => q.includes("SELECT version, name, checksum");
  return {
    get executed() {
      return executed;
    },
    exec: async (q: string) => {
      executed.push(q);
      if (isVersionSelect(q)) return [...(records ?? [])];
      return [];
    },
    begin: async (cb) => {
      await cb({ unsafe: async () => [] });
    },
    log: () => {},
  };
};

const ACCEPTANCE_DOC = join(import.meta.dir, "../../../docs/migrations-acceptance/2026-10-30-migration-1-baseline-acceptance.md");

/* ------------------------------------------------------------------ */
/* (9a) the accepted checksum pair — refuse + fallback                 */
/* ------------------------------------------------------------------ */
describe("migration acceptance — the literal incident pair", () => {
  test("the registry ships the ACCEPTED checksum (94ceeb1f…), not the pre-merge snapshot", () => {
    expect(migrationChecksum(baseline)).toBe(ACCEPTED_NEW_CHECKSUM);
    expect(migrationChecksum(baseline)).not.toBe(ACCEPTED_OLD_CHECKSUM);
  });

  test("a database stamped with the OLD checksum refuses with BOTH named", async () => {
    const io = makeIo([{ version: 1, name: "baseline", checksum: ACCEPTED_OLD_CHECKSUM }]);
    const err: unknown = await runMigrations(io, MIGRATIONS, GATE_CAP).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(SchemaMigrationError);
    expect((err as Error).message).toContain(ACCEPTED_OLD_CHECKSUM);
    expect((err as Error).message).toContain(ACCEPTED_NEW_CHECKSUM);
    // the marker bootstrap + version read ran; NOTHING beyond them
    expect(io.executed.length).toBe(2);
    expect(io.executed[0]).toBe(SCHEMA_MIGRATIONS_DDL);
  });

  test("the store falls back HONESTLY: probePg logs the refusal naming both checksums", async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://gate-fallback:sim@127.0.0.1:1/gate-fallback";
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const fake = makeFakeSql({ records: [{ version: 1, name: "baseline", checksum: ACCEPTED_OLD_CHECKSUM }] });
      const opts: ProbeOptions = {
        storeFactory: () =>
          new PgStore(process.env.DATABASE_URL!, {
            sql: fake.sql as never,
            // serve-simulated: the gate passes; the CHECKSUM drift is what fires
            migrationCapability: { grantedBy: "gate test (serve-simulated)" },
          }),
      };
      const store = await probePg(opts);
      expect(store).toBeNull(); // in-memory fallback
      const line = warns.join("\n");
      expect(line).toContain("in-memory store");
      expect(line).toContain("checksum mismatch");
      expect(line).toContain(ACCEPTED_OLD_CHECKSUM);
      expect(line).toContain(ACCEPTED_NEW_CHECKSUM);
      expect(fake.executed.length).toBe(2); // bootstrap + read, nothing else
    } finally {
      console.warn = origWarn;
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

/* ------------------------------------------------------------------ */
/* (9b) the gate — non-serve contexts cannot stamp the business DB     */
/* ------------------------------------------------------------------ */
describe("migration acceptance gate — business database reachable only from managed serve", () => {
  const BUSINESS_SIM = "postgres://owner:sim@db.example:5432/mallory-business";

  test("runMigrations without a stated capability refuses with NOTHING executed", async () => {
    const io = makeIo();
    const err: unknown = await runMigrations(io as never, MIGRATIONS, undefined as never).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MigrationGateError);
    expect((err as Error).name).toBe("MigrationGateError");
    expect(io.executed.length).toBe(0); // not even the marker bootstrap
  });

  test("an empty grantedBy is refused, nothing executed", async () => {
    const io = makeIo();
    await expect(runMigrations(io, MIGRATIONS, { grantedBy: "   " })).rejects.toBeInstanceOf(MigrationGateError);
    expect(io.executed.length).toBe(0);
  });

  test("PgStore against the BUSINESS URL outside serve refuses BEFORE any statement", async () => {
    clearManagedMigrationContextForTests();
    expect(managedMigrationSource()).toBeNull();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = BUSINESS_SIM;
    try {
      const fake = makeFakeSql();
      const pg = new PgStore(BUSINESS_SIM, { sql: fake.sql as never });
      const err: unknown = await pg.ensureSchema().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(MigrationGateError);
      expect((err as Error).name).toBe("MigrationGateError");
      expect((err as Error).message).toContain("BUSINESS database");
      expect(fake.executed.length).toBe(0);
      await pg.close();
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test("the SAME construction inside the managed serve context runs (zero work on a migrated DB)", async () => {
    clearManagedMigrationContextForTests();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = BUSINESS_SIM;
    markManagedMigrationContext("gate test (managed serve posture)");
    try {
      const fake = makeFakeSql({ records: [{ version: 1, name: "baseline", checksum: ACCEPTED_NEW_CHECKSUM }] });
      const pg = new PgStore(BUSINESS_SIM, { sql: fake.sql as never });
      await pg.ensureSchema(); // must NOT throw
      expect(fake.executed.length).toBe(2); // marker bootstrap + version read, zero migration statements
      await pg.ensureSchema(); // memoized
      expect(fake.executed.length).toBe(2);
      await pg.close();
    } finally {
      clearManagedMigrationContextForTests();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test("an explicit capability grant runs the migration (documented seam for disposable DBs)", async () => {
    clearManagedMigrationContextForTests();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = BUSINESS_SIM;
    try {
      const fake = makeFakeSql({ records: [] }); // fresh empty DB
      const pg = new PgStore(BUSINESS_SIM, {
        sql: fake.sql as never,
        migrationCapability: { grantedBy: "explicit local-db grant (gate test)" },
      });
      await pg.ensureSchema();
      // 2 (bootstrap+read) + 140 statements + 1 stamp insert
      expect(fake.executed.length).toBe(2 + 140 + 1);
      await pg.close();
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test("a NON-business URL needs no grant (test/scratch posture unchanged)", async () => {
    clearManagedMigrationContextForTests();
    const fake = makeFakeSql({ records: [{ version: 1, name: "baseline", checksum: ACCEPTED_NEW_CHECKSUM }] });
    const pg = new PgStore("postgres://test:test@127.0.0.1:1/any-local-db", { sql: fake.sql as never });
    await pg.ensureSchema();
    expect(fake.executed.length).toBe(2);
    await pg.close();
  });

  test("business-URL identity is exact: the owner secret matches, other URLs do not", () => {
    const prev = process.env.DATABASE_URL;
    const prevMixed = process.env.Database_URL;
    try {
      delete process.env.Database_URL;
      process.env.DATABASE_URL = BUSINESS_SIM;
      expect(isBusinessDatabaseUrl(BUSINESS_SIM)).toBe(true);
      expect(isBusinessDatabaseUrl("postgres://test:test@127.0.0.1:1/other")).toBe(false);
      delete process.env.DATABASE_URL;
      expect(isBusinessDatabaseUrl(BUSINESS_SIM)).toBe(false); // no env → not business
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
      if (prevMixed === undefined) delete process.env.Database_URL;
      else process.env.Database_URL = prevMixed;
    }
  });
});

/* ------------------------------------------------------------------ */
/* (9c) the acceptance record                                          */
/* ------------------------------------------------------------------ */
describe("migration acceptance — the durable record", () => {
  test("the acceptance record exists and pins both checksums, applied_at, approval", () => {
    const doc = readFileSync(ACCEPTANCE_DOC, "utf8");
    expect(doc).toContain(ACCEPTED_OLD_CHECKSUM);
    expect(doc).toContain(ACCEPTED_NEW_CHECKSUM);
    expect(doc).toContain("2026-10-29T20:24:37Z"); // applied_at preserved
    expect(doc).toContain("2026-10-30"); // approval date
    expect(doc).toContain("Option B");
    expect(doc).toContain("WHERE version = 1 AND checksum =");
  });
});

/* ------------------------------------------------------------------ */
/* (9d) fresh-empty and zero-work postures under the gate              */
/* ------------------------------------------------------------------ */
describe("migration acceptance gate — fresh and migrated postures", () => {
  test("fresh DB under an explicit grant applies exactly the registry, then stamps", async () => {
    const fake = makeFakeSql();
    const pg = new PgStore("postgres://fresh:db@127.0.0.1:1/fresh", {
      sql: fake.sql as never,
      migrationCapability: { grantedBy: "fresh-db posture test" },
    });
    await pg.ensureSchema();
    const stmts = fake.executed.slice(2).filter((q) => !q.includes("INSERT INTO schema_migrations"));
    expect(stmts).toEqual([...(baseline.statements ?? [])]);
    expect(fake.executed[fake.executed.length - 1]).toContain("INSERT INTO schema_migrations");
    await pg.close();
  });

  test("already-migrated DB under the managed context runs ZERO migration statements", async () => {
    markManagedMigrationContext("zero-work posture test");
    try {
      const fake = makeFakeSql({ records: [{ version: 1, name: "baseline", checksum: ACCEPTED_NEW_CHECKSUM }] });
      const pg = new PgStore("postgres://any:any@127.0.0.1:1/any", { sql: fake.sql as never });
      await pg.ensureSchema();
      expect(fake.executed).toEqual([SCHEMA_MIGRATIONS_DDL, expect.stringContaining("SELECT version, name, checksum")]);
      await pg.close();
    } finally {
      clearManagedMigrationContextForTests();
    }
  });
});

/* keep the postgres import referenced for parity with the other store suites */
void postgres;
