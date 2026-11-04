/**
 * ONE-TIME CALL-RECORDS BACKFILL (call-source W2, owner directive approved
 * 2026-11-04). Pulls HighLevel's raw call export (channel=Call) from
 * 2026-11-01T00:00:00-05:00 (the owner-set floor — NO earlier history)
 * through run time and lands every record in `hl_call_records`, chunked by
 * ET-day-aligned 24h windows, cursor-paginated, IDEMPOTENT (upsert by
 * message_id — re-running is always safe and only NEW rows change counts).
 *
 * The LEAD runs this from MAIN after the PR merges, against the production
 * DB. Safety rails:
 *   - Writes ONLY hl_call_records by default. `--sync-run` additionally
 *     records one highlevel sync_runs row (it holds the scheduler mutex for
 *     the run's duration; off by default per the lead's "write ONLY
 *     hl_call_records").
 *   - Refuses to run on a non-Postgres store (no silent memory "backfill").
 *   - Skips while a highlevel sync is already running (read-only guard;
 *     `--force` overrides) so the pass never races the incremental tick.
 *   - Prints a completion summary (totals, NEW rows, per-user counts with
 *     rep names) and NEVER prints credentials or connection strings.
 *
 * Run: bun scripts/backfill-hl-call-records.ts [--start <iso>] [--end <iso>] [--sync-run] [--force]
 * Env: DATABASE_URL, HIGHLEVEL_API_KEY, HIGHLEVEL_LOCATION_ID (case-insensitive).
 */
import { readFileSync } from "node:fs";
import { readHighLevelCreds } from "../src/server/sync/highlevel-live";
import { planBackfillWindows, runCallRecordsIngest, type CallRecordsIngestResult } from "../src/server/sync/call-records-export";
import { getStore } from "../src/server/store";
import { PgStore } from "../src/server/store/pg";
import type { Store, UserRow } from "../src/server/store/types";

/** The owner-set backfill floor: Nov 1 2026, 00:00 ET (NO earlier history). */
export const BACKFILL_FLOOR_ISO = "2026-11-01T00:00:00-05:00";

const envOf = (k: string): string => {
  const m = readFileSync("/proc/self/environ", "utf8").split("\0").find((s) => s.toLowerCase().startsWith(k.toLowerCase() + "="));
  return m ? m.slice(k.length + 1) : "";
};
for (const canon of ["DATABASE_URL", "HIGHLEVEL_API_KEY", "HIGHLEVEL_LOCATION_ID"] as const) {
  if (!process.env[canon]) {
    const v = envOf(canon);
    if (v) process.env[canon] = v;
  }
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("-") ? process.argv[i + 1] : null;
}
const hasFlag = (flag: string): boolean => process.argv.includes(flag);

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    console.log("BACKFILL ABORTED — running under the test runner (production DB writes are forbidden from tests)");
    process.exit(1);
  }
  const startMs = Date.parse(argValue("--start") ?? BACKFILL_FLOOR_ISO);
  const endMs = argValue("--end") ? Date.parse(argValue("--end") as string) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    console.log("BACKFILL ABORTED — unparsable/inverted window (--start/--end).");
    process.exit(1);
  }

  const store: Store = await getStore(
    { storeFactory: (u) => new PgStore(u, { migrationCapability: { grantedBy: "data-ops runner: backfill-hl-call-records (owner approved 2026-11-04)" } }) },
  );
  if (store.mode !== "postgres") {
    console.log("BACKFILL ABORTED — no DATABASE_URL: refusing to 'backfill' a memory store (nothing would persist).");
    process.exit(1);
  }

  const creds = readHighLevelCreds();
  if (!creds) {
    console.log("BACKFILL ABORTED — HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID missing from the environment.");
    process.exit(1);
  }

  // Read-only running guard (no writes): the incremental tick's sync_runs row
  // protects its own window; racing it here would only skew the NEW-row diff.
  const running = await store.getRunningSyncRun("highlevel");
  if (running && !hasFlag("--force")) {
    const ageMs = Date.now() - Date.parse(running.started_at);
    if (ageMs < 2 * 3_600_000) {
      console.log(`SKIP: a highlevel sync is already running (started ${running.started_at}) — re-run in a minute or pass --force.`);
      return;
    }
  }

  const syncRunId = hasFlag("--sync-run") ? await store.insertSyncRun("highlevel") : null;
  const windows = planBackfillWindows(startMs, endMs);
  console.log(`Call-records backfill: ${windows.length} day-window(s), ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()} (floor ${BACKFILL_FLOOR_ISO}).`);

  const interrupted = { v: false };
  const onInterrupt = (): void => {
    if (interrupted.v) process.exit(1);
    interrupted.v = true;
    console.log("[interrupt] finishing the current window, then stopping (idempotent — re-run resumes)");
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  const perUser = new Map<string, number>();
  let fetched = 0;
  let inserted = 0;
  let written = 0;
  let pages = 0;
  const warnings: string[] = [];
  try {
    for (const [i, w] of windows.entries()) {
      if (interrupted.v) break;
      const res: CallRecordsIngestResult = await runCallRecordsIngest({ store, creds, startIso: w.startIso, endIso: w.endIso, fetchImpl: fetch });
      fetched += res.fetched;
      written += res.written;
      inserted += res.inserted;
      pages += res.pages;
      for (const r of res.newRows) {
        const key = r.user_external_id ?? "";
        perUser.set(key, (perUser.get(key) ?? 0) + 1);
      }
      for (const wmsg of res.warnings) warnings.push(wmsg);
      console.log(`  window ${i + 1}/${windows.length} [${w.startIso} → ${w.endIso}): fetched=${res.fetched} new=${res.inserted} pages=${res.pages}${res.truncated ? " TRUNCATED(page-guard)" : ""}`);
    }

    // Per-user summary joined to users.external_id for names (the diagnostic's
    // per-agent repair counts). Unknown ids print raw (kept honest); the empty
    // user is the team-level inbound bucket.
    const users: UserRow[] = await store.getAllUsers();
    const nameByExternal = new Map(users.filter((u) => u.provider === "highlevel").map((u) => [u.external_id, u.name]));
    const total = await store.countHlCallRecords();
    console.log("\n=== Call-records backfill summary ===");
    console.log(`windows=${windows.length} fetched=${fetched} written=${written} NEW=${inserted} requests~=${pages}`);
    console.log(`hl_call_records total rows now: ${total}`);
    if (warnings.length) console.log(`warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 10)) console.log(`  - ${w}`);
    console.log("NEW rows per user:");
    const sorted = [...perUser.entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) console.log("  (none — everything was already stored; the backfill was idempotently a no-op)");
    for (const [ext, n] of sorted) {
      const label = ext === "" ? "(team-level — no user)" : nameByExternal.get(ext) ?? `${ext} (no matching users row)`;
      console.log(`  ${label}: ${n}`);
    }
    if (syncRunId != null) await store.finishSyncRun(syncRunId, "success", written, null);
    console.log(interrupted.v ? "INTERRUPTED — re-run to resume (idempotent)." : "DONE.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (syncRunId != null) await store.finishSyncRun(syncRunId, "error", written, msg.slice(0, 400)).catch(() => {});
    console.error(`BACKFILL FAILED after ${inserted} new rows: ${msg}`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

await main();
