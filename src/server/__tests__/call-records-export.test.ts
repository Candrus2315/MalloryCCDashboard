/**
 * Call-records export ingest tests (call-source W1+W2, owner directive
 * 2026-11-04) — MemoryStore-first, NO live API and NO production DB:
 *  - ISO-8601 param construction (the endpoint 400s on epoch ms).
 *  - Record parsing: IVR + null-user rows kept, null duration stays null.
 *  - Cursor pagination (request param nextCursor from the response field).
 *  - Page-guard truncation flag.
 *  - Ingest idempotency: same message twice → 1 stored row, inserted 1→0.
 *  - Backfill window boundaries (24h ET-aligned chunks, clipped tail).
 *  - Tick integration: the ingest runs inside the incremental tick and lands
 *    rows in the store (scheduler-level truncated-watermark pin lives in
 *    scheduler.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  buildCallExportQuery,
  CALL_EXPORT_MAX_PAGES,
  parseCallExportMessage,
  planBackfillWindows,
  runCallRecordsIngest,
  toIso8601Param,
} from "../sync/call-records-export";
import { schedulerTick, type SchedulerTickResult } from "../sync/scheduler";
import type { FetchLike } from "../sync/highlevel-live";

const CREDS = { apiKey: "test-key", locationId: "loc_123" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SAMPLE_CALL = {
  id: "msg_1",
  messageType: "TYPE_CALL",
  direction: "outbound",
  contactId: "cnt_1",
  conversationId: "conv_1",
  dateAdded: "2026-11-04T12:01:32Z",
  userId: "usr_allison",
  source: "calls",
  from: "+19175550001",
  to: "+19175550002",
  meta: { call: { status: "completed", duration: 240 } },
};

// ---------- ISO-8601 param construction ----------
describe("toIso8601Param / buildCallExportQuery", () => {
  test("renders the exact YYYY-MM-DDTHH:mm:ss.sssZ shape the endpoint accepts", () => {
    // ET-offset instant → UTC-normalized with ms + Z
    expect(toIso8601Param("2026-11-01T00:00:00-05:00")).toBe("2026-11-01T05:00:00.000Z");
    // epoch ms (the shape the endpoint REJECTS with 400) is converted, never passed raw
    const ms = Date.parse("2026-11-04T12:01:32.500Z");
    expect(toIso8601Param(ms)).toBe("2026-11-04T12:01:32.500Z");
    expect(toIso8601Param(new Date(ms))).toBe("2026-11-04T12:01:32.500Z");
  });
  test("unparsable instants throw (never a silent NaN param)", () => {
    expect(() => toIso8601Param("not-a-date")).toThrow();
  });
  test("query carries locationId, channel=Call, ISO bounds, limit=1000, nextCursor only when set", () => {
    const q = buildCallExportQuery({ locationId: "loc_123", startIso: "2026-11-01T00:00:00-05:00", endIso: "2026-11-02T00:00:00-05:00" });
    expect(q.get("locationId")).toBe("loc_123");
    expect(q.get("channel")).toBe("Call");
    expect(q.get("startDate")).toBe("2026-11-01T05:00:00.000Z");
    expect(q.get("endDate")).toBe("2026-11-02T05:00:00.000Z");
    expect(q.get("limit")).toBe("1000");
    expect(q.get("nextCursor")).toBeNull();
    const q2 = buildCallExportQuery({ locationId: "loc_123", startIso: "2026-11-01T05:00:00.000Z", endIso: "2026-11-02T05:00:00.000Z", cursor: "CUR1" });
    expect(q2.get("nextCursor")).toBe("CUR1");
  });
});

// ---------- record parsing ----------
describe("parseCallExportMessage", () => {
  test("maps every verified field onto the raw row", () => {
    const row = parseCallExportMessage(SAMPLE_CALL);
    expect(row).not.toBeNull();
    expect(row!.message_id).toBe("msg_1");
    expect(row!.user_external_id).toBe("usr_allison");
    expect(row!.contact_external_id).toBe("cnt_1");
    expect(row!.conversation_id).toBe("conv_1");
    expect(row!.direction).toBe("outbound");
    expect(row!.call_status).toBe("completed");
    expect(row!.duration_seconds).toBe(240);
    expect(row!.date_added).toBe("2026-11-04T12:01:32.000Z");
    expect(row!.message_type).toBe("TYPE_CALL");
    expect(row!.source).toBe("calls");
    expect(row!.from_number).toBe("+19175550001");
    expect(row!.to_number).toBe("+19175550002");
    expect(row!.raw).toEqual(SAMPLE_CALL);
  });
  test("TYPE_IVR_CALL is kept (marked, not dropped) and null userId = team-level", () => {
    const row = parseCallExportMessage({ id: "ivr_1", messageType: "TYPE_IVR_CALL", dateAdded: "2026-11-04T13:00:00Z", meta: { call: { status: "no-answer" } } });
    expect(row).not.toBeNull();
    expect(row!.message_type).toBe("TYPE_IVR_CALL");
    expect(row!.user_external_id).toBeNull(); // team-level — never dropped
    expect(row!.duration_seconds).toBeNull(); // no talk time reported
    expect(row!.call_status).toBe("no-answer");
  });
  test("a PRESENT zero duration stays 0; null stays null; unparsable string → 0", () => {
    expect(parseCallExportMessage({ id: "a", dateAdded: "2026-11-04T13:00:00Z", meta: { call: { duration: 0 } } })!.duration_seconds).toBe(0);
    expect(parseCallExportMessage({ id: "b", dateAdded: "2026-11-04T13:00:00Z", meta: { call: { duration: null } } })!.duration_seconds).toBeNull();
    expect(parseCallExportMessage({ id: "c", dateAdded: "2026-11-04T13:00:00Z", meta: { call: { duration: "weird" } } })!.duration_seconds).toBe(0);
  });
  test("records without id or parsable dateAdded are skipped (never inventable)", () => {
    expect(parseCallExportMessage({ messageType: "TYPE_CALL" })).toBeNull();
    expect(parseCallExportMessage({ id: "x", dateAdded: "nope" })).toBeNull();
  });
});

// ---------- cursor pagination ----------
describe("fetchCallRecordsWindow cursor pagination", () => {
  const msgs = (n: number, prefix: string, minute: number) =>
    Array.from({ length: n }, (_, i) => ({ ...SAMPLE_CALL, id: `${prefix}_${i}`, dateAdded: `2026-11-04T${String(minute).padStart(2, "0")}:00:00Z` }));

  test("walks every nextCursor page and collects all records", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      seenUrls.push(String(url));
      if (seenUrls.length === 1) return json({ messages: msgs(2, "p1", 9), nextCursor: "CUR1", total: 3 });
      return json({ messages: [SAMPLE_CALL], nextCursor: null, total: 3 });
    };
    const win = await runCallRecordsIngest({
      store: new MemoryStore(),
      creds: CREDS,
      fetchImpl,
      startIso: "2026-11-04T05:00:00.000Z",
      endIso: "2026-11-05T05:00:00.000Z",
    });
    expect(win.pages).toBe(2);
    expect(win.requests).toBe(2);
    expect(win.fetched).toBe(3);
    expect(win.truncated).toBe(false);
    // the 2nd request carried the response's cursor as the nextCursor PARAM
    const u2 = new URL(seenUrls[1]);
    expect(u2.searchParams.get("nextCursor")).toBe("CUR1");
    expect(u2.searchParams.get("channel")).toBe("Call");
  });

  test("page guard with more pages present → truncated=true + warning (window not drained)", async () => {
    const fetchImpl = async (): Promise<Response> => json({ messages: msgs(2, "p", 9), nextCursor: "MORE" });
    const win = await runCallRecordsIngest({
      store: new MemoryStore(),
      creds: CREDS,
      fetchImpl,
      startIso: "2026-11-04T05:00:00.000Z",
      endIso: "2026-11-05T05:00:00.000Z",
      maxPages: 1,
    });
    expect(win.truncated).toBe(true);
    expect(win.warnings.some((w) => w.includes("not fully drained"))).toBe(true);
  });

  test("an empty page body (no messages, no cursor) is a clean zero", async () => {
    const win = await runCallRecordsIngest({
      store: new MemoryStore(),
      creds: CREDS,
      fetchImpl: async () => json({}),
      startIso: "2026-11-04T05:00:00.000Z",
      endIso: "2026-11-05T05:00:00.000Z",
    });
    expect(win.fetched).toBe(0);
    expect(win.inserted).toBe(0);
    expect(win.pages).toBe(1);
    expect(win.truncated).toBe(false);
  });
});

// ---------- ingest idempotency + store round-trip (MemoryStore) ----------
describe("runCallRecordsIngest idempotency (MemoryStore)", () => {
  test("same message twice → written 2, inserted 2→0, exactly 2 stored rows", async () => {
    const store = new MemoryStore();
    const fetchImpl = async (): Promise<Response> => json({ messages: [SAMPLE_CALL, { ...SAMPLE_CALL, id: "msg_2", messageType: "TYPE_IVR_CALL", userId: null }], nextCursor: null });
    const opts = { store, creds: CREDS, fetchImpl, startIso: "2026-11-04T05:00:00.000Z", endIso: "2026-11-05T05:00:00.000Z" } as const;

    const first = await runCallRecordsIngest(opts);
    expect(first.fetched).toBe(2);
    expect(first.written).toBe(2);
    expect(first.inserted).toBe(2);
    expect(first.newRows.map((r) => r.message_id).sort()).toEqual(["msg_1", "msg_2"]);

    const second = await runCallRecordsIngest(opts);
    expect(second.written).toBe(2); // upsert re-writes, idempotent
    expect(second.inserted).toBe(0); // nothing NEW
    expect(second.newRows).toEqual([]);

    expect(await store.countHlCallRecords()).toBe(2); // 2 distinct ids, not 4 rows
    const rows = await store.getHlCallRecordsByMessageIds(["msg_1", "msg_2"]);
    expect(rows.length).toBe(2);
    // the IVR + null-user row survived (team-level rows are kept, marked)
    const ivr = rows.find((r) => r.message_id === "msg_2");
    expect(ivr?.message_type).toBe("TYPE_IVR_CALL");
    expect(ivr?.user_external_id).toBeNull();
  });
});

// ---------- backfill window boundaries ----------
describe("planBackfillWindows", () => {
  test("24h ET-aligned chunks from the Nov-1 floor; tail clipped at the end", () => {
    const startMs = Date.parse("2026-11-01T00:00:00-05:00"); // 05:00Z
    const endMs = Date.parse("2026-11-04T14:00:00Z"); // mid-window clip
    const windows = planBackfillWindows(startMs, endMs);
    expect(windows.length).toBe(4);
    expect(windows[0]).toEqual({ startIso: "2026-11-01T05:00:00.000Z", endIso: "2026-11-02T05:00:00.000Z" });
    expect(windows[1]).toEqual({ startIso: "2026-11-02T05:00:00.000Z", endIso: "2026-11-03T05:00:00.000Z" });
    expect(windows[2]).toEqual({ startIso: "2026-11-03T05:00:00.000Z", endIso: "2026-11-04T05:00:00.000Z" });
    // last window: starts at the last aligned boundary, clipped to the end
    expect(windows[3]).toEqual({ startIso: "2026-11-04T05:00:00.000Z", endIso: "2026-11-04T14:00:00.000Z" });
    // contiguous coverage — no gaps, no overlap
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].startIso).toBe(windows[i - 1].endIso);
    }
  });
  test("exactly-one-day and sub-day windows collapse to single chunks; inverted window → none", () => {
    const startMs = Date.parse("2026-11-01T05:00:00.000Z");
    expect(planBackfillWindows(startMs, startMs + 24 * 3_600_000).length).toBe(1);
    expect(planBackfillWindows(startMs, startMs + 3_600_000).length).toBe(1);
    expect(planBackfillWindows(startMs, startMs)).toEqual([]);
  });
});

// ---------- tick integration ----------
describe("schedulerTick call-records ingest integration", () => {
  test("the incremental tick pulls the export and lands raw rows in the store", async () => {
    const store = new MemoryStore();
    const watermarkIso = new Date(Date.parse("2026-11-04T17:00:00Z")).toISOString();
    await store.setSyncWatermark("highlevel", watermarkIso);
    const seenUrls: string[] = [];
    const res: SchedulerTickResult = await schedulerTickWithExport(store, seenUrls);
    expect(res.outcome).toBe("synced");
    // the export was queried over (watermark − 5-min overlap) → tick start
    const exportUrls = seenUrls.filter((u) => u.includes("/conversations/messages/export"));
    expect(exportUrls.length).toBeGreaterThan(0);
    const startParam = new URL(exportUrls[0]).searchParams.get("startDate");
    expect(startParam).toBe(new Date(Date.parse(watermarkIso) - 300_000).toISOString());
    // rows landed
    const rows = await store.getHlCallRecordsByMessageIds(["tick_call_1"]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.user_external_id).toBe("usr_new");
    expect(res.callRecords?.inserted).toBe(1);
    expect(res.callRecords?.truncated).toBe(false);
    // W4 (untruncated path): the watermark still advances on a clean tick
    expect(res.watermarkAdvanced).toBe(true);
    expect(Date.parse((await store.getSyncWatermark("highlevel"))!)).toBeGreaterThan(Date.parse(watermarkIso));
  });
});

/**
 * Fixture fetch for the tick integration: the standard incremental routes
 * (users/conversations/messages/contacts) return small bodies; the export
 * route returns one in-window call record for usr_new.
 */
