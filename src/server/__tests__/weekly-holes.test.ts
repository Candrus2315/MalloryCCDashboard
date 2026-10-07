/**
 * OWNER HOLES (owner definition 2026-09-30) — deterministic tests.
 *
 * Holes = empty booking slots = derived capacity (10 slots/day, 9 on Tuesday
 * = 69/week) − booked sessions per ET day, summed Mon–Sun. The derivation
 * reuses the commission engine's slot helpers (ONE studio-slot derivation,
 * never a second engine):
 *
 *  1. deriveWeeklyHoles (pure): capacity 69 (9 Tue), cancelled sessions never
 *     count as booked, out-of-week/unparsable sessions ignored, an overbooked
 *     day clamps at 0 (holes are EMPTY slots, never negative), and the owner's
 *     reference-week shape (9/21–9/27: 49 booked, Thursday 9/24 fully dark →
 *     20 holes) reproduces exactly.
 *  2. COPY REPORT (buildWeeklyCcReportText): with holes supplied the Holes
 *     line becomes "Holes (empty slots): N"; with holes null the legacy blank
 *     "Holes:" placeholder is preserved BYTE-IDENTICAL, and supplying holes
 *     changes ONLY that one line — every other line of the report is
 *     untouched (verified line-by-line in both directions).
 */
import { describe, expect, test } from "bun:test";
import { deriveWeeklyHoles, isCancelledSession } from "../commission/derive";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import { weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";
import type { AppointmentRow, LeadRow } from "../metrics/compute";

const EDT = "-04:00"; // September = EDT
const H = (date: string, time: string) => new Date(`${date}T${time}:00.000${EDT}`).toISOString();

/** A session appointment (holes care about the SESSION instant, not payment). */
const sess = (id: string, date: string, time: string, opts?: { cancelled?: boolean; datetime?: string }): AppointmentRow => ({
  id,
  acuity_appointment_id: id,
  contact_id: null,
  calendar_id: null,
  appointment_type: "Portrait Session",
  appointment_datetime: opts?.datetime ?? H(date, time),
  created_at: H(date, "09:00"),
  created_business_date: date,
  booking_win_business_date: null,
  raw: {},
  status: opts?.cancelled ? "cancelled" : "scheduled",
  cancelled: opts?.cancelled ?? false,
});

describe("deriveWeeklyHoles (pure, owner definition 9/30)", () => {
  test("derived capacity: 10 slots/day, 9 on Tuesday = 69/week", () => {
    const w = deriveWeeklyHoles({ weekStart: "2026-09-21", sessionAppts: [] });
    expect(w.capacity).toBe(69);
    expect(w.booked).toBe(0);
    expect(w.holes).toBe(69);
    expect(w.days.map((d) => d.capacity)).toEqual([10, 9, 10, 10, 10, 10, 10]);
    expect(w.days.map((d) => d.date)).toEqual([
      "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27",
    ]);
  });

  test("the owner's reference week 9/21–9/27: 49 booked, Thu 9/24 fully dark → 20 holes", () => {
    // Per-day booked: 8 + 7 + 8 + 0 + 8 + 9 + 9 = 49 (owner's reference total).
    const sessions: AppointmentRow[] = [
      ...Array.from({ length: 8 }, (_, i) => sess(`m${i}`, "2026-09-21", `${String(8 + i).padStart(2, "0")}:00`)),
      ...Array.from({ length: 7 }, (_, i) => sess(`t${i}`, "2026-09-22", `${String(9 + i).padStart(2, "0")}:00`)),
      ...Array.from({ length: 8 }, (_, i) => sess(`w${i}`, "2026-09-23", `${String(8 + i).padStart(2, "0")}:00`)),
      // Thursday 9/24: fully dark — zero sessions (and a cancelled record that must NOT count).
      sess("thx-cancelled", "2026-09-24", "10:00", { cancelled: true }),
      ...Array.from({ length: 8 }, (_, i) => sess(`f${i}`, "2026-09-25", `${String(8 + i).padStart(2, "0")}:00`)),
      ...Array.from({ length: 9 }, (_, i) => sess(`s${i}`, "2026-09-26", `${String(8 + i).padStart(2, "0")}:00`)),
      ...Array.from({ length: 9 }, (_, i) => sess(`u${i}`, "2026-09-27", `${String(8 + i).padStart(2, "0")}:00`)),
    ];
    const w = deriveWeeklyHoles({ weekStart: "2026-09-21", sessionAppts: sessions });
    expect(w.capacity).toBe(69);
    expect(w.booked).toBe(49); // cancelled never counts as booked
    expect(w.holes).toBe(20);
    expect(w.days.find((d) => d.date === "2026-09-24")).toEqual({
      date: "2026-09-24",
      capacity: 10,
      booked: 0,
      holes: 10, // Thursday fully dark = 10 holes alone
    });
    expect(w.days.map((d) => d.holes)).toEqual([2, 2, 2, 10, 2, 1, 1]);
  });

  test("cancelled sessions are excluded by either cancellation signal (flag or status)", () => {
    expect(isCancelledSession(sess("a", "2026-09-21", "08:00"))).toBe(false);
    expect(isCancelledSession(sess("b", "2026-09-21", "08:00", { cancelled: true }))).toBe(true);
    const statusCancelled = { ...sess("c", "2026-09-21", "08:00"), cancelled: false, status: "cancelled" };
    expect(isCancelledSession(statusCancelled)).toBe(true);
  });

  test("an overbooked day clamps at zero — holes are never negative", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => sess(`x${i}`, "2026-09-21", `${String(8 + (i % 11)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`));
    const w = deriveWeeklyHoles({ weekStart: "2026-09-21", sessionAppts: sessions });
    expect(w.days[0]).toMatchObject({ capacity: 10, booked: 12, holes: 0 });
    expect(w.holes).toBe(59); // 10 clamped Monday + Tue..Sun full 69 capacity... minus the other 10 booked = 69-10
  });

  test("sessions outside the week and unparsable instants are ignored — never guessed", () => {
    const sessions: AppointmentRow[] = [
      sess("before", "2026-09-20", "10:00"), // prior Sunday
      sess("after", "2026-09-28", "10:00"), // next Monday
      sess("bad", "2026-09-23", "10:00", { datetime: "not-a-date" }), // unparsable session time
      sess("in", "2026-09-23", "10:00"),
    ];
    const w = deriveWeeklyHoles({ weekStart: "2026-09-21", sessionAppts: sessions });
    expect(w.booked).toBe(1);
    expect(w.days[2]).toMatchObject({ booked: 1, holes: 9 });
  });
});

