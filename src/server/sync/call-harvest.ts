/**
 * RESUMABLE, UNCAPPED HighLevel call harvest — the accuracy layer for every
 * rep-call metric. Replaces the capped conversation scan that shipped with
 * highlevel-live.ts (CONVERSATION_SCAN_PAGES / CONVERSATION_VISIT_CAP), which
 * silently truncated rep-call coverage on this location (fingerprint: Allison
 * Wittner 9/25→6, 9/24→0, 9/23→16 calls — lumpy truncation, not reality).
 *
 * REAL API CONTRACT (probed against the Mallory location, 2026-09-26 — the
 * docs and this account disagree; every line below was verified live):
 *  - GET /conversations/search?locationId&limit=100 → newest-first by
 *    lastMessageDate, `{conversations, total, traceId}`. `limit` caps at 100
 *    (422 above). **`offset` is silently IGNORED** (every offset returns the
 *    same first page) — offset pagination is IMPOSSIBLE on this endpoint.
 *  - `startDate`/`endDate` (epoch ms) DO work as a CONJUNCTIVE half-open
 *    window on the conversation's `dateAdded` (creation), NOT lastMessageDate.
 *    Verified: [A,∞)=421, [M,∞)=156, [A,M)=265, [M,B)=156 — all consistent
 *    with [startDate, endDate) on dateAdded. A 0-width window returns 0.
 *  - Because dateAdded has ms precision and the window filter is exact,
 *    RECURSIVE BINARY PARTITIONING of a dateAdded range enumerates EVERY
 *    conversation with bounded requests (~2N/100 + depth overhead). This is
 *    the uncapped listing primitive — no page/visit caps anywhere.
 *  - Conversation list rows carry `messageTypes` (numeric codes; 1 = call —
 *    verified against message payloads) and `lastMessageType` (string,
 *    "TYPE_CALL"). ~13% of recent conversations contain a call; visiting
 *    those first (fast path) recovers most rep calls cheaply, then the
 *    resumable sweep visits the rest until coverage is 100%.
 *  - Messages page properly: /conversations/{id}/messages?limit=50 with
 *    `messages.lastMessageId` + `messages.nextPage` cursor (verified). Call
 *    messages carry messageType="TYPE_CALL", meta.call.duration (seconds, null
 *    for voicemail/no-answer), direction, status, userId, contactId,
 *    conversationId, altId, ISO dateAdded.
 *
 * CALL DEFINITION (owner spec, encoded here and in metrics/compute.ts):
 *  - A call = a conversation message with messageType === "TYPE_CALL".
 *    Total calls = ALL legitimate call attempts (voicemail / no-answer /
 *    null-duration included — they are attempts).
 *  - Over 2 Min = meta.call.duration > threshold (default 120s). A null
 *    duration NEVER qualifies.
 *  - SMS/email/Live-chat messages, conversations as a whole, and duplicate
 *    fetches (deduped by message id in the DB upsert) never count.
 *
 * RESUMABILITY: all progress persists in the DB (harvest_conversations +
 * harvest_progress). A stopped/killed run resumes exactly where it left off:
 * the dateAdded waterfall cursor for listing, visited flags for visiting.
 *
 * SERIALIZATION: every chunk runs inside a sync_runs row for provider
 * "highlevel" (the same row the 90s incremental scheduler and manual SYNC NOW
 * check), so the harvester and the fast incremental sync never overlap (429
 * protection).
 */
import { hlRequest, listOf, parseHlCall, type HighLevelCreds, type HlEndpointOpts } from "./highlevel-live";
import type { NormalizedCall } from "./adapters";
import type { HarvestConvRow, HarvestProgressRow } from "../store/types";

export type { HarvestConvRow, HarvestProgressRow } from "../store/types";

/** Numeric message-type code for calls in conversation.messageTypes (probed). */
export const MESSAGE_TYPE_CODE_CALL = 1;
/** Hard floor for the dateAdded waterfall (before the business existed). */
export const HISTORY_FLOOR_MS = Date.parse("2024-01-01T00:00:00Z");
/** Per-visit soft page cap (50 msgs/page ⇒ 40 pages = 2000 messages/conv) with warning. */
export const MAX_MESSAGE_PAGES_PER_VISIT = 25;

// ---------- list-row parsing ----------

