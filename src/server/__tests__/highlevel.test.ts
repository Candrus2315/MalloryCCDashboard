/**
 * HighLevel live-adapter tests — recorded-JSON fixtures through a stub fetch,
 * NO live API calls. Fixture shapes mirror the REAL endpoints as probed on the
 * Mallory location (2026-09-26): /users/ unpaginated, /contacts/ cursor-paged
 * with meta.startAfterId, calls extracted from /conversations/search +
 * /conversations/{id}/messages (messageType TYPE_CALL, meta.call.duration in
 * seconds — GET /calls/ is 404 on this account), opportunities via POST
 * /opportunities/search. Covers: duration/timestamp parsing, all pagination
 * styles, 429 backoff retry, error classification (401), unexpected shapes
 * (warn, don't crash), row-level skip rules, store upsert idempotency,
 * runDemoSync live wiring (connection row + demo-content replacement), and
 * the live-failure demo fallback.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  LiveHighLevelAdapter,
  parseDurationSeconds,
  parseHlCall,
  parseHlContact,
  parseHlOpportunity,
  parseHlUser,
  parseTimestamp,
  type FetchLike,
} from "../sync/highlevel-live";
import { runDemoSync } from "../sync/run";
import type { HighLevelAdapter } from "../sync/adapters";
import { addDays } from "../date-logic";

// ---------- fixtures (recorded from the real API v2 responses) ----------
const NOW = Date.now();
const daysAgoMs = (d: number) => NOW - d * 86_400_000;
const daysAgoIso = (d: number) => new Date(daysAgoMs(d)).toISOString();

const USERS_BODY = {
  users: [
    { id: "usr_001", firstName: "Alex", lastName: "Morgan", email: "alex@mallory.test", deleted: false },
    { id: "usr_002", name: "Priya Shah", email: "priya@mallory.test", deleted: false },
    { id: "usr_gone", name: "Deleted Rep", email: null, deleted: true },
  ],
  traceId: "t1",
};

const CONTACTS_P1 = {
  contacts: [
    { id: "cnt_001", contactName: "Emma Carter", phone: "+19175550142", email: "emma@example.test", assignedTo: "usr_001" },
    { id: "cnt_002", contactName: "Liam Nguyen", phone: "+19175550188", email: "liam@example.test", assignedUserId: "usr_002" },
  ],
  meta: { total: 3, startAfterId: "cursor_1" },
  traceId: "t2",
};
const CONTACTS_P2 = {
  contacts: [{ id: "cnt_003", firstName: "Ava", lastName: "Stone", phone: "", email: "ava@example.test", assignedTo: "usr_003" }],
  meta: {},
  traceId: "t3",
};

const CONVS_P1 = {
  conversations: [
    { id: "conv_A", lastMessageDate: daysAgoMs(2), contactId: "cnt_001", type: "TYPE_PHONE", lastMessageType: "TYPE_CALL" },
    { id: "conv_B", lastMessageDate: daysAgoMs(3), contactId: "cnt_002", type: "TYPE_PHONE", lastMessageType: "TYPE_SMS" },
    // out of window: must NOT be visited for messages
    { id: "conv_C", lastMessageDate: daysAgoMs(45), contactId: "cnt_003", type: "TYPE_PHONE", lastMessageType: "TYPE_CALL" },
  ],
  total: 3,
  traceId: "t4",
};
const CONVS_P2 = { conversations: [], total: 3, traceId: "t5" };

const MSGS_A_P1 = {
  messages: {
    lastMessageId: "cursor1",
    nextPage: true,
    messages: [
      { id: "call_001", direction: "outbound", status: "completed", contactId: "cnt_001", userId: "usr_001", conversationId: "conv_A", dateAdded: daysAgoIso(2), meta: { call: { duration: 38, status: "completed" } }, messageType: "TYPE_CALL" },
      { id: "sms_1", direction: "outbound", contactId: "cnt_001", dateAdded: daysAgoIso(2), body: "text", messageType: "TYPE_SMS" },
      // duplicate id (messages can repeat across cursor pages) — deduped
      { id: "call_001", direction: "outbound", status: "completed", contactId: "cnt_001", userId: "usr_001", dateAdded: daysAgoIso(2), meta: { call: { duration: 38, status: "completed" } }, messageType: "TYPE_CALL" },
    ],
  },
  traceId: "t6",
};
const MSGS_A_P2 = {
  messages: {
    lastMessageId: null,
    nextPage: false,
    messages: [
      { id: "call_002", direction: "inbound", status: "voicemail", contactId: "cnt_001", userId: "usr_001", conversationId: "conv_A", dateAdded: daysAgoIso(3), meta: { call: { duration: null, status: "voicemail" } }, messageType: "TYPE_CALL" },
    ],
  },
  traceId: "t7",
};
const MSGS_B_P1 = {
  messages: {
    lastMessageId: null,
    nextPage: false,
    messages: [
      // in-window 3-minute call (ISO-8601 duration) + an out-of-window call that must be excluded
      { id: "call_003", direction: "outbound", status: "completed", contactId: "cnt_002", userId: "usr_002", conversationId: "conv_B", dateAdded: daysAgoIso(3), meta: { call: { duration: "PT3M0S", status: "completed" } }, messageType: "TYPE_CALL" },
      { id: "call_old", direction: "outbound", status: "completed", contactId: "cnt_002", userId: "usr_002", dateAdded: daysAgoIso(45), meta: { call: { duration: 500, status: "completed" } }, messageType: "TYPE_CALL" },
    ],
  },
  traceId: "t8",
};

const OPPS_P1 = {
  opportunities: [
    { id: "opp_001", name: "Family Session — Carter", status: "open", monetaryValue: 450000, contactId: "cnt_001", assignedTo: "usr_001", pipelineId: "pipe_1", pipelineStageId: "stage_1", createdAt: daysAgoIso(2), updatedAt: daysAgoIso(1) },
    { id: "opp_002", name: "Animalia Session — Nguyen", status: "won", monetaryValue: "1200.50", contactId: "cnt_002" },
  ],
  meta: { total: 3, startAfterId: "cursor_o1" },
  traceId: "t9",
};
const OPPS_P2 = {
  opportunities: [{ id: "opp_003", name: "Weird value", status: "open", monetaryValue: "not-a-number", contactId: "cnt_003" }],
  meta: { total: 3 },
  traceId: "t10",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface SeenReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Stub fetch dispatching on path + method; per-endpoint ordered page lists
 * (clamped to the last page when exhausted, like a stable API snapshot).
 */
