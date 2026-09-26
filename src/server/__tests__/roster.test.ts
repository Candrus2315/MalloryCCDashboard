/**
 * ACTIVE ROSTER — match rule (incl. the Allison exception), exclusion from
 * team rollups, sync marking through a live stub, demo-purge idempotency.
 */
import { describe, expect, test } from "bun:test";
import { buildTeamRangeMetrics, type CallRow, type LeadRow } from "../metrics/compute";
import { activeRepIds, isRosterUser, keepRosterRepCalls } from "../roster";
import { MemoryStore } from "../store/memory";
import { DEFAULT_ACTIVE_ROSTER, normalizeAppSettings, normalizeRoster } from "../store/types";
import { runDemoSync } from "../sync/run";
import type { HighLevelAdapter } from "../sync/adapters";
import type { LiveHighLevelAdapter } from "../sync/highlevel-live";

const ROSTER = normalizeAppSettings(undefined).active_roster;

describe("isRosterUser (match rule)", () => {
  test("each of the five reps matches, case/whitespace-insensitive", () => {
    expect(isRosterUser("allison wittner", "ALLISONWITTNER@GMAIL.COM", ROSTER)).toBe(true);
    expect(isRosterUser("Carmine Morgano", "Carmine@MalloryPortraits.com", ROSTER)).toBe(true);
    expect(isRosterUser("DAN   MCKILLOP", "dan@malloryportraits.com", ROSTER)).toBe(true);
    expect(isRosterUser("jennifer stitt", "Jennifer@MalloryPortraits.Com", ROSTER)).toBe(true);
    expect(isRosterUser("Laura Rivera", " laura@malloryportraits.com ", ROSTER)).toBe(true);
  });

  test("Allison exception: BOTH the owner-quoted gmail and the live mallory address match", () => {
    expect(isRosterUser("Allison Wittner", "allisonwittner@gmail.com", ROSTER)).toBe(true);
    expect(isRosterUser("Allison Wittner", "allison@malloryportraits.com", ROSTER)).toBe(true);
    expect(isRosterUser("Allison Wittner", "allison.wittner@gmail.com", ROSTER)).toBe(false);
  });

  test("right name + wrong email is excluded", () => {
    expect(isRosterUser("Laura Rivera", "lrivera@elsewhere.com", ROSTER)).toBe(false);
  });

  test("right email + wrong name is excluded", () => {
    expect(isRosterUser("Not Laura Rivera", "laura@malloryportraits.com", ROSTER)).toBe(false);
  });

  test("missing/unverifiable email never matches (never silently guessed)", () => {
    expect(isRosterUser("Laura Rivera", null, ROSTER)).toBe(false);
    expect(isRosterUser("Laura Rivera", "", ROSTER)).toBe(false);
  });

  test("live non-roster users (admins, staff, agencies, test accounts) excluded", () => {
    expect(isRosterUser("Mallory Parkington", "mallory@malloryportraits.com", ROSTER)).toBe(false);
    expect(isRosterUser("Christy West", "christy@malloryportraits.com", ROSTER)).toBe(false);
    expect(isRosterUser("TEST BOOKER", "inquiries@malloryportraits.com", ROSTER)).toBe(false);
    expect(isRosterUser("Kurious Marketing", "kuriousmarketing@gmail.com", ROSTER)).toBe(false);
  });

  test("empty roster excludes everyone", () => {
    expect(isRosterUser("Laura Rivera", "laura@malloryportraits.com", [])).toBe(false);
  });
});

describe("active_roster setting", () => {
  test("default roster is exactly the owner's five reps", () => {
    expect(ROSTER.map((r) => r.name)).toEqual([
      "Allison Wittner",
      "Carmine Morgano",
      "Dan McKillop",
      "Jennifer Stitt",
      "Laura Rivera",
    ]);
    expect(DEFAULT_ACTIVE_ROSTER).toHaveLength(5);
  });

  test("missing/invalid stored roster falls back to the default five", () => {
    expect(normalizeRoster(undefined)).toHaveLength(5);
    expect(normalizeRoster([])).toHaveLength(5);
    expect(normalizeRoster([null, 42, { name: "" }, { name: "X", emails: [] }])).toHaveLength(5);
  });

  test("a stored roster survives save + read (owner-edited entries win)", async () => {
    const store = new MemoryStore();
    await store.saveSettings({
      active_roster: [{ name: "Someone Else", emails: ["se@example.test"] }, { name: "", emails: [] }],
    });
    const s = await store.getSettings();
    expect(s.active_roster).toEqual([{ name: "Someone Else", emails: ["se@example.test"] }]);
  });
});