export function parseConvListItem(c: Record<string, unknown>): HarvestConvRow | null {
  const id = typeof c["id"] === "string" && c["id"] ? c["id"] : null;
  if (!id) return null;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : Date.parse(String(v ?? "")) || 0;
  const types = Array.isArray(c["messageTypes"])
    ? (c["messageTypes"] as unknown[]).map((t) => Number(t)).filter((t) => Number.isFinite(t))
    : [];
  return {
    conv_id: id,
    last_message_date: num(c["lastMessageDate"]),
    date_added: num(c["dateAdded"]),
    message_types: types,
    last_message_type: typeof c["lastMessageType"] === "string" ? c["lastMessageType"] : null,
    contact_id: typeof c["contactId"] === "string" ? c["contactId"] : null,
    assigned_to: typeof c["assignedTo"] === "string" ? c["assignedTo"] : null,
  };
}

// ---------- the pure enumeration planner ----------

export interface ListPageResult {
  rows: HarvestConvRow[];
  total: number;
}

/** Fetch one dateAdded-bounded page (injectable for tests). */
export type ListPageFn = (startMs: number, endMsExclusive: number) => Promise<ListPageResult>;

export interface EnumerationBudget {
  maxListRequests: number;
  /** abort enumerating a window whose width falls below this (ms) — collision guard */
  minWidthMs?: number;
}

export interface EnumerationOutcome {
  rows: HarvestConvRow[];
  requests: number;
  /** Ranges we could not fully enumerate (window too narrow with >100 convs). */
  truncatedRanges: { startMs: number; endMsExclusive: number; total: number }[];
}

/**
 * Depth-first enumeration of a HALF-OPEN dateAdded range [startMs, endMs).
 * Splits recursively while total > 100 (the single-page limit). The dateAdded
 * filter is exact + unique per conversation, so this terminates and covers
 * every conversation in the range.
 */
export async function enumerateRange(
  listPage: ListPageFn,
  startMs: number,
  endMsExclusive: number,
  budget: { maxListRequests: number; minWidthMs?: number },
  sink: { rows: HarvestConvRow[]; requests: number; truncated: EnumerationOutcome["truncatedRanges"] },
): Promise<void> {
  if (budget.maxListRequests <= 0) return;
  const minWidth = budget.minWidthMs ?? 1_000; // 1 second floor
  const page = await listPage(startMs, endMsExclusive);
  budget.maxListRequests -= 1;
  sink.requests += 1;
  if (page.total <= 100) {
    sink.rows.push(...page.rows);
    return;
  }
  // >100 in window → split. Zero-width guard: keep splitting down to minWidth.
  const width = endMsExclusive - startMs;
  if (width <= minWidth) {
    sink.rows.push(...page.rows); // first 100 of an un-splittable dense range
    sink.truncated.push({ startMs, endMsExclusive, total: page.total });
    return;
  }
  const mid = startMs + Math.floor(width / 2);
  await enumerateRange(listPage, startMs, mid, budget, sink);
  if (budget.maxListRequests <= 0) return;
  await enumerateRange(listPage, mid, endMsExclusive, budget, sink);
}

/**
 * One waterfall step: fully enumerate the dateAdded window [hi - stepMs, hi)
 * newest-first. Returns the rows plus the advanced cursor. The harvester
 * persists the cursor after each window so a stopped run resumes.
 */
export async function enumerateWaterfallWindow(opts: {
  listPage: ListPageFn;
  hiExclusive: number;
  stepMs: number;
  floorMs: number;
  budget: { maxListRequests: number; minWidthMs?: number };
}): Promise<{ rows: HarvestConvRow[]; requests: number; nextHiExclusive: number; truncated: EnumerationOutcome["truncatedRanges"] }> {
  const startMs = Math.max(opts.hiExclusive - opts.stepMs, opts.floorMs);
  const sink = { rows: [] as HarvestConvRow[], requests: 0, truncated: [] as EnumerationOutcome["truncatedRanges"] };
  await enumerateRange(opts.listPage, startMs, opts.hiExclusive, opts.budget, sink);
  return {
    rows: sink.rows,
    requests: sink.requests,
    nextHiExclusive: startMs,
    truncated: sink.truncated,
  };
}

// ---------- message visiting ----------

/**
 * Fetch every message page of one conversation (resumable via lastMessageId
 * cursor; uncapped in the spec sense — the only bound is the per-conversation
 * message-count guard above, which warns loudly when hit). Returns parsed
 * TYPE_CALL messages within [windowStartMs, ∞).
 */
