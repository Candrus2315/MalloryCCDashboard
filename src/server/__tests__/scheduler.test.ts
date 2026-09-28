/**
 * Background scheduler tests — fixture-based, NO live API. Covers the owner
 * directive behaviors:
 *  - SKIP while a highlevel sync run is already in progress (sync_runs row);
 *    a running row older than the stale cutoff is treated as crashed and the
 *    tick proceeds.
 *  - SKIP when no HighLevel credentials resolve (demo mode).
 *  - INCREMENTAL harvest reads only activity newer than the stored watermark
 *    (fixture asserts the old conversation is never fetched) and the watermark
 *    ADVANCES after each successful tick.
 *  - Failure records the error on the connection row (keeping the last
 *    successful timestamp + watermark) and a later tick recovers.
 *  - Attribution recompute runs after each successful HighLevel tick.
 *  - Interval resolution: default 90s, clamped, settings-configurable.
 *  - runDemoSync live success sets the watermark; demo runs do not.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { planConversationsToVisit, WATERMARK_OVERLAP_SECONDS, harvestIncremental } from "../sync/highlevel-incremental";
import { readSchedulerIntervalSeconds, schedulerTick } from "../sync/scheduler";
import { runDemoSync } from "../sync/run";
import type { HighLevelAdapter } from "../sync/adapters";
import type { LiveHighLevelAdapter } from "../sync/highlevel-live";

const CREDENTIALS = { apiKey: "test-api-key", locationId: "loc_123" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOW = Date.now();
const secondsAgoIso = (s: number) => new Date(NOW - s * 1000).toISOString();
const hoursAgoMs = (h: number) => NOW - h * 3_600_000;

// ---------- fixtures (mirrors the real API v2 shapes) ----------
const USERS_BODY = {
  users: [
    { id: "usr_new", firstName: "Alex", lastName: "Morgan", email: "alex@mallory.test", deleted: false },
  ],
};
const CONVS_PAGE1 = {
  conversations: [
    { id: "conv_new", lastMessageDate: NOW - 30_000, contactId: "cnt_new", lastMessageType: "TYPE_CALL" },
    { id: "conv_old", lastMessageDate: hoursAgoMs(2), contactId: "cnt_other", lastMessageType: "TYPE_SMS" },
  ],
};
const MSGS_NEW = {
  messages: {
    lastMessageId: null,
    nextPage: false,
    messages: [
      { id: "call_new1", direction: "outbound", status: "completed", contactId: "cnt_new", userId: "usr_new", conversationId: "conv_new", dateAdded: secondsAgoIso(30), meta: { call: { duration: 240, status: "completed" } }, messageType: "TYPE_CALL" },
      // voicemail: null duration → stored 0s, never counts as over-2-minutes
      { id: "call_voicemail", direction: "inbound", status: "voicemail", contactId: "cnt_new", userId: "usr_new", conversationId: "conv_new", dateAdded: secondsAgoIso(40), meta: { call: { duration: null, status: "voicemail" } }, messageType: "TYPE_CALL" },
      { id: "sms_x", direction: "outbound", contactId: "cnt_new", dateAdded: secondsAgoIso(30), body: "text", messageType: "TYPE_SMS" },
    ],
  },
};
const CONTACT_NEW = {
  contact: { id: "cnt_new", contactName: "Emma Carter", phone: "+19175550142", email: "emma@example.test", assignedTo: "usr_new" },
};

interface SeenReq { url: string; method: string }
/** Incremental fixture fetch: routes on path; counts every request. */
function makeIncrementalFetch(opts: { seen?: SeenReq[]; fail?: boolean; convs?: unknown; messages?: unknown } = {}) {
  return async (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }): Promise<Response> => {
    const u = String(url);
    opts.seen?.push({ url: u, method: init?.method ?? "GET" });
    if (opts.fail) throw new Error("network down");
    const path = u.split("?")[0];
    if (path.endsWith("/users/")) return json(USERS_BODY);
    if (path.endsWith("/conversations/search")) return json(opts.convs ?? CONVS_PAGE1);
    if (path.includes("/conversations/conv_new/messages")) return json(opts.messages ?? MSGS_NEW);
    if (path.endsWith("/contacts/cnt_new")) return json(CONTACT_NEW);
    return json({});
  };
}

