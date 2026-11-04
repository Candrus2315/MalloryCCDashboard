/**
 * CALL-RECORDS EXPORT INGEST — HighLevel's raw call export becomes the SOURCE
 * OF TRUTH for call KPIs (call-source implementation W1+W2, owner directive
 * approved 2026-11-04; root cause + contract: /home/team/shared/
 * call-source-diagnostic-2026-11-04.md).
 *
 * WHY: the fast incremental conversations walk loses calls under load (visit
 * cap 200/tick; scheduler advanced the watermark anyway — chronic −54/−31
 * calls on 11/2/11/3). The export endpoint returns the COMPLETE raw call
 * record set for a window (verified live 11/4: every DB call present + the
 * missing 25), so the raw records land in `hl_call_records` losslessly; the
 * W3 follow-up session switches the KPI computation onto that table.
 *
 * VERIFIED API CONTRACT (probed 2026-11-04, live against the Mallory location):
 *   GET https://services.leadconnectorhq.com/conversations/messages/export
 *   Headers: authorization Bearer <PIT key>, version 2021-07-28, accept json.
 *   Params: locationId, channel=Call, startDate/endDate ISO-8601
 *   (YYYY-MM-DDTHH:mm:ss.sssZ — epoch ms is rejected with HTTP 400),
 *   limit=1000; pagination via the request param `nextCursor` taken from the
 *   response's top-level `nextCursor` (response {messages, nextCursor, total,
 *   traceId}).
 *   Record: id, messageType (TYPE_CALL|TYPE_IVR_CALL), direction, contactId,
 *   conversationId, dateAdded, dateUpdated, userId (nullable), source,
 *   meta.call.status (completed|no-answer|failed|busy|voicemail|ringing),
 *   meta.call.duration (seconds, nullable), altId, from, to.
 *
 * SERIALIZATION: the tick ingest runs INSIDE the scheduler's existing
 * sync_runs guard (no new mutex); the backfill script optionally holds the
 * same mutex. Upserts are idempotent by message_id — the 5-min watermark
 * overlap re-pulls are harmless. Writes ONLY hl_call_records: `calls` /
 * `harvest_calls` / evidence pipelines stay untouched until W3.
 */
import { hlRequest, listOf, parseDurationSeconds, parseTimestamp, type FetchLike, type HighLevelCreds, type HlEndpointOpts } from "./highlevel-live";
import type { HlCallRecordRow } from "../store/types";

export const CALL_EXPORT_PATH = "/conversations/messages/export";
/** Verified page size (the endpoint caps at 1000). */
export const CALL_EXPORT_PAGE_LIMIT = 1000;
/** Runaway guard: 50 pages × 1000 = 50k records per pass (1–3 requests/day typical). */
export const CALL_EXPORT_MAX_PAGES = 50;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * ISO-8601 request param construction (verified contract: epoch ms → HTTP
 * 400). Accepts epoch ms, Date, or any parseable instant and renders the
 * exact UTC shape the endpoint accepts: YYYY-MM-DDTHH:mm:ss.sssZ.
 */
export function toIso8601Param(raw: number | Date | string): string {
  const ms = typeof raw === "number" ? raw : Date.parse(raw instanceof Date ? (raw as Date).toISOString() : raw);
  if (!Number.isFinite(ms)) throw new Error(`call-records export: unparsable window instant (${String(raw)})`);
  return new Date(ms).toISOString();
}

/** Pure query builder for one export page (asserted byte-for-byte in tests). */
export function buildCallExportQuery(opts: {
  locationId: string;
  startIso: string;
  endIso: string;
  cursor?: string | null;
  limit?: number;
}): URLSearchParams {
  const q = new URLSearchParams({
    locationId: opts.locationId,
    channel: "Call",
    startDate: toIso8601Param(opts.startIso),
    endDate: toIso8601Param(opts.endIso),
    limit: String(opts.limit ?? CALL_EXPORT_PAGE_LIMIT),
  });
  if (opts.cursor) q.set("nextCursor", opts.cursor);
  return q;
}

