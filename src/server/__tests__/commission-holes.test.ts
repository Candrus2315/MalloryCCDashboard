/**
 * OWNER RULING 3 — NARROW filled-hole derivation + RULING 1 qualifying-win
 * gating (pure, no store). The prior session's broad "day under capacity"
 * default is REJECTED; every test below is the narrow semantics:
 *
 *  - the week's derived schedule: 10 slots/day, 9 on Tuesday (69/week)
 *  - slot open/filled state evaluated at Monday 00:00 ET
 *  - a slot filled when the week began was NEVER a hole of that week
 *  - advance bookings (created pre-week) for this week's slots do NOT qualify
 *  - a cancelled-then-rebooked slot is not open at week start → never pays
 *  - in-week bookings for LATER weeks fill no current-week hole
 *  - ONLY rep-attributed paid-deposit Booking Wins fill a hole (RULING 2)
 */
import { describe, expect, test } from "bun:test";
import { addDays } from "../date-logic";
import type { AppointmentRow, AttributionRow } from "../metrics/compute";
import {
  computeWeeklyCommissions,
  commissionEmployeeOf,
  deriveFilledHolesForWeek,
  etTimeOfInstant,
  qualifyingRepWinsForWeek,
  scheduledSlotTimesForDay,
  slotBlockOf,
  tierHeldForWeek,
} from "../commission/derive";
import type { CommissionEmployeeInput } from "../commission/engine";
import type { UserRow } from "../store/types";

const WEEK = "2026-09-07"; // Monday
const WEEK_END = "2026-09-13"; // Sunday

/** ET → UTC instant for September 2026 (EDT, UTC−4 — fixed offset is exact for this test month). */
function etToUtc(date: string, time: string): string {
  const [h, m] = time.split(":").map(Number);
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h + 4, m, 0)).toISOString();
}

let seq = 0;
interface ApptOverrides {
  date?: string;
  time?: string;
  created?: string; // ET creation date (S7c created_business_date)
  paid?: boolean;
  cancelled?: boolean;
  type?: string;
}
function appt(o: ApptOverrides = {}): AppointmentRow {
  seq += 1;
  const date = o.date ?? "2026-09-09";
  const time = o.time ?? "10:00";
  const created = o.created ?? date;
  return {
    id: `appt-${seq}`,
    contact_id: null,
    calendar_id: "cal-mallory",
    appointment_type: o.type ?? "Portrait Session",
    appointment_datetime: etToUtc(date, time),
    created_at: etToUtc(created, "12:00"), // full precision (S7c) — noon ET creation
    created_business_date: created,
    created_time_precision: "full",
    payment_state: o.paid === false ? "pending_payment" : "paid",
    booking_win_business_date: o.paid === false ? null : created,
    status: o.cancelled ? "cancelled" : "scheduled",
    cancelled: !!o.cancelled,
    raw: { paid: o.paid === false ? "no" : "yes" } as Record<string, unknown>,
  };
}
function attr(apptId: string, repId: string | null, opts: { note?: string; manual?: boolean } = {}): AttributionRow {
  seq += 1;
  return {
    id: `attr-${seq}`,
    appointment_id: apptId,
    call_id: null,
    rep_id: repId,
    method: repId ? "contact_id" : "none",
    confidence: repId ? 1 : 0,
    manual_override: !!opts.manual,
    note: opts.note ?? null,
  };
}
const emp = (id: string, name: string, ft: boolean, tier: 1 | 2 | 3 | 4 | 5): CommissionEmployeeInput => ({
  userId: id,
  name,
  employmentType: ft ? "full_time" : "part_time",
  tier,
  tierEffectiveDate: "2026-08-31",
});

