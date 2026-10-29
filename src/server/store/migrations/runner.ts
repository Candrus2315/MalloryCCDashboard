/**
 * MIGRATION RUNNER — versioned schema management (docs/MIGRATION-PLAN.md §2).
 *
 * Replaces the pre-runner cold-start DDL sweep: instead of re-asserting all
 * 140 idempotent statements on every boot, the database records which
 * migration version is applied in `schema_migrations` and subsequent boots
 * run ZERO migration statements (only the marker table bootstrap + one
 * version SELECT — two round trips instead of ~140).
 *
 * Design (following the plan, simplest-safe options chosen where it offered
 * alternatives):
 *   - Forward-only. No down-migrations (§2.4): a bad migration is corrected
 *     by a new forward migration, never by rewriting history.
 *   - `schema_migrations (version int PK, name text, applied_at timestamptz,
 *     checksum text)` in the SAME database is the single source of truth
 *     (§2.5) — no filesystem state, no env var.
 *   - Regular migrations run inside a transaction via `begin` (§2.1) so the
 *     version row commits atomically with the DDL; statement-list
 *     migrations flagged `nonTransactional` (the baseline) run per-statement
 *     in autocommit so the lock profile against a LIVE populated database
 *     matches the pre-runner sweep — no lock accumulates across 140
 *     statements. Postgres cannot run in a txn what it cannot run in a txn
 *     (e.g. CREATE INDEX CONCURRENTLY) — that is the only other sanctioned
 *     use of nonTransactional.
 *   - Checksums (sha256 over the migration's canonical content) are recorded
 *     at stamp time and verified on EVERY boot (§1.2 risk 6 / §2.2 step 3):
 *     editing a merged migration = checksum mismatch = refuse to boot with a
 *     named error. No checksums are guessed — the recorded row is compared
 *     against the registry the running code ships with.
 *   - Drift is fail-visible (§2.4): a recorded version that is missing from
 *     the registry, a gap in recorded versions, or a checksum mismatch all
 *     throw SchemaMigrationError naming version + name before ANY statement
 *     of the offending migration would run. The pre-runner reset-on-failure
 *     semantics in pg.ts still apply (next ensureSchema retries; a
 *     persistently failing migration blocks boot BY DESIGN).
 *   - The version table itself is the ONLY new schema object this runner
 *     introduces; it is created `IF NOT EXISTS` and carries no app data.
 *   - Pure orchestration: all execution flows through injected `exec` /
 *     `begin` I/O (pg.ts supplies the capped executor + real pool), so the
 *     whole flow is unit-testable offline with a statement-recording fake.
 */
import { createHash } from "node:crypto";

/** A migration needs only a statement list (normal) or a programmatic up(). */
export interface Migration {
  /** 1-based, strictly sequential — registry position MUST equal version. */
  version: number;
  name: string;
  /**
   * Statement-list migration: ordered SQL text, executed in registry order.
   * `nonTransactional: false` (default) wraps the whole list in one
   * transaction; `true` runs each statement in autocommit (the frozen
   * baseline's mode — live-DB lock profile of the pre-runner sweep).
   */
  statements?: readonly string[];
  /**
   * Programmatic migration. Receives the transaction handle (or the raw
   * capped sql when `nonTransactional`). Only for logic a statement list
   * cannot express; prefer `statements`.
   */
  up?: (tx: MigrationSql) => Promise<void>;
  /** true only for what Postgres cannot run inside a transaction. */
  nonTransactional?: boolean;
}

/** The minimal sql surface a migration may use. */
export interface MigrationSql {
  unsafe: (query: string, params?: unknown[]) => PromiseLike<unknown>;
}

/** Row shape of schema_migrations as read back. */
export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
}

/** Injected I/O — pg.ts supplies capped execution; tests supply a fake. */
export interface MigrationRunnerIo {
  /** Execute one statement, bounded by the caller's per-statement cap. */
  exec: (query: string, params?: unknown[]) => Promise<unknown>;
  /** Run cb inside a transaction (postgres.js sql.begin). */
  begin?: (cb: (tx: MigrationSql) => Promise<void>) => Promise<void>;
  /** Boot log sink (default console.log). */
  log?: (msg: string) => void;
}

