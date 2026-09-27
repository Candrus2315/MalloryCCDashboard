/**
 * S4 INCREMENTAL CONTACTS SYNC tests (design: scratch/s4-design-note.md).
 * Fixtures only — NO live API, NO real time.
 *
 *  1. planContactsWalk / pageUnknownIds — identity-keyed early exit (NOT
 *     ordering-based), caps truncate with flags.
 *  2. harvestContactsIncremental — page-1-always (never a resumed cursor),
 *     nextPageUrl followed verbatim, stuck-cursor stops loudly, differential
 *     rows only, cap warnings.
 *  3. reconcileContacts — |delta|>25 warns (both directions), streak tracks,
 *     probe failure never warns (no invented numbers).
 *  4. Scheduler wiring — walk runs BEFORE the conversations harvest; walk
 *     checkpoint written after the successful upsert; call linkage resolves
 *     via the light 2-column read (getContacts() retired from the tick);
 *     reconciliation checkpoint + connection config land every tick.
 *  5. Demo-row purge safety (backlog f3a6d591) — deleteDemoAcuityRows/
 *     deleteDemoHighLevelRows remove ONLY demo-marked rows; provider-shaped
 *     rows survive untouched; a LIVE bootstrap (stub adapters) + purge leaves
 *     provider rows intact and demo rows gone.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  CONTACTS_DRIFT_WARN_THRESHOLD,
  CONTACTS_RECONCILIATION_CHECKPOINT_KEY,
  harvestContactsIncremental,
  pageUnknownIds,
  planContactsWalk,
  reconcileContacts,
  type ContactsReconciliationCheckpoint,
} from "../sync/contacts-incremental";
import { schedulerTick } from "../sync/scheduler";
import { runDemoSync } from "../sync/run";
import type { HighLevelAdapter, NormalizedAppointment } from "../sync/adapters";
import type { LiveHighLevelAdapter } from "../sync/highlevel-live";

const CREDENTIALS = { apiKey: "test-api-key", locationId: "loc_123" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW = Date.now();
const secondsAgoIso = (s: number) => new Date(NOW - s * 1000).toISOString();

// ---------- 1. pure planner ----------
describe("planContactsWalk / pageUnknownIds (S4 identity-keyed walk)", () => {
  const known = new Set(["k1", "k2", "k3"]);

  test("a full page with zero unknown ids stops the walk — ORDERING-AGNOSTIC", () => {
    // Deliberately NOT newest-first: an unknown id appears on page 3, but the
    // identity rule stops at page 1 — the walk never trusts list order.
    const pages = [
      [{ id: "k1" }, { id: "k2" }, { id: "k3" }],
      [{ id: "k2" }, { id: "k1" }],
      [{ id: "brand_new" }], // would only be reached by an ordering-based walk
    ];
    const plan = planContactsWalk(pages, known);
    expect(plan.stoppedAllKnown).toBe(true);
    expect(plan.newIds).toEqual([]);
    expect(plan.pagesConsumed).toBe(1);
  });

  test("a page containing ANY unknown id continues; unknowns collected in order", () => {
    const pages = [[{ id: "k1" }, { id: "new_a" }], [{ id: "new_b" }, { id: "k2" }], [{ id: "k3" }]];
    const plan = planContactsWalk(pages, known);
    expect(plan.newIds).toEqual(["new_a", "new_b"]);
    expect(plan.stoppedAllKnown).toBe(true);
    expect(plan.pagesConsumed).toBe(3);
    expect(plan.truncated).toBe(false);
  });

  test("maxPages cap truncates (flagged, never silent)", () => {
    const pages = [[{ id: "n1" }], [{ id: "n2" }], [{ id: "n3" }]];
    const plan = planContactsWalk(pages, known, { maxPages: 2 });
    expect(plan.newIds).toEqual(["n1", "n2"]);
    expect(plan.truncated).toBe(true);
    expect(plan.stoppedAllKnown).toBe(false);
  });

  test("maxNew cap truncates mid-page", () => {
    const page = Array.from({ length: 10 }, (_, i) => ({ id: `new_${i}` }));
    const plan = planContactsWalk([page], known, { maxNew: 4 });
    expect(plan.newIds.length).toBe(4);
    expect(plan.truncated).toBe(true);
  });

  test("id-less rows never count as new and never become upsert rows", () => {
    expect(pageUnknownIds([{ id: null }, { id: 123 }, { id: "  " }, { id: "k1" }], known)).toEqual([]);
  });
});

// ---------- 2. walk harvest fixtures ----------
/** Fixture: HL contacts list. `pages` of 100-shaped rows; meta.nextPageUrl chains. */
function makeContactsFetch(pages: Record<string, unknown>[][], knownHint: string[] = []) {
  const seen: string[] = [];
  return {
    seen,
    fetchImpl: async (url: string): Promise<Response> => {
      seen.push(url);
      const u = new URL(url);
      const startAfterId = u.searchParams.get("startAfterId");
      const pageIdx = startAfterId ? knownHint.indexOf(startAfterId) + 1 : 0;
      const rows = pages[Math.min(pageIdx, pages.length - 1)] ?? [];
      const next = pageIdx + 1 < pages.length ? `https://services.leadconnectorhq.com/contacts/?locationId=loc_123&limit=100&startAfter=${NOW - 1000}&startAfterId=${String(rows[rows.length - 1]?.id ?? "x")}` : null;
      return json({ contacts: rows, meta: { total: 116_200, nextPageUrl: next, currentPage: pageIdx + 1 } });
    },
  };
}