// ---------- COPY REPORT: the Holes line is additive-only ----------
/** A representative report input — every template line present. */
const baseInput: WeeklyCcReportInput = {
  week: { start: "2026-09-21", end: "2026-09-27" },
  monthKey: "2026-09",
  bookingsWeek: { total: 49, goal: 79 },
  bookingsMonth: { total: 120, goal: 316 },
  channels: { alliance: 2, auction: 1, website: null },
  channelLeads: { alliance: 5, auction: 3, website: null },
  leads: { family: 30, animalia: 19, total: 49 },
  conversion: { overall: 0.4, family: 0.35, animalia: 0.5 },
  funnel: { wins: 49, leads: 49, pct: 1 },
  calendar: {
    // slotsOccupied = appointments (no double-bookings in this fixture) — the
    // fill lines stay byte-identical to the legacy text.
    thisWeek: { appointments: 40, slotsOccupied: 40, capacity: 69 },
    nextWeek: { appointments: 12, slotsOccupied: 12, capacity: 69 },
    beyond: 30,
    firstFullyOpenDay: "2026-10-05",
  },
  notes: {},
  celebrateDefault: "Allison Wittner — 47 paid bookings",
  holes: null,
};

describe("COPY REPORT — Holes line (byte-identity of every existing line)", () => {
  test("holes null → the legacy blank 'Holes:' placeholder is preserved exactly", () => {
    const text = buildWeeklyCcReportText({ ...baseInput, holes: null });
    const lines = text.split("\n");
    expect(lines).toContain("Holes:");
    expect(lines.filter((l) => l.startsWith("Holes"))).toHaveLength(1);
  });

  test("holes supplied → ONE line 'Holes (empty slots): N'; every other line byte-identical", () => {
    const before = buildWeeklyCcReportText({ ...baseInput, holes: null }).split("\n");
    const after = buildWeeklyCcReportText({ ...baseInput, holes: 20 }).split("\n");
    expect(after).toContain("Holes (empty slots): 20");
    // Exactly one line differs, at the same index — no additions, removals, or reorders.
    const diffs = before
      .map((l, i) => ({ i, same: l === after[i] }))
      .filter((x) => !x.same)
      .map((x) => x.i);
    expect(diffs).toEqual([before.indexOf("Holes:")]);
    expect(before.length).toBe(after.length);
    // And in the reverse direction: every non-Holes line is byte-identical.
    before.forEach((l, i) => {
      if (l === "Holes:") return;
      expect(after[i]).toBe(l);
    });
  });

  test("the filled line sits in the placeholder group (between Empty appointments and 1st Call Completed)", () => {
    const text = buildWeeklyCcReportText({ ...baseInput, holes: 20 });
    const lines = text.split("\n");
    const i = lines.indexOf("Holes (empty slots): 20");
    expect(lines[i - 1]).toBe("Empty appointments:");
    expect(lines[i + 1]).toBe("1st Call Completed through Monday:");
  });
});

