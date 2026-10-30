# MIGRATION-1 BASELINE ACCEPTANCE — OPTION B (proof-based checksum correction)

**Date:** 2026-10-30 (UTC) · **Operator:** agent-lead executing via agent-engineer (Option B) · **Approval:** owner, 2026-10-30
**Operation class:** one-time, guarded, single-row data correction — NOT a migration, NOT DDL, NOT a code change.
**Durable record:** this file is permanent. The original checksum value is preserved here and in the row's history; nothing was deleted.

## What was corrected

The production `schema_migrations` row for version 1 recorded the checksum of a **pre-merge development snapshot** of
the baseline, written at 2026-10-29T20:24:37Z — 4m36s **before the first commit** (`a2afd26`, 20:29:13Z) of the
`feat/migration-runner` branch and 21 minutes before the squash-merge (`07a34ca`, 20:46:01Z). The executing process ran
uncommitted working-tree code. The only content difference between that snapshot and the shipped baseline is the
documented PR #124 deviation: two misplaced `ALTER` statements relocated after their `CREATE TABLE`s — byte-identical
statement text, sorted multiset identical, order changed.

## The two checksums

| | value |
|---|---|
| **Old (database recorded — pre-merge dev snapshot, `a2afd26` bytes)** | `752992ad3fe2903ba716bf52e80bcc5f9c6d0602b104e0eaa0c46446973fb954` |
| **New (shipped baseline, main `07a34ca`)** | `94ceeb1fa88edf10f73afb6397676be57a35b2addc5d37f3f5a3f6f1e615a87b` |

Both reproduced to the last hex digit by the audit's `hashcheck.ts` (commit `a2afd26` and main `07a34ca` over the
identical runner recipe). Reference: `shared/migration1-audit.md` + `shared/migration1-audit-evidence/`.

## The evidence this acceptance stands on (all read-only, pre-write)

- **Live-schema fingerprint: complete match, zero drift** — 49/49 tables (none extra beyond `schema_migrations`),
  47/47 columns, 38/38 indexes (incl. the multi-line unique partial index, definition-verified), the DROP CONSTRAINT
  target absent (correct post-drop no-op state), all 5 guarded seed guards matching 0 rows. Re-run immediately before
  the write: identical verdict.
- **140/140 baseline statements are the guarded idempotent forms they shipped as** — worst case (a full re-run) is
  zero destructive or duplicate DDL on prod.
- **Delta = exactly the two documented relocations** — ordered diff 56 lines all inside the two moves; sorted
  multiset over all 140 statements EMPTY; targeted byte diffs of both moved statements byte-identical.
- **Provenance** — the stamped value never represented shipped history (written by pre-merge dev code before the first
  commit existed); correcting it restores the intended invariant (the DB records what shipped code computes).

## The one prod write (executed 2026-10-30 ~00:24 UTC)

```sql
UPDATE schema_migrations SET checksum = '94ceeb1fa88edf10f73afb6397676be57a35b2addc5d37f3f5a3f6f1e615a87b'
WHERE version = 1 AND checksum = '752992ad3fe2903ba716bf52e80bcc5f9c6d0602b104e0eaa0c46446973fb954';
```

- Executed inside a transaction; **row-count asserted = 1** before commit (any other count would have rolled back).
- `applied_at` does NOT appear in the SET clause — **preserved: `2026-10-29T20:24:37Z`** (read back unchanged).
- Result: exactly **1 row updated**; committed; post-update read-back: version 1, name `baseline`, new checksum,
  applied_at unchanged, table still exactly **1 row**. (xmin advanced 2551892 → 2552502 — the normal MVCC artifact of
  any UPDATE; the tuple is rewritten, the data is as stated above.)
- No other statement of any kind was issued against production: no DDL, no other rows, no deletes.

## Post-correction reconnection (verified, no restart)

The serve retry loop re-attempted its Postgres probe on the next cycle and verified the corrected checksum:
`[schema] database at schema version 1 — up to date (zero migration statements run)` — ZERO migration statements
executed (no `applying migration` lines; the only notices were the runner's bootstrap `IF NOT EXISTS` "already exists,
skipping" notices, the same class the pre-runner sweep produced). The app left the in-memory fallback: `/health`
returned all providers `ok` with fresh syncs, the scheduler resumed (`+466 attributions, sheets synced +201 leads`),
and the Today page served real DB figures (WTD 65 / 79 goal; Bookings Today 16; frozen target semantics intact).
Evidence: `shared/migration1-audit-evidence/serve-log-reconnect-excerpt.txt` + `accept-output.txt`.

## Approval & audit references

- **Owner approval:** 2026-10-30 — Option B (proof-based checksum acceptance) explicitly approved.
- **Audit report:** `shared/migration1-audit.md` (verdict, timeline, diff proof, fingerprint, idempotency, options).
- **Evidence directory:** `shared/migration1-audit-evidence/` (probes, hash reproductions, statement dumps, column
  fingerprint, serve-log reconnect excerpt, the write's before/after output).
- **Recurrence guard (shipped with this acceptance):** the migration-acceptance gate
  (`src/server/store/migration-gate.ts` + the capability contract in `migrations/runner.ts`) makes runMigrations
  against the business database reachable ONLY from the managed serve context — a dev boot, scratch probe, test
  harness, or page-data loader constructing PgStore against `Database_URL` now fails VISIBLY with a named
  `MigrationGateError` instead of silently stamping. Regression tests pin the checksum pair and the gate; see
  `src/server/__tests__/migration-acceptance-gate.test.ts`.