describe("derived schedule (owner ruling 9/29 model)", () => {
  test("10 slots non-Tuesday (08:00 start), 9 on Tuesday (09:00 start), 69/week", () => {
    expect(scheduledSlotTimesForDay("2026-09-07")).toEqual(["08:00", "09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30", "17:30"]);
    expect(scheduledSlotTimesForDay("2026-09-08")).toEqual(["09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30", "17:30"]);
    const week = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"];
    expect(week.reduce((n, d) => n + scheduledSlotTimesForDay(d).length, 0)).toBe(69);
    expect(slotBlockOf("12:00")).toBe("morning");
    expect(slotBlockOf("13:30")).toBe("afternoon");
  });
  test("etTimeOfInstant renders ET clock time", () => {
    expect(etTimeOfInstant(Date.parse(etToUtc("2026-09-09", "13:30")))).toBe("13:30");
  });
});

describe("RULING 3 — narrow slot-level derivation", () => {
  test("a dark week: 69 open slots, zero filled, zero bonus", () => {
    const d = deriveFilledHolesForWeek({ weekStart: WEEK, sessionAppts: [], repWins: [] });
    expect(d.totalSlots).toBe(69);
    expect(d.openAtStart).toBe(69);
    expect(d.audit).toEqual([]);
    expect(d.byRep.size).toBe(0);
    expect(d.days.find((x) => x.date === "2026-09-08")).toEqual({ date: "2026-09-08", capacity: 9, openAtStart: 9, filledByRep: 0 });
  });
  test("open-at-start slot filled IN-WEEK by a rep-attributed paid win → exactly $10 + full audit row", () => {
    const win = appt({ date: "2026-09-09", time: "10:00", created: "2026-09-09" });
    const a = attr(win.id, "rep-carmine");
    const d = deriveFilledHolesForWeek({ weekStart: WEEK, sessionAppts: [win], repWins: [] });
    expect(d.openAtStart).toBe(69); // nothing blocked it
    expect(d.audit).toEqual([]);
    // With the win properly derived:
    const wins = qualifyingRepWinsForWeek([win], [a], WEEK, WEEK_END);
    expect(wins.length).toBe(1);
    const d2 = deriveFilledHolesForWeek({ weekStart: WEEK, sessionAppts: [win], repWins: wins });
    expect(d2.audit.length).toBe(1);
    expect(d2.byRep.get("rep-carmine")).toBe(1);
    const row = d2.audit[0];
    expect(row).toMatchObject({
      userId: "rep-carmine",
      appointmentId: win.id,
      appointment_date_et: "2026-09-09",
      appointment_time_et: "10:00",
      slot_date: "2026-09-09",
      slot_time: "10:00",
      slot_block: "morning",
      bonus_cents: 1000,
      week_start: WEEK,
    });
    expect(d2.openAtStart).toBe(69); // still 69 — it WAS open when the week began, then filled
    const wed = d2.days.find((x) => x.date === "2026-09-09");
    expect(wed).toEqual({ date: "2026-09-09", capacity: 10, openAtStart: 10, filledByRep: 1 });
  });
  test("slot already filled when the week began (advance booking created PRE-week) → NEVER a hole", () => {
    const advance = appt({ date: "2026-09-11", time: "08:00", created: "2026-09-04", paid: false, type: "Online Booking" });
    // Even a full rep-attributed PAID win created pre-week for this week's slot:
    const advancePaid = appt({ date: "2026-09-10", time: "11:00", created: "2026-09-02" });
    const d = deriveFilledHolesForWeek({
      weekStart: WEEK,
      sessionAppts: [advance, advancePaid],
      repWins: [], // pre-week-created wins aren't even in the week's win-date bucket
    });
    expect(d.openAtStart).toBe(67); // 69 − 2 pre-existing occupants
    expect(d.audit).toEqual([]);
  });
  test("cancelled-then-rebooked edge: the pre-week record blocks the slot (conservative, never pays)", () => {
    const cancelled = appt({ date: "2026-09-12", time: "13:30", created: "2026-09-03", cancelled: true });
    const rebook = appt({ date: "2026-09-12", time: "13:30", created: "2026-09-10" });
    const wins = qualifyingRepWinsForWeek([rebook], [attr(rebook.id, "rep-allison")], WEEK, WEEK_END);
    expect(wins.length).toBe(1);
    const d = deriveFilledHolesForWeek({ weekStart: WEEK, sessionAppts: [cancelled, rebook], repWins: wins });
    expect(d.audit).toEqual([]); // NOT a qualifying hole — it was not open at Monday 00:00 ET
    expect(d.openAtStart).toBe(68);
    const sat = d.days.find((x) => x.date === "2026-09-12");
    expect(sat?.filledByRep).toBe(0);
  });
  test("a win created in-week for a LATER week's session fills no current-week hole", () => {
    const later = appt({ date: "2026-09-15", time: "10:00", created: "2026-09-09" }); // next week's Tuesday
    const wins = qualifyingRepWinsForWeek([later], [attr(later.id, "rep-allison")], WEEK, WEEK_END);
    expect(wins.length).toBe(1); // it IS a qualifying win (win date in-week)
    const d = deriveFilledHolesForWeek({ weekStart: WEEK, sessionAppts: [later], repWins: wins });
    expect(d.audit).toEqual([]);
    expect(d.byRep.size).toBe(0);
  });
  test("Tuesday 08:00 is off-grid (first Tuesday slot is 09:00) — such a session fills nothing", () => {
    const offGrid = appt({ date: "2026-09-08", time: "08:00", created: "2026-09-08" });
    const wins = qualifyingRepWinsForWeek([offGrid], [attr(offGrid.id, "rep-allison")], WEEK, WEEK_END);
    expect(wins.length).toBe(1);
    const d = deriveFilledHolesForWeek({ weekStart: WEEK, sessionAppts: [offGrid], repWins: wins });
    expect(d.audit).toEqual([]);
    const tue = d.days.find((x) => x.date === "2026-09-08");
    expect(tue?.openAtStart).toBe(9); // all 9 Tuesday slots still open
  });
  test("a rep win can fill a hole even when OTHER slots that day are dark (slot-level, not day-level)", () => {
    // 5 sessions on Wednesday: only the rep win's own slot fills.
    const sessions = [
      appt({ date: "2026-09-09", time: "08:00", created: "2026-09-01", paid: false }), // pre-week advance
      appt({ date: "2026-09-09", time: "09:00", created: "2026-09-09", paid: false }), // in-week pending (online, unpaid)
      appt({ date: "2026-09-09", time: "10:00", created: "2026-09-02", paid: true }), // pre-week paid
    ];
    const win = appt({ date: "2026-09-09", time: "13:30", created: "2026-09-09" });
    const wins = qualifyingRepWinsForWeek([win], [attr(win.id, "rep-laura")], WEEK, WEEK_END);
    const d = deriveFilledHolesForWeek({ weekStart: WEEK, sessionAppts: [...sessions, win], repWins: wins });
    expect(d.audit.length).toBe(1);
    expect(d.audit[0].slot_time).toBe("13:30");
    expect(d.audit[0].slot_block).toBe("afternoon");
    expect(d.openAtStart).toBe(67); // 69 − (08:00 pre-week pending + 10:00 pre-week paid)
    expect(d.days.find((x) => x.date === "2026-09-09")?.filledByRep).toBe(1);
  });
});

