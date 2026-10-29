# MIGRATION PLAN — pg.ts startup DDL (PLAN ONLY — no code changed)

**Status: PLAN. This document is an audit + proposal. Nothing in it has been implemented; `src/server/store/pg.ts` is untouched by the batch that adds this file. Any implementation requires its own delegated task, its own PR, and the full gate suite.**

## 1. Current state — the cold-start DDL sweep

`PgStore` carries its entire schema as one ordered array:

- **Location:** `src/server/store/pg.ts`, `const DDL: string[]` — **lines 111–964 (854 lines, 140 statements)** as of main `8ae9af9`.
- **Execution:** `ensureSchema()` memoizes `runSchemaDdl()` (`schemaReady` promise). The sweep runs **one statement at a time** via `this.sql.unsafe(stmt)`, each raced by a client-side JS-timer cap `DEFAULT_SCHEMA_STMT_TIMEOUT_MS = 90_000` (90s), inside a pool whose sessions carry a server-side `statement_timeout` of 300s and `connect_timeout` 30s. On ANY failure (cap or rejection) the memoized promise is reset so the **next `ensureSchema()` retries from the top** — safe because every statement is idempotent.
- **Trigger:** `ensureSchema()` is awaited by **162** store methods, so the first store call after process boot pays the whole sweep; it is then memoized for the process lifetime. The running-guard, boot-seed, and ingest-wedge hardening (reliability PR #112) sit around this sweep.

### 1.1 Statement census (audited 2026-10-29, script-extracted, comment-safe)

| Class | Count | Form | Idempotency |
|---|---|---|---|
| CREATE TABLE | **49** | `CREATE TABLE IF NOT EXISTS …` | yes (no-op when present) |
| ALTER TABLE | **48** | 47 × `ADD COLUMN IF NOT EXISTS` + 1 × `DROP CONSTRAINT IF EXISTS` | yes |
| CREATE INDEX | **38** | 35 normal + 3 UNIQUE, all `IF NOT EXISTS` | yes |
| Data UPDATE (seed/backfill) | **5** | guarded one-time fixes: Dan McKillop `call_start_date` + 4 commission-tier seeds, each `… AND <col> IS NULL` | yes (guarded) |
| **Total** | **140** | | |

Table coverage (49): core identity/reporting (users, contacts, opportunities, calls, appointments, booking_attributions, leads, rep_goals, team_goals, monthly_goals, weekly_report_notes, availability_rules, blocked_times, daily_priorities, integration_connections, manual_overrides, sync_runs, app_settings, lead_count_adjustments, sync_watermarks, sync_checkpoints), harvest (harvest_conversations, harvest_progress, harvest_calls, harvest_runs), PIPs (pips, pip_evidence_snapshots, pip_checkins, pip_templates, pip_event_log), commissions (commission_weekly, commission_cycles, commission_adjustments), availability feed (availability_slots, availability_dates, availability_sync_runs, availability_discrepancies, availability_calendars, availability_appointment_types), retention (internal_clients, client_match_links, data_match_exceptions, retention_attempts, retention_appointment_outcomes, retention_cancellations, retention_no_shows, retention_transfers, retention_owner_history, ret_scorecards).

**Ordering rule today:** array order is dependency order — a table before its indexes, base tables before the `ALTER`s that extend them, and feature blocks grouped chronologically as the product grew (core → availability feed → harvest → PIPs → commissions → retention). New statements are appended; the array is an append-only log of everything the schema ever needed.

### 1.2 Cold-start cost / risk

**Cost.** The sweep is 140 sequential network round trips (TLS, managed Postgres). Ops history records **~40–65s** for the full sweep on the managed host (code comment at pg.ts:1213 says "the 65s ensureSchema sweep"; probes measured 40–60s). Every store method awaits it, so boot-to-first-paint and boot-to-first-sync-tick pay this once per process.

**Risks, honestly stated:**

1. **Boot wedge (historical).** Before the reliability hardening, one hung DDL statement (an `ACCESS EXCLUSIVE` lock blocker, a stalled TLS write) wedged the *whole process* — every store method awaits `schemaReady`, so SSR loaders, sync ticks, and `/health` all hung (the 10/8–9 and 10/20–21 wedges). The per-statement 90s cap + reset-on-failure + running-guard now contain this, but the fundamental shape — 140 uncached round-trips on every boot, all-or-nothing — remains.
2. **No version tracking.** The database cannot say what schema it holds; the code can only re-assert (`IF NOT EXISTS`). There is no record of which statements ever failed, no schema version to inspect in `/status`, and no way to tell "this DB predates feature X" from code.
3. **Unbounded growth.** Each feature appends statements; the sweep grows monotonically forever. At 140 it is acceptable; the mechanism gives no reason it would stay acceptable.
4. **Category mixing.** Five data-mutating `UPDATE` seeds live inside an array named DDL. They are guarded and safe, but a schema migration runner would treat data backfill as a different animal (row counts, runtime, reversibility) than `CREATE TABLE`.
5. **Comment drift.** pg.ts:1213 says the sweep is "~204 individual DDL statements" — the actual count is **140** (comment-only drift; left as-is in this docs-only batch, worth fixing in the next code touch).
6. **No checksums.** Any accidental edit to an existing statement is silent — idempotency makes wrong-but-parseable statements pass unnoticed.

## 2. Proposed versioned migration architecture (PROPOSED — not implemented)

### 2.1 Runner design

- New directory `src/server/store/migrations/` with ordered files `NNN_name.ts`, each exporting:

  ```ts
  export const migration = {
    version: 7,
    name: "add_retention_transfers",
    // true only for CREATE INDEX CONCURRENTLY-style statements (cannot run in a txn)
    nonTransactional: false,
    up: (sql: Sql) => Promise<void>,
  };
  ```

- A `schema_migrations` table: `version int PRIMARY KEY, name text, applied_at timestamptz, checksum text`.
- `ensureSchema()` **keeps its name and signature** and becomes "ensure migrations applied": read current version → apply all migrations with version > current, in order → record each with its checksum. All **162 existing call sites stay untouched**; the Store interface does not change.
- Regular migrations run inside a transaction (`sql.begin`), so a failure leaves no half-state and the version row commits atomically with the DDL. `nonTransactional: true` migrations run standalone (only for operations Postgres cannot run in a txn, e.g. `CREATE INDEX CONCURRENTLY`).

### 2.2 Baselining the existing production DB as version N

1. Snapshot today's 140-statement array **verbatim** as `000_baseline.ts` (version 1). It is already idempotent, so running it against the existing production DB is a no-op by construction.
2. First boot with the runner: production's `schema_migrations` is empty → runner applies `000_baseline.ts` (all no-ops) and stamps version 1. Existing databases and fresh databases converge on the same recorded state with zero manual steps and zero data risk. (Alternative considered — a manual `INSERT` into `schema_migrations` — rejected: it adds a human step to a boot that can stamp itself safely.)
3. **From that commit on, `000_baseline.ts` is FROZEN.** New schema changes are new numbered migration files only. Editing a merged migration is forbidden (checksum mismatch = refuse to boot with a named error, forcing explicit human action).

### 2.3 Safe ordering rules

- Migrations are strictly append-only and monotonically numbered; ordering follows version order, matching the current array's dependency discipline (table before its index; base table before ALTER).
- **Additive-first policy:** new tables / nullable columns / indexes are normal migrations. Anything destructive (DROP COLUMN/CONSTRAINT, type change, `NOT NULL` on populated data) requires the **expand → backfill → contract** pattern across ≥ 2 migrations, and the contract step needs owner sign-off in the PR description.
- Large backfills are **not** boot migrations: boot must stay bounded. Row-touching backfills run as explicit out-of-band jobs (the sync-jobs pathway), with the migration only adding the column.
- The five existing guarded UPDATE seeds migrate out of the schema path into a `seeds` migration (or app-level guarded seed step) at the runner cutover — they are data, not schema, and must not re-run as part of future version bumps.

### 2.4 Rollback / failure behavior

- **Forward-only.** No automatic down-migrations. This matches the team's audit discipline: a bad migration is corrected by a new forward migration, never by rewriting history. (Automatic `down` scripts rot; we do not ship them.)
- **On failure mid-migration:** the transaction rolls back, `schema_migrations` is not advanced, boot fails loudly with the migration's version + name + error. The existing reset-on-failure semantics retry on the next `ensureSchema()`; a persistently failing migration blocks boot **by design** — same containment as today's behavior, but now the failure names a version instead of an anonymous SQL string.
- The 90s per-statement cap and server `statement_timeout` are retained unchanged. A migration that legitimately needs longer is split or moved out-of-band — never given a private timeout raise.
- **Operator recovery:** re-running is always safe (idempotent baseline, transactional forward migrations). The only manual intervention ever required is deciding what the *next forward* migration should be.

### 2.5 Where the version is tracked

`schema_migrations` in the same Postgres database is the single source of truth (no filesystem state, no env var). The runner logs the applied version at boot; a small optional follow-up surfaces the current schema version + last migration name/time on `/status` via the existing `buildHealthPayload` (read-only, non-blocking).

### 2.6 Rollout sequence (for a future implementation task)

1. **PR 1:** add runner + `schema_migrations` + `000_baseline.ts` (byte-identical statement set, same order). Behavior change: none — same 140 idempotent statements run on boot; they are now recorded.
2. **PR 2 (observation period):** nothing. Let several boots/publishes run; verify `schema_migrations` stamps correctly on prod, dev, and test stores.
3. **PR 3+:** new schema work arrives as migration files only; the baseline array is frozen.
4. **Much later (optional):** produce a trimmed "fresh-install" baseline for new environments. Explicitly NOT while any environment predates the runner.

### 2.7 Verification expectations for that future task

- Boot on an empty database (fresh install path).
- Boot against a production snapshot predating the runner (baseline-stamp path) — statement-level row/shape parity before/after.
- Checksum-mismatch refusal test; retry-after-failure test (existing reset-on-failure semantics).
- Store-parity: the full MemoryStore/PgStore mirror batteries (commission-flow, harvest, retention-*, ingest-batch, read-cache) plus typecheck + full `bun test` + `bun run build` gates.

## 3. Explicit non-goals of this document

- **No schema changes** and **no destructive operations** are proposed; the baseline is today's schema exactly.
- **No `pg.ts` rewrite.** The runner wraps the existing array; call sites, `ensureSchema` semantics, and the Store interface do not change in the proposal.
- No switch to an external migration tool — the runner is ~100 lines and dependency-free; the current stack (bun + postgres.js) already supports everything described.