describe("keepRosterRepCalls + activeRepIds", () => {
  const call = (id: string, rep_id: string | null, duration: number): CallRow => ({
    id,
    rep_id,
    contact_id: null,
    started_at: "2026-09-24T14:00:00.000Z",
    duration_seconds: duration,
    over_two_minutes: duration > 120,
  });

  test("keeps roster reps' calls; drops non-roster and unlinked calls", () => {
    const active = new Set(["r_laura", "r_allison"]);
    const calls = [call("1", "r_laura", 300), call("2", "r_admin", 500), call("3", null, 400), call("4", "r_allison", 30)];
    const kept = keepRosterRepCalls(calls, active);
    expect(kept.map((c) => c.id)).toEqual(["1", "4"]);
  });

  test("empty active set → zero calls (no reps, no team numbers)", () => {
    expect(keepRosterRepCalls([call("1", "r_laura", 300)], new Set())).toEqual([]);
  });

  test("activeRepIds picks only is_active users", () => {
    expect(activeRepIds([
      { id: "a", is_active: true },
      { id: "b", is_active: false },
      { id: "c", is_active: true },
    ])).toEqual(new Set(["a", "c"]));
  });
});

describe("team rollups exclude non-roster users", () => {
  const call = (id: string, rep_id: string | null, duration: number): CallRow => ({
    id,
    rep_id,
    contact_id: null,
    started_at: "2026-09-24T14:00:00.000Z",
    duration_seconds: duration,
    over_two_minutes: duration > 120,
  });
  const lead = (id: string, rep_id: string | null): LeadRow => ({
    id,
    provider: "google_sheets",
    source_id: `s_${id}`,
    lead_type: "family",
    source_date: "2026-09-24",
    work_date: "2026-09-24",
    contact_id: null,
    assigned_rep_id: rep_id,
    source_sheet: "family",
  });
  const base = {
    calls: [] as CallRow[],
    appts: [],
    attributions: [],
    allCallsForJoin: [],
    leads: [] as LeadRow[],
    workStart: "2026-09-24",
    workEnd: "2026-09-24",
    weeks: ["2026-09-21"],
    teamGoalByWeek: new Map([["2026-09-21", 79]]),
    today: "2026-09-25",
    thresholdSeconds: 120,
  };

  test("calls from a non-roster user never count in team totals", () => {
    const calls = [call("1", "r_laura", 300), call("2", "r_admin", 500), call("3", null, 60)];
    const without = buildTeamRangeMetrics({ ...base, calls: keepRosterRepCalls(calls, new Set(["r_laura"])), activeRepIds: new Set(["r_laura"]) });
    const withAll = buildTeamRangeMetrics({ ...base, calls });
    expect(without.totalCalls).toBe(1);
    expect(without.callsOverThreshold).toBe(1);
    expect(without.avgCallDurationSeconds).toBe(300);
    // backward compat: no activeRepIds → old behavior (all calls counted)
    expect(withAll.totalCalls).toBe(3);
  });

  test("assigned leads from non-roster reps are excluded from team assignedLeads", () => {
    const leads = [lead("1", "r_laura"), lead("2", "r_admin"), lead("3", null)];
    const m = buildTeamRangeMetrics({ ...base, leads, activeRepIds: new Set(["r_laura"]) });
    expect(m.assignedLeads).toBe(1);
    const mAll = buildTeamRangeMetrics({ ...base, leads });
    expect(mAll.assignedLeads).toBe(2);
  });
});

// ---------- sync marking through a live stub ----------
const FIVE: { external_id: string; name: string; email: string }[] = [
  { external_id: "u_allison", name: "Allison Wittner", email: "allison@malloryportraits.com" },
  { external_id: "u_carmine", name: "Carmine Morgano", email: "carmine@malloryportraits.com" },
  { external_id: "u_dan", name: "Dan McKillop", email: "dan@malloryportraits.com" },
  { external_id: "u_jennifer", name: "Jennifer Stitt", email: "jennifer@malloryportraits.com" },
  { external_id: "u_laura", name: "Laura Rivera", email: "laura@malloryportraits.com" },
];
const EXTRA_USERS = [
  { external_id: "u_admin", name: "Admin Person", email: "admin@malloryportraits.com" },
  { external_id: "u_laura2", name: "Laura Rivera", email: "laura@otheragency.com" }, // right name, wrong email
];