describe("RULING 1 — qualifying-win gating (rep-attributed paid wins only)", () => {
  const winAppt = (o: ApptOverrides = {}) => appt({ date: "2026-09-09", time: "09:00", created: "2026-09-09", ...o });
  test("attributed + manual + ambiguous + unattributed + no-verdict", () => {
    const a1 = winAppt();
    const a2 = winAppt({ time: "10:00" });
    const a3 = winAppt({ time: "11:00" });
    const a4 = winAppt({ time: "13:30" });
    const a5 = winAppt({ time: "14:30" });
    const attributions = [
      attr(a1.id, "rep-allison"),
      attr(a2.id, "rep-allison", { manual: true }), // manual assignment counts
      attr(a3.id, null, { note: "ambiguous: two candidates" }), // never pays
      attr(a4.id, null), // unattributed — never pays
      // a5: NO verdict row — never guessed into rep credit
    ];
    const wins = qualifyingRepWinsForWeek([a1, a2, a3, a4, a5], attributions, WEEK, WEEK_END);
    expect(wins.map((w) => w.appointmentId).sort()).toEqual([a1.id, a2.id].sort());
  });
  test("unpaid/pending never counts; cancelled never counts; win date governs the bucket", () => {
    const pending = winAppt({ paid: false });
    const cancelled = winAppt({ time: "10:00", cancelled: true });
    const outsideWeek = winAppt({ time: "11:00", created: "2026-09-29", date: "2026-09-29" });
    const attributed = [attr(pending.id, "rep-x"), attr(cancelled.id, "rep-x"), attr(outsideWeek.id, "rep-x")];
    expect(qualifyingRepWinsForWeek([pending, cancelled, outsideWeek], attributed, WEEK, WEEK_END)).toEqual([]);
  });
});