// ---------- pure window planner ----------
describe("planConversationsToVisit (incremental window)", () => {
  test("visits only conversations at/after the watermark, stops at the first all-old page", () => {
    const pages = [
      [{ id: "a", lastMessageDateMs: NOW - 10_000 }, { id: "b", lastMessageDateMs: NOW - 5_000 }],
      [{ id: "c", lastMessageDateMs: NOW - 20_000 }, { id: "old", lastMessageDateMs: NOW - 3_600_000 }],
      [{ id: "ancient", lastMessageDateMs: NOW - 7_200_000 }], // would be visited only if scanning continued
    ];
    const plan = planConversationsToVisit(pages, NOW - 60_000);
    expect(plan.visitIds).toEqual(["a", "b", "c"]);
    expect(plan.truncated).toBe(false);
  });
  test("a page with zero in-window conversations ends the scan", () => {
    const pages = [
      [{ id: "a", lastMessageDateMs: NOW - 10_000 }],
      [{ id: "old", lastMessageDateMs: NOW - 3_600_000 }],
      [{ id: "weird_newer", lastMessageDateMs: NOW - 5_000 }], // out of order — never fetched per tick
    ];
    const plan = planConversationsToVisit(pages, NOW - 60_000);
    expect(plan.visitIds).toEqual(["a"]);
    expect(plan.truncated).toBe(false); // scan ended naturally, no budget hit
  });
  test("in-window data beyond the scan-page budget is flagged truncated", () => {
    const pages = [
      [{ id: "a", lastMessageDateMs: NOW - 10_000 }],
      [{ id: "old", lastMessageDateMs: NOW - 3_600_000 }],
      [{ id: "beyond", lastMessageDateMs: NOW - 5_000 }],
    ];
    const plan = planConversationsToVisit(pages, NOW - 60_000, { scanPages: 2 });
    expect(plan.visitIds).toEqual(["a"]);
    expect(plan.truncated).toBe(true);
  });
  test("conversation cap truncates instead of unbounded visits", () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, lastMessageDateMs: NOW - 1000 * (i + 1) }));
    const plan = planConversationsToVisit([page], NOW - 3_600_000, { conversationCap: 10 });
    expect(plan.visitIds.length).toBe(10);
    expect(plan.truncated).toBe(true);
  });
});