function liveRosterAdapter(): LiveHighLevelAdapter & HighLevelAdapter {
  const adapter = {
    provider: "highlevel" as const,
    isDemo: false,
    lastRun: { counts: { users: 7, contacts: 1, calls: 2, opportunities: 0 }, warnings: [], windowStart: null, endpointNotes: [] },
    fetchUsers: async () => [...FIVE, ...EXTRA_USERS],
    fetchContacts: async () => [
      { external_id: "cnt_1", name: "Client One", phone: "+19175550101", email: "c1@example.test", assignedRepExternalId: "u_laura" },
      { external_id: "cnt_2", name: "Client Two", phone: "+19175550102", email: "c2@example.test", assignedRepExternalId: "u_admin" },
    ],
    fetchCalls: async () => [
      { external_call_id: "call_l", repExternalId: "u_laura", contactExternalId: "cnt_1", startedAt: "2026-09-25T14:00:00.000Z", durationSeconds: 200, direction: "outbound", status: "completed" },
      { external_call_id: "call_a", repExternalId: "u_admin", contactExternalId: "cnt_2", startedAt: "2026-09-25T15:00:00.000Z", durationSeconds: 300, direction: "outbound", status: "completed" },
    ],
    fetchOpportunities: async () => [],
  };
  return adapter as unknown as LiveHighLevelAdapter & HighLevelAdapter;
}

describe("sync roster marking (live stub → runDemoSync)", () => {
  test("live users are marked per the roster rule; non-roster rows stay but go inactive", async () => {
    const store = new MemoryStore();
    const settings = normalizeAppSettings(undefined);
    await runDemoSync({ store, settings, sheetsAdapter: null, highlevelAdapter: liveRosterAdapter() });

    const active = await store.getUsers();
    expect(active.map((u) => u.name).sort()).toEqual([
      "Allison Wittner",
      "Carmine Morgano",
      "Dan McKillop",
      "Jennifer Stitt",
      "Laura Rivera",
    ]);
    // the wrong-email Laura is a DIFFERENT row and must not be active
    expect(active.filter((u) => u.name === "Laura Rivera")).toHaveLength(1);

    const all = await store.getAllUsers();
    expect(all).toHaveLength(7); // non-roster rows kept in the DB

    // raw calls stay (2), rep linkage preserved via getAllUsers-based mapping
    const calls = await store.getAllCallsSince("2026-01-01T00:00:00.000Z");
    expect(calls).toHaveLength(2);
    const kept = keepRosterRepCalls(calls, activeRepIds(active));
    expect(kept).toHaveLength(1); // only the roster rep's call reaches team math
  });

  test("demo purge: pre-existing demo rows are gone after the live sync; idempotent", async () => {
    const store = new MemoryStore();
    await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null }); // demo seed first
    expect((await store.getAllUsers()).some((u) => u.external_id.startsWith("demo-"))).toBe(true);

    const settings = normalizeAppSettings(undefined);
    const first = await runDemoSync({ store, settings, sheetsAdapter: null, highlevelAdapter: liveRosterAdapter() });
    expect(first.providers.find((p) => p.provider === "highlevel")?.error ?? null).toBeNull();
    expect((await store.getAllUsers()).some((u) => u.external_id.startsWith("demo-"))).toBe(false);

    // idempotent: a second live run lands the exact same roster state
    await runDemoSync({ store, settings, sheetsAdapter: null, highlevelAdapter: liveRosterAdapter() });
    const active = await store.getUsers();
    expect(active).toHaveLength(5);
    const calls = await store.getAllCallsSince("2026-01-01T00:00:00.000Z");
    expect(calls).toHaveLength(2); // upserts, never duplicates
  });

  test("a FAILED live sync never re-seeds demo reps (roster protection)", async () => {
    const store = new MemoryStore();
    const failing = {
      provider: "highlevel" as const,
      isDemo: false,
      lastRun: null,
      fetchUsers: async () => {
        throw new Error("401 unauthorized");
      },
      fetchContacts: async () => [],
      fetchCalls: async () => [],
      fetchOpportunities: async () => [],
    } as unknown as LiveHighLevelAdapter & HighLevelAdapter;
    const res = await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: failing });
    const hl = res.providers.find((p) => p.provider === "highlevel");
    expect(hl?.error).toContain("401");
    expect((await store.getAllUsers()).some((u) => u.external_id.startsWith("demo-"))).toBe(false);
    const conn = (await store.getConnections()).find((c) => c.provider === "highlevel");
    expect(conn?.status).toBe("error");
    expect(conn?.is_demo).toBe(false); // stale LIVE data, not demo data
  });

  test("pure demo mode (no credentials) stays viewable with demo reps active", async () => {
    const store = new MemoryStore();
    await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null });
    const users = await store.getUsers();
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((u) => u.is_active)).toBe(true);
  });
});