describe("computeWeeklyCommissions integration (§5 + §G + §H on the narrow holes)", () => {
  test("a near-dark week (>8 open at start) ZEROES every hole bonus (RULING 5) but keeps the fills visible", () => {
    const win = appt({ date: "2026-09-09", time: "09:00", created: "2026-09-09" });
    const win2 = appt({ date: "2026-09-10", time: "08:00", created: "2026-09-10" });
    const allison = emp("rep-allison", "Allison", true, 5);
    const carmine = emp("rep-carmine", "Carmine", true, 1);
    const computation = computeWeeklyCommissions({
      weekStart: WEEK,
      wins: [win, win2],
      attributions: [attr(win.id, "rep-carmine"), attr(win2.id, "rep-carmine")],
      sessionAppts: [win, win2],
      employees: [allison, carmine],
    });
    expect(computation.teamQualifyingBookings).toBe(2);
    expect(computation.poolUnlocked).toBe(false); // 2 < 79 → locked
    expect(computation.openAtStart).toBe(69); // no pre-week occupants → > 8 → RULING 5 cap
    expect(computation.holeBonusCapped).toBe(true);
    const carmineRow = computation.employees.find((e) => e.userId === "rep-carmine");
    const allisonRow = computation.employees.find((e) => e.userId === "rep-allison");
    expect(carmineRow?.qualifyingBookings).toBe(2);
    expect(carmineRow?.baseCents).toBe(1000); // FT T1 flat: 2 × $5
    expect(carmineRow?.filledHoles).toBe(2); // WHAT was filled stays visible (facts, not money)
    expect(carmineRow?.holeCents).toBe(0); // RULING 5: >8 open at start → hole money $0 for EVERY rep
    expect(carmineRow?.totalCents).toBe(1000); // base only — hole and pool contribute nothing
    expect(carmineRow?.poolCents).toBe(0);
    expect(allisonRow).toMatchObject({ qualifyingBookings: 0, totalCents: 0 }); // §5: present at $0
    // Slot-level audit rows stay DERIVED but ZEROED so the drawer can still show what WAS filled.
    expect(computation.holeAudit.length).toBe(2);
    for (const h of computation.holeAudit) expect(h.bonus_cents).toBe(0);
    expect(computation.totalSlots).toBe(69);
  });
  test("a win occupying an already-filled slot adds NO hole bonus (RULING 3 narrow)", () => {
    // An advance booking created PRE-week for this week's slot, whose deposit was
    // paid in-week — a qualifying BOOKING (RULING 1: win date 9/9) but the slot
    // was filled when the week began, so it fills NO hole (RULING 3).
    const win = { ...appt({ date: "2026-09-09", time: "09:00", created: "2026-09-02" }), booking_win_business_date: "2026-09-09" };
    const computation = computeWeeklyCommissions({
      weekStart: WEEK,
      wins: [win],
      attributions: [attr(win.id, "rep-allison", { manual: true })],
      sessionAppts: [win],
      employees: [emp("rep-allison", "Allison", true, 5)],
    });
    expect(computation.employees[0].qualifyingBookings).toBe(1); // counts as a booking
    expect(computation.employees[0].filledHoles).toBe(0); // but fills NO hole
    expect(computation.holeAudit).toEqual([]);
  });
});