function makeFetch(pages: Record<string, unknown[]>, opts: { apiKey: string; locationId: string; seen?: SeenReq[] }): FetchLike {
  const pageIdx: Record<string, number> = {};
  return async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    opts.seen?.push({ url: u, method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    const path = u.split("?")[0];
    for (const key of Object.keys(pages)) {
      const [pkey, pmethod] = key.split("|");
      if (path === `/${pkey}` || path.endsWith(`/${pkey}`) || path.includes(`/${pkey}/`)) {
        if (pmethod && pmethod !== method) continue;
        const list = pages[key];
        const i = Math.min(pageIdx[key] ?? 0, list.length - 1);
        pageIdx[key] = (pageIdx[key] ?? 0) + 1;
        return json(list[i]);
      }
    }
    return json({ error: `unmatched ${method} ${u}` }, 404);
  };
}

const CREDENTIALS = { apiKey: "test-api-key", locationId: "loc_123" };
const SLEEP_NOOP = async () => {};

function stubAdapter(pages: Record<string, unknown[]>, extra: { pageSize?: number } = {}) {
  return new LiveHighLevelAdapter({
    creds: CREDENTIALS,
    fetchImpl: makeFetch(pages, { apiKey: CREDENTIALS.apiKey, locationId: CREDENTIALS.locationId }),
    sleep: SLEEP_NOOP,
    pageSize: 2,
    ...extra,
  });
}

function fullPages() {
  return {
    "users|GET": [USERS_BODY],
    "contacts|GET": [CONTACTS_P1, CONTACTS_P2],
    "conversations/search|GET": [CONVS_P1, CONVS_P2],
    "messages|GET": [MSGS_A_P1, MSGS_A_P2, MSGS_B_P1],
    "opportunities/search|POST": [OPPS_P1, OPPS_P2],
  };
}

// ---------- pure parsers ----------
describe("parseDurationSeconds", () => {
  test("number seconds", () => expect(parseDurationSeconds(305)).toBe(305));
  test("numeric string seconds", () => expect(parseDurationSeconds("90")).toBe(90));
  test("float seconds rounds", () => expect(parseDurationSeconds(90.6)).toBe(91));
  test("ISO-8601 PT durations", () => {
    expect(parseDurationSeconds("PT1M30S")).toBe(90);
    expect(parseDurationSeconds("PT2H")).toBe(7200);
    expect(parseDurationSeconds("PT45S")).toBe(45);
    expect(parseDurationSeconds("PT1H2M3S")).toBe(3723);
    expect(parseDurationSeconds("P1DT0H0M30S")).toBe(86430);
  });
  test("clock strings", () => {
    expect(parseDurationSeconds("1:30")).toBe(90);
    expect(parseDurationSeconds("0:05:12")).toBe(312);
    expect(parseDurationSeconds("2:00:05")).toBe(7205);
  });
  test("junk → 0 (never NaN)", () => {
    expect(parseDurationSeconds(null)).toBe(0);
    expect(parseDurationSeconds(undefined)).toBe(0);
    expect(parseDurationSeconds("")).toBe(0);
    expect(parseDurationSeconds("five minutes")).toBe(0);
    expect(parseDurationSeconds(-4)).toBe(0);
  });
});

describe("parseTimestamp", () => {
  test("ISO string passes through normalized", () => {
    expect(parseTimestamp("2026-09-20T14:03:00Z")).toBe("2026-09-20T14:03:00.000Z");
    expect(parseTimestamp("2026-09-22T10:00:00-04:00")).toBe("2026-09-22T14:00:00.000Z");
  });
  test("epoch ms and epoch seconds", () => {
    expect(parseTimestamp(1758369600000)).toBe("2025-09-20T12:00:00.000Z");
    expect(parseTimestamp("1758369600")).toBe("2025-09-20T12:00:00.000Z");
  });
  test("junk → null", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("not a date")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });
});

