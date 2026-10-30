/**
 * ROOT-CAUSE REPRO — the benign parse_utilcmd.c boot-log error object (2026-10-30).
 *
 * Reproduces the exact live sequence: a PgStore constructed against a database
 * that ALREADY has schema_migrations (every healthy prod boot) runs the runner's
 * marker bootstrap `CREATE TABLE IF NOT EXISTS schema_migrations (...)` and
 * Postgres answers with a NOTICE (SQLSTATE 42P07, parse_utilcmd.c transformCreateStmt).
 * postgres.js 3.4.9 has NO onnotice handler wired in pg.ts, so its DEFAULT handler
 * console.log()s the raw notice object — the "error object" in /tmp/serve.log.
 *
 * Phase A: fresh database → baseline applies → NO notice (nothing pre-exists).
 * Phase B: same database, second store → marker bootstrap trips → notice prints.
 * Phase C (after the fix): same again → the notice is routed/classified instead.
 *
 * Scratch probe — disposable local database ONLY (migration gate: localhost is
 * auto-granted as a non-business URL). Not imported by the app.
 */
import { PgStore } from "../src/server/store/pg.ts";

const URL_ = "postgres://postgres@127.0.0.1:5432/repro_notice?sslmode=disable";

const phase = process.argv[2] ?? "all";

if (phase === "a" || phase === "all") {
  console.log("=== PHASE A: FRESH database (baseline v0→v1 applies; expect NO notices) ===");
  const a = new PgStore(URL_);
  await a.ensureSchema();
  await a.close();
  console.log("=== PHASE A done (baseline applied, schema_migrations stamped) ===");
}

if (phase === "b" || phase === "all") {
  console.log("=== PHASE B: SECOND store on the SAME database (expect the notice object) ===");
  const b = new PgStore(URL_);
  await b.ensureSchema();
  await b.close();
  console.log("=== PHASE B done (marker bootstrap tripped IF NOT EXISTS) ===");
}
process.exit(0);