describe("RULING 5 — hole-bonus cap (owner directive 10/2: ≤8 open at start pays, >8 never does)", () => {
  /** The week's full derived slot grid (Mon..Sun), day-ordered — 69 entries. */
  function weekSlots(weekStart: string): { date: string; time: string }[] {
    const out: { date: string; time: string }[] = [];
    let d = weekStart;
    for (let i = 0; i < 7; i++) {
      for (const t of scheduledSlotTimesForDay(d)) out.push({ date: d, time: t });
      d = addDays(d, 1);
    }
    return out;
  }
  /** Pre-week PENDING occupants: they block their slots at week start (conservative rule) and are never wins. */
  function preWeekOccupants(slots: { date: string; time: string }[]): AppointmentRow[] {
    return slots.map((s) => appt({ date: s.date, time: s.time, created: "2026-09-01", paid: false }));
  }
  test("exactly 8 open at start → hole bonus PAID ($10 + full audit)", () => {
    const grid = weekSlots(WEEK);
    expect(grid.length).toBe(69);
    const occupants = preWeekOccupants(grid.slice(0, 61)); // 69 − 61 = 8 open
    const freeSlot = grid[61]!; // Sunday 09:00
    const win = appt({ date: freeSlot.date, time: freeSlot.time, created: freeSlot.date });
    const computation = computeWeeklyCommissions({
      weekStart: WEEK,
      wins: [win],
      attributions: [attr(win.id, "rep-carmine")],
      sessionAppts: [...occupants, win],
      employees: [emp("rep-carmine", "Carmine", true, 1)],
    });
    expect(computation.openAtStart).toBe(8); // ≤ 8 → pays
    expect(computation.holeBonusCapped).toBe(false);
    const carmineRow = computation.employees[0];
    expect(carmineRow.filledHoles).toBe(1);
    expect(carmineRow.holeCents).toBe(1000);
    expect(carmineRow.totalCents).toBe(1500); // FT T1: 1 × $5 + $10 hole
    expect(computation.holeAudit.length).toBe(1);
    expect(computation.holeAudit[0]).toMatchObject({ slot_date: freeSlot.date, slot_time: freeSlot.time, bonus_cents: 1000 });
  });
  test("9 open at start → CAPPED: hole bonus $0, audit retained but zeroed", () => {
    const grid = weekSlots(WEEK);
    const occupants = preWeekOccupants(grid.slice(0, 60)); // 69 − 60 = 9 open
    const freeSlot = grid[60]!; // Sunday 08:00
    const win = appt({ date: freeSlot.date, time: freeSlot.time, created: freeSlot.date });
    const computation = computeWeeklyCommissions({
      weekStart: WEEK,
      wins: [win],
      attributions: [attr(win.id, "rep-carmine")],
      sessionAppts: [...occupants, win],
      employees: [emp("rep-carmine", "Carmine", true, 1)],
    });
    expect(computation.openAtStart).toBe(9); // > 8 → the owner's 10/2 ruling
    expect(computation.holeBonusCapped).toBe(true);
    const carmineRow = computation.employees[0];
    expect(carmineRow.filledHoles).toBe(1); // the fill itself stays derived
    expect(carmineRow.holeCents).toBe(0); // but the money is $0
    expect(carmineRow.totalCents).toBe(500); // base only (FT T1: 1 × $5)
    expect(computation.holeAudit.length).toBe(1); // drawer can still show what WAS filled
    expect(computation.holeAudit[0]).toMatchObject({ slot_date: freeSlot.date, slot_time: freeSlot.time, bonus_cents: 0 });
  });
  test(">8 zeroes EVERY rep in the week (multi-rep week), base/pool untouched", () => {
    const grid = weekSlots(WEEK);
    const occupants = preWeekOccupants(grid.slice(0, 60)); // 9 open at start
    const s1 = grid[60]!;
    const s2 = grid[61]!;
    const winA = appt({ date: s1.date, time: s1.time, created: s1.date });
    const winB = appt({ date: s2.date, time: s2.time, created: s2.date });
    const computation = computeWeeklyCommissions({
      weekStart: WEEK,
      wins: [winA, winB],
      attributions: [attr(winA.id, "rep-carmine"), attr(winB.id, "rep-allison")],
      sessionAppts: [...occupants, winA, winB],
      employees: [emp("rep-carmine", "Carmine", true, 1), emp("rep-allison", "Allison", true, 5)],
    });
    expect(computation.holeBonusCapped).toBe(true);
    const carmineRow = computation.employees.find((e) => e.userId === "rep-carmine");
    const allisonRow = computation.employees.find((e) => e.userId === "rep-allison");
    expect(carmineRow?.filledHoles).toBe(1);
    expect(allisonRow?.filledHoles).toBe(1);
    expect(carmineRow?.holeCents).toBe(0); // EVERY rep zeroed
    expect(allisonRow?.holeCents).toBe(0);
    expect(carmineRow?.baseCents).toBe(500); // base unaffected
    expect(allisonRow?.baseCents).toBe(2000); // FT T5: 1 × $20 unaffected
    expect(computation.holeAudit.length).toBe(2); // both fills visible at $0
    for (const h of computation.holeAudit) expect(h.bonus_cents).toBe(0);
  });
});