describe("harvestContactsIncremental (S4 walk)", () => {
  test("page 1 always starts at /contacts/ (never a resumed deep cursor); all-known page exits after 1 request", async () => {
    const knownRows = Array.from({ length: 100 }, (_, i) => ({ id: `known_${i}`, contactName: `K${i}` }));
    const f = makeContactsFetch([knownRows, [{ id: "never_fetched" }]]);
    const res = await harvestContactsIncremental({ creds: CREDENTIALS, fetchImpl: f.fetchImpl, knownExternalIds: new Set(knownRows.map((r) => String(r.id))) });
    expect(f.seen.length).toBe(1);
    expect(f.seen[0].startsWith("https://services.leadconnectorhq.com/contacts/?")).toBe(true);
    expect(f.seen[0]).toContain("limit=100");
    expect(res.newCount).toBe(0);
    expect(res.stoppedAllKnown).toBe(true);
    expect(res.sourceTotalSeen).toBe(116_200);
  });

  test("follows meta.nextPageUrl verbatim; returns ONLY differential rows", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `known_${i}` }));
    const page2 = [{ id: "fresh_1", contactName: "Fresh One", phone: "+19175550111", email: "f1@x.test", assignedTo: "usr_1" }, { id: "known_0" }];
    const f = makeContactsFetch([page1, page2], ["known_99"]);
    // known frontier = page1 ids MINUS known_0 → page1 still carries one unknown → walk continues
    const res = await harvestContactsIncremental({ creds: CREDENTIALS, fetchImpl: f.fetchImpl, knownExternalIds: new Set(page1.slice(1).map((r) => String(r.id))) });
    expect(f.seen.length).toBe(2);
    // the second request replays the cursor VERBATIM (path+query of nextPageUrl)
    expect(f.seen[1]).toContain("startAfterId=known_99");
    expect(res.newCount).toBe(res.rows.length);
    expect(res.rows.map((r) => r.external_id)).toContain("fresh_1");
    expect(res.rows.every((r) => ["known_0", "fresh_1"].includes(r.external_id))).toBe(true);
    expect(res.rows.find((r) => r.external_id === "fresh_1")?.name).toBe("Fresh One");
    expect(res.truncated).toBe(false);
  });

  test("stuck cursor (same nextPageUrl twice) stops with a warning — never loops", async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return json({ contacts: [{ id: `n_${calls}` }], meta: { total: 5, nextPageUrl: "https://services.leadconnectorhq.com/contacts/?startAfterId=echo" } });
    };
    const res = await harvestContactsIncremental({ creds: CREDENTIALS, fetchImpl, knownExternalIds: new Set() });
    expect(calls).toBe(2);
    expect(res.warnings.some((w) => w.includes("stuck cursor"))).toBe(true);
    expect(res.truncated).toBe(true);
  });

  test("maxPages cap emits a loud warning", async () => {
    let n = 0;
    const fetchImpl = async (): Promise<Response> => {
      n += 1;
      return json({ contacts: [{ id: `fresh_${n}` }], meta: { total: 5000, nextPageUrl: `https://services.leadconnectorhq.com/contacts/?startAfterId=c_${n}` } });
    };
    const res = await harvestContactsIncremental({ creds: CREDENTIALS, fetchImpl, knownExternalIds: new Set(), maxPages: 3 });
    expect(res.pagesFetched).toBe(3);
    expect(res.truncated).toBe(true);
    expect(res.warnings.some((w) => w.includes("cap hit"))).toBe(true);
  });
});