async function schedulerTickWithExport(store: MemoryStore, seen: string[]): Promise<SchedulerTickResult> {
  const fetchImpl: FetchLike = async (url: string): Promise<Response> => {
    seen.push(String(url));
    const path = String(url).split("?")[0];
    if (path.endsWith("/users/")) return json({ users: [{ id: "usr_new", firstName: "Alex", lastName: "Morgan", email: "alex@mallory.test" }] });
    if (path.endsWith("/conversations/search")) return json({ conversations: [] });
    if (path.endsWith("/conversations/messages/export")) {
      return json({ messages: [{ id: "tick_call_1", messageType: "TYPE_CALL", direction: "outbound", contactId: "cnt_new", conversationId: "conv_new", dateAdded: "2026-11-04T16:59:00Z", userId: "usr_new", meta: { call: { status: "completed", duration: 120 } } }], nextCursor: null, total: 1 });
    }
    return json({});
  };
  return schedulerTick({ store, creds: { apiKey: "k", locationId: "loc_123" }, fetchImpl, trigger: "background", liveAdapters: { sheets: null } });
}

// guard constants stay honest
test("export page limit is the verified 1000 and the runaway guard is in place", () => {
  const q = buildCallExportQuery({ locationId: "l", startIso: "2026-11-01T05:00:00.000Z", endIso: "2026-11-02T05:00:00.000Z" });
  expect(q.get("limit")).toBe("1000");
  expect(CALL_EXPORT_MAX_PAGES).toBeGreaterThan(1);
});
