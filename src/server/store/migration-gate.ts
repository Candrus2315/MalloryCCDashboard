/**
 * MIGRATION-ACCEPTANCE GATE — context detection (2026-10-30).
 *
 * Companion to the capability contract in migrations/runner.ts. Resolves WHO
 * may run migrations against a given database URL:
 *
 *   1. an explicit grant (documented seam for local disposable databases),
 *   2. the managed serve context — serve.ts marks this process at boot, BEFORE
 *      the port binds, so no request can construct a store before the mark,
 *   3. any URL that is not the business database (TEST_DATABASE_URL battery,
 *      scratch probes, unit-test fakes) — migrations are routine there.
 *
 * A PgStore constructed against the BUSINESS database (the owner's Database_URL
 * secret) outside the managed serve context is REFUSED with a named
 * MigrationGateError — fail-visible, nothing silently skipped, drift checks
 * untouched. This closes the hole that stamped production with pre-merge dev
 * code on 2026-10-29 (an out-of-band process constructing PgStore against
 * Database_URL); the durable record is
 * docs/migrations-acceptance/2026-10-30-migration-1-baseline-acceptance.md.
 *
 * The managed mark lives on globalThis (same pattern as auth.ts's
 * markProdServeRuntime) so the flag set by serve.ts (src copy) is visible to
 * the bundled store code inside dist/server/server.js — one process, one flag.
 */
import { MigrationGateError, type MigrationRunCapability } from "./migrations/runner";

/** Named boot/store refusal for a gated migration attempt. Re-exported for callers that import from here. */
export { MigrationGateError };

const MANAGED_KEY = "__MALLORY_MANAGED_MIGRATIONS__";

/**
 * Mark THIS process as the managed serve context. Called by serve.ts before
 * Bun.serve binds (same discipline as markProdServeRuntime: set before any
 * request can reach the store). `source` is recorded verbatim into the
 * capability's grantedBy for boot-log auditability.
 */
export function markManagedMigrationContext(source: string): void {
  (globalThis as unknown as Record<string, unknown>)[MANAGED_KEY] = source;
}

/** The managed-serve mark of this process, or null outside serve.ts. */
export function managedMigrationSource(): string | null {
  const v = (globalThis as unknown as Record<string, unknown>)[MANAGED_KEY];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** TEST SEAM: remove the mark so a test can exercise the non-serve posture. Never call from serve code. */
export function clearManagedMigrationContextForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[MANAGED_KEY];
}

/**
 * Business-database identity: the exact URL the owner's secret names in this
 * process. The store layer passes the env-resolved URL verbatim, so an exact
 * trimmed comparison is the same check the store already performs; a URL that
 * does not name the business database is a test/scratch/local database.
 */
export function isBusinessDatabaseUrl(databaseUrl: string): boolean {
  const candidates = [process.env.DATABASE_URL, process.env.Database_URL]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  const target = databaseUrl.trim();
  return candidates.some((c) => c === target);
}

/**
 * Resolve the migration capability for a store construction. Throws
 * MigrationGateError when the only reading of the situation is "a non-serve
 * process is about to migrate the business database".
 */
export function resolveMigrationCapability(databaseUrl: string, explicit?: MigrationRunCapability): MigrationRunCapability {
  if (explicit && typeof explicit.grantedBy === "string" && explicit.grantedBy.trim().length > 0) return explicit;
  const managed = managedMigrationSource();
  if (managed) return { grantedBy: `managed serve context (${managed})` };
  if (!isBusinessDatabaseUrl(databaseUrl)) {
    return { grantedBy: "non-business database URL (test/scratch/local)" };
  }
  throw new MigrationGateError(
    "migration-acceptance gate: this PgStore was constructed against the BUSINESS database (Database_URL) outside the " +
      "managed serve context — running migrations is refused (dev boot, scratch probe, test harness, or page-data " +
      "loader must never stamp the business DB). Import the store only through serve.ts, or pass an explicit " +
      "{ migrationCapability: { grantedBy } } for a disposable local database. See " +
      "docs/migrations-acceptance/2026-10-30-migration-1-baseline-acceptance.md.",
  );
}
