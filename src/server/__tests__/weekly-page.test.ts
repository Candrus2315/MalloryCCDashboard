/**
 * WEEKLY REPORT (owner directive 2026-09-29) — deterministic tests.
 *
 * Covers:
 *  1. The Mon–Sun boundary: the most recent COMPLETED week (lastCompleted-
 *     WeekStart) — a Sunday belongs to the week that ended the previous day;
 *     the in-progress week is never "last week". Year boundary included.
 *  2. MTD bucketing: month start .. today (ET calendar arithmetic through the
 *     store's win-bucket query) — Aug 31 is out for September, the following
 *     Monday is out of last week but inside MTD, and pending (unpaid) rows
 *     never count anywhere.
 *  3. The full payload builder through the established PageDeps seam
 *     (MemoryStore + pinned today): win split, attribution join (manual
 *     overrides ARE rep bookings; unattributed = team-total-only line),
 *     source-dated assigned-lead conversion, leads by source_date, derived
 *     calendar capacity (from the seeded schedule config — never a hardcoded
 *     9/day), first fully open day, and the no-goal honest state.
 */
import { describe, expect, test } from "bun:test";
import { lastCompletedWeekStart, monthStartDate, goalVsActual, isAnimaliaSession, winsByDate } from "../metrics/weekly";
import { availabilityPageData, weeklyPageData, type AvailabilityViewPayload } from "../page-data";
import { MemoryStore } from "../store/memory";
import type { AppointmentRow, AvailabilityRule } from "../metrics/compute";

// Operating week Mon 2026-09-21 .. Sun 2026-09-27; today pinned Tue 2026-09-29.
const TODAY = "2026-09-29";
const LW_MON = "2026-09-21";
const LW_SUN = "2026-09-27";
const NEXT_MON = "2026-09-28";
const H = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString(); // EDT

describe("weekly window + MTD bucket boundaries (pure)", () => {
  test("lastCompletedWeekStart — Tue → prior Monday; Mon → the week that ended yesterday", () => {
    expect(lastCompletedWeekStart(TODAY)).toBe(LW_MON);
    expect(lastCompletedWeekStart("2026-09-28")).toBe(LW_MON); // Monday morning report covers the week just finished
  });
  test("an in-progress week is NEVER 'last week' — Sat/Sun reach back one more week", () => {
    expect(lastCompletedWeekStart("2026-09-27")).toBe("2026-09-14"); // Sunday: 9/21..9/27 is not complete
    expect(lastCompletedWeekStart("2026-09-26")).toBe("2026-09-14"); // Saturday
  });
  test("year boundary — Thu Jan 1, 2026 → the Mon–Sun week Dec 22–28, 2025", () => {
    expect(lastCompletedWeekStart("2026-01-01")).toBe("2025-12-22");
  });
  test("monthStartDate — ET calendar month start (MTD window floor)", () => {
    expect(monthStartDate(TODAY)).toBe("2026-09-01");
    expect(monthStartDate("2026-01-01")).toBe("2026-01-01");
    expect(monthStartDate("2026-12-31")).toBe("2026-12-01");
  });
  test("goalVsActual — 'X/Goal (±N)' with the owner's −/±/+ signs; goal '—' when unset", () => {
    expect(goalVsActual(62, 79)).toBe("62/79 (−17)");
    expect(goalVsActual(80, 79)).toBe("80/79 (+1)");
    expect(goalVsActual(79, 79)).toBe("79/79 (±0)");
    expect(goalVsActual(5, null)).toBe("5/—");
  });
  test("isAnimaliaSession — case-insensitive containment, everything else family", () => {
    expect(isAnimaliaSession("Animalia Session (cat & other animals)")).toBe(true);
    expect(isAnimaliaSession("Auction Animalia Session + 20\" Portrait")).toBe(true);
    expect(isAnimaliaSession("Portrait Session")).toBe(false);
    expect(isAnimaliaSession("animalia Mini")).toBe(true);
  });
  test("winsByDate — zero-fills the window and ignores out-of-window wins", () => {
    const win = (id: string, date: string): AppointmentRow => ({
      id,
      contact_id: null,
      calendar_id: null,
      appointment_type: "Portrait Session",
      appointment_datetime: H(date, "14:00"),
      created_at: H(date, "12:00"),
      created_business_date: date,
      booking_win_business_date: date,
      raw: { priceSold: "300.00", amountPaid: "300.00" },
      status: "scheduled",
      cancelled: false,
    });
    const map = winsByDate([win("a", LW_MON), win("b", LW_MON), win("c", LW_SUN), win("d", NEXT_MON)], [
      LW_MON,
      "2026-09-22",
      LW_SUN,
    ]);
    expect(map.get(LW_MON)).toBe(2);
    expect(map.get("2026-09-22")).toBe(0);
    expect(map.get(LW_SUN)).toBe(1);
    expect(map.size).toBe(3); // the next-Monday win is not in the window
  });
});

