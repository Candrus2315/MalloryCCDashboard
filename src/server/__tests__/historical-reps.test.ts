/**
 * HISTORICAL REPS (owner directive 2026-10-20: "weekly report is wrong, add
 * back whatever you took out — I think it was Laura's bookings").
 *
 * Laura Rivera left the CC team 10/20 and was removed from
 * settings.active_roster; her users row flipped is_active=false on sync. The
 * owner ordered her HISTORICAL contribution restored to the REPORTING
 * surfaces (Weekly incl. By-Rep + per-day grid + CC Report copy text; Reps
 * incl. per-rep history and team totals) while she STAYS off the active team.
 *
 * Pinned here:
 *  (a) reporting eligibility = ACTIVE ROSTER ∪ HISTORICAL REPS (buildReporting-
 *      Eligibility / reportingRepUsers), mappings pointing at a historical rep
 *      stay INERT;
 *  (b) operational surfaces stay ACTIVE-ROSTER-ONLY — Today's team call gate
 *      (buildRosterEligibility) and the sync's is_active write rule
 *      (isRosterUser against the active roster) never see historical entries;
 *  (c) a departed rep's WEEKLY numbers equal the pre-removal numbers
 *      byte-for-byte (Laura's real Oct 12–18 facts: 2 wins, both manual
 *      overrides — the $30 line is commission dollars outside the Weekly
 *      payload, which counts wins);
 *  (d) EMPTY historical_reps behaves bit-identically (pure sets AND whole
 *      page payloads deep-equal).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { UserRow } from "../store/types";
import { todayPageData, repsPageData, weeklyPageData } from "../page-data";
import {
  applyRosterEligibility,
  buildRosterEligibility,
  buildReportingEligibility,
  historicalRepIds,
  isRosterUser,
  reportingRepUsers,
} from "../roster";
import type { CallRow, LeadRow } from "../metrics/compute";

// The owner's directive day: Tue 2026-10-20 — last completed week = Oct 12–18.
const TODAY = "2026-10-20";
const LW_MON = "2026-10-12";
const LW_SUN = "2026-10-18";
const ET = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString();

const LAURA = { name: "Laura Rivera", emails: ["laura@malloryportraits.com"] };
const HISTORICAL = [LAURA];
/** The post-removal active roster (Laura OFF — exactly the live state). */
const ROSTER_WITHOUT_LAURA = [
  { name: "Allison Wittner", emails: ["allisonwittner@gmail.com", "allison@malloryportraits.com"] },
  { name: "Carmine Morgano", emails: ["carmine@malloryportraits.com"] },
  { name: "Dan McKillop", emails: ["dan@malloryportraits.com"] },
  { name: "Jennifer Stitt", emails: ["jennifer@malloryportraits.com"] },
];

/**
 * One store, two states. RAW ROWS identical: Laura's real Oct 12–18 facts —
 * 2 paid wins (both manual overrides), calls in-week and current-week, and an
 * assigned lead. Only the ROSTER state differs:
 *  - state "active"  : Laura is_active=true, default roster (pre-removal);
 *  - state "departed": Laura is_active=false, roster without her, historical_reps=[Laura].
 */
