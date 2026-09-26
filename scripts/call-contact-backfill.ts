/**
 * ONE-TIME CONTROLLED BACKFILL: call→contact identity restoration (owner-
 * ratified attribution program, Session 2). Restores calls.contact_id for
 * historical call rows using the local DB ledgers:
 *
 *   bun run scripts/call-contact-backfill.ts
 *
 * - CHECKPOINTED: progress persists in sync_checkpoints under the NEW key
 *   "hl_call_contact_backfill_v1" after EVERY batch — interrupt at any point
 *   and rerun the SAME command; it resumes exactly where it stopped.
 * - IDEMPOTENT: verdicts are FILL-NULL-ONLY (an existing non-null contact_id
 *   is never overwritten — direct source data always wins) and per-call
 *   resolution is deterministic, so reruns duplicate nothing and rewrite only
 *   what they can re-derive.
 * - LOCALLY-DRIVEN: reads calls, harvest_calls (direct message contactId),
 *   harvest_conversations (parent conversation contactId), the canonical
 *   contacts index (exact phone/email) — NO HighLevel traffic by default.
 *   The harvest ledger is verified to carry contact_external_id for every
 *   harvested message, so the optional targeted HL fetch (ONLY for calls
 *   whose source ids are genuinely absent from both ledgers) stays OFF unless
 *   CALL_CONTACT_FETCH_MISSING=1 is set explicitly.
 *
 * Status / progress:
 *   SELECT value FROM sync_checkpoints WHERE key='hl_call_contact_backfill_v1';
 *
 * Reset (only if you really mean it — drops the cursor; fill-null-only makes
 * a from-scratch rerun safe, just slower):
 *   DELETE FROM sync_checkpoints WHERE key='hl_call_contact_backfill_v1';
 *
 * RUN WINDOW: Session 3 runs this AFTER the HL contacts backfill completes
 * (until then most ledger contact ids cannot resolve to contacts rows yet —
 * the run would record them "unresolved"; a later run fills them).
 */
import {
  CALL_CONTACT_BACKFILL_CHECKPOINT_KEY,
  parseCallContactCheckpoint,
  runCallContactBackfillChunk,
  type BackfillCallRow,
  type CallContactSourceIdentity,
} from "../src/server/sync/call-contact-backfill";
import { readHighLevelCreds, hlRequest } from "../src/server/sync/highlevel-live";
import { getStore } from "../src/server/store";

const BATCH_SIZE = Number(process.env.CALL_CONTACT_BATCH_SIZE ?? 200);
const MAX_MINUTES = Number(process.env.CALL_CONTACT_MAX_MINUTES ?? 10);
const FETCH_MISSING = process.env.CALL_CONTACT_FETCH_MISSING === "1";

const store = await getStore();

// ---------- verify first: who would need a targeted HL call? ----------
const allCalls = (await store.getAllCallsSince("1970-01-01T00:00:00.000Z")) as (BackfillCallRow & { provider: string })[];
const unresolved = allCalls.filter((c) => c.contact_id == null);
const messageIds = unresolved.map((c) => c.external_call_id).filter((x): x is string => !!x);
const convIds = [...new Set(unresolved.map((c) => c.conversation_id).filter((x): x is string => !!x))];
const [ledgerRows, convRows] = await Promise.all([
  store.getHarvestCallsByMessageIds(messageIds),
  store.getHarvestConversationsByIds(convIds),
]);
const ledgerContactIds = new Set(ledgerRows.filter((r) => r.contact_external_id).map((r) => r.message_id));
const convContactConvs = new Set(convRows.filter((r) => r.contact_id).map((r) => r.conv_id));
const withDirect = unresolved.filter((c) => c.external_call_id && ledgerContactIds.has(c.external_call_id)).length;
const withParent = unresolved.filter(
  (c) => !(c.external_call_id && ledgerContactIds.has(c.external_call_id)) && c.conversation_id && convContactConvs.has(c.conversation_id),
).length;
const missingSource = unresolved.length - withDirect - withParent;
console.log(`verify: ${unresolved.length} calls without contact_id · direct-ledger ${withDirect} · parent-conversation ${withParent} · genuinely missing source ids ${missingSource}`);

// ---------- optional targeted HL fetch (explicit flag only) ----------
async function fetchSourceIdentity(call: BackfillCallRow): Promise<CallContactSourceIdentity | null> {
  if (!FETCH_MISSING || !call.conversation_id) return null;
  const creds = readHighLevelCreds();
  if (!creds) return null;
  const opts = { creds, fetchImpl: fetch, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) };
  const body = (await hlRequest({ path: `/conversations/${call.conversation_id}/messages`, query: new URLSearchParams({ limit: "50" }) }, opts)) as Record<string, unknown> | null;
  const wrapper = (body?.["messages"] ?? null) as Record<string, unknown> | null;
  const messages = (wrapper?.["messages"] ?? wrapper?.["data"] ?? []) as Record<string, unknown>[];
  for (const m of messages) {
    if (call.external_call_id && String(m["id"] ?? "") === call.external_call_id) {
      return {
        messageContactExternalId: typeof m["contactId"] === "string" ? m["contactId"] : null,
        conversationContactExternalId: null,
      };
    }
  }
  return null;
}

// ---------- resume-or-start ----------
const port = Object.assign(store, { fetchSourceIdentity });
const existingCp = parseCallContactCheckpoint(await store.getSyncCheckpoint(CALL_CONTACT_BACKFILL_CHECKPOINT_KEY));
if (existingCp) {
  console.log(`RESUMING: ${existingCp.scanned} scanned / ${existingCp.filled} filled · cursor ${existingCp.lastStartedAt ?? "-"} · methods ${JSON.stringify(existingCp.byMethod)}`);
} else {
  console.log("STARTING from the oldest unresolved call (no usable checkpoint)");
}
if (missingSource > 0 && !FETCH_MISSING) {
  console.log(`note: ${missingSource} call(s) lack local source ids — rerun with CALL_CONTACT_FETCH_MISSING=1 to attempt a targeted HL fetch (default off)`);
}

const deadline = Date.now() + MAX_MINUTES * 60_000;
let chunks = 0;
let lastResult = { scanned: 0, filled: 0, done: existingCp?.done ?? false };
for (;;) {
  const r = await runCallContactBackfillChunk({
    store: port,
    batchSize: BATCH_SIZE,
    log: (line) => {
      if (chunks === 0) console.log(`  ${line}`);
    },
    now: () => new Date(),
  });
  chunks += 1;
  lastResult = { scanned: r.scanned, filled: r.filled, done: r.done };
  if (r.scanned === 0) break; // nothing left (done) or fully processed
  if (r.done) break;
  if (Date.now() >= deadline) {
    console.log("time budget reached — checkpoint saved, rerun the same command to resume");
    break;
  }
}

const cp = parseCallContactCheckpoint(await store.getSyncCheckpoint(CALL_CONTACT_BACKFILL_CHECKPOINT_KEY));
console.log(JSON.stringify({
  chunksThisRun: chunks,
  scannedThisRun: lastResult.scanned,
  filledThisRun: lastResult.filled,
  done: lastResult.done,
  checkpoint: cp,
}));
const storedCalls = await store.getAllCallsSince("1970-01-01T00:00:00.000Z");
const stillUnresolved = storedCalls.filter((c) => c.contact_id == null).length;
console.log(`DB calls: ${storedCalls.length} · still without contact_id: ${stillUnresolved}`);
process.exit(0);