// ---------- builder end-to-end (MemoryStore + pinned clock) ----------

const rules3Blocks: AvailabilityRule[] = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, open_time: "09:00", close_time: "10:00", active: true },
  { weekday, open_time: "11:00", close_time: "12:00", active: true },
  { weekday, open_time: "14:00", close_time: "15:00", active: true },
]); // 3 one-hour blocks/day → 3 slots/day → 21/week (deliberately NOT the live 2-block shape)

async function seedWeeklyStore(): Promise<{ store: MemoryStore; idOf: (name: string) => string }> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  await store.upsertUsers(
    ["Allison Wittner", "Carmine Morgano", "Jennifer Stitt", "Laura Rivera", "Dan McKillop"].map((name) => ({
      id: name,
      provider: "highlevel",
      external_id: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      email: null,
      is_active: true,
      call_start_date: null,
    })),
  );
  const all = await store.getAllUsers();
  const idOf = (name: string) => all.find((u) => u.name === name)!.id;

  const win = (id: string, winDate: string | null, type: string, createdDate: string, paid = true) => ({
    id,
    acuity_appointment_id: id,
    contact_id: "k1",
    calendar_id: "cal-1",
    appointment_type: type,
    appointment_datetime: H(createdDate, "14:00"),
    created_at: H(createdDate, "12:00"),
    created_business_date: createdDate,
    booking_win_business_date: winDate,
    raw: paid ? { priceSold: "300.00", amountPaid: "300.00" } : { paid: "no", priceSold: "300.00" },
    status: "scheduled",
    cancelled: false,
  });
  await store.upsertAppointments([
    // LAST WEEK (9/21..9/27)
    win("w-mon-1", LW_MON, "Portrait Session", LW_MON),
    win("w-mon-2", LW_MON, "Animalia Session", LW_MON),
    win("w-tue-1", "2026-09-22", "Animalia Session", "2026-09-22"),
    win("w-sun-1", LW_SUN, "Portrait Session", LW_SUN), // Sunday — the last day IN
    win("w-unattr-1", "2026-09-24", "Portrait Session", "2026-09-24"), // no attribution → online/unattributed
    // boundary rows
    win("w-next-mon-1", NEXT_MON, "Portrait Session", NEXT_MON), // Monday after — out of last week, IN MTD
    win("w-aug-31", "2026-08-31", "Portrait Session", "2026-08-31"), // before September — out of MTD
    win("w-sep-1", "2026-09-01", "Portrait Session", "2026-09-01"), // MTD floor day — IN
    win("w-mtd-unattr", "2026-09-10", "Animalia Session", "2026-09-10"), // MTD unattributed
    win("w-pending", null, "Portrait Session", "2026-09-23", false), // pending payment — NEVER counts
  ]);

  // The stores generate INTERNAL appointment ids (upsert keys on the Acuity
  // id) — attributions reference internal ids in production, so resolve them
  // the same way before seeding (memory-store mirror of the pg uuid join).
  const stored = await store.getAppointmentsOverlapping("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
  const apptId = (acuityId: string) => stored.find((a) => a.acuity_appointment_id === acuityId)!.id;

  const manual = idOf("Carmine Morgano");
  await store.upsertAttributions([
    { id: "a1", appointment_id: apptId("w-mon-1"), call_id: null, rep_id: idOf("Allison Wittner"), method: "contact_id", confidence: 1, manual_override: false },
    { id: "a2", appointment_id: apptId("w-mon-2"), call_id: null, rep_id: idOf("Allison Wittner"), method: "contact_id", confidence: 1, manual_override: false },
    { id: "a3", appointment_id: apptId("w-tue-1"), call_id: null, rep_id: manual, method: "manual", confidence: 1, manual_override: true },
    { id: "a4", appointment_id: apptId("w-sun-1"), call_id: null, rep_id: idOf("Jennifer Stitt"), method: "contact_id", confidence: 1, manual_override: false },
    { id: "a5", appointment_id: apptId("w-next-mon-1"), call_id: null, rep_id: idOf("Laura Rivera"), method: "contact_id", confidence: 1, manual_override: false },
    { id: "a6", appointment_id: apptId("w-aug-31"), call_id: null, rep_id: idOf("Allison Wittner"), method: "contact_id", confidence: 1, manual_override: false },
    { id: "a7", appointment_id: apptId("w-sep-1"), call_id: null, rep_id: idOf("Allison Wittner"), method: "contact_id", confidence: 1, manual_override: false },
    { id: "a8", appointment_id: apptId("w-mtd-unattr"), call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false }, // ambiguous → unattributed
    // w-unattr-1 + w-pending deliberately have NO attribution row
  ]);

  await store.upsertLeads(
    (
      [
        ["l1", "family", LW_MON, true],
        ["l2", "family", "2026-09-22", true],
        ["l3", "animalia", "2026-09-25", true],
        ["l4", "animalia", "2026-09-26", false],
        ["l5", "family", "2026-09-20", true], // Sunday before the week — out
        ["l6", "animalia", NEXT_MON, true], // Monday after — out
        ["l7", "animalia", "2026-09-23", true],
        ["l8", "family", "2026-09-24", true],
        ["l9", "family", "2026-09-26", false],
        ["l10", "animalia", LW_MON, true],
      ] as const
    ).map(([id, type, source, assigned]) => ({
      id,
      lead_type: type,
      source_date: source,
      work_date: source,
      contact_id: null,
      assigned_rep_id: assigned ? idOf("Allison Wittner") : null,
      source_sheet: type,
      source_id: id,
      provider: "google_sheets",
    })),
  );

  await store.upsertTeamGoal({ week_start: LW_MON, booking_goal: 7, lead_budget: 700 });

  // calendar: sessions this week (incl. Monday before today), next week, beyond; one cancelled.
  // raw {paid:"no"} — future unpaid sessions are NEVER wins, so they can't pollute
  // the MTD bucket; the calendar section counts them regardless of payment.
  const session = (id: string, date: string, time: string, cancelled = false) => ({
    id,
    acuity_appointment_id: id,
    contact_id: null,
    calendar_id: "cal-1",
    appointment_type: "Portrait Session",
    appointment_datetime: H(date, time),
    created_at: H("2026-09-20", "10:00"),
    created_business_date: "2026-09-20",
    raw: { paid: "no", priceSold: "300.00" },
    status: cancelled ? "cancelled" : "scheduled",
    cancelled,
  });
  await store.upsertAppointments([
    session("c-mon", NEXT_MON, "15:00"),
    session("c-tue", TODAY, "14:00"),
    session("c-wed", "2026-09-30", "14:00"),
    session("c-fri-cancelled", "2026-10-02", "14:00", true),
    session("c-next-week", "2026-10-06", "14:00"),
    session("c-beyond", "2026-10-20", "14:00"),
  ]);
  await store.upsertAvailabilityRules(rules3Blocks);
  return { store, idOf };
}