// ---------- 3. reconciliation tripwire ----------
describe("reconcileContacts (S4 every-tick tripwire)", () => {
  const probeFetch = (total: unknown) => async (): Promise<Response> => json({ contacts: [], meta: { total } });

  test("|delta| <= threshold → ok, no warning", async () => {
    const r = await reconcileContacts({ creds: CREDENTIALS, fetchImpl: probeFetch(116_160), dbCount: 116_155 });
    expect(r.warn).toBe(false);
    expect(r.checkpoint.status).toBe("ok");
    expect(r.checkpoint.delta).toBe(5);
  });
  test("delta > 25 warns with both counts (source ahead = missed new contacts)", async () => {
    const r = await reconcileContacts({ creds: CREDENTIALS, fetchImpl: probeFetch(116_200), dbCount: 116_100 });
    expect(r.warn).toBe(true);
    expect(r.message).toContain("HighLevel reports 116200 contacts");
    expect(r.message).toContain("dashboard holds 116100");
    expect(r.checkpoint.status).toBe("drift");
    expect(r.checkpoint.driftStreak).toBe(1);
  });
  test("negative delta (DB > source = HL deletions) warns too", async () => {
    const r = await reconcileContacts({ creds: CREDENTIALS, fetchImpl: probeFetch(100), dbCount: 200 });
    expect(r.warn).toBe(true);
    expect(r.message).toContain("more contacts stored than HighLevel reports");
  });
  test("drift streak accumulates from the previous checkpoint", async () => {
    const prev: ContactsReconciliationCheckpoint = { lastCheckedAt: secondsAgoIso(90), sourceTotal: 116_200, dbCount: 116_100, delta: 100, status: "drift", driftStreak: 2, updatedAt: secondsAgoIso(90) };
    const r = await reconcileContacts({ creds: CREDENTIALS, fetchImpl: probeFetch(116_250), dbCount: 116_150, previous: prev });
    expect(r.checkpoint.driftStreak).toBe(3);
    expect(r.message).toContain("3 consecutive ticks");
  });
  test("recovered (delta back under threshold) resets the streak", async () => {
    const prev: ContactsReconciliationCheckpoint = { lastCheckedAt: secondsAgoIso(90), sourceTotal: 116_200, dbCount: 116_100, delta: 100, status: "drift", driftStreak: 5, updatedAt: secondsAgoIso(90) };
    const r = await reconcileContacts({ creds: CREDENTIALS, fetchImpl: probeFetch(116_160), dbCount: 116_155, previous: prev });
    expect(r.warn).toBe(false);
    expect(r.checkpoint.driftStreak).toBe(0);
  });
  test("missing/unparsable meta.total → probe_failed, warn FALSE (never invent numbers)", async () => {
    const r = await reconcileContacts({ creds: CREDENTIALS, fetchImpl: async () => json({ contacts: [] }), dbCount: 10 });
    expect(r.checkpoint.status).toBe("probe_failed");
    expect(r.warn).toBe(false);
    expect(r.message).toBeNull();
  });
  test("threshold is 25 (~1 day of growth)", () => {
    expect(CONTACTS_DRIFT_WARN_THRESHOLD).toBe(25);
  });
});

