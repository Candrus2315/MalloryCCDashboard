/**
 * Resumable HighLevel call-harvest engine tests — synthetic lister/fetch, no
 * live API. Covers: uncapped full-range enumeration, chunk resumability
 * (progress + visited flags), idempotent call upserts by message id, call-flag
 * priority, lastMessageType filter propagation, and the "null duration never
 * qualifies" rule.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  enumerateRange,
  makeListPageFn,
  parseConvListItem,
  runHarvestChunk,
  type HarvestConvRow,
  type ListPageFn,
} from "../sync/call-harvest";
import type { HighLevelCreds } from "../sync/highlevel-live";
import type { NormalizedCall } from "../sync/adapters";

const CREDENTIALS: HighLevelCreds = { apiKey: "test-key", locationId: "test-loc" };
const T0 = Date.parse("2026-09-14T04:00:00.000Z");

function synthConv(i: number, over: Partial<HarvestConvRow> = {}): HarvestConvRow {
  return {
    conv_id: `conv-${String(i).padStart(4, "0")}`,
    last_message_date: T0 + i * 60_000,
    date_added: T0 + i * 60_000,
    message_types: [],
    last_message_type: null,
    contact_id: `contact-${i}`,
    assigned_to: null,
    ...over,
  };
}

/** listPage over a fixed sorted-by-dateAdded corpus, honoring [start,end) + limit 100. */
function listerFor(corpus: HarvestConvRow[]): ListPageFn {
  return async (startMs, endMsExclusive) => {
    const inRange = corpus.filter((c) => c.date_added >= startMs && c.date_added < endMsExclusive);
    return { rows: inRange.slice(0, 100), total: inRange.length };
  };
}

/** Fake fetch that answers /conversations/{id}/messages with a scripted payload. */
function messageFetcher(byConv: Map<string, Record<string, unknown>[]>, capturedUrls: string[] = []) {
  return async (url: string): Promise<Response> => {
    capturedUrls.push(url);
    const m = /\/conversations\/([^/]+)\/messages/.exec(url);
    const list = m ? (byConv.get(decodeURIComponent(m[1])) ?? []) : [];
    return new Response(JSON.stringify({ messages: { messages: list, nextPage: false, lastMessageId: null } }), { status: 200 });
  };
}

function callMessage(id: string, convId: string, atMs: number, duration: number | null, userId: string): Record<string, unknown> {
  return {
    id,
    messageType: "TYPE_CALL",
    conversationId: convId,
    contactId: "contact-x",
    userId,
    direction: "outbound",
    dateAdded: new Date(atMs).toISOString(),
    meta: { call: { duration, status: duration === null ? "no-answer" : "completed" } },
  };
}

describe("call harvest — enumeration", () => {
  test("binary partitioning enumerates a dense range fully (no page caps, no dupes)", async () => {
    const corpus = Array.from({ length: 350 }, (_, i) => synthConv(i, { date_added: T0 + i * 7_000, last_message_date: T0 + i * 7_000 }));
    const sink = { rows: [] as HarvestConvRow[], requests: 0, truncated: [] as { startMs: number; endMsExclusive: number; total: number }[] };
    await enumerateRange(listerFor(corpus), T0, T0 + 350 * 7_000 + 1, { maxListRequests: 200 }, sink);
    const ids = new Set(sink.rows.map((r) => r.conv_id));
    expect(ids.size).toBe(350);
    expect(sink.truncated.length).toBe(0);
    expect(sink.requests).toBeGreaterThan(3); // splits happened
  });

  test("parseConvListItem maps ids, messageTypes and dates", () => {
    const row = parseConvListItem({ id: "abc", dateAdded: T0, lastMessageDate: T0 + 5, messageTypes: [1, 2], lastMessageType: "TYPE_CALL", contactId: "c1", assignedTo: null });
    expect(row).not.toBeNull();
    expect(row!.conv_id).toBe("abc");
    expect(row!.message_types).toEqual([1, 2]);
    expect(row!.last_message_type).toBe("TYPE_CALL");
    expect(parseConvListItem({})).toBeNull();
  });
});