describe("weeklyPageData (MemoryStore, pinned today)", () => {
  test("LAST WEEK bucket: Sun in / next-Monday out; daily strip, type split, goal line", async () => {
    const { store } = await seedWeeklyStore();
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.week.start).toBe(LW_MON);
    expect(data.week.end).toBe(LW_SUN);
    // wins: mon-1, mon-2, tue-1, sun-1, unattr-1 — pending never counts, next-Monday out
    expect(data.bookings.total).toBe(5);
    expect(data.bookings.family).toBe(3);
    expect(data.bookings.animalia).toBe(2);
    expect(data.bookings.goal).toBe(7);
    expect(data.bookings.goalLine).toBe("5/7 (−2)");
    expect(data.bookings.daily).toEqual([
      { date: LW_MON, count: 2 },
      { date: "2026-09-22", count: 1 },
      { date: "2026-09-23", count: 0 },
      { date: "2026-09-24", count: 1 }, // w-unattr-1 — a team win (the online/unattributed line)
      { date: "2026-09-25", count: 0 },
      { date: "2026-09-26", count: 0 },
      { date: LW_SUN, count: 1 },
    ]);
  });

  test("BY REP: manual overrides count as rep bookings; unattributed is the separate team-only line", async () => {
    const { store } = await seedWeeklyStore();
    const data = await weeklyPageData({ store, today: TODAY });
    const rows = data.bookings.repRows;
    expect(rows.find((r) => r.rep_name === "Allison Wittner")?.total).toBe(2);
    const carmine = rows.find((r) => r.rep_name === "Carmine Morgano");
    expect(carmine?.total).toBe(1);
    expect(carmine?.manual).toBe(1); // owner override — still a rep booking
    expect(rows.find((r) => r.rep_name === "Jennifer Stitt")?.total).toBe(1);
    expect(rows.find((r) => r.rep_name === "Laura Rivera")?.total).toBe(0); // her win is NEXT Monday — out
    expect(rows.find((r) => r.rep_name === "Dan McKillop")?.total).toBe(0); // zero-win roster rep still listed
    expect(data.bookings.unattributed).toBe(1);
    // team total includes the unattributed win (5 = 2+1+1+0+0 + 1)
    expect(rows.reduce((s, r) => s + r.total, 0) + data.bookings.unattributed).toBe(data.bookings.total);
  });

  test("CONVERSION: numerator = rep-attributed wins; denominator = source-dated assigned leads", async () => {
    const { store } = await seedWeeklyStore();
    const data = await weeklyPageData({ store, today: TODAY });
    // assigned leads in 9/21..9/27: l1,l2,l8 (family) + l3,l7,l10 (animalia) — l4/l9 unassigned, l5/l6 out of window
    expect(data.conversion.denominator).toEqual({ overall: 6, family: 3, animalia: 3 });
    // rep wins last week: mon-1,sun-1 (family) + mon-2,tue-1 (animalia) — unattr-1 excluded
    expect(data.conversion.numerator).toEqual({ overall: 4, family: 2, animalia: 2 });
    expect(data.conversion.overall).toBeCloseTo(4 / 6, 6);
    expect(data.conversion.family).toBeCloseTo(2 / 3, 6);
    expect(data.conversion.animalia).toBeCloseTo(2 / 3, 6);
  });

  test("LEADS: sheet leads by source_date in the week (in/out boundaries respected)", async () => {
    const { store } = await seedWeeklyStore();
    const data = await weeklyPageData({ store, today: TODAY });
    // in-window (9/21..9/27): family l1,l2,l8,l9; animalia l3,l4,l7,l10 — l5 (Sun before) and l6 (Mon after) out
    expect(data.leads).toEqual({ family: 4, animalia: 4, total: 8 });
  });

  test("MTD: month-start..today bucket — Aug 31 out, next-Monday in, top performer highlighted", async () => {
    const { store } = await seedWeeklyStore();
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.month.start).toBe("2026-09-01");
    expect(data.month.end).toBe(TODAY);
    // in: sep-1, mon-1, mon-2, tue-1, unattr-1, mtd-unattr, next-mon-1, sun-1 = 8 (pending never; aug-31 out)
    expect(data.mtd.total).toBe(8);
    const rows = data.mtd.repRows;
    expect(rows.find((r) => r.rep_name === "Allison Wittner")?.total).toBe(3); // sep-1, mon-1, mon-2 (aug-31 out)
    expect(rows.find((r) => r.rep_name === "Carmine Morgano")?.total).toBe(1);
    expect(rows.find((r) => r.rep_name === "Laura Rivera")?.total).toBe(1); // next-Monday win counts in MTD
    expect(data.mtd.unattributed).toBe(2); // unattr-1 + mtd-unattr
    expect(data.mtd.topPerformer).toEqual({ repId: rows[0].rep_id, repName: "Allison Wittner", total: 3 });
    // no monthly goal exists anywhere — never invented
    expect(data.mtd.goal).toBeNull();
  });

  test("CALENDAR: buckets vs DERIVED capacity (3 blocks → 3 slots/day → 21/week), first fully open day", async () => {
    const { store } = await seedWeeklyStore();
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.calendar.thisWeek.appointments).toBe(4); // Mon + Tue + Wed sessions + w-next-mon-1 (its session is 9/28); the cancelled one never counts
    expect(data.calendar.nextWeek.appointments).toBe(1);
    expect(data.calendar.beyond).toBe(1); // visible, never silently dropped
    // DISTINCT-SLOT OCCUPANCY (owner report 10/6): fill counts slots, not
    // sessions — c-mon's 15:00 session sits OFF this schedule's grid (blocks
    // 09–10, 11–12, 14–15 → slots 09:00/11:00/14:00), so it counts as a
    // session but occupies NO slot: 4 sessions on 3 distinct slots.
    expect(data.calendar.thisWeek.slotsOccupied).toBe(3);
    expect(data.calendar.nextWeek.slotsOccupied).toBe(1);
    // capacity from the SEEDED config (3 one-hour blocks/day), not a hardcoded 9
    expect(data.calendar.thisWeek.capacity).toBe(21);
    expect(data.calendar.nextWeek.capacity).toBe(21);
    // 9/29, 9/30 have sessions → first zero-appointment open day is Oct 1
    expect(data.calendar.firstFullyOpenDay).toBe("2026-10-01");
  });

  test("goalless week: default 79 shown + honest warning (never invented data)", async () => {
    const store = new MemoryStore();
    await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.bookings.goal).toBe(79);
    expect(data.bookings.goalLine).toBe("0/79 (−79)");
    expect(data.warnings.some((w) => w.includes("No team booking goal stored"))).toBe(true);
    expect(data.warnings.some((w) => w.includes("No paid bookings recorded"))).toBe(true);
    expect(data.warnings.some((w) => w.includes("No sheet leads"))).toBe(true);
  });
});

