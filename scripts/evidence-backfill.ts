/**
 * RESUMABLE SMS/LIVE-CHAT EVIDENCE BACKFILL (SMS EVIDENCE + CONTACT
 * RE-RESOLUTION spec, owner approved 2026-11-02).
 *
 * Walks every HighLevel conversation CREATED at/after the 2026-10-01 evidence
 * floor and persists its NON-CALL messages into `evidence_messages` as
 * attribution evidence. The `calls` / `harvest_calls` pipelines are NEVER
 * touched: parsed call messages are discarded here, so pickup rate, call
 * counts, and over-2-min metrics stay bit-identical.
 *
 * LISTING: /conversations/search offset is ignored (probed 2026-09-26), so
 * coverage comes from RECURSIVE dateAdded BINARY PARTITIONING over
 * [2026-10-01T00:00:00Z, now) — the same uncapped primitive the call harvest
 * uses (enumerateWaterfallWindow). Pure-call conversations
 * (messageTypes ⊆ {1}) are pruned client-side: they cannot contain a non-call
 * message, so they never cost a visit.
 *
 * SERIALIZATION: holds the provider 'highlevel' sync_runs mutex (the 90s
 * incremental scheduler pauses); try/finally always closes the row.
 *
 * RESUMABILITY: progress persists under sync_checkpoints key
 * "hl_evidence_backfill_v1" after every waterfall window and every visit —
 * { listHiExclusive, listDone, queue: pending conversation rows, counters }.
 * Interrupted runs resume exactly; reruns are idempotent (upsert dedupe by
 * message id).
 *
 * Run: bun scripts/evidence-backfill.ts [minutes=45]
 * Env: DATABASE_URL, HIGHLEVEL_API_KEY, HIGHLEVEL_LOCATION_ID (case-insensitive).
 */
import { readFileSync } from "node:fs";
import {
  enumerateWaterfallWindow,
  makeListPageFn,
  visitConversationMessages,
} from "../src/server/sync/call-harvest";
import { readHighLevelCreds } from "../src/server/sync/highlevel-live";
import { makeBudgetBoundedFetch } from "../src/server/sync/body-read";
import { getStore } from "../src/server/store";
import { PgStore } from "../src/server/store/pg";

const GRANT_SOURCE = "data-ops runner: evidence-backfill (owner approved 2026-11-02)";

export const EVIDENCE_BACKFILL_CHECKPOINT_KEY = "hl_evidence_backfill_v1";
/** The evidence floor — do NOT go older (pre-floor verdicts preserved by design). */
export const EVIDENCE_FLOOR_MS = Date.parse("2026-10-01T00:00:00Z");
const WATERFALL_WINDOW_MS = 6 * 3600_000;

interface QueueItem {
  id: string;
  mt: number[];
}

interface Checkpoint {
  listHiExclusive: number;
  listDone: boolean;
  queue: QueueItem[];
  listed: number;
  pruned: number;
  visited: number;
  evidenceFound: number;
  updated_at: string;
}

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

const RUN_MINUTES = Number.isFinite(Number(process.argv[2])) && process.argv[2] && !process.argv[2].startsWith("-") ? Number(process.argv[2]) : 45;