// ---------- weeklyPageData wiring (MemoryStore + pinned clock) ----------
// TODAY = Tue 2026-09-29: report week = 9/21–9/27 (the owner's reference),
// this week = 9/28–10/4 (in progress), next week = 10/5–10/11.

/** Seed the owner's reference shape: 49 booked across 9/21–9/27, Thursday 9/24 fully dark (a cancelled row must not count). */
function referenceWeekSessions(): AppointmentRow[] {
  const out: AppointmentRow[] = [];
  const shape: [string, number][] = [
    ["2026-09-21", 8],
    ["2026-09-22", 7],
    ["2026-09-23", 8],
    ["2026-09-24", 0],
    ["2026-09-25", 8],
    ["2026-09-26", 9],
    ["2026-09-27", 9],
  ];
  for (const [date, n] of shape) {
    for (let i = 0; i < n; i++) out.push(sess(`${date}-s${i}`, date, `${String(8 + i).padStart(2, "0")}:00`));
  }
  out.push(sess("ref-thu-cancelled", "2026-09-24", "10:00", { cancelled: true })); // books no session
  return out;
}

async function seedHolesStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  await store.upsertAppointments([
    ...referenceWeekSessions(),
    // this week (in progress): 2 booked Tuesday 9/29
    sess("cur-1", "2026-09-29", "10:00"),
    sess("cur-2", "2026-09-29", "11:00"),
  ]);
  return store;
}

describe("weeklyPageData holes wiring (MemoryStore, pinned today)", () => {
  test("report week = the owner's 20 holes; this/next week holes carry the per-day breakdown", async () => {
    const store = await seedHolesStore();
    const data = await weeklyPageData({ store, today: "2026-09-29" });
    // report week: 69 capacity, 49 booked, 20 holes (cancelled Thursday excluded)
    const thisWeek = data.calendar.thisWeek.holes;
    expect(thisWeek).not.toBeNull();
    expect(thisWeek!.capacity).toBe(69); // this week 9/28–10/4
    expect(thisWeek!.booked).toBe(2);
    expect(thisWeek!.holes).toBe(67);
    expect(thisWeek!.days).toHaveLength(7);
    const nextWeek = data.calendar.nextWeek.holes;
    expect(nextWeek).not.toBeNull();
    expect(nextWeek!.booked).toBe(0); // no sessions seeded for 10/5–11
    expect(nextWeek!.holes).toBe(69);
  });

  test("COPY REPORT carries the report week's holes: 'Holes (empty slots): 20'", async () => {
    const store = await seedHolesStore();
    const data = await weeklyPageData({ store, today: "2026-09-29" });
    const lines = data.report.reportText.split("\n");
    expect(lines).toContain("Holes (empty slots): 20");
    const i = lines.indexOf("Holes (empty slots): 20");
    expect(lines[i - 1]).toBe("Empty appointments:");
    expect(lines[i + 1]).toBe("1st Call Completed through Monday:");
  });

  test("every other line of the copied report is untouched vs the legacy text (holes null)", async () => {
    const store = await seedHolesStore();
    const data = await weeklyPageData({ store, today: "2026-09-29" });
    // Rebuild the same report with the holes figure stripped — the ONLY
    // difference must be the Holes line back at its legacy blank placeholder.
    const legacy = buildWeeklyCcReportText({
      week: { start: data.week.start, end: data.week.end },
      monthKey: data.month.key,
      bookingsWeek: { total: data.bookings.total, goal: data.bookings.goal },
      bookingsMonth: { total: data.mtd.total, goal: data.mtd.goal },
      channels: data.channels,
      channelLeads: data.channelLeads,
      leads: data.leads,
      conversion: { overall: data.conversion.overall, family: data.conversion.family, animalia: data.conversion.animalia },
      funnel: data.funnel,
      calendar: {
        thisWeek: {
          appointments: data.calendar.thisWeek.appointments,
          slotsOccupied: data.calendar.thisWeek.slotsOccupied,
          capacity: data.calendar.thisWeek.capacity,
        },
        nextWeek: {
          appointments: data.calendar.nextWeek.appointments,
          slotsOccupied: data.calendar.nextWeek.slotsOccupied,
          capacity: data.calendar.nextWeek.capacity,
        },
        beyond: data.calendar.beyond,
        firstFullyOpenDay: data.calendar.firstFullyOpenDay,
      },
      notes: data.report.notes,
      celebrateDefault: data.report.celebrateDefault,
      holes: null,
    }).split("\n");
    const actual = data.report.reportText.split("\n");
    expect(legacy.length).toBe(actual.length);
    legacy.forEach((l, i) => {
      if (l === "Holes:") return; // the ONE intended change
      expect(actual[i]).toBe(l);
    });
    expect(legacy.filter((l) => l === "Holes:")).toHaveLength(1);
  });
});