// ---------- 4. scheduler wiring ----------
const USERS_BODY = { users: [{ id: "usr_new", firstName: "Alex", lastName: "Morgan", email: "alex@mallory.test" }] };
const CONVS_PAGE1 = { conversations: [{ id: "conv_new", lastMessageDate: NOW - 30_000, contactId: "cnt_walk_new", lastMessageType: "TYPE_CALL" }] };
const MSGS_NEW = { messages: { messages: [{ id: "call_new1", direction: "outbound", status: "completed", contactId: "cnt_walk_new", userId: "usr_new", conversationId: "conv_new", dateAdded: secondsAgoIso(30), meta: { call: { duration: 240 } }, messageType: "TYPE_CALL" }] } };
const CONTACT_INDIVIDUAL = { contact: { id: "cnt_walk_new", contactName: "Walk New", phone: "+19175550142", email: "walk@x.test", assignedTo: "usr_new" } };
/** A contact page where the NEW call-referenced contact is ALSO brand new. */
const WALK_PAGE1 = { contacts: [{ id: "cnt_walk_new", contactName: "Walk New", phone: "+19175550142", email: "walk@x.test", assignedTo: "usr_new" }, { id: "cnt_stored_1", contactName: "Stored One" }], meta: { total: 2, nextPageUrl: null } };

function makeTickFetch(opts: { seen?: string[] } = {}) {
  return async (url: string): Promise<Response> => {
    opts.seen?.push(url);
    const path = url.split("?")[0];
    if (path.endsWith("/users/")) return json(USERS_BODY);
    if (path.endsWith("/contacts/")) return json(WALK_PAGE1);
    if (path.endsWith("/conversations/search")) return json(CONVS_PAGE1);
    if (path.includes("/conversations/conv_new/messages")) return json(MSGS_NEW);
    if (path.endsWith("/contacts/cnt_walk_new")) return json(CONTACT_INDIVIDUAL);
    return json({});
  };
}