// ---------- scheduler tick behaviors ----------
describe("schedulerTick", () => {
  test("SKIP: a highlevel sync run already in progress blocks the tick (no API calls)", async () => {
    const store = new MemoryStore();
    await store.insertSyncRun("highlevel"); // the running backfill
    const seen: SeenReq[] = [];
    const res = await schedulerTick({ store, creds: CREDENTIALS, fetchImpl: makeIncrementalFetch({ seen }), trigger: "background", liveAdapters: { sheets: null } });
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("sync-in-progress");
    expect(seen.length).toBe(0);
    const runs = await store.getSyncRuns(10);
    expect(runs.filter((r) => r.provider === "highlevel").length).toBe(1); // no second run started
  });

  test("STALE: a running row older than the cutoff is a crashed process — tick proceeds", async () => {
    const store = new MemoryStore();
    await store.insertSyncRun("highlevel"); // started "now"…
    await store.setSyncWatermark("highlevel", secondsAgoIso(120));
    // …but the tick's clock is 13h later → the row is stale, not live
    const res = await schedulerTick({
      store,
      creds: CREDENTIALS,
      fetchImpl: makeIncrementalFetch(),
      now: () => new Date(Date.now() + 13 * 3_600_000),
      trigger: "background",
      liveAdapters: { sheets: null }, // hermetic: sheets tick must not self-resolve the real secret
    });
    expect(res.outcome).toBe("synced");
    expect(res.mode).toBe("incremental");
  });

  test("SKIP: no credentials → no-credentials, nothing fetched", async () => {
    const store = new MemoryStore();
    const seen: SeenReq[] = [];
    const res = await schedulerTick({ store, creds: null, fetchImpl: makeIncrementalFetch({ seen }), liveAdapters: { sheets: null } });
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("no-credentials");
    expect(seen.length).toBe(0);
  });

  test("INCREMENTAL: reads only post-watermark activity; watermark advances; connection row honest", async () => {
    const store = new MemoryStore();
    const watermarkIso = secondsAgoIso(60);
    await store.setSyncWatermark("highlevel", watermarkIso);
    const seen: SeenReq[] = [];
    const res = await schedulerTick({ store, creds: CREDENTIALS, fetchImpl: makeIncrementalFetch({ seen }), trigger: "background", liveAdapters: { sheets: null } });

    expect(res.outcome).toBe("synced");
    expect(res.mode).toBe("incremental");
    expect(res.calls).toBe(2); // completed + voicemail (SMS excluded)
    // old conversation never visited
    expect(seen.some((r) => r.url.includes("conv_old/messages"))).toBe(false);
    expect(seen.some((r) => r.url.includes("conv_new/messages"))).toBe(true);

    // watermark advanced to at least the tick start (>= old watermark)
    const newWatermark = await store.getSyncWatermark("highlevel");
    expect(newWatermark).not.toBeNull();
    expect(Date.parse(newWatermark!)).toBeGreaterThan(Date.parse(watermarkIso));

    // calls stored with durations; over_two_minutes honors the 120s threshold.
    // (CallRow read-outs strip external ids — identify rows by started_at.)
    const calls = await store.getAllCallsSince("1970-01-01");
    expect(calls.length).toBe(2);
    const completed = calls.find((c) => c.started_at === secondsAgoIso(30));
    expect(completed?.duration_seconds).toBe(240);
    expect(completed?.over_two_minutes).toBe(true);
    const voicemail = calls.find((c) => c.started_at === secondsAgoIso(40));
    expect(voicemail?.duration_seconds).toBe(0);
    expect(voicemail?.over_two_minutes).toBe(false);

    // rep + contact linkage resolved from the incremental snapshot
    expect(completed?.rep_id).not.toBeNull();
    expect(completed?.contact_id).not.toBeNull();

    // connection row: connected, NOT demo, fresh timestamps, no error
    const hl = (await store.getConnections()).find((c) => c.provider === "highlevel");
    expect(hl?.status).toBe("connected");
    expect(hl?.is_demo).toBe(false);
    expect(hl?.last_error).toBeNull();
    expect(hl?.last_successful_sync_at).not.toBeNull();
  });

  test("FAILURE: error recorded on the connection row, watermark + last success preserved, retry recovers", async () => {
    const store = new MemoryStore();
    const watermarkIso = secondsAgoIso(60);
    await store.setSyncWatermark("highlevel", watermarkIso);
    const prevSuccess = secondsAgoIso(180);
    await store.upsertConnection({
      provider: "highlevel",
      status: "connected",
      is_demo: false,
      last_sync_at: prevSuccess,
      last_successful_sync_at: prevSuccess,
      last_error: null,
      config: { source: "highlevel-api" },
    });

    const failed = await schedulerTick({ store, creds: CREDENTIALS, fetchImpl: makeIncrementalFetch({ fail: true }), liveAdapters: { sheets: null } });
    expect(failed.outcome).toBe("error");
    expect(failed.error).toContain("network down");
    const afterFail = (await store.getConnections()).find((c) => c.provider === "highlevel");
    expect(afterFail?.status).toBe("error");
    expect(afterFail?.last_error).toContain("network down");
    expect(afterFail?.last_successful_sync_at).toBe(prevSuccess); // not clobbered
    expect(await store.getSyncWatermark("highlevel")).toBe(watermarkIso); // not advanced
    const failedRun = (await store.getSyncRuns(5)).find((r) => r.provider === "highlevel" && r.status === "error");
    expect(failedRun?.error).toContain("network down");

    // next tick recovers: fetch works again → connected, watermark advances
    const recovered = await schedulerTick({ store, creds: CREDENTIALS, fetchImpl: makeIncrementalFetch(), liveAdapters: { sheets: null } });
    expect(recovered.outcome).toBe("synced");
    const afterRecovery = (await store.getConnections()).find((c) => c.provider === "highlevel");
    expect(afterRecovery?.status).toBe("connected");
    expect(afterRecovery?.last_error).toBeNull();
    expect(Date.parse((await store.getSyncWatermark("highlevel"))!)).toBeGreaterThan(Date.parse(watermarkIso));
  });

  test("ATTRIBUTIONS: recompute runs after each successful HighLevel tick", async () => {
    const store = new MemoryStore();
    await store.setSyncWatermark("highlevel", secondsAgoIso(60));
    const res = await schedulerTick({ store, creds: CREDENTIALS, fetchImpl: makeIncrementalFetch(), liveAdapters: { sheets: null } });
    expect(res.outcome).toBe("synced");
    expect(typeof res.attributions).toBe("number");
    const attrRun = (await store.getSyncRuns(10)).find((r) => r.provider === "attribution" && r.status === "success");
    expect(attrRun).toBeDefined();
  });

  test("BOOTSTRAP: no watermark → full sync path runs (live stub replaces demo rows, sets watermark)", async () => {
    const store = new MemoryStore();
    await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null }); // seed demo rows
    const usersBefore = await store.getUsers();
    expect(usersBefore.some((u) => u.external_id.startsWith("demo-"))).toBe(true);
    // liveAdapters injection keeps the bootstrap OFF the real API; the stub live
    // adapter succeeds → demo rows replaced + watermark set for future ticks.
    const res = await schedulerTick({
      store,
      creds: CREDENTIALS,
      fetchImpl: makeIncrementalFetch(),
      liveAdapters: { sheets: null, highlevel: stubLiveAdapter() },
      trigger: "background",
    });
    expect(res.outcome).toBe("synced");
    expect(res.mode).toBe("full");
    expect(await store.getSyncWatermark("highlevel")).not.toBeNull();
    const usersAfter = await store.getUsers();
    expect(usersAfter.every((u) => !u.external_id.startsWith("demo-"))).toBe(true);
  });
});

