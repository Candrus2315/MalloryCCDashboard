/**
 * ACCURACY PASS 3 — mapping-driven eligibility (design/data-terminology.md):
 *
 * 1. NO-MAPPING REGRESSION: with zero rep_mappings configured, the eligibility
 *    pipeline is BIT-IDENTICAL to the verified part-2 reconciliation — the
 *    same rows keepRosterRepCalls keeps, the same per-rep and team totals as
 *    the owner-verified matrix (docs/reconciliation-2026-09-26.md, WTD window).
 * 2. MAPPING SEMANTICS: mapping a HL user flips EXACTLY that user's calls
 *    into the rep's numbers and the CC team totals, at QUERY TIME.
 * 3. IMMUTABLE SOURCE: mapping never rewrites stored rows (rep_id, raw HL
 *    user id, timestamps, durations).
 * 4. call_start_date / repOperatingState: before/on/after boundary in ET.
 */
import { describe, expect, test } from "bun:test";
import { repOperatingState } from "../date-logic";
import { buildTeamRangeMetrics, repRangeSummaries, type AttributionRow, type CallRow, type LeadRow } from "../metrics/compute";
import {
  applyAttributionEligibility,
  applyRosterEligibility,
  buildRosterEligibility,
  eligibleRepId,
  keepRosterRepCalls,
} from "../roster";
import { buildCallOwnershipBuckets } from "../../components/reps-views";
import { MemoryStore } from "../store/memory";
import { normalizeRepMappings } from "../store/types";

// ---------- part-2 verified matrix (WTD 9/21–9/26 ET, docs/reconciliation) ----------
// Rep | calls / over-2-min  (owner-verified, ledger == DB)
const MATRIX: { rep: string; external: string; calls: number; over: number }[] = [
  { rep: "Allison Wittner", external: "hl-allison", calls: 620, over: 57 },
  { rep: "Carmine Morgano", external: "hl-morgano", calls: 685, over: 31 },
  { rep: "Dan McKillop", external: "hl-dan", calls: 0, over: 0 },
  { rep: "Jennifer Stitt", external: "hl-jennifer", calls: 549, over: 10 },
  { rep: "Laura Rivera", external: "hl-laura", calls: 151, over: 8 },
];
// Non-roster HL users seen in calls (163 unassigned total incl. 1 no-user row)
const NON_ROSTER: { name: string; external: string; calls: number }[] = [
  { name: "Christy West", external: "hl-christy", calls: 100 },
  { name: "Annah Kniphfer", external: "hl-annah", calls: 22 },
  { name: "Emily Abney", external: "hl-emily", calls: 20 },
  { name: "Amy Clark", external: "hl-amy", calls: 8 },
  { name: "Brand Locus", external: "hl-brand", calls: 7 },
  { name: "Katelynn Todorov", external: "hl-katelynn", calls: 4 },
  { name: "Lexa Brandis", external: "hl-lexa", calls: 1 },
];
const NO_USER_ROWS = 1;
const TEAM_CALLS = MATRIX.reduce((a, m) => a + m.calls, 0); // 2005
const TEAM_OVER = MATRIX.reduce((a, m) => a + m.over, 0); // 106

let seq = 0;
/** One synthetic call row; `over` rows carry 200s, the rest 60s. */
const call = (repId: string | null, providerExternal: string | null, over: boolean): CallRow => {
  seq += 1;
  return {
    id: `c${seq}`,
    rep_id: repId,
    contact_id: null,
    started_at: "2026-09-25T14:00:00.000Z",
    duration_seconds: over ? 200 : 60,
    over_two_minutes: over,
    provider_rep_external_id: providerExternal,
  };
};