describe("commissionEmployeeOf + tierHeldForWeek (§B — tier held during the week)", () => {
  const user = (over: Partial<UserRow>): UserRow => ({
    id: "u1",
    provider: "highlevel",
    external_id: "x",
    name: "X",
    email: null,
    is_active: true,
    call_start_date: null,
    ...over,
  });
  test("ineligible / tierless / invalid tier / bad employment → null (never silently $0)", () => {
    expect(commissionEmployeeOf(user({ commission_eligible: false, employment_type: "full_time", commission_tier: 5 }))).toBeNull();
    expect(commissionEmployeeOf(user({ commission_eligible: true, employment_type: "full_time", commission_tier: null }))).toBeNull();
    expect(commissionEmployeeOf(user({ commission_eligible: true, employment_type: "full_time", commission_tier: 9 }))).toBeNull();
    expect(commissionEmployeeOf(user({ commission_eligible: true, employment_type: "seasonal", commission_tier: 3 }))).toBeNull();
    expect(commissionEmployeeOf(user({ commission_eligible: true, employment_type: "part_time", commission_tier: 3 }))).toMatchObject({ tier: 3 });
  });
  test("tier effective after the week → skipped; on/before the week end → included", () => {
    const late = { userId: "u", name: "X", employmentType: "full_time" as const, tier: 3 as const, tierEffectiveDate: "2026-09-20" };
    const lastDay = { ...late, tierEffectiveDate: "2026-09-13" };
    const midWeek = { ...late, tierEffectiveDate: "2026-09-09" };
    expect(tierHeldForWeek(late, WEEK, WEEK_END)).toBeNull();
    expect(tierHeldForWeek(lastDay, WEEK, WEEK_END)).toBe(lastDay);
    expect(tierHeldForWeek(midWeek, WEEK, WEEK_END)).toBe(midWeek);
  });
});

describe("RepWin typing sanity (appointmentDatetime carried for slot matching)", () => {
  test("RepWin instances carry the session instant", () => {
    const win = appt();
    const wins = qualifyingRepWinsForWeek([win], [attr(win.id, "rep-a")], WEEK, WEEK_END);
    expect(wins[0].appointmentDatetime).toBe(win.appointment_datetime);
  });
});
