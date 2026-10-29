/**
 * MIGRATION REGISTRY — the ordered, append-only list of schema migrations
 * (docs/MIGRATION-PLAN.md §2.1/§2.3).
 *
 * Rules, enforced here and by the runner:
 *   - Files are named NNN_name.ts; the registry imports them in order and
 *     the runner requires position i to hold version i+1.
 *   - APPEND-ONLY + FROZEN HISTORY: never edit a merged migration file
 *     (checksum verification refuses to boot on mismatch), never renumber,
 *     never reorder. New schema work is a new numbered file only.
 *   - Additive-first policy (§2.3): new tables / nullable columns / indexes
 *     are normal migrations; anything destructive needs the
 *     expand → backfill → contract pattern across ≥ 2 migrations and owner
 *     sign-off in the PR description.
 *   - Large row-touching backfills are NOT boot migrations (§2.3) — boot
 *     must stay bounded; the migration only adds the column, the backfill
 *     runs as an out-of-band job.
 *   - New data seeds never go in a migration file (§2.3) — app-level
 *     guarded step only.
 */
import { migration as baseline } from "./000_baseline";
import type { Migration } from "./runner";

export const MIGRATIONS: readonly Migration[] = [baseline];

/** Highest applied version once every migration is recorded. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;