/** Build the WTD matrix dataset. Roster rows link rep_id; non-roster rows store rep NULL + raw HL id (exactly how the live harvest stores them); `knownNonRoster` also links an inactive user row (the audit's alternate shape). */
function buildCalls(opts: { linkNonRoster: boolean }): { calls: CallRow[]; users: { id: string; is_active: boolean; external_id: string; name: string }[] } {
  const users = [
    ...MATRIX.map((m) => ({ id: m.rep, is_active: true, external_id: m.external, name: m.rep })),
    ...NON_ROSTER.map((m) => ({ id: `u-${m.external}`, is_active: false, external_id: m.external, name: m.name })),
  ];
  const inactiveByExternal = new Map(NON_ROSTER.map((m) => [m.external, `u-${m.external}`]));
  const calls: CallRow[] = [];
  for (const m of MATRIX) {
    for (let i = 0; i < m.over; i++) calls.push(call(m.rep, m.external, true));
    for (let i = 0; i < m.calls - m.over; i++) calls.push(call(m.rep, m.external, false));
  }
  for (const m of NON_ROSTER) {
    const repId = opts.linkNonRoster ? inactiveByExternal.get(m.external)! : null;
    for (let i = 0; i < m.calls; i++) calls.push(call(repId, m.external, false));
  }
  for (let i = 0; i < NO_USER_ROWS; i++) calls.push(call(null, null, false));
  return { calls, users };
}

const lead = (repId: string | null): LeadRow => {
  seq += 1;
  return {
    id: `l${seq}`,
    lead_type: "family",
    source_date: "2026-09-24",
    work_date: "2026-09-25",
    contact_id: null,
    assigned_rep_id: repId,
    source_sheet: "family",
  };
};

describe("NO-MAPPING REGRESSION — bit-identical to the part-2 verified matrix", () => {
  const { calls, users } = buildCalls({ linkNonRoster: true });
  const elig = buildRosterEligibility(users, []); // zero mappings — today's config

  test("eligibility keeps EXACTLY the keepRosterRepCalls set (same rows, same order, same refs)", () => {
    const legacy = keepRosterRepCalls(calls, new Set(users.filter((u) => u.is_active).map((u) => u.id)));
    const mapped = applyRosterEligibility(calls, elig);
    expect(mapped).toEqual(legacy);
    expect(mapped.length).toBe(legacy.length);
    for (let i = 0; i < legacy.length; i++) expect(mapped[i]).toBe(legacy[i]); // same references
  });

  test("per-rep totals equal the verified matrix (620/57, 685/31, 0/0, 549/10, 151/8)", () => {
    const reps = MATRIX.map((m) => ({ id: m.rep, name: m.rep }));
    const summaries = repRangeSummaries({
      reps,
      calls: applyRosterEligibility(calls, elig),
      appts: [],
      attributions: [],
      allCallsForJoin: applyRosterEligibility(calls, elig),
      leads: [],
      workStart: "2026-09-21",
      workEnd: "2026-09-26",
      thresholdSeconds: 120,
    });
    for (const m of MATRIX) {
      const s = summaries.get(m.rep)!;
      expect(s.totalCalls).toBe(m.calls);
      expect(s.callsOverThreshold).toBe(m.over);
    }
  });

  test("team totals equal the verified matrix (2005 calls / 106 over 2 min)", () => {
    const m = buildTeamRangeMetrics({
      calls: applyRosterEligibility(calls, elig),
      appts: [],
      attributions: [],
      allCallsForJoin: applyRosterEligibility(calls, elig),
      leads: [],
      workStart: "2026-09-21",
      workEnd: "2026-09-26",
      weeks: ["2026-09-21"],
      teamGoalByWeek: new Map([["2026-09-21", 79]]),
      today: "2026-09-26",
      thresholdSeconds: 120,
      activeRepIds: elig.activeIds,
    });
    expect(m.totalCalls).toBe(TEAM_CALLS);
    expect(m.callsOverThreshold).toBe(TEAM_OVER);
  });

  test("ownership buckets reconcile the ledger: 2168 total = 2005 roster + 162 non-roster + 1 unattributed", () => {
    const buckets = buildCallOwnershipBuckets({
      calls,
      activeRepIds: elig.activeIds,
      mappedExternalIds: new Set(elig.mapping.keys()),
      userById: new Map(users.map((u) => [u.id, { name: u.name, external_id: u.external_id }])),
      thresholdSeconds: 120,
    });
    expect(buckets.nonRoster.totalCalls).toBe(TEAM_CALLS === 2005 ? 162 : buckets.nonRoster.totalCalls);
    expect(buckets.nonRoster.totalCalls).toBe(162);
    expect(buckets.nonRoster.users.map((u) => u.name)).toEqual(NON_ROSTER.map((n) => n.name)); // sorted desc by calls
    expect(buckets.unattributed.totalCalls).toBe(NO_USER_ROWS); // ONLY the no-owner rows
    expect(TEAM_CALLS + buckets.nonRoster.totalCalls + buckets.unattributed.totalCalls).toBe(2168);
  });

  test("ownership buckets UNLINKED shape (how the live harvest stored 9/21–25): rep NULL + raw HL id → still 162 non-roster + 1 unattributed", () => {
    // The live DB held the non-roster rows with rep_id NULL and only the raw
    // HL user id (the user row did not exist at call-sync time). Ownership
    // must resolve from the RAW id: Non Roster Calls — never Unattributed.
    const { calls, users } = buildCalls({ linkNonRoster: false });
    const elig = buildRosterEligibility(users, []);
    const buckets = buildCallOwnershipBuckets({
      calls,
      activeRepIds: elig.activeIds,
      mappedExternalIds: new Set(elig.mapping.keys()),
      userById: new Map(users.map((u) => [u.id, { name: u.name, external_id: u.external_id }])),
      thresholdSeconds: 120,
    });
    expect(buckets.nonRoster.totalCalls).toBe(162); // same split as the linked shape
    expect(buckets.nonRoster.users.map((u) => u.name)).toEqual(NON_ROSTER.map((n) => n.name));
    expect(buckets.unattributed.totalCalls).toBe(NO_USER_ROWS); // the no-HL-user row only
  });

  test("attribution eligibility is the IDENTITY with no mappings (same refs)", () => {
    const eligible = applyRosterEligibility(calls, elig);
    const attrs: AttributionRow[] = [
      { id: "a1", appointment_id: "ap1", call_id: eligible[0].id, rep_id: MATRIX[0].rep, method: "phone", confidence: 1, manual_override: false },
      { id: "a2", appointment_id: "ap2", call_id: "unknown-call", rep_id: null, method: "none", confidence: 0, manual_override: false },
    ];
    const out = applyAttributionEligibility(attrs, eligible, elig);
    expect(out.length).toBe(attrs.length);
    expect(out[0]).toBe(attrs[0]);
    expect(out[1]).toBe(attrs[1]);
  });
});