async function main(): Promise<void> {
  const store = await getStore(
    { storeFactory: (u) => new PgStore(u, { migrationCapability: { grantedBy: GRANT_SOURCE } }) },
  );
  const creds = readHighLevelCreds();
  if (!creds) throw new Error("HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID missing — cannot run the evidence backfill");

  const running = await store.getRunningSyncRun("highlevel");
  if (running) {
    const ageMs = Date.now() - Date.parse(running.started_at);
    if (ageMs < 2 * 3_600_000) {
      console.log(`SKIP: a highlevel sync is already running (started ${running.started_at}) — scheduler mutex.`);
      return;
    }
    await store.finishSyncRun(running.id, "error", 0, "reclaimed by evidence backfill (stale running row)");
  }
  const syncRunId = await store.insertSyncRun("highlevel");

  const budget = new AbortController();
  const deadline = Date.now() + RUN_MINUTES * 60_000;
  const interrupted = { v: false };
  const onInterrupt = (): void => {
    if (interrupted.v) process.exit(1);
    interrupted.v = true;
    console.log("[interrupt] aborting in-flight fetches; closing the sync row cleanly…");
    budget.abort();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  const fetchImpl = makeBudgetBoundedFetch(
    (input, init) => fetch(input, init),
    budget.signal,
    "evidence-backfill",
  );

  let cp: Checkpoint;
  const stored = await store.getSyncCheckpoint(EVIDENCE_BACKFILL_CHECKPOINT_KEY);
  try {
    const parsed = stored ? JSON.parse(stored) : null;
    cp = parsed && typeof parsed.listHiExclusive === "number" && Array.isArray(parsed.queue)
      ? (parsed as Checkpoint)
      : { listHiExclusive: Date.now() + 60_000, listDone: false, queue: [], listed: 0, pruned: 0, visited: 0, evidenceFound: 0, updated_at: new Date().toISOString() };
  } catch {
    cp = { listHiExclusive: Date.now() + 60_000, listDone: false, queue: [], listed: 0, pruned: 0, visited: 0, evidenceFound: 0, updated_at: new Date().toISOString() };
  }
  const save = async (): Promise<void> => {
    cp.updated_at = new Date().toISOString();
    await store.setSyncCheckpoint(EVIDENCE_BACKFILL_CHECKPOINT_KEY, JSON.stringify(cp));
  };

  let listRequests = 0;
  let evidenceUpserted = 0;
  try {
    const listPage = makeListPageFn(creds, fetchImpl, undefined, undefined, undefined);

    // ---- LIST phase: dateAdded waterfall down to the Oct-1 floor ----
    while (!cp.listDone && !budget.signal.aborted) {
      const outcome = await enumerateWaterfallWindow({
        listPage,
        hiExclusive: cp.listHiExclusive,
        stepMs: WATERFALL_WINDOW_MS,
        floorMs: EVIDENCE_FLOOR_MS,
        budget: { maxListRequests: 40 },
      });
      listRequests += outcome.requests;
      for (const row of outcome.rows) {
        cp.listed += 1;
        const pureCall = row.message_types.length > 0 && row.message_types.every((t) => t === 1);
        if (pureCall) {
          cp.pruned += 1;
          continue;
        }
        cp.queue.push({ id: row.conv_id, mt: row.message_types });
      }
      if (outcome.truncated.length > 0) {
        console.log(`WARN: ${outcome.truncated.length} window(s) could not be fully enumerated (dense range); re-run retries them`);
      }
      cp.listHiExclusive = outcome.nextHiExclusive;
      if (outcome.nextHiExclusive <= EVIDENCE_FLOOR_MS) cp.listDone = true;
      await save();
      if (outcome.requests === 0) break;
      if (Date.now() > deadline) break;
    }
    console.log(`[list] listed=${cp.listed} pruned-pure-call=${cp.pruned} queue=${cp.queue.length} listDone=${cp.listDone} requests=${listRequests}`);

    // ---- VISIT phase: fetch messages, persist NON-CALL rows as evidence ----
    while (cp.queue.length > 0 && !budget.signal.aborted && Date.now() <= deadline) {
      const item = cp.queue.shift()!;
      const visit = await visitConversationMessages({
        creds,
        fetchImpl,
        conversationId: item.id,
        windowStartMs: 0, // calls are discarded here; every non-call message is evidence
        collectEvidence: true,
      });
      cp.visited += 1;
      if (visit.evidence.length) {
        await store.upsertEvidenceMessages(visit.evidence);
        evidenceUpserted += visit.evidence.length;
        cp.evidenceFound += visit.evidence.length;
      }
      if (cp.visited % 25 === 0 || cp.queue.length === 0) {
        await save();
        console.log(`[visit] visited=${cp.visited} remaining=${cp.queue.length} evidence=${cp.evidenceFound}`);
      } else {
        await save();
      }
    }
    await save();
    const done = cp.listDone && cp.queue.length === 0;
    await store.finishSyncRun(syncRunId, "success", cp.evidenceFound, null);
    console.log(`DONE=${done} evidenceUpsertedThisRun=${evidenceUpserted} totalEvidence=${cp.evidenceFound} visitedTotal=${cp.visited}`);
  } catch (e) {
    await save().catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(syncRunId, "error", cp.evidenceFound, msg.slice(0, 400)).catch(() => {});
    throw e;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

await main();
