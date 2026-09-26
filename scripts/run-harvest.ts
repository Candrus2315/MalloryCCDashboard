/**
 * RESUMABLE HighLevel CALL HARVEST RUNNER (uncapped) — the accuracy layer for
 * every rep-call metric. Supersedes scripts/backfill-calls.ts.
 *
 * LISTING (probed live 2026-09-26): offset is IGNORED by /conversations/search
 * (offset=0 and offset=500 return the identical page), so coverage comes from
 * RECURSIVE dateAdded BINARY PARTITIONING (startDate/endDate are a conjunctive
 * half-open window on dateAdded). Two passes, each with its own persisted
 * waterfall cursor in harvest_progress:
 *   A "highlevel-calls-calllast" — server-narrowed lastMessageType=TYPE_CALL
 *     (probed: works; total 8,302 vs 30,293 unfiltered). These conversations
 *     END in a call — the highest-value subset, listed + visited first.
 *   B "highlevel-calls-all" — unfiltered (total 30,293), so conversations whose
 *     call is BURIED under later SMS (messageTypes ∋ 1, lastMessageType ≠ call)
 *     are discovered and visited too.
 * Visits (message fetches) are prioritized: call-flagged first, newest first,
 * 100 ms pacing; upserts are idempotent by provider message id (calls table +
 * independent harvest_calls ledger). Every visited conversation is marked so a
 * stopped/killed run resumes exactly (cursors + visited flags in the DB).
 *
 * SERIALIZATION: the run holds the provider 'highlevel' sync_runs mutex — the
 * 90s incremental scheduler skips its ticks while this runs (stale cutoff 12h
 * >> a harvest run, so it is never preempted mid-run).
 *
 * RECONCILIATION: recount per rep per ET day straight from the harvest ledger
 * (harvest_calls) vs the dashboard's `calls` table — they must agree for every
 * roster rep. Coverage (listed/visited/flagged) is printed per ET day.
 *
 * Run: bun scripts/run-harvest.ts [minutes=80] [--recon]
 * Env: DATABASE_URL, HIGHLEVEL_API_KEY, HIGHLEVEL_LOCATION_ID (case-insensitive).
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { runHarvestChunk, harvestCoverageComplete } from "../src/server/sync/call-harvest";
import { readHighLevelCreds } from "../src/server/sync/highlevel-live";
import type { NormalizedCall } from "../src/server/sync/adapters";
import { getStore } from "../src/server/store";

// env secrets may reach /proc/self/environ with odd casing; canonicalize before use.
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

const RUN_MINUTES = Number.isFinite(Number(process.argv[2])) && process.argv[2] && !process.argv[2].startsWith("--") ? Number(process.argv[2]) : 80;
const RECON_ONLY = process.argv.includes("--recon");

// Operative window (owner requirement): previous week (Mon 2026-09-14) through
// today (Sat 2026-09-26), all ET-aligned at 00:00 ET = 04:00 UTC (EDT).
const WINDOW_START_ISO = "2026-09-14T04:00:00.000Z"; // prev-week Monday 00:00 ET
const WTD_START_ISO = "2026-09-21T04:00:00.000Z"; // current-week Monday 00:00 ET
const Y_START_ISO = "2026-09-25T04:00:00.000Z"; // yesterday 00:00 ET
const Y_END_ISO = "2026-09-26T04:00:00.000Z"; // today 00:00 ET
const PASS_CALLLAST = "highlevel-calls-calllast";
const PASS_ALL = "highlevel-calls-all";
const ALLISON_EXT = "Pf0rllLIswGz28ljL5pZ";

function openSql(databaseUrl: string) {
  let needsSsl = false;
  try {
    const u = new URL(databaseUrl);
    needsSsl = u.searchParams.get("sslmode") === null && u.protocol.startsWith("postgres");
  } catch {
    // validated below by the first query
  }
  return postgres(databaseUrl, { max: 3, idle_timeout: 20, connect_timeout: 10, ...(needsSsl ? { ssl: "require" } : {}) });
}

async function main(): Promise<void> {
  const store = await getStore();
  if (store.mode !== "postgres") {
    console.error("FATAL: postgres store unavailable — harvest needs the real database.");
    process.exit(1);
  }
  const sql = openSql(process.env.DATABASE_URL!);
  let creds = readHighLevelCreds();
  if (!creds) {
    console.error("FATAL: HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID not set — cannot harvest.");
    process.exit(1);
  }

  const fmt = (n: number): string => n.toLocaleString("en-US");
  const windowStartMs = Date.parse(WINDOW_START_ISO);

  // ---------- reconciliation printer (also usable standalone via --recon) ----------
  async function printReconciliation(): Promise<void> {
    const users = await store.getUsers();
    const roster = users.filter((u) => u.is_active);

    const ledgerRecount = async (startIso: string, endIso: string | null) =>
      await sql`SELECT hc.user_external_id, count(*)::int AS n,
          SUM(CASE WHEN hc.duration_seconds > 120 THEN 1 ELSE 0 END)::int AS over2
        FROM harvest_calls hc
        WHERE hc.started_at >= ${startIso} ${endIso ? sql`AND hc.started_at < ${endIso}` : sql``}
        GROUP BY 1`;

    const dbRecount = async (startIso: string, endIso: string | null) =>
      await sql`SELECT u.external_id, u.name, count(*)::int AS n, SUM((c.duration_seconds > 120)::int)::int AS over2
        FROM calls c JOIN users u ON u.id = c.rep_id
        WHERE c.provider = 'highlevel' AND c.started_at >= ${startIso} ${endIso ? sql`AND c.started_at < ${endIso}` : sql``}
        GROUP BY 1, 2`;

    const [ledY, dbY, ledW, dbW] = await Promise.all([
      ledgerRecount(Y_START_ISO, Y_END_ISO),
      dbRecount(Y_START_ISO, Y_END_ISO),
      ledgerRecount(WTD_START_ISO, null),
      dbRecount(WTD_START_ISO, null),
    ]);
    const ledYMap = new Map(ledY.map((r) => [r.user_external_id, r]));
    const dbYMap = new Map((dbY as Record<string, unknown>[]).map((r) => [r.external_id, r]));
    const ledWMap = new Map(ledW.map((r) => [r.user_external_id, r]));
    const dbWMap = new Map((dbW as Record<string, unknown>[]).map((r) => [r.external_id, r]));

    const rowOf = (ext: string, label: string) => {
      const ly = ledYMap.get(ext) as Record<string, unknown> | undefined;
      const dy = dbYMap.get(ext) as Record<string, unknown> | undefined;
      const lw = ledWMap.get(ext) as Record<string, unknown> | undefined;
      const dw = dbWMap.get(ext) as Record<string, unknown> | undefined;
      const num = (v: unknown): number => Number(v ?? 0);
      const yMatch = num(ly?.n) === num(dy?.n) && num(ly?.over2) === num(dy?.over2);
      const wMatch = num(lw?.n) === num(dw?.n) && num(lw?.over2) === num(dw?.over2);
      return {
        label,
        ly: `${num(ly?.n)}/${num(ly?.over2)}`,
        dy: `${num(dy?.n)}/${num(dy?.over2)}`,
        lw: `${num(lw?.n)}/${num(lw?.over2)}`,
        dw: `${num(dw?.n)}/${num(dw?.over2)}`,
        ok: yMatch && wMatch ? "OK" : "MISMATCH",
      };
    };

    console.log("\n=== PER-REP RECONCILIATION  (calls/over2 — 'harvest ledger' vs 'dashboard DB') ===");
    console.log("rep                        | yest led/db | wtd led/db | match");
    const seen = new Set<string>();
    for (const u of roster) {
      seen.add(u.external_id);
      const r = rowOf(u.external_id, `${u.name} (${u.external_id})`);
      console.log(`${r.label.padEnd(26)} | ${r.ly.padStart(9)} | ${r.lw.padStart(10)} | ${r.ok}`);
    }
    if (!seen.has(ALLISON_EXT)) {
      const r = rowOf(ALLISON_EXT, `ALLISON check (${ALLISON_EXT})`);
      console.log(`${r.label.padEnd(26)} | ${r.ly.padStart(9)} | ${r.lw.padStart(10)} | ${r.ok}`);
    }
    const unledgered = [...ledWMap.keys()].filter((k) => !seen.has(k) && k);
    if (unledgered.length) {
      console.log(`(non-roster rep ids in ledger WTD: ${unledgered.length} — kept unattributed in the calls table)`);
    }

    // Allison deep-dive: per ET day, both sources
    const ledDays = await sql`SELECT to_char(started_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS d, count(*)::int AS n,
        SUM(CASE WHEN duration_seconds > 120 THEN 1 ELSE 0 END)::int AS over2
      FROM harvest_calls WHERE user_external_id = ${ALLISON_EXT} GROUP BY 1 ORDER BY 1`;
    const dbDays = await sql`SELECT to_char(c.started_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS d, count(*)::int AS n,
        SUM((c.duration_seconds > 120)::int)::int AS over2
      FROM calls c JOIN users u ON u.id = c.rep_id WHERE u.external_id = ${ALLISON_EXT} GROUP BY 1 ORDER BY 1`;
    console.log("\n=== ALLISON (Pf0rllLIswGz28ljL5pZ) per ET day — ledger vs DB ===");
    const dbDayMap = new Map((dbDays as Record<string, unknown>[]).map((r) => [String(r.d), r]));
    for (const r of ledDays as Record<string, unknown>[]) {
      const d = dbDayMap.get(String(r.d)) as Record<string, unknown> | undefined;
      const flag = Number(r.n) === Number(d?.n ?? 0) && Number(r.over2) === Number(d?.over2 ?? 0) ? "OK" : "MISMATCH";
      console.log(`${r.d}  ledger calls=${r.n} over2=${r.over2}   DB calls=${Number(d?.n ?? 0)} over2=${Number(d?.over2 ?? 0)}  ${flag}`);
    }

    const cov = await store.getHarvestCoverageSummary(windowStartMs);
    console.log(`\n=== HARVEST COVERAGE (window >= ${WINDOW_START_ISO}) ===`);
    console.log(`listed=${fmt(cov.total)} visited=${fmt(cov.visited)} call-flagged=${fmt(cov.callFlagged)} (${cov.total ? Math.round((cov.visited / cov.total) * 1000) / 10 : 0}% visited)`);
    for (const d of cov.byDay) console.log(`  ${d.day}  listed=${fmt(d.total)} visited=${fmt(d.visited)}`);

    const [runs] = (await sql`SELECT id::text, started_at, finished_at, list_requests, conversations_listed, visits_done, calls_found, messages_scanned, stopped_reason
      FROM harvest_runs ORDER BY started_at DESC LIMIT 1`) as Record<string, unknown>[];
    if (runs) {
      console.log("\n=== LAST HARVEST RUN (pages/records fetched) ===");
      console.log(`run=${String(runs.id)} started=${String(runs.started_at)} finished=${runs.finished_at ? String(runs.finished_at) : "(running)"}`);
      console.log(`list_requests=${runs.list_requests} conversations_listed=${runs.conversations_listed} visits=${runs.visits_done} calls_found=${runs.calls_found} messages_scanned=${runs.messages_scanned} stopped=${runs.stopped_reason ?? "-"}`);
    }
  }

  if (RECON_ONLY) {
    await printReconciliation();
    await sql.end({ timeout: 3 });
    return;
  }

  // ---------- mutex: hold the provider highlevel sync_runs row (scheduler pauses) ----------
  const running = await store.getRunningSyncRun("highlevel");
  if (running) {
    const ageMs = Date.now() - Date.parse(running.started_at);
    // No legitimate highlevel run (90s incremental ticks, attribution, manual
    // SYNC NOW) lives longer than ~2h — anything older is a crashed process
    // (e.g. the prior session's backfill left a running row at 06:03Z).
    if (ageMs < 2 * 3_600_000) {
      console.log(`SKIP: a highlevel sync is already running (started ${running.started_at}) — scheduler mutex.`);
      await sql.end({ timeout: 3 });
      return;
    }
    await store.finishSyncRun(running.id, "error", 0, "reclaimed by harvest runner (stale running row)");
  }
  const syncRunId = await store.insertSyncRun("highlevel");
  const [harvestRun] = (await sql`INSERT INTO harvest_runs (sync_run_id, window_start_utc) VALUES (${syncRunId}::uuid, ${WINDOW_START_ISO}) RETURNING id::text`) as Record<string, unknown>[];
  console.log(`harvest run ${String(harvestRun.id)} · window >= ${WINDOW_START_ISO} · budget ${RUN_MINUTES} min`);

  // ---------- rep/contact maps for attribution ----------
  const users = await store.getUsers();
  const byExt = new Map(users.map((u) => [u.external_id, u]));
  const contactRows = (await sql`SELECT id::text, external_id FROM contacts WHERE provider = 'highlevel' AND external_id IS NOT NULL`) as Record<string, unknown>[];
  const contactByExt = new Map(contactRows.map((r) => [String(r.external_id), String(r.id)]));

  const stats = { listRequests: 0, listed: 0, visits: 0, calls: 0, messages: 0 };
  const deadline = Date.now() + RUN_MINUTES * 60_000;

  async function onCalls(calls: NormalizedCall[]): Promise<void> {
    if (!calls.length) return;
    await store.upsertCalls(
      calls.map((c) => {
        const rep = c.repExternalId ? byExt.get(c.repExternalId) : undefined;
        return {
          id: "",
          provider: "highlevel",
          external_call_id: c.external_call_id,
          rep_id: rep && rep.is_active ? String(rep.id) : null,
          contact_id: contactByExt.get(c.contactExternalId) ?? null,
          direction: c.direction,
          call_status: c.status,
          started_at: c.startedAt,
          duration_seconds: c.durationSeconds,
          over_two_minutes: c.durationSeconds > 120,
          provider_rep_external_id: c.repExternalId || null,
          conversation_id: c.conversation_id ?? null,
        };
      }),
    );
    for (const c of calls) {
      await sql`INSERT INTO harvest_calls (message_id, conversation_id, user_external_id, contact_external_id, started_at, duration_seconds, direction, call_status)
        VALUES (${c.external_call_id}, ${c.conversation_id ?? ""}, ${c.repExternalId || null}, ${c.contactExternalId}, ${c.startedAt}, ${c.durationSeconds > 0 ? c.durationSeconds : null}, ${c.direction}, ${c.status})
        ON CONFLICT (message_id) DO UPDATE SET user_external_id = EXCLUDED.user_external_id, contact_external_id = EXCLUDED.contact_external_id,
          started_at = EXCLUDED.started_at, duration_seconds = EXCLUDED.duration_seconds, direction = EXCLUDED.direction,
          call_status = EXCLUDED.call_status, harvested_at = now()`;
    }
    stats.calls += calls.length;
  }

  let stoppedReason = "coverage-complete";
  let chunk = 0;
  const runChunk = async (o: { progressId: string; maxListRequests: number; maxVisits: number; listExtraQuery?: Record<string, string> }) => {
    const r = await runHarvestChunk({
      store,
      creds,
      fetchImpl: fetch,
      windowStartUtc: WINDOW_START_ISO,
      progressId: o.progressId,
      listExtraQuery: o.listExtraQuery,
      maxListRequests: o.maxListRequests,
      maxVisits: o.maxVisits,
      onCalls,
      now: () => new Date(),
    });
    chunk += 1;
    stats.listRequests += r.listRequests;
    stats.listed += r.conversationsListed;
    stats.visits += r.visitsDone;
    stats.calls += r.callsFound;
    stats.messages += r.messagesScanned;
    if (r.warnings.length) for (const w of r.warnings.slice(0, 3)) console.log(`  warn: ${w}`);
    if (chunk % 5 === 0 || r.coverageComplete) {
      console.log(`chunk ${chunk}: +${r.visitsDone} visits, +${r.callsFound} calls · totals: list=${stats.listRequests} listed=${fmt(stats.listed)} visits=${fmt(stats.visits)} calls=${fmt(stats.calls)} msgs=${fmt(stats.messages)}`);
    }
    return r;
  };

  try {
    // Phase 1: list + visit the call-last subset (server-filtered, fastest path to every call).
    for (;;) {
      if (Date.now() >= deadline) { stoppedReason = "time-budget"; break; }
      const p = await store.getHarvestProgress(PASS_CALLLAST);
      if (p?.list_complete) break;
      const r = await runChunk({ progressId: PASS_CALLLAST, maxListRequests: 40, maxVisits: 60, listExtraQuery: { lastMessageType: "TYPE_CALL" } });
      if (p && r.listRequests === 0 && r.visitsDone === 0) { console.log("phase 1 stalled (no progress)"); break; }
    }
    // Phase 2: unfiltered listing (flags buried-call conversations) + continue visits.
    for (;;) {
      if (Date.now() >= deadline) { stoppedReason = "time-budget"; break; }
      const p = await store.getHarvestProgress(PASS_ALL);
      if (p?.list_complete) break;
      const r = await runChunk({ progressId: PASS_ALL, maxListRequests: 25, maxVisits: 60 });
      if (p && r.listRequests === 0 && r.visitsDone === 0) { console.log("phase 2 stalled (no progress)"); break; }
    }
    // Phase 3: visit everything left in-window until coverage completes or budget runs out.
    for (;;) {
      if (Date.now() >= deadline) { stoppedReason = "time-budget"; break; }
      if (await harvestCoverageComplete(store, WINDOW_START_ISO, PASS_ALL)) break;
      const r = await runChunk({ progressId: PASS_ALL, maxListRequests: 0, maxVisits: 100 });
      if (r.visitsDone === 0) break; // nothing unvisited left
    }
  } catch (e) {
    stoppedReason = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  await sql`UPDATE harvest_runs SET finished_at = now(), list_requests = ${stats.listRequests}, conversations_listed = ${stats.listed},
    visits_done = ${stats.visits}, calls_found = ${stats.calls}, messages_scanned = ${stats.messages}, stopped_reason = ${stoppedReason}
    WHERE id = ${String(harvestRun.id)}::uuid`;
  await store.finishSyncRun(syncRunId, stoppedReason.startsWith("error") ? "error" : "success", stats.calls, stoppedReason.startsWith("error") ? stoppedReason : null);
  console.log(`\nDONE (${stoppedReason}): list=${stats.listRequests} listed=${fmt(stats.listed)} visits=${fmt(stats.visits)} calls=${fmt(stats.calls)} msgs=${fmt(stats.messages)}`);

  await printReconciliation();
  await sql.end({ timeout: 3 });
}

await main();