describe("row parsers", () => {
  test("user: id required; deleted users skipped; name from parts", () => {
    expect(parseHlUser({ id: "u1", firstName: "A", lastName: "B" })).toEqual({ external_id: "u1", name: "A B", email: null });
    expect(parseHlUser({ id: "u2", name: "N", deleted: true })).toBeNull();
    expect(parseHlUser({ firstName: "A" })).toBeNull();
  });
  test("contact: phone/email trimmed; assignedTo or assignedUserId rep linkage", () => {
    const c = parseHlContact({ id: "c1", contactName: "X", phone: " ", email: "x@y.z", assignedTo: "u9" })!;
    expect(c.phone).toBeNull();
    expect(c.assignedRepExternalId).toBe("u9");
    expect(parseHlContact({ id: "c2", assignedUserId: "u7" })!.assignedRepExternalId).toBe("u7");
    expect(parseHlContact({ nope: true })).toBeNull();
  });
  test("call: TYPE_CALL only; missing contactId or timestamp → skipped; duration from meta.call", () => {
    expect(parseHlCall({ id: "k", contactId: "c", dateAdded: "2026-09-01T00:00:00Z", messageType: "TYPE_SMS", body: "hi" })).toBeNull();
    expect(parseHlCall({ id: "k", contactId: "c", dateAdded: "2026-09-01T00:00:00Z", meta: { call: { duration: 38, status: "completed" } }, messageType: "TYPE_CALL" })!.durationSeconds).toBe(38);
    expect(parseHlCall({ id: "k", dateAdded: "2026-09-01T00:00:00Z" })).toBeNull();
    expect(parseHlCall({ id: "k", contactId: "c" })).toBeNull();
    const voicemail = parseHlCall({ id: "k2", contactId: "c", dateAdded: "2026-09-01T00:00:00Z", meta: { call: { duration: null, status: "voicemail" } }, messageType: "TYPE_CALL" })!;
    expect(voicemail.durationSeconds).toBe(0); // honest: duration unknown, not invented
    expect(voicemail.status).toBe("voicemail");
  });
  test("opportunity: money normalization + pipelineStageId", () => {
    const p = parseHlOpportunity({ id: "o1", status: "won", monetaryValue: "1200.50", pipelineStageId: "st1" })!;
    expect(p.monetaryValue).toBe(1200.5);
    expect(p.stageId).toBe("st1");
    expect(parseHlOpportunity({ id: "o2", monetaryValue: "NaN" })!.monetaryValue).toBe(0);
  });
});

