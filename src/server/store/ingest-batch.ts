/**
 * INGEST BATCHING + PER-RUN WALL-CLOCK DEADLINE (10/23 sheets/attribution wedge fix).
 *
 * Evidence (scratch/sheets-wedge-forensics.md, §7 addendum): the heavy ingest
 * paths (sheets leads, booking attributions, Acuity appointments) upserted
 * ROW BY ROW — one INSERT…ON CONFLICT round-trip per row. Healthy rate is
 * 63-78 ms/row (~3,860 rows ≈ 5 min), but periodic contention flares push it
 * to 271-755 ms/row (worst legit run: 48 min). When a run crossed the 30-min
 * reap bound, the reaper closed its sync_runs row but the JS chain kept
 * running detached — pg_stat_activity at ~17:16 showed FIVE concurrent
 * INSERT-INTO-leads chains + THREE INSERT-INTO-appointments chains fighting
 * for the connection pools, and a late zombie's unconditional finishSyncRun
 * overwrote the reaper's error row with a false "success" (the 16:05
 * "recovery").
 *
 * This module carries the two structural fixes:
 * 1. BATCHING — chunkRows() splits an ingest payload into ~500-row chunks so
 *    the store can emit one multi-row INSERT…ON CONFLICT statement per chunk
 *    (3,860 rows collapse from ~3,900 round-trips to ~8 statements). The
 *    per-row VALUES tuples are still built as parameterized sql fragments in
 *    the store — no string building, injection-safe.
 * 2. DEADLINE — makeRunDeadline() returns a tiny per-run wall-clock budget
 *    object. Ingest loops call deadline.check() once per chunk; past the
 *    limit it throws RunDeadlineExceeded so a detached zombie chain stops
 *    hammering the database within ~INGEST_RUN_DEADLINE_MS of its start
 *    instead of running for hours. The limit (40 min) sits ABOVE the reap
 *    bound (30 min) with margin: legit runs observed max 21.5 min during a
 *    flare, so a healthy run never trips it, but a reaped run's detached
 *    chain is force-stopped soon after its row is reaped. The clock is
 *    injectable (opts.now / opts.startedAtMs / opts.limitMs) so tests can pin
 *    both behaviors without sleeping.
 *
 * The reap bound (TICK_WATCHDOG_CAP_MS / STALE_RUN_REAP_MINUTES) and the
 * statement_timeout are deliberately NOT touched here — this deadline is an
 * ADDITIONAL self-defense inside the ingest loops, not a change to the
 * existing bounds.
 */

/** Rows per batched INSERT statement. ~500 keeps one statement well under any
 * parameter/wire limits (11 columns × 500 = 5,500 params per statement, far
 * below the 65k protocol cap) while collapsing round-trips ~500×. */
export const INGEST_CHUNK_SIZE = 500;

/** Per-run ingest wall-clock budget: 40 min = the 30-min reap bound + margin.
 * A detached zombie stops its DB hammering within ~40 min of its start; legit
 * runs observed to date max 21.5 min, so healthy runs never see this. */
export const INGEST_RUN_DEADLINE_MS = 40 * 60_000;

/** Thrown by RunDeadline.check() when a run has exhausted its wall-clock
 * budget. Callers surface it like any other sync error (the sync_run row gets
 * an honest error either way — it was already reaped). */
export class RunDeadlineExceeded extends Error {
  readonly label: string;
  readonly elapsedMs: number;
  readonly limitMs: number;

  constructor(label: string, elapsedMs: number, limitMs: number) {
    super(
      `ingest run deadline exceeded: "${label}" ran ${Math.round(elapsedMs / 1000)}s (limit ${Math.round(limitMs / 1000)}s) — stopping the loop so a detached run cannot hammer the DB for hours`,
    );
    this.name = "RunDeadlineExceeded";
    this.label = label;
    this.elapsedMs = elapsedMs;
    this.limitMs = limitMs;
  }
}

/** Per-run wall-clock budget handed into the ingest loops. check() is called
 * once per chunk (NOT per row) — it is pure CPU, no I/O. */
export interface RunDeadline {
  readonly label: string;
  readonly startedAtMs: number;
  readonly limitMs: number;
  /** Throws RunDeadlineExceeded once the run has consumed its budget. */
  check(): void;
}

export interface RunDeadlineOptions {
  /** Human-readable label for the error message (e.g. "google_sheets"). */
  label?: string;
  /** Anchor instant (epoch ms). Defaults to the moment makeRunDeadline is
   * called — pass the sync run's start for a true per-RUN budget. */
  startedAtMs?: number;
  /** Wall-clock budget in ms. Defaults to INGEST_RUN_DEADLINE_MS. */
  limitMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export function makeRunDeadline(options: RunDeadlineOptions = {}): RunDeadline {
  const label = options.label ?? "ingest";
  const now = options.now ?? Date.now;
  const startedAtMs = options.startedAtMs ?? now();
  const limitMs = options.limitMs ?? INGEST_RUN_DEADLINE_MS;
  return {
    label,
    startedAtMs,
    limitMs,
    check() {
      const elapsedMs = now() - startedAtMs;
      if (elapsedMs >= limitMs) {
        throw new RunDeadlineExceeded(label, elapsedMs, limitMs);
      }
    },
  };
}

/** Split an ingest payload into ~INGEST_CHUNK_SIZE-row chunks.
 * Returns [] for an empty payload, exactly one chunk for rows.length <= size
 * (the single-row path stays one statement — semantics unchanged), and
 * ceil(n/size) chunks otherwise. Chunk boundaries are exact: no row is
 * dropped, duplicated, or reordered. */
export function chunkRows<T>(rows: readonly T[], size: number = INGEST_CHUNK_SIZE): T[][] {
  if (size < 1) throw new Error(`chunkRows: size must be >= 1, got ${size}`);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

/** Keep the LAST occurrence per conflict key (order of first appearance kept).
 * A multi-row INSERT ... ON CONFLICT cannot affect the same row twice in ONE
 * statement (cardinality error), while the per-row loop it replaced applied
 * every occurrence in order - last wins. Deduping to the last occurrence
 * preserves that final state exactly. */
export function dedupeLast<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const map = new Map<string, T>();
  for (const row of rows) map.set(keyOf(row), row);
  return [...map.values()];
}

/** Options threaded through the Store ingest upserts. All optional — a store
 * builds its own default deadline (anchored at the upsert call) when none is
 * passed, so a bare store call is still bounded. */
export interface IngestOptions {
  deadline?: RunDeadline;
}