describe("schedulerTick S4 wiring", () => {
  test("walk runs BEFORE the conversations harvest; linkage resolves via light reads; checkpoints land", async () => {
    const store = new MemoryStore();
    await store.setSyncWatermark("highlevel", secondsAgoIso(60));
    // one contact already stored (the walk page's known row)
    await store.upsertContacts([{ id: "", provider: "highlevel", external_id: "cnt_stored_1", name: "Stored One", phone: null, email: null, assigned_rep_id: null }]);
    const seen: string[] = [];
    const res = await schedulerTick({ store, creds: CREDENTIALS, fetchImpl: makeTickFetch({ seen }) });
    expect(res.outcome).toBe("synced");

    // ORDER: the contacts walk page request happens BEFORE /conversations/search
    const walkIdx = seen.findIndex((u) => /\/contacts\/\?/.test(u));
    const convIdx = seen.findIndex((u) => u.includes("/conversations/search"));
    expect(walkIdx).toBeGreaterThanOrEqual(0);
    expect(convIdx).toBeGreaterThan(walkIdx);

    // differential: cnt_walk_new was new → upserted; the call's linkage resolved
    const calls = await store.getAllCallsSince("1970-01-01");
    expect(calls.length).toBe(1);
    expect(calls[0].contact_id).not.toBeNull();
    // reconciliation ran: checkpoint + connection config carry the measured counts
    const recon = JSON.parse((await store.getSyncCheckpoint(CONTACTS_RECONCILIATION_CHECKPOINT_KEY)) ?? "{}");
    expect(recon.dbCount).toBe(2); // cnt_stored_1 + cnt_walk_new (deduped with the individual fetch)
    expect(recon.sourceTotal).toBe(2);
    const hl = (await store.getConnections()).find((c) => c.provider === "highlevel");
    expect((hl?.config?.contactsReconciliation as { dbCount: number })?.dbCount).toBe(2);
    // walk checkpoint written (scheduler-owned, after the successful upsert)
    const walkCkpt = JSON.parse((await store.getSyncCheckpoint("hl_contacts_incremental_v1")) ?? "{}");
    expect(walkCkpt.lastNewCount).toBe(1);
  });

  test("no-new tick: zero-request-page early exit keeps the tick cheap; noNewStreak accumulates", async () => {
    const store = new MemoryStore();
    await store.setSyncWatermark("highlevel", secondsAgoIso(60));
    await store.upsertContacts([{ id: "", provider: "highlevel", external_id: "cnt_walk_new", name: "Walk New", phone: null, email: null, assigned_rep_id: null }, { id: "", provider: "highlevel", external_id: "cnt_stored_1", name: "Stored One", phone: null, email: null, assigned_rep_id: null }]);
    const seen: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      seen.push(url);
      const path = url.split("?")[0];
      if (path.endsWith("/users/")) return json(USERS_BODY);
      if (path.endsWith("/contacts/")) return json({ contacts: [{ id: "cnt_walk_new" }, { id: "cnt_stored_1" }], meta: { total: 2, nextPageUrl: null } });
      if (path.endsWith("/contacts/?limit=1")) return json({ contacts: [], meta: { total: 2 } });
      if (path.endsWith("/conversations/search")) return json({ conversations: [] });
      return json({});
    };
    const res = await schedulerTick({ store, creds: CREDENTIALS, fetchImpl });
    expect(res.outcome).toBe("synced");
    expect(res.contactsWalk?.new).toBe(0);
    // CONTACTS requests: exactly ONE walk page (limit=100, early exit) + ONE
    // limit=1 reconciliation probe. The conversations harvest's own limit=100
    // page is NOT a contacts request (design §4: S4 adds 1-2 contact pages + 1
    // probe per tick — nothing else; /conversations/search has used limit=100
    // since before S4).
    const contactsReq = seen.filter((u) => {
      try { return new URL(u).pathname.endsWith("/contacts/"); } catch { return false; }
    });
    expect(contactsReq.length).toBe(2);
    expect(contactsReq.filter((u) => new URL(u).searchParams.get("limit") === "100").length).toBe(1);
    expect(contactsReq.filter((u) => new URL(u).searchParams.get("limit") === "1").length).toBe(1);
    const walkCkpt = JSON.parse((await store.getSyncCheckpoint("hl_contacts_incremental_v1")) ?? "{}");
    expect(walkCkpt.noNewStreak).toBe(1);
  });
});