describe("MAPPING SEMANTICS — mapping a synthetic user flips exactly their calls", () => {
  const { calls, users } = buildCalls({ linkNonRoster: true });
  const allisonId = MATRIX[0].rep;
  const LEXA = NON_ROSTER[NON_ROSTER.length - 1]; // hl-lexa, 1 call (under threshold)

  test("mapping hl-lexa → Allison: Allison +1 call, team +1, others untouched", () => {
    const mappings = normalizeRepMappings([{ external_user_id: LEXA.external, rep_id: allisonId }]);
    expect(mappings).toEqual([{ external_user_id: LEXA.external, rep_id: allisonId }]);
    const elig = buildRosterEligibility(users, mappings);
    expect(eligibleRepId({ rep_id: null, provider_rep_external_id: LEXA.external }, elig)).toBe(allisonId);

    const eligible = applyRosterEligibility(calls, elig);
    expect(eligible.length).toBe(TEAM_CALLS + 1);
    expect(eligible.filter((c) => c.rep_id === allisonId).length).toBe(620 + 1);

    const reps = MATRIX.map((m) => ({ id: m.rep, name: m.rep }));
    const summaries = repRangeSummaries({
      reps,
      calls: eligible,
      appts: [],
      attributions: [],
      allCallsForJoin: eligible,
      leads: [],
      workStart: "2026-09-21",
      workEnd: "2026-09-26",
      thresholdSeconds: 120,
    });
    expect(summaries.get(allisonId)!.totalCalls).toBe(621); // exactly +1
    expect(summaries.get(allisonId)!.callsOverThreshold).toBe(57); // Lexa's call is under threshold
    expect(summaries.get(MATRIX[1].rep)!.totalCalls).toBe(685); // Morgano untouched
    expect(summaries.get(MATRIX[4].rep)!.totalCalls).toBe(151); // Laura untouched
  });

  test("mapping shifts team totals by exactly the mapped user's calls", () => {
    const elig = buildRosterEligibility(users, normalizeRepMappings([{ external_user_id: LEXA.external, rep_id: allisonId }]));
    const m = buildTeamRangeMetrics({
      calls: applyRosterEligibility(calls, elig),
      appts: [],
      attributions: [],
      allCallsForJoin: applyRosterEligibility(calls, elig),
      leads: [],
      workStart: "2026-09-21",
      workEnd: "2026-09-26",
      weeks: ["2026-09-21"],
      teamGoalByWeek: new Map([["2026-09-21", 79]]),
      today: "2026-09-26",
      thresholdSeconds: 120,
      activeRepIds: elig.activeIds,
    });
    expect(m.totalCalls).toBe(TEAM_CALLS + 1);
    expect(m.callsOverThreshold).toBe(TEAM_OVER);
  });

  test("buckets drop the mapped user; Unattributed is never touched by mappings", () => {
    const elig = buildRosterEligibility(users, normalizeRepMappings([{ external_user_id: LEXA.external, rep_id: allisonId }]));
    const buckets = buildCallOwnershipBuckets({
      calls,
      activeRepIds: elig.activeIds,
      mappedExternalIds: new Set(elig.mapping.keys()),
      userById: new Map(users.map((u) => [u.id, { name: u.name, external_id: u.external_id }])),
      thresholdSeconds: 120,
    });
    expect(buckets.nonRoster.totalCalls).toBe(161); // 162 − Lexa's 1
    expect(buckets.nonRoster.users.find((u) => u.key === LEXA.external)).toBeUndefined();
    expect(buckets.unattributed.totalCalls).toBe(NO_USER_ROWS);
  });

  test("a mapping to a NON-roster rep is inert (deactivated reps inherit nothing)", () => {
    const elig = buildRosterEligibility(users, normalizeRepMappings([{ external_user_id: LEXA.external, rep_id: "u-hl-christy" }]));
    expect(elig.mapping.size).toBe(0);
    expect(applyRosterEligibility(calls, elig).length).toBe(TEAM_CALLS);
  });

  test("bookings attributed to a mapped user's call flow to the mapped rep (query time)", () => {
    const elig = buildRosterEligibility(users, normalizeRepMappings([{ external_user_id: LEXA.external, rep_id: allisonId }]));
    // a booking whose attribution carries the non-roster call with rep NULL
    const attrs: AttributionRow[] = [
      { id: "a1", appointment_id: "ap-lexa", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false },
    ];
    // find the eligible call that came from Lexa (rep now = allison, provider id = hl-lexa)
    const eligible = applyRosterEligibility(calls, elig);
    const lexaCall = eligible.find((c) => c.provider_rep_external_id === LEXA.external)!;
    const withCall: AttributionRow[] = [{ ...attrs[0], call_id: lexaCall.id }];
    const out = applyAttributionEligibility(withCall, eligible, elig);
    expect(out[0].rep_id).toBe(allisonId); // booking became Allison's — query-time only
    expect(withCall[0].rep_id).toBeNull(); // the row handed in was not mutated
    // with no mapping the same attribution stays exactly as-is
    const noMap = buildRosterEligibility(users, []);
    expect(applyAttributionEligibility(withCall, eligible, noMap)[0].rep_id).toBeNull();
  });
});