export async function visitConversationMessages(opts: {
  hlRequestFn?: typeof hlRequest;
  creds: HighLevelCreds;
  fetchImpl: HlEndpointOpts["fetchImpl"];
  sleep?: (ms: number) => Promise<void>;
  conversationId: string;
  windowStartMs: number;
  maxPages?: number;
}): Promise<{ calls: NormalizedCall[]; messagesScanned: number; warnings: string[] }> {
  const doRequest = opts.hlRequestFn ?? hlRequest;
  const endpointOpts: HlEndpointOpts = { creds: opts.creds, fetchImpl: opts.fetchImpl, sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) };
  const calls = new Map<string, NormalizedCall>();
  const warnings: string[] = [];
  let messagesScanned = 0;
  let lastMessageId: string | null = null;
  const maxPages = opts.maxPages ?? MAX_MESSAGE_PAGES_PER_VISIT;
  let exhausted = false;
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ limit: "50" });
    if (lastMessageId) query.set("lastMessageId", lastMessageId);
    const body = (await doRequest({ path: `/conversations/${opts.conversationId}/messages`, query }, endpointOpts)) as Record<string, unknown> | null;
    const wrapper = (body?.["messages"] ?? null) as Record<string, unknown> | null;
    const messages = listOf(wrapper as Record<string, unknown> | null, "messages", "data") as Record<string, unknown>[];
    messagesScanned += messages.length;
    for (const m of messages) {
      const call = parseHlCall(m);
      if (call && Date.parse(call.startedAt) >= opts.windowStartMs) {
        call.conversation_id = opts.conversationId;
        calls.set(call.external_call_id, call);
      }
    }
    lastMessageId = typeof (wrapper as Record<string, unknown> | null)?.["lastMessageId"] === "string" ? ((wrapper as Record<string, unknown>)["lastMessageId"] as string) : null;
    const more = (wrapper as Record<string, unknown> | null)?.["nextPage"];
    const hasNext = more === true || (typeof more === "string" && more !== "false" && more !== "0");
    if (!hasNext || !lastMessageId || messages.length === 0) {
      exhausted = false;
      break;
    }
    if (page + 1 < maxPages) await endpointOpts.sleep(100); // pacing between pages
    exhausted = true;
  }
  if (exhausted) {
    warnings.push(`conversation ${opts.conversationId}: message scan stopped at the ${maxPages}-page guard — very long conversation, some older in-window calls may be missing`);
  }
  return { calls: [...calls.values()], messagesScanned, warnings };
}

// ---------- live listPage over the real API ----------

/** Build the real ListPageFn against /conversations/search (startDate/endDate = dateAdded bounds).
 *  `extraQuery` adds server-side narrowing (e.g. lastMessageType=TYPE_CALL — probed to work;
 *  the numeric messageTypes param is IGNORED by this endpoint). */
export function makeListPageFn(creds: HighLevelCreds, fetchImpl: HlEndpointOpts["fetchImpl"], sleep?: (ms: number) => Promise<void>, extraQuery?: Record<string, string>): ListPageFn {
  const endpointOpts: HlEndpointOpts = { creds, fetchImpl, sleep: sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) };
  return async (startMs, endMsExclusive) => {
    const query = new URLSearchParams({ locationId: creds.locationId, limit: "100", startDate: String(startMs), endDate: String(endMsExclusive) });
    for (const [k, v] of Object.entries(extraQuery ?? {})) query.set(k, v);
    const body = (await hlRequest({ path: "/conversations/search", query }, endpointOpts)) as Record<string, unknown> | null;
    const items = listOf(body, "conversations", "data") as Record<string, unknown>[];
    const rows: HarvestConvRow[] = [];
    for (const raw of items) {
      const row = parseConvListItem(raw);
      if (row) rows.push(row);
    }
    const total = typeof body?.["total"] === "number" ? body["total"] : rows.length;
    return { rows, total };
  };
}

// ---------- store-facing row + progress shapes ----------

export interface HarvestStorePort {
  getHarvestProgress(id: string): Promise<HarvestProgressRow | null>;
  saveHarvestProgress(p: HarvestProgressRow): Promise<void>;
  upsertHarvestConversations(rows: HarvestConvRow[]): Promise<number>;
  getUnvisitedInWindow(windowStartMs: number, limit: number, callFlaggedFirst: boolean): Promise<HarvestConvRow[]>;
  markHarvestVisited(convIds: string[], callsFoundByConv: Record<string, number>, messagesScannedByConv?: Record<string, number>): Promise<void>;
}