/** The version marker — the runner's ONLY schema object (plan §2.1/§2.5). */
export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version int PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    checksum text NOT NULL
  )`;

const SELECT_VERSIONS = `SELECT version, name, checksum FROM schema_migrations ORDER BY version`;

/** Named boot-refusal error for any registry/database disagreement. */
export class SchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMigrationError";
  }
}

/**
 * sha256 over a migration's canonical content: version + name + statements
 * (joined NUL-separated) for statement migrations; the up() source text for
 * programmatic ones (documented caveat: programmatic migrations that might
 * be transpiled differently per build should carry an explicit stable
 * checksum instead — none exist today).
 */
export function migrationChecksum(m: Migration): string {
  const hash = createHash("sha256");
  hash.update(`${m.version}\n${m.name}\n`);
  if (m.statements) {
    for (const s of m.statements) {
      hash.update(s);
      hash.update("\n\u0000");
    }
  } else if (m.up) {
    hash.update(m.up.toString());
  } else {
    throw new Error(`migration ${m.version} (${m.name}): neither statements nor up()`);
  }
  return hash.digest("hex");
}

export interface MigrationRunResult {
  /** Highest version recorded after the run. */
  appliedMax: number;
  /** Versions applied during THIS call ([] when already current). */
  applied: number[];
}

/**
 * Ensure the database is at the registry's current version. Reads the
 * marker, verifies every recorded migration (presence, order, checksum),
 * then applies pending migrations in order, recording each.
 */
export async function runMigrations(
  io: MigrationRunnerIo,
  migrations: readonly Migration[],
  done?: (result: MigrationRunResult) => void,
): Promise<MigrationRunResult> {
  const log = io.log ?? ((msg: string) => console.log(`[schema] ${msg}`));
  // Registry invariants — strictly sequential 1..N, statement-or-up present.
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i];
    if (m.version !== i + 1) {
      throw new SchemaMigrationError(
        `migration registry is not sequential: position ${i} holds version ${m.version} (${m.name}), expected ${i + 1}`,
      );
    }
    if (!m.statements?.length && !m.up) {
      throw new SchemaMigrationError(`migration ${m.version} (${m.name}): neither statements nor up()`);
    }
  }
  await io.exec(SCHEMA_MIGRATIONS_DDL);
  const rows = (await io.exec(SELECT_VERSIONS)) as MigrationRecord[];
  for (let i = 0; i < rows.length; i++) {
    const rec = rows[i];
    const m = migrations[i];
    if (!m) {
      throw new SchemaMigrationError(
        `schema_migrations records version ${rec.version} (${rec.name}) which this build's registry does not contain — the database is ahead of the code (or a migration file was lost). Refusing to boot.`,
      );
    }
    if (rec.version !== m.version) {
      throw new SchemaMigrationError(
        `schema_migrations is not a contiguous prefix: record ${i} is version ${rec.version}, registry position ${i} is ${m.version} (${m.name}). Refusing to boot.`,
      );
    }
    const expected = migrationChecksum(m);
    if (rec.checksum !== expected) {
      throw new SchemaMigrationError(
        `checksum mismatch for migration ${m.version} (${m.name}): database recorded ${rec.checksum}, code ships ${expected}. A merged migration was edited — forbidden (MIGRATION-PLAN §2.2). Restore the file or resolve explicitly.`,
      );
    }
  }
  const applied: number[] = [];
  const pending = migrations.slice(rows.length);
  for (const m of pending) {
    const t0 = Date.now();
    log(`applying migration ${m.version} (${m.name})…`);
    if (m.statements?.length) {
      if (m.nonTransactional) {
        // Per-statement autocommit: the baseline's live-DB lock profile.
        for (const stmt of m.statements) await io.exec(stmt);
      } else {
        if (!io.begin) {
          throw new SchemaMigrationError(`migration ${m.version} (${m.name}) is transactional but the io supplies no begin`);
        }
        const statements = m.statements;
        await io.begin(async (tx) => {
          for (const stmt of statements) await tx.unsafe(stmt);
        });
      }
    } else if (m.up) {
      if (m.nonTransactional) {
        await m.up({ unsafe: (q, params) => io.exec(q, params) });
      } else {
        if (!io.begin) {
          throw new SchemaMigrationError(`migration ${m.version} (${m.name}) is transactional but the io supplies no begin`);
        }
        const up = m.up;
        await io.begin(async (tx) => {
          await up(tx);
        });
      }
    }
    await io.exec(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [
      m.version,
      m.name,
      migrationChecksum(m),
    ]);
    applied.push(m.version);
    log(`applied migration ${m.version} (${m.name}) in ${Date.now() - t0}ms`);
  }
  const result: MigrationRunResult = {
    appliedMax: rows.length + applied.length,
    applied,
  };
  if (!applied.length) {
    log(`database at schema version ${result.appliedMax} — up to date (zero migration statements run)`);
  } else {
    log(`database stamped at schema version ${result.appliedMax}`);
  }
  done?.(result);
  return result;
}