// ---------- interval resolution ----------
describe("readSchedulerIntervalSeconds", () => {
  test("default 90; clamps to 30–3600; keeps valid values", () => {
    expect(readSchedulerIntervalSeconds(undefined)).toBe(90);
    expect(readSchedulerIntervalSeconds(Number.NaN)).toBe(90);
    expect(readSchedulerIntervalSeconds(5)).toBe(30);
    expect(readSchedulerIntervalSeconds(99_999)).toBe(3600);
    expect(readSchedulerIntervalSeconds(120)).toBe(120);
  });
  test("settings-configurable (persisted + normalized on read)", async () => {
    const store = new MemoryStore();
    expect((await store.getSettings()).highlevel_sync_interval_seconds).toBe(90);
    await store.saveSettings({ highlevel_sync_interval_seconds: 150 });
    expect((await store.getSettings()).highlevel_sync_interval_seconds).toBe(150);
  });
});

// ---------- full-sync watermark wiring ----------
describe("runDemoSync watermark wiring", () => {
  test("live success sets the watermark; demo runs leave it untouched", async () => {
    const liveStore = new MemoryStore();
    await runDemoSync({ store: liveStore, sheetsAdapter: null, highlevelAdapter: stubLiveAdapter() });
    expect(await liveStore.getSyncWatermark("highlevel")).not.toBeNull();

    const demoStore = new MemoryStore();
    await runDemoSync({ store: demoStore, sheetsAdapter: null, highlevelAdapter: null });
    expect(await demoStore.getSyncWatermark("highlevel")).toBeNull();
  });
});

/** Minimal live-adapter stub shaped like LiveHighLevelAdapter for runDemoSync wiring. */
function stubLiveAdapter(): LiveHighLevelAdapter & HighLevelAdapter {
  const call = {
    external_call_id: "call_x",
    repExternalId: "usr_new",
    contactExternalId: "cnt_new",
    startedAt: secondsAgoIso(30),
    durationSeconds: 200,
    direction: "outbound",
    status: "completed",
  };
  const adapter = {
    provider: "highlevel" as const,
    isDemo: false,
    lastRun: { counts: { users: 1, contacts: 1, calls: 1, opportunities: 0 }, warnings: [], windowStart: secondsAgoIso(60), endpointNotes: [] },
    fetchUsers: async () => [{ external_id: "usr_new", name: "Alex Morgan", email: "alex@mallory.test" }],
    fetchContacts: async () => [{ external_id: "cnt_new", name: "Emma Carter", phone: "+19175550142", email: "emma@example.test", assignedRepExternalId: "usr_new" }],
    fetchCalls: async () => [call],
    fetchOpportunities: async () => [],
  };
  return adapter as unknown as LiveHighLevelAdapter & HighLevelAdapter;
}

// overlap constant sanity (documents the incremental lookback contract)
test("watermark overlap is 5 minutes", () => {
  expect(WATERMARK_OVERLAP_SECONDS).toBe(300);
});