// ---------- OWNER REPORT 10/6 "CALENDAR-FILL ACCURACY" fixture ----------
// The owner's real Oct 5–11 numbers (65 appointments on only 61 distinct
// slots — 4 double-booked: Oct 5 ×1, Oct 7 ×1, Oct 11 ×2; 4 pending_payment
// in window), reconstructed against the REAL studio schedule (the live
// settings grid: non-Tue 08:00–13:00 + 13:30–18:30, Tue from 09:00; 60-min
// interval/duration → 10 slots/day, 9 Tue = 69/week — the same grid the
// commission engine derives). The live DB has moved on since the report
// (cancellation reconciliation #44 + new bookings), so the reported snapshot
// is pinned as a fixture, not read live.
const OW_TODAY = "2026-10-07"; // Wednesday inside the reported week
const OW_MON = "2026-10-05";
const OW_SUN = "2026-10-11";
// the REAL rules shape (weekday 2 = Tuesday starts 09:00; close 13:00 keeps
// the 12:00 session, close 18:30 keeps the 17:30 session)
const realRules: AvailabilityRule[] = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, open_time: weekday === 2 ? "09:00" : "08:00", close_time: "13:00", active: true },
  { weekday, open_time: "13:30", close_time: "18:30", active: true },
]);
// per-day session layout: [singles on grid times..., doubles as [time, ×2]]
// → Oct 5: 9 distinct/10 sessions; Oct 6: 8/8; Oct 7: 9/10; Oct 8–10: 9/9 each;
//   Oct 11: 8 distinct/10 sessions. Totals: 61 distinct slots, 65 sessions.
const OW_GRID = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30", "17:30"];
const OW_DAY_PLAN: Array<[string, string[], string[]]> = [
  // [date, single times, double times]
  [OW_MON, ["08:00", "09:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30"], ["10:00"]],
  ["2026-10-06", ["09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30"], []], // Tue grid (no 08:00)
  ["2026-10-07", ["08:00", "09:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30"], ["10:00"]],
  ["2026-10-08", ["08:00", "09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30"], []],
  ["2026-10-09", ["08:00", "09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30"], []],
  ["2026-10-10", ["08:00", "09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30"], []],
  [OW_SUN, ["08:00", "09:00", "10:00", "11:00", "12:00", "13:30"], ["14:30", "15:30"]],
];
const PENDING_SLOTS = new Set(["2026-10-05|08:00", "2026-10-06|09:00", "2026-10-07|13:30", "2026-10-11|08:00"]);