describe("IMMUTABLE SOURCE — mapping never rewrites stored rows", () => {
  test("store rows keep rep_id NULL + raw HL id after mapping eligibility is applied", async () => {
    const s = new MemoryStore();
    await s.upsertUsers([
      { id: "r-allison", provider: "highlevel", external_id: "hl-allison", name: "Allison Wittner", email: "a@x.test", is_active: true, call_start_date: null },
      { id: "r-lexa", provider: "highlevel", external_id: "hl-lexa", name: "Lexa Brandis", email: "l@x.test", is_active: false, call_start_date: null },
    ]);
    await s.upsertCalls([
      { id: "stored-1", rep_id: null, contact_id: null, started_at: "2026-09-25T14:00:00.000Z", duration_seconds: 180, over_two_minutes: true, external_call_id: "hlmsg-1", provider: "highlevel", provider_rep_external_id: "hl-lexa", conversation_id: "conv-1" },
    ]);
    // owner maps Lexa → Allison in settings (internal ids are store-generated)
    const all = await s.getAllUsers();
    const allisonInternalId = all.find((u) => u.external_id === "hl-allison")!.id;
    await s.saveSettings({ rep_mappings: [{ external_user_id: "hl-lexa", rep_id: allisonInternalId }] });

    const users = await s.getAllUsers();
    const elig = buildRosterEligibility(users, (await s.getSettings()).rep_mappings ?? []);
    const raw = await s.getCallsBetween("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    expect(raw[0].rep_id).toBeNull(); // SOURCE ROW UNCHANGED
    expect(raw[0].provider_rep_external_id).toBe("hl-lexa"); // RAW ID UNCHANGED

    const eligible = applyRosterEligibility(raw, elig);
    // QUERY-TIME view only. The decorated copy carries the MAPPED rep's
    // STORE-GENERATED internal id (upsertUsers ignores caller-supplied ids —
    // "r-allison" was never the stored id; the store assigned its own, which
    // the mapping above resolved via getAllUsers()). Asserting the literal
    // "r-allison" here was the defect: it tested the store's id policy, not
    // eligibility.
    expect(eligible[0].rep_id).toBe(allisonInternalId);
    expect(eligible[0]).not.toBe(raw[0]); // a copy, never the stored row
    expect(raw[0].rep_id).toBeNull(); // original still untouched

    // The RAW audit view ignores mappings (they change reporting eligibility,
    // never source truth): the call's owner IS a known HL user outside the
    // roster — Lexa, resolved from provider_rep_external_id — so it shows in
    // Non Roster Calls and NEVER in Unattributed. The immutable ids (HL
    // message id + conversation id) remain fully inspectable there.
    const audit = await s.getAuditCalls("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "non-roster", 120);
    expect(audit).toHaveLength(1); // KNOWN user outside the roster (mapped users stay visible in the raw view)
    expect(audit[0].external_call_id).toBe("hlmsg-1");
    expect(audit[0].conversation_id).toBe("conv-1");
    expect(audit[0].rep_name).toBe("Lexa Brandis"); // resolved from the raw HL user id
    const unattributed = await s.getAuditCalls("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "unattributed", 120);
    expect(unattributed).toHaveLength(0); // ownership IS determinable (Lexa) — never Unattributed
  });
});

describe("call_start_date / repOperatingState — before/on/after boundary (ET)", () => {
  const DAN = "2026-09-28"; // Monday — owner's worked example

  test("before the start date → not-yet-active", () => {
    expect(repOperatingState(DAN, "2026-09-27")).toBe("not-yet-active");
    expect(repOperatingState(DAN, "2026-09-21")).toBe("not-yet-active");
  });
  test("ON the start date → active (normal monitoring begins that day)", () => {
    expect(repOperatingState(DAN, "2026-09-28")).toBe("active");
  });
  test("after the start date → active", () => {
    expect(repOperatingState(DAN, "2026-09-29")).toBe("active");
    expect(repOperatingState(DAN, "2026-10-05")).toBe("active");
  });
  test("no start date (null/undefined/garbage) → always active", () => {
    expect(repOperatingState(null, "2026-09-20")).toBe("active");
    expect(repOperatingState(undefined, "2026-09-20")).toBe("active");
    expect(repOperatingState("09/28/2026", "2026-09-20")).toBe("active");
  });
  test("MemoryStore backfills Dan McKillop = 2026-09-28 (owner directive)", async () => {
    const s = new MemoryStore();
    await s.upsertUsers([
      { id: "temp-dan", provider: "highlevel", external_id: "hl-dan", name: "Dan McKillop", email: "dan@malloryportraits.com", is_active: true, call_start_date: null },
    ]);
    const users = await s.getUsers();
    expect(users.find((u) => u.name === "Dan McKillop")?.call_start_date).toBe("2026-09-28");
    const danId = users.find((u) => u.name === "Dan McKillop")!.id;
    await s.setUserCallStartDate(danId, null); // owner editor can clear it
    expect((await s.getAllUsers()).find((u) => u.id === danId)?.call_start_date).toBeNull();
    await s.setUserCallStartDate(danId, "2026-10-05"); // and set it
    expect((await s.getUsers()).find((u) => u.id === danId)?.call_start_date).toBe("2026-10-05");
  });
});