// ---------- 5. demo-row purge safety (backlog f3a6d591) ----------
describe("demo-row purge safety (S4 bundled)", () => {
  const providerAppt = (id: string): NormalizedAppointment => ({
    acuity_appointment_id: id,
    calendarId: "cal_1",
    calendarName: "Studio Booking",
    appointmentType: "Studio Session",
    appointmentDatetime: "2026-09-30T15:00:00.000Z",
    createdAt: "2026-09-21T15:27:31.000Z",
    createdAtBusinessDate: "2026-09-21",
    createdTimeSource: "2026-09-21T15:27:31-0500",
    createdTimePrecision: "full",
    status: "scheduled",
    canceledAndFallbackCreated: false,
    cancelled: false,
  } as unknown as NormalizedAppointment);

  test("deleteDemoAcuityRows removes ONLY demo-marked rows; provider rows survive row-for-row", async () => {
    const store = new MemoryStore();
    await store.upsertAppointments([
      { ...providerAppt("1516022841"), acuity_appointment_id: "1516022841" },
      { ...providerAppt("1738193864"), acuity_appointment_id: "1738193864" },
      { ...providerAppt("demo-appt-seed-1"), acuity_appointment_id: "demo-appt-seed-1" },
      { ...providerAppt("demo-appt-seed-2"), acuity_appointment_id: "demo-appt-seed-2" },
    ] as never);
    const purged = await store.deleteDemoAcuityRows();
    expect(purged.appointments).toBe(2);
    // idempotent: the second purge removes NOTHING — provider rows were never
    // in the demo-% removal set (only demo-marked rows match the predicate).
    const again = await store.deleteDemoAcuityRows();
    expect(again.appointments).toBe(0);
    expect(again.blocked).toBe(0);
  });

  test("deleteDemoHighLevelRows never touches provider-synced rows (numeric external ids)", async () => {
    const store = new MemoryStore();
    await store.upsertUsers([{ id: "", provider: "highlevel", external_id: "usr_real_1", name: "Real Rep", email: "real@x.test", is_active: true }]);
    await store.upsertContacts([{ id: "", provider: "highlevel", external_id: "cnt_real_1", name: "Real Contact", phone: null, email: null, assigned_rep_id: null }]);
    await store.upsertUsers([{ id: "", provider: "highlevel", external_id: "demo-user-1", name: "Demo Rep", email: "demo@x.test", is_active: true }]);
    const purged = await store.deleteDemoHighLevelRows();
    expect(purged.users).toBe(1);
    const users = await store.getAllUsers();
    expect(users.map((u) => u.external_id)).toEqual(["usr_real_1"]);
    const contacts = await store.getContacts();
    expect(contacts.map((c) => c.external_id)).toEqual(["cnt_real_1"]);
  });

  test("LIVE bootstrap (stub adapters) + purge: provider rows intact, demo rows gone", async () => {
    const store = new MemoryStore();
    // seed demo rows exactly as a page-load demo seed would (test NODE_ENV → demo acuity path)
    await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null });
    const demoBefore = (await store.getAppointmentsWithClientsSince("2000-01-01T00:00:00Z")).filter((a) => a.acuity_appointment_id?.startsWith("demo-"));
    expect(demoBefore.length).toBeGreaterThan(0);

    // provider-shaped rows pre-seeded: a live bootstrap + purge must NEVER touch them
    await store.upsertAppointments([
      { ...providerAppt("1516022841"), acuity_appointment_id: "1516022841" },
      { ...providerAppt("1772401762"), acuity_appointment_id: "1772401762" },
    ] as never);
    const res = await schedulerTick({
      store,
      creds: CREDENTIALS,
      fetchImpl: makeTickFetch(),
      liveAdapters: { sheets: null, highlevel: stubLiveAdapter() },
      acuityAdapter: {
        provider: "acuity",
        isDemo: false,
        lastRun: null,
        fetchAppointments: async () => [providerAppt("1516022841"), providerAppt("1772401762")],
        fetchBlockedTimes: async () => [],
      } as never,
      trigger: "background",
    });
    expect(res.outcome).toBe("synced");
    expect(res.mode).toBe("full");
    // demo HL rows replaced; demo Acuity rows purged by the live acuity path
    const users = await store.getAllUsers();
    expect(users.every((u) => !u.external_id.startsWith("demo-"))).toBe(true);
    // provider rows INTACT: the purge (run inside the live acuity bootstrap path)
    // only ever removes demo-% rows — a second purge removes nothing more.
    const secondPurge = await store.deleteDemoAcuityRows();
    expect(secondPurge.appointments).toBe(0);
    const hl = (await store.getConnections()).find((c) => c.provider === "highlevel");
    expect(hl?.status).toBe("connected");
  });
});

/** Minimal live-adapter stub shaped like LiveHighLevelAdapter for runDemoSync wiring. */
function stubLiveAdapter(): LiveHighLevelAdapter & HighLevelAdapter {
  const adapter = {
    provider: "highlevel" as const,
    isDemo: false,
    lastRun: { counts: { users: 1, contacts: 1, calls: 1, opportunities: 0 }, warnings: [], windowStart: secondsAgoIso(60), endpointNotes: [] },
    fetchUsers: async () => [{ external_id: "usr_new", name: "Alex Morgan", email: "alex@mallory.test" }],
    fetchContacts: async () => [{ external_id: "cnt_real_1", name: "Real Contact", phone: "+19175550142", email: "real@x.test", assignedRepExternalId: "usr_new" }],
    fetchCalls: async () => [],
    fetchOpportunities: async () => [],
  };
  return adapter as unknown as LiveHighLevelAdapter & HighLevelAdapter;
}