async function seedOwnerWeekStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.saveSettings({
    acuity: { calendars_included: [], types_included: [] },
    studio: { hours: realRules }, // the engine grid == the canonical 10/day 9-Tue grid
  });
  await store.upsertAvailabilityRules(realRules); // the weekly report reads the mirror when non-empty
  const rows: AppointmentRow[] = [];
  let n = 0;
  for (const [date, singles, doubles] of OW_DAY_PLAN) {
    for (const t of singles) {
      n += 1;
      rows.push({
        id: `ow-${n}`,
        acuity_appointment_id: `ow-${n}`,
        contact_id: null,
        calendar_id: "1335091",
        appointment_type: "Portrait Session",
        appointment_datetime: H(date, t),
        created_at: H("2026-10-04", "12:00"),
        created_business_date: "2026-10-04",
        booking_win_business_date: null,
        raw: { paid: "no", priceSold: "300.00" },
        status: PENDING_SLOTS.has(`${date}|${t}`) ? "scheduled" : "scheduled",
        cancelled: false,
        payment_state: PENDING_SLOTS.has(`${date}|${t}`) ? "pending_payment" : null,
      });
    }
    for (const t of doubles) {
      for (let k = 0; k < 2; k++) {
        n += 1;
        rows.push({
          id: `ow-${n}`,
          acuity_appointment_id: `ow-${n}`,
          contact_id: null,
          calendar_id: "1335091",
          appointment_type: "Portrait Session",
          appointment_datetime: H(date, t),
          created_at: H("2026-10-04", "12:00"),
          created_business_date: "2026-10-04",
          booking_win_business_date: null,
          raw: { paid: "no", priceSold: "300.00" },
          status: "scheduled",
          cancelled: false,
          payment_state: null,
        });
      }
    }
  }
  await store.upsertAppointments(rows);
  return store;
}