// ---------- adapter over fixtures ----------
describe("LiveHighLevelAdapter (fixture fetch)", () => {
  test("users: single unpaginated request (no limit param — the endpoint 422s on it); deleted skipped", async () => {
    const seen: SeenReq[] = [];
    const adapter = new LiveHighLevelAdapter({
      creds: CREDENTIALS,
      fetchImpl: makeFetch({ "users|GET": [USERS_BODY] }, { apiKey: CREDENTIALS.apiKey, locationId: CREDENTIALS.locationId, seen }),
      sleep: SLEEP_NOOP,
    });
    const users = await adapter.fetchUsers();
    expect(users.map((u) => u.external_id)).toEqual(["usr_001", "usr_002"]);
    expect(seen.length).toBe(1);
    expect(seen[0].url).not.toContain("limit=");
    expect(seen[0].url).toContain("locationId=loc_123");
    expect(seen[0].headers.authorization).toBe(`Bearer ${CREDENTIALS.apiKey}`);
    expect(seen[0].headers.version).toBe("2021-07-28");
  });

  test("contacts: cursor pagination via meta.startAfterId, capped", async () => {
    const seen: SeenReq[] = [];
    const adapter = new LiveHighLevelAdapter({
      creds: CREDENTIALS,
      fetchImpl: makeFetch({ "contacts|GET": [CONTACTS_P1, CONTACTS_P2] }, { apiKey: CREDENTIALS.apiKey, locationId: CREDENTIALS.locationId, seen }),
      sleep: SLEEP_NOOP,
      pageSize: 2,
    });
    const contacts = await adapter.fetchContacts();
    expect(contacts.map((c) => c.external_id)).toEqual(["cnt_001", "cnt_002", "cnt_003"]);
    expect(seen.length).toBe(2);
    expect(seen[0].url).not.toContain("startAfterId");
    expect(seen[1].url).toContain("startAfterId=cursor_1");
  });

  test("calls: conversations in window visited, out-of-window skipped, dedupe, durations", async () => {
    const seen: SeenReq[] = [];
    const adapter = new LiveHighLevelAdapter({
      creds: CREDENTIALS,
      fetchImpl: makeFetch(
        { "conversations/search|GET": [CONVS_P1, CONVS_P2], "messages|GET": [MSGS_A_P1, MSGS_A_P2, MSGS_B_P1] },
        { apiKey: CREDENTIALS.apiKey, locationId: CREDENTIALS.locationId, seen },
      ),
      sleep: SLEEP_NOOP,
    });
    const calls = await adapter.fetchCalls();
    // call_001 deduped; call_002 (voicemail) + call_003 (PT3M0S) in; call_old (45d) out; sms_1 not a call
    expect(calls.map((c) => c.external_call_id).sort()).toEqual(["call_001", "call_002", "call_003"]);
    expect(calls.find((c) => c.external_call_id === "call_001")!.durationSeconds).toBe(38);
    expect(calls.find((c) => c.external_call_id === "call_002")!.durationSeconds).toBe(0);
    expect(calls.find((c) => c.external_call_id === "call_003")!.durationSeconds).toBe(180);
    // only in-window conversations visited
    expect(seen.some((r) => r.url.includes("/conversations/conv_A/messages"))).toBe(true);
    expect(seen.some((r) => r.url.includes("/conversations/conv_B/messages"))).toBe(true);
    expect(seen.some((r) => r.url.includes("/conversations/conv_C/messages"))).toBe(false);
    // conversations/search paged by offset, messages cursor-paged via lastMessageId
    expect(seen.some((r) => r.url.includes("/conversations/search") && r.url.includes("offset=0"))).toBe(true);
    expect(seen.some((r) => r.url.includes("/conversations/conv_A/messages") && r.url.includes("lastMessageId=cursor1"))).toBe(true);
    expect(adapter.lastRun.windowStart).toBeTruthy();
  });

  test("429 is retried with backoff and then succeeds", async () => {
    let attempts = 0;
    const adapter = new LiveHighLevelAdapter({
      creds: CREDENTIALS,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : json({ users: USERS_BODY.users });
      },
      sleep: SLEEP_NOOP,
    });
    const users = await adapter.fetchUsers();
    expect(attempts).toBe(2);
    expect(users.length).toBe(2);
  });

  test("401 → actionable auth error naming the secret", async () => {
    const adapter = new LiveHighLevelAdapter({ creds: CREDENTIALS, fetchImpl: async () => new Response("{}", { status: 401 }), sleep: SLEEP_NOOP });
    await expect(adapter.fetchUsers()).rejects.toThrow(/HIGHLEVEL_API_KEY/);
  });

  test("unexpected payload shape → empty result + warning, no crash", async () => {
    const adapter = stubAdapter({ "contacts|GET": [{ unexpected: true }] });
    const contacts = await adapter.fetchContacts();
    expect(contacts).toEqual([]);
  });

  test("opportunities: POST search cursor-paged (offset REJECTED live: 422), money strings + garbage → 0", async () => {
    const seen: SeenReq[] = [];
    const adapter = new LiveHighLevelAdapter({
      creds: CREDENTIALS,
      fetchImpl: makeFetch({ "opportunities/search|POST": [OPPS_P1, OPPS_P2] }, { apiKey: CREDENTIALS.apiKey, locationId: CREDENTIALS.locationId, seen }),
      sleep: SLEEP_NOOP,
      pageSize: 2,
    });
    const opps = await adapter.fetchOpportunities();
    expect(opps.length).toBe(3);
    expect(opps.find((o) => o.external_id === "opp_002")!.monetaryValue).toBe(1200.5);
    expect(opps.find((o) => o.external_id === "opp_003")!.monetaryValue).toBe(0);
    expect(opps.find((o) => o.external_id === "opp_001")!.stageId).toBe("stage_1");
    expect(seen[0].method).toBe("POST");
    const body = JSON.parse(seen[0].body ?? "{}");
    expect(body.locationId).toBe("loc_123");
    // live quirk (2026-09-26): the endpoint 422s on `offset` — cursor only
    expect("offset" in body).toBe(false);
    expect(JSON.parse(seen[1].body ?? "{}").startAfterId).toBe("cursor_o1");
  });
});