// ---------- chunk runner ----------

export interface HarvestChunkResult {
  listRequests: number;
  conversationsListed: number;
  visitsDone: number;
  callsFound: number;
  messagesScanned: number;
  listComplete: boolean;
  coverageComplete: boolean;
  warnings: string[];
  /** Parsed in-window call messages found this chunk (upsert-ready). */
  newCalls: NormalizedCall[];
}

export interface HarvestChunkOpts {
  store: HarvestStorePort;
  creds: HighLevelCreds;
  fetchImpl: HlEndpointOpts["fetchImpl"];
  sleep?: (ms: number) => Promise<void>;
  /** Backfill window (ET-day-aligned): conversations active on/after this instant are in scope. */
  windowStartUtc: string;
  /** Budgets for ONE chunk (kept small so a chunk fits between scheduler ticks). */
  maxListRequests?: number;
  maxVisits?: number;
  waterfallWindowMs?: number;
  /** Inject a real-request lister (tests); default: the live makeListPageFn. */
  listPage?: ListPageFn;
  /** Server-side narrowing for the default lister (e.g. { lastMessageType: "TYPE_CALL" }). */
  listExtraQuery?: Record<string, string>;
  /** Which harvest_progress row owns this pass's cursor (default 'highlevel-calls'). */
  progressId?: string;
  /** Pacing sleep between conversation visits (ms). */
  visitSleepMs?: number;
  /** Lower bound of the dateAdded waterfall (default HISTORY_FLOOR_MS). */
  floorMs?: number;
  /** When true, skip fast-path ordering (tests). */
  disableFastPath?: boolean;
  /** Callback that persists parsed calls (upsert by external id) — caller owns rep mapping. */
  onCalls?: (calls: NormalizedCall[]) => Promise<void>;
  now?: () => Date;
}

function defaultProgress(id: string, windowStartUtc: string, startedIso: string, nowMs: number): HarvestProgressRow {
  return {
    id,
    window_start_utc: windowStartUtc,
    list_hi_exclusive: nowMs + 60_000, // small slack for clock skew / future-dated rows
    list_complete: false,
    list_requests: 0,
    conversations_listed: 0,
    visits_done: 0,
    calls_found: 0,
    messages_scanned: 0,
    started_at: startedIso,
    updated_at: startedIso,
    completed_at: null,
    last_error: null,
  };
}

/**
 * TRUE when every in-window conversation has been visited: no unvisited row
 * remains and the list phase is complete. The caller uses this to flip
 * stale-state warnings off (never present partial coverage as final).
 */
export async function harvestCoverageComplete(store: HarvestStorePort, windowStartUtc: string, progressId = "highlevel-calls"): Promise<boolean> {
  const progress = await store.getHarvestProgress(progressId);
  if (!progress || !progress.list_complete) return false;
  const unvisited = await store.getUnvisitedInWindow(Date.parse(windowStartUtc), 1, false);
  return unvisited.length === 0;
}

/**
 * Run ONE bounded, resumable harvest chunk:
 *  1. LIST phase — advance the dateAdded waterfall (every window fully
 *     enumerated by recursive partitioning; NO page/visit caps), persist
 *     discovered conversations, save the cursor after each window.
 *  2. VISIT phase — message-fetch unvisited in-window conversations:
 *     call-flagged (messageTypes contains 1) first (fast path — the cheap
 *     subset that holds most rep calls), then the sweep; parsed TYPE_CALL
 *     messages are handed to onCalls (upsert by external id); each visited
 *     conversation is marked so a stopped run resumes exactly.
 * Serialized by the CALLER via the provider highlevel sync_runs row (the
 * 90s incremental scheduler checks the same mutex).
 */