describe("OWNER FIXTURE Oct 5–11: calendar fill counts DISTINCT occupied slots", () => {
  test("65 sessions on 61 distinct of 69 slots — fill = 61, never 65; sessions stay visible; holes UNCHANGED (locked raw-basis)", async () => {
    const store = await seedOwnerWeekStore();
    const data = await weeklyPageData({ store, today: OW_TODAY });
    const tw = data.calendar.thisWeek;
    expect(tw.start).toBe(OW_MON);
    expect(tw.end).toBe(OW_SUN);
    // raw session population (the owner's count)
    expect(tw.appointments).toBe(65);
    // the FIX: distinct occupied slots — the fill number, not 65
    expect(tw.slotsOccupied).toBe(61);
    expect(tw.capacity).toBe(69); // real schedule: 10/day, 9 Tue
    // next week empty in this fixture
    expect(data.calendar.nextWeek.appointments).toBe(0);
    expect(data.calendar.nextWeek.slotsOccupied).toBe(0);
    // pending_payment sessions COUNT as booked (owner ruling pending — no
    // decision in code): the 4 pending rows are inside the 65/61.
    expect(tw.appointments).toBe(65); // includes the 4 pending_payment rows
    // the LOCKED hole derivation is UNTOUCHED — appointment-count basis:
    // 69 − 65 = 4 holes (fill basis would imply 8 unfilled slots; the
    // divergence is flagged, not silently reconciled — see the PR).
    expect(tw.holes).not.toBeNull();
    expect(tw.holes!.capacity).toBe(69);
    expect(tw.holes!.booked).toBe(65);
    expect(tw.holes!.holes).toBe(4);
    // the copied report line: distinct-slot fill + visible sessions
    expect(data.report.reportText).toContain("This week: 61/69 filled (88%) · 65 sessions");
  });

  test("AVAILABILITY page booked counts are DISTINCT slots too (already the engine's behavior — regression-pinned): Oct 5–11 sums 61", async () => {
    const store = await seedOwnerWeekStore();
    const page = await availabilityPageData({ store, today: OW_TODAY, view: { view: "month", month: "2026-10" } });
    const view = page.view as AvailabilityViewPayload;
    const week = view.days.filter((d) => d.date >= OW_MON && d.date <= OW_SUN);
    expect(week).toHaveLength(7);
    // per-day distinct occupied slots (owner's doubles: −1 Oct 5, −1 Oct 7, −2 Oct 11)
    expect(week.map((d) => d.booked)).toEqual([9, 8, 9, 9, 9, 9, 8]);
    const sum = week.reduce((s, d) => s + d.booked, 0);
    expect(sum).toBe(61); // 65 appointments − 4 doubles — never 65
    expect(view.summary.booked).toBeGreaterThanOrEqual(61); // month summary counts the whole month
    expect(week.map((d) => d.totalCapacity)).toEqual([10, 9, 10, 10, 10, 10, 10]);
  });
});
