/**
 * TARGETED HIGHLEVEL CALL HARVEST — commission data-fix step 3 (2026-10-02).
 *
 * The blanket harvest (run-harvest.ts) is budget-capped: it visited ~1,260 of
 * ~5,687 conversations in the widened window (dateAdded >= 2026-08-22), so the
 * W1/W2 re-verdict flipped only +3 attributed — far short of ground truth
 * (Allison W1=35, W2=42). This runner visits ONLY conversations that can carry
 * the missing evidence: the conversations of the GHL contacts who own the W1/W2
 * Booking Wins.
 *
 * TARGET SET (the same records the commission engine consumes):
 *   stored `appointments` with payment_state='paid' AND booking_win_business_date
 *   in the requested weeks (default W1+W2 = 2026-08-31..2026-09-13; optional
 *   --weeks=w1,w2,w3,w4 extends to 2026-09-27), any attribution state
 *   -> appointments.contact_id -> contacts(provider=highlevel).external_id.
 *
 * CONVERSATION SOURCES, both funneling into the SAME visit loop and the SAME
 * writer as the blanket harvest (store.upsertCalls + harvest_calls ledger +
 * markHarvestVisited — idempotent by provider message id):
 *   1. API mode (preferred): /conversations/search?contactId=<ext>, probed at
 *      startup against a contact with known conversations (rows must ALL carry
 *      that contactId, else the param is unsupported and we fall back). With
 *      full-range dateAdded bounds [0, now] it lists a contact's ENTIRE
 *      conversation history — including threads created before the 8/22 window
 *      floor, which the blanket visit pass can never reach (its visit batch is
 *      dateAdded-bounded) — and the per-contact set is <100 rows, so one
 *      request per contact covers it. Parsed calls stay bounded to the window
 *      floor by visitConversationMessages.
 *   2. DB mode (fallback): every UNVISITED conversation already listed in
 *      harvest_conversations whose contact_id is a target — ANY dateAdded band
 *      (pre-8/22 threads holding late-August calls are exactly the records the
 *      blanket pass misses; the call-evidence bound is enforced in the visit).
 *
 * SERIALIZATION: holds the provider 'highlevel' sync_runs mutex (the same row
 * the scheduler and run-harvest check); records a harvest_runs row for audit;
 * reclaims stale (>2h) running rows exactly like run-harvest. NEVER forces
 * anything; per-contact failures are warned and skipped; upserts idempotent.
 *
 * Run: bun scripts/run-harvest-targeted.ts [minutes=90] [--weeks=w1,w2] [--mode=api|db|auto] [--dry]
 * Env: DATABASE_URL, HIGHLEVEL_API_KEY, HIGHLEVEL_LOCATION_ID (case-insensitive).
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import {
  visitConversationMessages,
  parseConvListItem,
  enumerateRange,
  type HarvestConvRow,
} from "../src/server/sync/call-harvest";
import { readHighLevelCreds, hlRequest, listOf, type HighLevelCreds, type HlEndpointOpts } from "../src/server/sync/highlevel-live";
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

// ---------- args ----------
const argv = process.argv.slice(2);
const RUN_MINUTES = Number.isFinite(Number(argv[0])) && argv[0] && !argv[0].startsWith("--") ? Number(argv[0]) : 90;
const weeksArg = argv.find((a) => a.startsWith("--weeks="))?.slice(8) ?? "w1,w2";
const WEEKS = weeksArg.split(",").map((w) => w.trim().toLowerCase());
const MODE = (argv.find((a) => a.startsWith("--mode="))?.slice(7) ?? "auto") as "auto" | "api" | "db";
const DRY = argv.includes("--dry");

// Week → win-date ET band (Mon..Sun; booking_win_business_date is an ET date).
const WEEK_BANDS: Record<string, { from: string; to: string }> = {
  w1: { from: "2026-08-31", to: "2026-09-06" },
  w2: { from: "2026-09-07", to: "2026-09-13" },
  w3: { from: "2026-09-14", to: "2026-09-20" },
  w4: { from: "2026-09-21", to: "2026-09-27" },
};
const WINDOW_START_ISO = "2026-08-22T04:00:00.000Z"; // the widened harvest floor (call-evidence bound)
const WINDOW_START_MS = Date.parse(WINDOW_START_ISO);

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
    console.error("FATAL: postgres store unavailable — targeted harvest needs the real database.");
    process.exit(1);
  }
  const sql = openSql(process.env.DATABASE_URL!);
  const creds = readHighLevelCreds();
  if (!creds) {
    console.error("FATAL: HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID not set — cannot harvest.");
    process.exit(1);
  }
  const bands = WEEKS.map((w) => WEEK_BANDS[w]).filter((b) => !!b);
  if (!bands.length) {
    console.error(`FATAL: no recognized weeks in --weeks=${weeksArg} (use w1..w4)`);
    process.exit(1);
  }
  const bandRange = {
    from: bands.reduce((min, b) => (b.from < min ? b.from : min), bands[0].from),
    to: bands.reduce((max, b) => (b.to > max ? b.to : max), bands[0].to),
  };
  console.log(`TARGETED HARVEST weeks=${WEEKS.join("+")} (wins ${bandRange.from}..${bandRange.to}) mode=${MODE} budget=${RUN_MINUTES}min dry=${DRY}`);

  // ---------- target set: win appointments -> GHL contact ids ----------
  const wins = (await sql`
    SELECT a.id::text AS appt_id, a.booking_win_business_date, c.external_id AS hl_ext
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id AND c.provider = 'highlevel'
    WHERE a.payment_state = 'paid'
      AND a.booking_win_business_date >= ${bandRange.from} AND a.booking_win_business_date <= ${bandRange.to}
  `) as Record<string, unknown>[];
  const targets = new Map<string, number>(); // hl_ext -> win count
  for (const w of wins) {
    if (typeof w.hl_ext === "string" && w.hl_ext) targets.set(w.hl_ext, (targets.get(w.hl_ext) ?? 0) + 1);
  }
  console.log(`paid wins in band: ${wins.length} -> distinct target GHL contacts: ${targets.size}`);
  if (!targets.size) {
    console.log("nothing to do");
    await sql.end({ timeout: 3 });
    return;
  }
  const targetIds = [...targets.keys()];

  // ---------- mutex: hold the provider highlevel sync_runs row (real runs only — DRY is read-only) ----------
  let syncRunId: string | null = null;
  let harvestRunId: string | null = null;
  if (!DRY) {
    const running = await store.getRunningSyncRun("highlevel");
    if (running) {
      const ageMs = Date.now() - Date.parse(running.started_at);
      if (ageMs < 2 * 3_600_000) {
        console.log(`SKIP: a highlevel sync is already running (started ${running.started_at}) — scheduler mutex.`);
        await sql.end({ timeout: 3 });
        return;
      }
      await store.finishSyncRun(running.id, "error", 0, "reclaimed by targeted harvest runner (stale running row)");
    }
    syncRunId = await store.insertSyncRun("highlevel");
    const [harvestRun] = (await sql`INSERT INTO harvest_runs (sync_run_id, window_start_utc) VALUES (${syncRunId}::uuid, ${WINDOW_START_ISO}) RETURNING id::text`) as Record<string, unknown>[];
    harvestRunId = String(harvestRun.id);
    console.log(`harvest run ${harvestRunId} (targeted) · call-evidence window >= ${WINDOW_START_ISO}`);
  } else {
    console.log(`DRY: no mutex held, no rows written · call-evidence window >= ${WINDOW_START_ISO}`);
  }

  // ---------- the SAME writer the blanket harvest uses ----------
  const users = await store.getUsers();
  const byExt = new Map(users.map((u) => [u.external_id, u]));
  const contactRows = (await sql`SELECT id::text, external_id FROM contacts WHERE provider = 'highlevel' AND external_id IS NOT NULL`) as Record<string, unknown>[];
  const contactByExt = new Map(contactRows.map((r) => [String(r.external_id), String(r.id)]));
  const stats = { visits: 0, calls: 0, messages: 0, apiRequests: 0, apiListed: 0, skippedVisited: 0 };

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

  const deadline = Date.now() + RUN_MINUTES * 60_000;
  const endpointOpts: HlEndpointOpts = { creds, fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

  async function visitConv(conv: HarvestConvRow): Promise<void> {
    const visit = await visitConversationMessages({
      creds,
      fetchImpl: fetch,
      conversationId: conv.conv_id,
      windowStartMs: WINDOW_START_MS,
    });
    stats.visits += 1;
    stats.messages += visit.messagesScanned;
    if (visit.calls.length) await onCalls(visit.calls);
    if (!DRY) {
      await store.markHarvestVisited([conv.conv_id], { [conv.conv_id]: visit.calls.length }, { [conv.conv_id]: visit.messagesScanned });
    }
    await endpointOpts.sleep(100); // pacing between conversation visits
  }

  /** One /conversations/search request; contactId filter optional (probed). */
  async function searchConversations(contactId: string | null, startMs: number, endMsExclusive: number): Promise<{ rows: HarvestConvRow[]; total: number }> {
    stats.apiRequests += 1;
    const query = new URLSearchParams({ locationId: creds.locationId, limit: "100", startDate: String(startMs), endDate: String(endMsExclusive) });
    if (contactId) query.set("contactId", contactId);
    const body = (await hlRequest({ path: "/conversations/search", query }, endpointOpts)) as Record<string, unknown> | null;
    const items = listOf(body, "conversations", "data") as Record<string, unknown>[];
    const rows: HarvestConvRow[] = [];
    for (const raw of items) {
      const row = parseConvListItem(raw);
      // STRICT identity guard: in contactId mode a mismatched row means the
      // param is unsupported — never ingest a conversation owned by someone else.
      if (row && (!contactId || row.contact_id === contactId)) rows.push(row);
    }
    const total = typeof body?.["total"] === "number" ? body["total"] : rows.length;
    return { rows, total };
  }

  // ---------- MODE 1: per-contact API listing, probed first ----------
  let apiModeUsable = false;
  if (MODE !== "db" && !DRY) {
    // Probe with a target that HAS at least one conversation in the DB ledger,
    // so an empty result can't be misread as "param ignored".
    const probeRow = (await sql`SELECT contact_id::text AS ext FROM harvest_conversations WHERE contact_id IN ${sql(targetIds)} LIMIT 1`) as Record<string, unknown>[];
    const probeContact = probeRow.length ? String(probeRow[0].ext) : targetIds[0];
    try {
      const probe = await searchConversations(probeContact, 0, Date.now() + 60_000);
      const allMatch = probe.rows.length > 0 && probe.rows.every((r) => r.contact_id === probeContact);
      console.log(`contactId probe on ${probeContact}: requests=1 rows=${probe.rows.length} total=${probe.total} allMatch=${allMatch}`);
      apiModeUsable = allMatch;
      if (!allMatch) console.log("contactId param NOT honored by /conversations/search (page carries other contacts) — falling back to the DB ledger.");
    } catch (e) {
      console.log(`contactId probe failed (${e instanceof Error ? e.message : String(e)}) — falling back to the DB ledger.`);
    }
  }

  if (apiModeUsable) {
    console.log(`API mode: enumerating full conversation history for ${targetIds.length} target contacts`);
    if (!DRY) {
      for (const ext of targetIds) {
        if (Date.now() >= deadline) { console.log("time budget reached — stopping"); break; }
        const sink = { rows: [] as HarvestConvRow[], requests: 0, truncated: [] as { startMs: number; endMsExclusive: number; total: number }[] };
        try {
          await enumerateRange((_s, _e) => searchConversations(ext, _s, _e), 0, Date.now() + 60_000, { maxListRequests: 8, minWidthMs: 60_000 }, sink);
        } catch (e) {
          console.log(`  warn: listing ${ext} failed: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        for (const t of sink.truncated.slice(0, 1)) console.log(`  warn: contact ${ext} has a dense window (total ${t.total}) — retried up to the request floor`);
        stats.apiListed += sink.rows.length;
        if (sink.rows.length) await store.upsertHarvestConversations(sink.rows);
        const convIds = sink.rows.map((r) => r.conv_id);
        const visitedRows = convIds.length
          ? ((await sql`SELECT conv_id FROM harvest_conversations WHERE conv_id IN ${sql(convIds)} AND visited = true`) as Record<string, unknown>[])
          : [];
        const visitedSet = new Set(visitedRows.map((r) => String(r.conv_id)));
        for (const row of sink.rows) {
          if (visitedSet.has(row.conv_id)) { stats.skippedVisited += 1; continue; }
          if (Date.now() >= deadline) break;
          try {
            await visitConv(row);
          } catch (e) {
            console.log(`  warn: visit ${row.conv_id} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      console.log(`API mode done: listed=${stats.apiListed} visits=${stats.visits} skippedVisited=${stats.skippedVisited} calls=${stats.calls}`);
    } else {
      console.log(`DRY: would list+visit ${targetIds.length} contacts`);
    }
  }

  // ---------- MODE 2 (fallback or --mode=db): DB-ledger unvisited targets ----------
  if (!apiModeUsable) {
    const rows = (await sql`
      SELECT conv_id, last_message_date, date_added, message_types, last_message_type, contact_id, assigned_to
      FROM harvest_conversations
      WHERE visited = false AND contact_id IN ${sql(targetIds)}
      ORDER BY last_message_date DESC
      LIMIT 5000
    `) as Record<string, unknown>[];
    const harvestRows: HarvestConvRow[] = rows.map((r) => ({
      conv_id: String(r.conv_id),
      last_message_date: Number(r.last_message_date),
      date_added: Number(r.date_added),
      message_types: Array.isArray(r.message_types) ? (r.message_types as unknown as number[]) : [],
      last_message_type: (r.last_message_type as string | null) ?? null,
      contact_id: (r.contact_id as string | null) ?? null,
      assigned_to: (r.assigned_to as string | null) ?? null,
    }));
    console.log(`DB mode: unvisited target conversations in ledger: ${harvestRows.length}`);
    if (!DRY) {
      for (const row of harvestRows) {
        if (Date.now() >= deadline) { console.log("time budget reached — stopping"); break; }
        try {
          await visitConv(row);
        } catch (e) {
          console.log(`  warn: visit ${row.conv_id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else {
      console.log(`DRY: would visit ${harvestRows.length} ledger conversations`);
    }
  }

  // ---------- ledger evidence preview: in-window calls by rep for targets ----------
  const repTally = (await sql`
    SELECT hc.user_external_id, u.name, count(*)::int AS n
    FROM harvest_calls hc LEFT JOIN users u ON u.external_id = hc.user_external_id AND u.provider='highlevel'
    WHERE hc.contact_external_id IN ${sql(targetIds)} AND hc.started_at >= ${WINDOW_START_ISO}
    GROUP BY 1, 2 ORDER BY 3 DESC
  `) as Record<string, unknown>[];
  console.log("\n=== target-contact calls in evidence window, by HL rep id ===");
  for (const r of repTally) console.log(`  ${r.user_external_id ?? "(none)"} ${r.name ?? "?"}: ${r.n}`);

  const finishedReason = Date.now() >= deadline ? "time-budget" : "complete";
  if (!DRY && syncRunId && harvestRunId) {
    await sql`UPDATE harvest_runs SET finished_at = now(), list_requests = ${stats.apiRequests}, conversations_listed = ${stats.apiListed},
      visits_done = ${stats.visits}, calls_found = ${stats.calls}, messages_scanned = ${stats.messages}, stopped_reason = ${finishedReason}
      WHERE id = ${harvestRunId}::uuid`;
    await store.finishSyncRun(syncRunId, "success", stats.calls, null);
  }
  console.log(`\nDONE (${finishedReason}${DRY ? " DRY" : ""}): apiRequests=${stats.apiRequests} listed=${stats.apiListed} visits=${stats.visits} (skippedVisited=${stats.skippedVisited}) calls=${stats.calls} msgs=${stats.messages}`);
  await sql.end({ timeout: 3 });
  process.exit(0); // the store pool's idle_timeout (240s) must not hold the process after the work is done
}

await main();