function optString(m: Record<string, unknown>, key: string): string | null {
  const v = m[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/**
 * Parse ONE export record → the raw row. Skipping rules: no `id`, or an
 * unparsable `dateAdded` (the W3 day-bucket key) — everything else is KEPT,
 * including TYPE_IVR_CALL (marked, filtered later) and null-userId rows
 * (team-level inbound; never dropped).
 */
export function parseCallExportMessage(m: Record<string, unknown>): HlCallRecordRow | null {
  const messageId = optString(m, "id");
  const dateAdded = parseTimestamp(m["dateAdded"]);
  if (!messageId || !dateAdded) return null;
  const meta = (m["meta"] ?? null) as Record<string, unknown> | null;
  const call = (meta?.["call"] ?? null) as Record<string, unknown> | null;
  // duration: null stays null (attempt without talk time — W3 talk-time sums
  // must not read a fabricated 0); a present-but-unparsable value → 0.
  const rawDuration = call?.["duration"];
  const duration = rawDuration == null ? null : parseDurationSeconds(rawDuration);
  return {
    message_id: messageId,
    user_external_id: optString(m, "userId"),
    contact_external_id: optString(m, "contactId"),
    conversation_id: optString(m, "conversationId"),
    direction: optString(m, "direction"),
    // verified carrier: meta.call.status (the older message shape used a
    // top-level status — same value, alternate shape, defensive fallback).
    call_status: (call && optString(call, "status")) ?? optString(m, "status"),
    duration_seconds: duration,
    date_added: dateAdded,
    // channel=Call only yields call flavors; a missing type is stored as the
    // plain call type (attempt-counting doctrine; only the exact
    // "TYPE_IVR_CALL" string is IVR for the W3 exclusion).
    message_type: optString(m, "messageType") ?? "TYPE_CALL",
    source: optString(m, "source"),
    from_number: optString(m, "from"),
    to_number: optString(m, "to"),
    raw: m,
  };
}

export interface CallRecordsWindow {
  records: HlCallRecordRow[];
  pages: number;
  requests: number;
  /** True when the page guard stopped the walk with a nextCursor still present. */
  truncated: boolean;
  skipped: number;
  warnings: string[];
}

/**
 * Fetch EVERY call record in [startIso, endIso] via cursor pagination.
 * Pure fetch+parse (no store access) — tests run against a stub fetchImpl.
 */
export async function fetchCallRecordsWindow(opts: {
  creds: HighLevelCreds;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Hard per-call cap (tests shrink it); default: the shared SYNC_FETCH_TIMEOUT_MS resolver. */
  timeoutMs?: number;
  startIso: string;
  endIso: string;
  maxPages?: number;
}): Promise<CallRecordsWindow> {
  const endpointOpts: HlEndpointOpts = { creds: opts.creds, fetchImpl: opts.fetchImpl, sleep: opts.sleep ?? defaultSleep, timeoutMs: opts.timeoutMs };
  const maxPages = opts.maxPages ?? CALL_EXPORT_MAX_PAGES;
  const records: HlCallRecordRow[] = [];
  const warnings: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let requests = 0;
  let truncated = false;
  let skipped = 0;
  for (;;) {
    if (pages >= maxPages) {
      truncated = cursor != null; // more pages existed than the guard allows
      if (truncated) warnings.push(`call-records export: ${maxPages}-page guard hit with more pages present — window not fully drained (${records.length} records so far); re-run continues (idempotent)`);
      break;
    }
    const query = buildCallExportQuery({ locationId: opts.creds.locationId, startIso: opts.startIso, endIso: opts.endIso, cursor });
    const body = (await hlRequest({ path: CALL_EXPORT_PATH, query }, endpointOpts)) as Record<string, unknown> | null;
    requests += 1;
    pages += 1;
    const items = listOf(body, "messages", "data") as Record<string, unknown>[];
    for (const m of items) {
      const row = parseCallExportMessage(m);
      if (row) records.push(row);
      else skipped += 1;
    }
    const next = body && typeof body["nextCursor"] === "string" && body["nextCursor"] ? (body["nextCursor"] as string) : null;
    if (!next || items.length === 0) break;
    cursor = next;
  }
  if (skipped > 0) warnings.push(`call-records export: ${skipped} record(s) without id/dateAdded skipped (never inventable)`);
  return { records, pages, requests, truncated, skipped, warnings };
}

/** Store port for the ingest (implemented by both stores). */
export interface CallRecordsStorePort {
  upsertHlCallRecords(rows: HlCallRecordRow[]): Promise<number>;
  getHlCallRecordsByMessageIds(messageIds: string[]): Promise<HlCallRecordRow[]>;
}

export interface CallRecordsIngestResult extends CallRecordsWindow {
  /** Record count fetched this pass (== records.length; summary convenience). */
  fetched: number;
  /** Rows handed to the upsert (always == fetched). */
  written: number;
  /** Rows NOT already stored before this pass (the backfill "NEW" counter). */
  inserted: number;
  /** The inserted rows themselves (per-user backfill summary; empty on re-runs). */
  newRows: HlCallRecordRow[];
}

/**
 * One idempotent ingest pass over a window: fetch → diff against stored ids →
 * upsert. The pre-diff (not a DB trick) supplies the exact "NEW rows" count
 * the backfill summary reports; it is race-free because every writer of this
 * table holds the provider highlevel sync_runs guard.
 */
export async function runCallRecordsIngest(opts: {
  store: CallRecordsStorePort;
  creds: HighLevelCreds;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  startIso: string;
  endIso: string;
  maxPages?: number;
}): Promise<CallRecordsIngestResult> {
  const win = await fetchCallRecordsWindow(opts);
  const ids = win.records.map((r) => r.message_id);
  const stored = new Set<string>();
  const SCAN_CHUNK = 5000;
  for (let i = 0; i < ids.length; i += SCAN_CHUNK) {
    for (const r of await opts.store.getHlCallRecordsByMessageIds(ids.slice(i, i + SCAN_CHUNK))) stored.add(r.message_id);
  }
  const inserted = win.records.filter((r) => !stored.has(r.message_id)).length;
  const newRows = win.records.filter((r) => !stored.has(r.message_id));
  const written = win.records.length ? await opts.store.upsertHlCallRecords(win.records) : 0;
  return { ...win, fetched: win.records.length, written, inserted, newRows };
}

/**
 * Pure backfill planner (W2): chunk [startMs, endExclusiveMs) into ≤24h
 * windows aligned to the START instant (2026-11-01T00:00:00-05:00 → every
 * boundary lands on an ET midnight). The last window is clipped at the end.
 * Exported for the boundary tests.
 */
export function planBackfillWindows(
  startMs: number,
  endExclusiveMs: number,
  chunkMs = 24 * 3_600_000,
): { startIso: string; endIso: string }[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endExclusiveMs) || endExclusiveMs <= startMs) return [];
  const windows: { startIso: string; endIso: string }[] = [];
  for (let lo = startMs; lo < endExclusiveMs; lo += chunkMs) {
    const hi = Math.min(lo + chunkMs, endExclusiveMs);
    windows.push({ startIso: new Date(lo).toISOString(), endIso: new Date(hi).toISOString() });
  }
  return windows;
}