export async function runHarvestChunk(opts: HarvestChunkOpts): Promise<HarvestChunkResult> {
  const maxListRequests = opts.maxListRequests ?? 40;
  const maxVisits = opts.maxVisits ?? 30;
  const waterfallWindowMs = opts.waterfallWindowMs ?? 6 * 3600_000;
  const floorMs = opts.floorMs ?? HISTORY_FLOOR_MS;
  const windowStartMs = Date.parse(opts.windowStartUtc);
  const now = opts.now ?? (() => new Date());

  const progress = (await opts.store.getHarvestProgress(opts.progressId ?? "highlevel-calls")) ?? defaultProgress(opts.progressId ?? "highlevel-calls", opts.windowStartUtc, now().toISOString(), now().getTime());
  const listPage = opts.listPage ?? makeListPageFn(opts.creds, opts.fetchImpl, opts.sleep, opts.listExtraQuery);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const result: HarvestChunkResult = {
    listRequests: 0,
    conversationsListed: 0,
    visitsDone: 0,
    callsFound: 0,
    messagesScanned: 0,
    listComplete: progress.list_complete,
    coverageComplete: false,
    warnings: [],
    newCalls: [],
  };

  try {
    // ---- LIST phase: dateAdded waterfall, every window fully enumerated ----
    if (!progress.list_complete) {
      let requestsLeft = maxListRequests;
      while (requestsLeft > 0 && !progress.list_complete) {
        const outcome = await enumerateWaterfallWindow({
          listPage,
          hiExclusive: progress.list_hi_exclusive,
          stepMs: waterfallWindowMs,
          floorMs,
          budget: { maxListRequests: requestsLeft },
        });
        result.listRequests += outcome.requests;
        requestsLeft -= outcome.requests;
        progress.list_requests += outcome.requests;
        if (outcome.rows.length > 0) {
          const upserted = await opts.store.upsertHarvestConversations(outcome.rows);
          progress.conversations_listed += upserted;
          result.conversationsListed += upserted;
        }
        for (const t of outcome.truncated) {
          result.warnings.push(`list: dateAdded window [${new Date(t.startMs).toISOString()}, ${new Date(t.endMsExclusive).toISOString()}) holds ${t.total} conversations — enumeration floor hit; some in-window calls may be missing (re-run to retry this window)`);
        }
        if (outcome.truncated.length > 0) {
          // Cannot advance past an un-enumerable window (rows share a ms) —
          // stop the list phase here; the warning is surfaced, never silent.
          progress.updated_at = now().toISOString();
          await opts.store.saveHarvestProgress(progress);
          break;
        }
        if (outcome.nextHiExclusive <= floorMs) {
          progress.list_complete = true;
          progress.list_hi_exclusive = floorMs;
        } else {
          progress.list_hi_exclusive = outcome.nextHiExclusive;
        }
        progress.updated_at = now().toISOString();
        await opts.store.saveHarvestProgress(progress); // resumable cursor after every window
        if (outcome.requests === 0) break; // budget exhausted mid-window
      }
      result.listComplete = progress.list_complete;
    }

    // ---- VISIT phase: fast path (call-flagged) first, then the sweep ----
    if (maxVisits > 0) {
      const batch = await opts.store.getUnvisitedInWindow(windowStartMs, maxVisits, !opts.disableFastPath);
      for (const conv of batch) {
        if (result.visitsDone >= maxVisits) break;
        const visit = await visitConversationMessages({
          creds: opts.creds,
          fetchImpl: opts.fetchImpl,
          sleep: opts.sleep,
          conversationId: conv.conv_id,
          windowStartMs,
        });
        result.visitsDone += 1;
        result.messagesScanned += visit.messagesScanned;
        result.callsFound += visit.calls.length;
        if (visit.warnings.length) result.warnings.push(...visit.warnings);
        if (visit.calls.length) {
          result.newCalls.push(...visit.calls);
          if (opts.onCalls) await opts.onCalls(visit.calls);
        }
        const callsByConv: Record<string, number> = { [conv.conv_id]: visit.calls.length };
        const msgsByConv: Record<string, number> = { [conv.conv_id]: visit.messagesScanned };
        await opts.store.markHarvestVisited([conv.conv_id], callsByConv, msgsByConv);
        progress.visits_done += 1;
        progress.calls_found += visit.calls.length;
        progress.messages_scanned += visit.messagesScanned;
        await sleep(opts.visitSleepMs ?? 100); // pacing between conversation visits (429-aware via hlRequest retries)
      }
      progress.updated_at = now().toISOString();
      await opts.store.saveHarvestProgress(progress);
    }

    result.coverageComplete = await harvestCoverageComplete(opts.store, opts.windowStartUtc);
    if (result.coverageComplete && !progress.completed_at) {
      progress.completed_at = now().toISOString();
      progress.updated_at = now().toISOString();
      await opts.store.saveHarvestProgress(progress);
    }
    return result;
  } catch (e) {
    progress.last_error = e instanceof Error ? e.message : String(e);
    progress.updated_at = now().toISOString();
    await opts.store.saveHarvestProgress(progress).catch(() => {});
    throw e;
  }
}
