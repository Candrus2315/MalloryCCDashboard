# Root cause — the benign `parse_utilcmd.c` boot-log error object

**Date:** 2026-10-30 · **Status:** identified + contained (notice routing; no schema/semantics change) · **Repro:** `scratch/repro-parse-utilcmd-notice.ts`

## Symptom

Every healthy app boot prints a bare object that reads like an unhandled error into the serve log, between the `[schema] migrations authorized by: …` and `[schema] database at schema version 1 — up to date` lines:

```js
{
  severity_local: "NOTICE",
  severity: "NOTICE",
  code: "42P07",
  message: 'relation "schema_migrations" already exists, skipping',
  file: "parse_utilcmd.c",
  line: "208",          // 207 on the local PG 16.15 — same routine
  routine: "transformCreateStmt",
}
```

It is **not an error**. `severity: "NOTICE"` — Postgres parse-analyzed a `CREATE TABLE IF NOT EXISTS` against a relation that already exists, **skipped the create, and continued normally**. Boot completes, the version read follows, the runner logs "up to date". The migration-1 acceptance record (2026-10-30, all six checks PASS) observed exactly this and was unaffected.

## Exact trigger — statement + code path

1. **Boot** → `serve.ts` constructs the store → first `ensureSchema()` → `PgStore.runSchemaMigrations()` (`src/server/store/pg.ts:421`) → `runMigrations(...)` (`src/server/store/pg.ts:428`).
2. **The runner's marker-table bootstrap** — `SCHEMA_MIGRATIONS_DDL` (`src/server/store/migrations/runner.ts:111–116`):

   ```sql
   CREATE TABLE IF NOT EXISTS schema_migrations (…)
   ```

   executed unconditionally at `runner.ts:196` (`await io.exec(SCHEMA_MIGRATIONS_DDL)`) on **every** boot, before the version SELECT — the runner's own bootstrap, not part of the frozen baseline.
3. On any already-stamped database (prod is at v1) Postgres evaluates `IF NOT EXISTS` during parse analysis in `parse_utilcmd.c` / `transformCreateStmt` and answers with **NOTICE 42P07** ("already exists, skipping"). Nothing throws; the statement is a no-op.
4. **Where it's logged, and why it looks like an error object:** the store's postgres client (`src/server/store/pg.ts:357`, `postgres(databaseUrl, {…})`) set **no `onnotice` handler**, so postgres.js 3.4.9's built-in default ran: `console.log(parseError(x))` (`node_modules/postgres/cjs/src/connection.js:916–918`, the `onnotice ? onnotice(...) : console.log(...)` fallback in `NoticeResponse`). The driver applies `parseError()` to the NoticeResponse payload — which is why SQLSTATE `code`, `file`, and `routine` ride along and the result resembles an error dump. **No app code swallows anything**: there was never a catch involved; the driver just prints every server notice raw.

## Historical breadth (why the log used to have thousands)

`/tmp/serve.log` holds ~4,490 such objects. They come in two eras:

- **Pre-runner cold-start sweep** (before PR #124): the old boot DDL sweep re-asserted all ~140 idempotent statements every boot on a populated DB → notices for every `CREATE TABLE IF NOT EXISTS` (`42P07` via `parse_utilcmd.c`), every `CREATE INDEX IF NOT EXISTS` (`42P07` via `index.c index_create`), and every `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (`42701 duplicate_column` via `tablecmds.c check_for_column_name_collision`). Five of those column notices fire **even on a fresh database** — the frozen baseline creates `pips.template_id`, `pips.template_version`, `pips.checkin_cadence_days`, `commission_weekly.hole_audit`, `commission_weekly.hole_bonus_capped` in their CREATE TABLEs and then re-ADDs them IF NOT EXISTS for older-deploy compatibility. Self-redundant by design, harmless.
- **Post-runner boots (today, every boot): exactly ONE object** — the marker bootstrap above. That is the object this note resolves.

## The contained fix (routing only — zero schema impact)

`src/server/store/pg-notices.ts` classifies the expected idempotent-DDL notice family — `severity === "NOTICE"` **and** SQLSTATE in {`42P07` duplicate_table, `42701` duplicate_column, `42P06` duplicate_schema, `42710` duplicate_object} **and** message ends `already exists, skipping` — and `pg.ts` wires `onnotice` to print those as ONE compact line:

```
[pg notice 42P07] relation "schema_migrations" already exists, skipping
```

Every other notice (different severity, code, or message — e.g. `does not exist, skipping`) still prints exactly as the driver's default did. **No schema statement, the frozen baseline, checksums, gate semantics, or migration behavior changed** — this is a log-routing change at the client layer only. Tests: `src/server/__tests__/pg-notices.test.ts` (13 tests: the exact live objects, the whole sanctioned code family, and explicit never-benign cases for WARNING severity, unknown codes, and near-miss messages).

## Verification

Repro against a disposable local database (`scratch/repro-parse-utilcmd-notice.ts`, Phase B = a second store on an already-stamped DB, the every-boot shape):

- **Before:** the 9-line object above, byte-for-byte the live shape.
- **After:** `[pg notice 42P07] relation "schema_migrations" already exists, skipping` — one line, then `[schema] database at schema version 1 — up to date (zero migration statements run)`.

Full gates at the fix commit: suite pass/0 fail, typecheck 0, build 0 (counts recorded in the PR).
