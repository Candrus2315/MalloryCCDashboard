/**
 * PG NOTICE ROUTING (2026-10-30) — root cause documented in
 * docs/root-cause-parse-utilcmd-boot-notice-2026-10-30.md.
 *
 * postgres.js 3.4.9's DEFAULT notice handler is `console.log(parseError(x))`
 * (node_modules/postgres/cjs/src/connection.js:916–918, the `onnotice ? … :
 * console.log(…)` fallback), so every Postgres NOTICE arrives in the boot log
 * as a bare multi-line object that reads like an unhandled error — SQLSTATE
 * code, file and routine fields included.
 *
 * The one object that appears on EVERY healthy boot comes from the migration
 * runner's marker-table bootstrap: `CREATE TABLE IF NOT EXISTS schema_migrations …`
 * (migrations/runner.ts SCHEMA_MIGRATIONS_DDL, executed at runner.ts io.exec
 * before the version read). On an already-stamped database Postgres parse-
 * analysis (parse_utilcmd.c transformCreateStmt) emits a NOTICE — SQLSTATE
 * 42P07 "relation \"schema_migrations\" already exists, skipping" — and then
 * SKIPS the create and continues. Severity NOTICE is not an error: boot
 * completes, the version read follows, the runner logs "up to date".
 *
 * This module classifies the expected idempotent-DDL notice family so the
 * store's postgres client can route them to ONE compact line instead of the
 * raw object, and lets every other notice print exactly as postgres.js's
 * default did. It decides NOTHING about schema: no statement, the frozen
 * baseline, and migration semantics are untouched.
 *
 * The family (all severity NOTICE, message ending "already exists, skipping"):
 *   42P07 duplicate_table  — "relation \"x\" already exists, skipping"
 *                            (tables AND indexes — index_create reports 42P07)
 *   42701 duplicate_column — "column \"c\" of relation \"r\" already exists, skipping"
 *   42P06 duplicate_schema — "schema \"s\" already exists, skipping"
 *   42710 duplicate_object — "constraint … already exists, skipping"
 * Anything else (different severity, different code, different message) is
 * NOT classified expected and passes through untouched.
 */

/** Structural subset of postgres.js's Notice (types/index.d.ts: `{ [field: string]: string }`). */
export interface PgNotice {
  severity?: string;
  code?: string;
  message?: string;
}

/**
 * SQLSTATEs Postgres uses for the IF NOT EXISTS "already exists, skipping"
 * NOTICE family. Kept explicit (not a wildcard) so an unexpected notice code
 * can never be silently classified as benign.
 */
const DUPLICATE_OBJECT_CODES: ReadonlySet<string> = new Set(["42P07", "42701", "42P06", "42710"]);

/** True for the benign idempotent-DDL notices the frozen baseline/marker bootstrap can emit. */
export function isExpectedIdempotentDdlNotice(n: PgNotice): boolean {
  return (
    n.severity === "NOTICE" &&
    typeof n.code === "string" &&
    DUPLICATE_OBJECT_CODES.has(n.code) &&
    typeof n.message === "string" &&
    n.message.endsWith("already exists, skipping")
  );
}

/** One compact line, e.g. `[pg notice 42P07] relation "schema_migrations" already exists, skipping`. */
export function formatPgNoticeLine(n: PgNotice): string {
  return `[pg notice ${n.code ?? "?"}] ${n.message ?? "(no message)"}`;
}