// ---------- store idempotency ----------
describe("store upsert idempotency (MemoryStore)", () => {
  test("re-running the live sync never duplicates rows", async () => {
    const store = new MemoryStore();
    const runOnce = async () => {
      await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: stubAdapter(fullPages()) });
    };
    await runOnce();
    const [users, contacts, calls, opps] = [await store.getUsers(), await store.getContacts(), await store.getAllCallsSince("1970-01-01"), await store.getOpportunities()];
    await runOnce();
    const [users2, contacts2, calls2, opps2] = [await store.getUsers(), await store.getContacts(), await store.getAllCallsSince("1970-01-01"), await store.getOpportunities()];
    expect(users2.length).toBe(users.length);
    expect(contacts2.length).toBe(contacts.length);
    expect(calls2.length).toBe(calls.length);
    expect(opps2.length).toBe(opps.length);
    // live replaced demo: no demo-* external ids remain
    expect(users2.every((u) => !u.external_id.startsWith("demo-"))).toBe(true);
    expect(contacts2.every((c) => !c.external_id.startsWith("demo-"))).toBe(true);
    expect(opps2.length).toBe(3);
  });
});

// ---------- runDemoSync wiring ----------
describe("runDemoSync HighLevel wiring", () => {
  test("live success: real data replaces demo content; connection connected/demo=false; metrics read real calls", async () => {
    const store = new MemoryStore();
    // 1) demo content exists first (as in the current DB)
    await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null });
    const demoUsers = await store.getUsers();
    expect(demoUsers.some((u) => u.external_id.startsWith("demo-"))).toBe(true);

    // 2) live sync with fixtures
    const res = await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: stubAdapter(fullPages()) });
    const hl = res.providers.find((p) => p.provider === "highlevel")!;
    expect(hl.error).toBeNull();
    expect(hl.count).toBe(2 + 3 + 3 + 3); // users (deleted skipped) + contacts + calls + opportunities

    const conn = (await store.getConnections()).find((c) => c.provider === "highlevel")!;
    expect(conn.status).toBe("connected");
    expect(conn.is_demo).toBe(false);
    expect(conn.last_error).toBeNull();
    expect(conn.config.source).toBe("highlevel-api");
    expect(String(conn.config.note)).toContain("calls: 3 in 30-day window");

    // exactly the live entities remain — demo content replaced. getAllUsers()
    // (raw rows) is the right lens here: fixture users don't match the owner's
    // active roster, so getUsers() (active-only) correctly returns none of them.
    const users = await store.getAllUsers();
    expect(users.map((u) => u.external_id).sort()).toEqual(["usr_001", "usr_002"]);
    const contacts = await store.getContacts();
    expect(contacts.map((c) => c.external_id).sort()).toEqual(["cnt_001", "cnt_002", "cnt_003"]);
    const calls = await store.getAllCallsSince(addDays(new Date().toISOString().slice(0, 10), -30));
    expect(calls.length).toBe(3);
    // duration + threshold flag land in the store for the metrics layer:
    // 38s and voicemail(0s) are under the 120s default, the 180s call is over
    const c1 = calls.find((c) => c.duration_seconds === 38)!;
    expect(c1.over_two_minutes).toBe(false);
    expect(calls.filter((c) => c.over_two_minutes).length).toBe(1);
    // rep linkage resolves (rep metrics group by rep_id)
    expect(calls.every((c) => c.contact_id !== null)).toBe(true);
    expect(calls.every((c) => c.rep_id !== null)).toBe(true);
    // opportunities stored with internal contact/rep ids
    const opps = await store.getOpportunities();
    expect(opps.length).toBe(3);
    const o1 = opps.find((o) => o.external_id === "opp_001")!;
    expect(o1.contact_id).toBeTruthy();
    expect(o1.rep_id).toBeTruthy();
    expect(o1.monetary_value).toBe(450000);
  });

  test("live failure: demo seed SKIPPED (roster protection) + honest error connection row", async () => {
    const store = new MemoryStore();
    const failing = new LiveHighLevelAdapter({ creds: CREDENTIALS, fetchImpl: async () => new Response("{}", { status: 401 }), sleep: SLEEP_NOOP });
    const res = await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: failing });
    const hl = res.providers.find((p) => p.provider === "highlevel")!;
    expect(hl.error).toContain("HIGHLEVEL_API_KEY");
    const conn = (await store.getConnections()).find((c) => c.provider === "highlevel")!;
    expect(conn.status).toBe("error");
    // stale LIVE data is shown, not demo data — demo reps must never re-enter
    // a live-connected database (owner roster directive)
    expect(conn.is_demo).toBe(false);
    expect(conn.last_error).toContain("HIGHLEVEL_API_KEY");
    expect((await store.getAllUsers()).some((u) => u.external_id.startsWith("demo-"))).toBe(false);
    expect((await store.getOpportunities()).length).toBe(0);
  });

  test("no credentials (highlevelAdapter: null): demo run + demo connection row", async () => {
    const store = new MemoryStore();
    await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null });
    const conn = (await store.getConnections()).find((c) => c.provider === "highlevel")!;
    expect(conn.status).toBe("demo");
    expect(conn.is_demo).toBe(true);
    expect((await store.getOpportunities()).length).toBe(0);
  });

  test("HighLevelAdapter interface still satisfied by the demo adapter (no opportunities)", async () => {
    const demo: HighLevelAdapter = new (class {
      provider = "highlevel" as const;
      isDemo = true;
      async fetchUsers() {
        return [];
      }
      async fetchContacts() {
        return [];
      }
      async fetchCalls() {
        return [];
      }
    })();
    expect(demo.isDemo).toBe(true);
  });
});

describe("MemoryStore.deleteDemoHighLevelRows", () => {
  test("removes demo rows only, keeps live rows + nulls dangling refs, idempotent", async () => {
    const store = new MemoryStore();
    await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null }); // seeds demo users/contacts/calls
    await store.upsertUsers([{ id: "", provider: "highlevel", external_id: "live_rep", name: "Live Rep", email: null, is_active: true }]);
    const res = await store.deleteDemoHighLevelRows();
    expect(res.users).toBeGreaterThan(0);
    expect(res.calls).toBeGreaterThan(0);
    const users = await store.getUsers();
    expect(users.length).toBe(1);
    expect(users[0].external_id).toBe("live_rep");
    // second call is a no-op
    const again = await store.deleteDemoHighLevelRows();
    expect(again).toEqual({ users: 0, contacts: 0, calls: 0 });
  });
});