async function seedLauraWeek(state: "active" | "departed" | "departed-empty-historical") {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  await store.upsertUsers(
    ["Allison Wittner", "Dan McKillop", "Laura Rivera"].map((name) => ({
      id: name,
      provider: "highlevel",
      external_id: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      email: name === "Laura Rivera" ? "laura@malloryportraits.com" : `${name.split(" ")[0].toLowerCase()}@malloryportraits.com`,
      is_active: !(name === "Laura Rivera" && state !== "active"),
      call_start_date: null,
    })),
  );
  if (state === "departed") {
    await store.saveSettings({ active_roster: ROSTER_WITHOUT_LAURA, historical_reps: HISTORICAL });
  } else if (state === "departed-empty-historical") {
    await store.saveSettings({ active_roster: ROSTER_WITHOUT_LAURA }); // historical stays []
  }
  const all = await store.getAllUsers();
  const idOf = (name: string) => all.find((u) => u.name === name)!.id;
  const lauraId = idOf("Laura Rivera");
  const allisonId = idOf("Allison Wittner");

  const call = (ext: string, rep: string, etDate: string, dur: number): CallRow & { external_call_id: string; provider: string } => ({
    id: `call-${ext}`,
    external_call_id: ext,
    provider: "highlevel",
    rep_id: rep,
    contact_id: `contact-${ext}`,
    started_at: ET(etDate, "10:00"),
    duration_seconds: dur,
    over_two_minutes: dur > 120,
  });
  await store.upsertCalls([
    // Laura: 3 calls in the report week + 2 in the CURRENT week (operational-gate pins).
    call("l1", lauraId, "2026-10-13", 300),
    call("l2", lauraId, "2026-10-14", 300),
    call("l3", lauraId, "2026-10-17", 300),
    call("lc1", lauraId, "2026-10-19", 300),
    call("lc2", lauraId, "2026-10-20", 300),
    // Allison: 1 call in the report week + 1 current-week call.
    call("a1", allisonId, "2026-10-14", 300),
    call("ac1", allisonId, "2026-10-19", 300),
  ]);

  const win = (id: string, createdDate: string, type = "Family Portrait Session") => ({
    id,
    acuity_appointment_id: id,
    contact_id: `contact-${id}`,
    calendar_id: "cal-1",
    appointment_type: type,
    appointment_datetime: ET(createdDate, "14:00"),
    created_at: ET(createdDate, "12:00"),
    created_business_date: createdDate,
    booking_win_business_date: createdDate,
    raw: { priceSold: "300.00", amountPaid: "300.00" },
    status: "scheduled",
    cancelled: false,
  });
  await store.upsertAppointments([
    win("appt-l1", "2026-10-14"), // Laura win 1 (Wed)
    win("appt-l2", "2026-10-17"), // Laura win 2 (Sat) — like her live Oct 12–18 facts
    win("appt-a1", "2026-10-13"), // Allison win
  ]);
  // Attributions reference the STORE-GENERATED internal appointment ids
  // (upsert keys on the Acuity id) — resolve them the production way.
  const stored = await store.getAppointmentsOverlapping("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
  const apptId = (acuityId: string) => stored.find((a) => a.acuity_appointment_id === acuityId)!.id;
  const attr = (acuityId: string, repId: string): { id: string; appointment_id: string; call_id: string | null; rep_id: string; method: string; confidence: number; manual_override: boolean } => ({
    id: `attr-${acuityId}`,
    appointment_id: apptId(acuityId),
    call_id: null,
    rep_id: repId,
    method: "manual",
    confidence: 1,
    manual_override: true, // Laura's live wins that week are manual overrides
  });
  await store.upsertAttributions([attr("appt-l1", lauraId), attr("appt-l2", lauraId), attr("appt-a1", allisonId)]);

  const lead = (ext: string, source: string, rep: string | null): LeadRow & { source_id: string; provider: string } => ({
    id: `lead-${ext}`,
    source_id: ext,
    provider: "google_sheets",
    lead_type: "family",
    source_date: source,
    work_date: source,
    contact_id: null,
    assigned_rep_id: rep,
    source_sheet: "family",
  });
  await store.upsertLeads([lead("l1", "2026-10-13", lauraId), lead("a1", "2026-10-13", allisonId)]);

  return { store, lauraId, allisonId };
}

// ---------- (a) reporting eligibility union ----------

describe("HISTORICAL REPS — (a) reporting eligibility = ACTIVE ∪ HISTORICAL", () => {
  test("buildReportingEligibility includes the departed rep's id; buildRosterEligibility does not", async () => {
    const { store, lauraId } = await seedLauraWeek("departed");
    const allUsers = await store.getAllUsers();
    const settings = await store.getSettings();

    const reporting = buildReportingEligibility(allUsers, settings);
    expect(reporting.activeIds.has(lauraId)).toBe(true);
    const activeOnly = buildRosterEligibility(allUsers, settings.rep_mappings ?? []);
    expect(activeOnly.activeIds.has(lauraId)).toBe(false);

    // The union drives the call gate: Laura's in-week calls flow back in.
    const calls = await store.getCallsBetween(ET(LW_MON, "00:00"), ET(LW_SUN, "23:59"));
    const lauraCalls = calls.filter((c) => c.rep_id === lauraId);
    expect(lauraCalls).toHaveLength(3);
    expect(applyRosterEligibility(lauraCalls, activeOnly)).toHaveLength(0); // broken state
    expect(applyRosterEligibility(lauraCalls, reporting)).toHaveLength(3); // restored
  });

  test("a rep_mapping pointing at a HISTORICAL (non-active) rep stays inert", async () => {
    const { store, lauraId, allisonId } = await seedLauraWeek("departed");
    const allUsers = await store.getAllUsers();

    const inert = buildReportingEligibility(allUsers, {
      historical_reps: HISTORICAL,
      rep_mappings: [{ external_user_id: "hl-legacy", rep_id: lauraId }],
    });
    expect(inert.mapping.has("hl-legacy")).toBe(false); // inert exactly as today

    const live = buildReportingEligibility(allUsers, {
      historical_reps: HISTORICAL,
      rep_mappings: [{ external_user_id: "hl-legacy", rep_id: allisonId }],
    });
    expect(live.mapping.get("hl-legacy")).toBe(allisonId); // active-target mappings unaffected
  });

  test("reportingRepUsers — departed rep joins the list; empty historical = exact active list", async () => {
    const { store, lauraId } = await seedLauraWeek("departed");
    const allUsers = await store.getAllUsers();
    const withHistorical = reportingRepUsers(allUsers, HISTORICAL);
    expect(withHistorical.map((u) => u.id)).toContain(lauraId);
    expect(withHistorical.some((u) => u.is_active === false && u.id === lauraId)).toBe(true);

    const without = reportingRepUsers(allUsers, []);
    expect(without).toEqual(allUsers.filter((u) => u.is_active)); // same rows, same order
    // element-identity: no copies when the historical list is empty
    expect(without.every((u, i) => u === allUsers.filter((x) => x.is_active)[i])).toBe(true);
  });
});

// ---------- (b) operational surfaces stay ACTIVE-ROSTER-ONLY ----------

describe("HISTORICAL REPS — (b) Today + sync is_active write stay active-only", () => {
  test("Today's team call gate (buildRosterEligibility) still excludes the departed rep", async () => {
    const { store, lauraId } = await seedLauraWeek("departed");
    const allUsers = await store.getAllUsers();
    const settings = await store.getSettings();
    // The operational builder ignores historical_reps BY CONSTRUCTION (its
    // input has none) — pinned so a future signature change cannot drift.
    const operational = buildRosterEligibility(allUsers, settings.rep_mappings ?? []);
    expect(operational.activeIds.has(lauraId)).toBe(false);

    // End-to-end on the operational page: the per-rep strip lists ONLY the
    // active rep — Laura's row never appears on Today even though she is a
    // historical rep, and Allison's WTD call count stays 1 (Laura's 2 calls
    // in the week-to-date window are excluded by the active-only gate).
    const today = await todayPageData({ store, today: TODAY, etNowMinutes: 9 * 60 });
    expect(today.metrics.repRows.map((r) => r.name)).not.toContain("Laura Rivera");
    expect(today.metrics.repRows.map((r) => r.name)).toContain("Allison Wittner");
    expect(today.metrics.repRows.find((r) => r.name === "Allison Wittner")!.totalCalls).toBe(1);
  });

  test("the sync's is_active rule matches the ACTIVE roster only — Laura stays inactive", async () => {
    expect(isRosterUser(LAURA.name, LAURA.emails[0], ROSTER_WITHOUT_LAURA)).toBe(false);
    // sanity: the same rule matched her while she was rostered
    expect(isRosterUser(LAURA.name, LAURA.emails[0], ROSTER_WITHOUT_LAURA.concat([LAURA]))).toBe(true);
    // a historical list must NEVER flip the verdict on its own
    expect(isRosterUser(LAURA.name, LAURA.emails[0], [])).toBe(false);
  });
});

// ---------- (c) departed-rep weekly numbers = pre-removal numbers ----------

describe("HISTORICAL REPS — (c) Weekly output for the departed rep equals pre-removal", () => {
  test("Laura's Oct 12–18 weekly rows are byte-identical: active vs departed+historical", async () => {
    const active = await seedLauraWeek("active");
    const departed = await seedLauraWeek("departed");

    const weeklyActive = await weeklyPageData({ store: active.store, today: TODAY });
    const weeklyDeparted = await weeklyPageData({ store: departed.store, today: TODAY });

    // Laura's by-rep row: 2 wins, both manual overrides (her live facts).
    const lauraActive = weeklyActive.bookings.repRows.find((r) => r.rep_name === "Laura Rivera");
    expect(lauraActive?.total).toBe(2);
    expect(lauraActive?.manual).toBe(2);
    expect(weeklyDeparted.bookings.repRows).toEqual(weeklyActive.bookings.repRows);

    // Per-day × per-rep grid identical (her Sat Oct 17 win in its column).
    expect(weeklyDeparted.bookings.dayByRep).toEqual(weeklyActive.bookings.dayByRep);
    const lauraGrid = weeklyDeparted.bookings.dayByRep.reps.find((r) => r.rep_name === "Laura Rivera");
    expect(lauraGrid?.counts).toEqual([0, 0, 1, 0, 0, 1, 0]); // Wed Oct 14 + Sat Oct 17

    // Conversion + MTD + the copied CC Report text identical.
    expect(weeklyDeparted.conversion).toEqual(weeklyActive.conversion);
    expect(weeklyDeparted.mtd.repRows).toEqual(weeklyActive.mtd.repRows);
    expect(weeklyDeparted.report.reportText).toBe(weeklyActive.report.reportText);
  });
});

// ---------- Reps page: restored row + team totals + Past-rep marker ----------

describe("HISTORICAL REPS — Reps page restores the departed rep (marked Past rep)", () => {
  test("departed rep's row, calls and team averages return; she leaves the Non Roster bucket", async () => {
    const departed = await seedLauraWeek("departed");
    const reps = await repsPageData({ range: "last-week", week: LW_MON }, { store: departed.store, today: TODAY });

    const laura = reps.repList.find((r) => r.name === "Laura Rivera");
    expect(laura).toBeDefined();
    expect(laura!.historical).toBe(true); // the Past-rep marker
    expect(laura!.totalCalls).toBe(3); // her in-week calls restored
    expect(laura!.totalBookings).toBe(2); // her wins restored

    // She is a CC-rep owner again in the assigned-leads grid, NOT an "Other Lead Owner".
    const gridLaura = reps.assignedByDay.rows.find((r) => r.rep_name === "Laura Rivera");
    expect(gridLaura).toBeDefined();
    expect(gridLaura!.total.family).toBe(1);

    // Team averages cover ALL THREE reps again (incl. the departed one).
    expect(reps.repList).toHaveLength(3);
    expect(reps.nonRoster.users.some((u) => u.name === "Laura Rivera")).toBe(false);

    // selectable: ?rep=<lauraId> resolves her detail with the same metrics.
    const detail = await repsPageData({ range: "last-week", week: LW_MON, rep: departed.lauraId }, { store: departed.store, today: TODAY });
    expect(detail.detail?.rep.name).toBe("Laura Rivera");
    expect(detail.repList.find((r) => r.isSelected)?.historical).toBe(true);
  });
});

// ---------- (d) empty historical_reps is bit-identical ----------

describe("HISTORICAL REPS — (d) empty historical_reps is bit-identical", () => {
  test("pure: empty historical eligibility deep-equals the operational builder", async () => {
    const { store } = await seedLauraWeek("departed-empty-historical");
    const allUsers = await store.getAllUsers();
    const a = buildReportingEligibility(allUsers, { historical_reps: [], rep_mappings: [] });
    const b = buildRosterEligibility(allUsers, []);
    expect([...a.activeIds].sort()).toEqual([...b.activeIds].sort());
    expect(a.mapping.size).toBe(b.mapping.size);
    expect(historicalRepIds(allUsers, [])).toEqual(new Set());
  });

  test("page-level: whole payloads identical with historical [] vs the key absent", async () => {
    const active = await seedLauraWeek("active"); // historical never written (key absent after normalize → [])
    const activeExplicit = await seedLauraWeek("active");
    await activeExplicit.store.saveSettings({ historical_reps: [] });

    const repsA = await repsPageData({ range: "last-week", week: LW_MON }, { store: active.store, today: TODAY });
    const repsB = await repsPageData({ range: "last-week", week: LW_MON }, { store: activeExplicit.store, today: TODAY });
    expect(JSON.stringify(repsB)).toBe(JSON.stringify(repsA));

    const weeklyA = await weeklyPageData({ store: active.store, today: TODAY });
    const weeklyB = await weeklyPageData({ store: activeExplicit.store, today: TODAY });
    expect(JSON.stringify(weeklyB)).toBe(JSON.stringify(weeklyA));
  });

  test("normalize: empty/invalid historical entries fall back to [] (never the default five)", async () => {
    const { normalizeHistoricalReps } = await import("../store/types");
    expect(normalizeHistoricalReps([])).toEqual([]);
    expect(normalizeHistoricalReps(undefined)).toEqual([]);
    expect(normalizeHistoricalReps([{ name: "", emails: ["x@y.z"] }, { name: "Ok Rep", emails: [] }])).toEqual([]);
    expect(normalizeHistoricalReps([{ name: " Laura Rivera ", emails: [" LAURA@malloryportraits.com "], stray: 1 }])).toEqual([
      { name: "Laura Rivera", emails: ["LAURA@malloryportraits.com"] },
    ]);
  });
});