describe("call harvest — resumable chunks over the memory store", () => {
  function setup(nFlagged: number, nPlain: number) {
    const store = new MemoryStore();
    const corpus: HarvestConvRow[] = [];
    let i = 0;
    for (; i < nFlagged; i++) corpus.push(synthConv(i, { message_types: [1], last_message_type: "TYPE_CALL" }));
    for (; i < nFlagged + nPlain; i++) corpus.push(synthConv(i, { message_types: [2], last_message_type: "TYPE_SMS" }));
    const messages = new Map<string, Record<string, unknown>[]>();
    for (const c of corpus) {
      messages.set(
        c.conv_id,
        c.message_types.includes(1) ? [callMessage(`msg-${c.conv_id}`, c.conv_id, c.last_message_date + 1_000, 300, "rep-1")] : [callMessage(`sms-${c.conv_id}`, c.conv_id, c.last_message_date + 1_000, null, "rep-1")],
      );
    }
    const onCalls: NormalizedCall[][] = [];
    const NOW = T0 + 2 * 86_400_000; // fixed "now" near the corpus
    const base = {
      store,
      creds: CREDENTIALS,
      listPage: listerFor(corpus),
      fetchImpl: messageFetcher(messages),
      windowStartUtc: new Date(T0).toISOString(),
      floorMs: T0 - 60_000, // waterfall completes just below the corpus
      sleep: async () => {},
      onCalls: async (calls: NormalizedCall[]) => {
        onCalls.push(calls);
      },
      now: () => new Date(NOW),
    };
    return { store, corpus, onCalls, base };
  }

  test("list + visit chunks fill coverage; progress persists; re-run is a no-op", async () => {
    const { store, base, onCalls } = setup(3, 3);
    const r1 = await runHarvestChunk({ ...base, maxListRequests: 40, maxVisits: 2 });
    expect(r1.listComplete).toBe(true);
    expect(r1.visitsDone).toBe(2);
    expect(r1.callsFound).toBe(2);
    expect(r1.newCalls.length).toBe(2);
    expect(r1.coverageComplete).toBe(false);

    const r2 = await runHarvestChunk({ ...base, maxListRequests: 0, maxVisits: 10 });
    expect(r2.visitsDone).toBe(4);
    expect(r2.coverageComplete).toBe(true);

    const progress = await store.getHarvestProgress("highlevel-calls");
    expect(progress!.visits_done).toBe(6);
    expect(progress!.calls_found).toBe(6);

    const r3 = await runHarvestChunk({ ...base, maxListRequests: 0, maxVisits: 10 });
    expect(r3.visitsDone).toBe(0);
    expect(r3.callsFound).toBe(0);
    expect(onCalls.flat().length).toBe(6);
  });

  test("flagged conversations are visited first; every call lands exactly once (idempotent upsert)", async () => {
    const { store, base, onCalls } = setup(2, 2);
    const r = await runHarvestChunk({ ...base, maxListRequests: 40, maxVisits: 2 });
    // 2 visits = both flagged conversations (newest first), not the SMS ones
    expect(r.newCalls.length).toBe(2);
    expect(new Set(r.newCalls.map((c) => c.conversation_id)).size).toBe(2);
    // feed the SAME calls through the upsert path twice — dedup by message id
    const rows = r.newCalls.map((c) => ({
      id: "",
      provider: "highlevel",
      external_call_id: c.external_call_id,
      rep_id: null,
      contact_id: null,
      direction: c.direction,
      call_status: c.status,
      started_at: c.startedAt,
      duration_seconds: c.durationSeconds,
      over_two_minutes: c.durationSeconds > 120,
      provider_rep_external_id: c.repExternalId,
      conversation_id: c.conversation_id ?? null,
    }));
    expect(await store.upsertCalls(rows)).toBe(2);
    expect(await store.upsertCalls(rows)).toBe(2);
    const all = await store.getCallsBetween(new Date(T0).toISOString(), new Date(T0 + 86_400_000).toISOString());
    expect(all.length).toBe(2);
    expect(onCalls.length).toBeGreaterThan(0);
  });

  test("null-duration calls count as attempts but never as over-2-min", async () => {
    const store = new MemoryStore();
    const conv = synthConv(0, { message_types: [1], last_message_type: "TYPE_CALL" });
    const messages = new Map([[conv.conv_id, [callMessage("m-null", conv.conv_id, T0 + 1_000, null, "rep-1")]]]);
    const collected: NormalizedCall[] = [];
    await runHarvestChunk({
      store,
      creds: CREDENTIALS,
      listPage: listerFor([conv]),
      fetchImpl: messageFetcher(messages),
      windowStartUtc: new Date(T0).toISOString(),
      floorMs: T0 - 1_000,
      sleep: async () => {},
      onCalls: async (calls) => {
        collected.push(...calls);
      },
      now: () => new Date(T0 + 3_600_000),
    });
    expect(collected.length).toBe(1);
    expect(collected[0].durationSeconds).toBe(0); // null → attempt, duration unknown
    expect(collected[0].conversation_id).toBe(conv.conv_id);
  });

  test("calls outside the window are not collected", async () => {
    const store = new MemoryStore();
    const conv = synthConv(0, { message_types: [1], last_message_type: "TYPE_CALL" });
    const messages = new Map([
      [conv.conv_id, [callMessage("in", conv.conv_id, T0 + 1_000, 200, "rep-1"), callMessage("out", conv.conv_id, T0 - 86_400_000, 200, "rep-1")]],
    ]);
    const collected: NormalizedCall[] = [];
    await runHarvestChunk({
      store,
      creds: CREDENTIALS,
      listPage: listerFor([conv]),
      fetchImpl: messageFetcher(messages),
      windowStartUtc: new Date(T0).toISOString(),
      floorMs: T0 - 1_000,
      sleep: async () => {},
      onCalls: async (calls) => {
        collected.push(...calls);
      },
      now: () => new Date(T0 + 3_600_000),
    });
    expect(collected.map((c) => c.external_call_id)).toEqual(["in"]);
  });
});

describe("call harvest — live lister wiring", () => {
  test("lastMessageType filter and date bounds reach the URL", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      urls.push(url);
      return new Response(JSON.stringify({ conversations: [], total: 0 }), { status: 200 });
    };
    const listPage = makeListPageFn(CREDENTIALS, fetchImpl, async () => {}, { lastMessageType: "TYPE_CALL" });
    const out = await listPage(1000, 2000);
    expect(out.total).toBe(0);
    const u = new URL(urls[0]);
    expect(u.pathname).toContain("/conversations/search");
    expect(u.searchParams.get("lastMessageType")).toBe("TYPE_CALL");
    expect(u.searchParams.get("startDate")).toBe("1000");
    expect(u.searchParams.get("endDate")).toBe("2000");
    expect(u.searchParams.get("limit")).toBe("100");
  });
});
