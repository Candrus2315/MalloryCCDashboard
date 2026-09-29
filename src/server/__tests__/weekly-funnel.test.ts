/**
 * BOOKINGS FROM LEADS funnel (owner request 2026-09-29) — deterministic tests.
 *
 * The owner's funnel view: for each Mon–Sun week,
 *   % = ALL paid bookings (booking_win_business_date in week, incl.
 *       online/unattributed) ÷ ALL sheet leads (source_date in week, all
 *       sheets). It is the OVERALL funnel rate, not a strict lead→booking
 *       attribution — online bookings, repeat clients and Alliance/Auction
 *       members never appear in the sheets.
 *
 *  1. recentCompletedWeekStarts (injected clock): the last N COMPLETED Mon–Sun
 *     weeks, oldest first — the in-progress week NEVER appears (any weekday,
 *     incl. the Monday-report day and a Sunday when the current week is still
 *     incomplete), and the owner's reference series reproduces exactly.
 *  2. weekFunnelRows bucketing: Sun/Mon week boundaries, pending (unpaid) rows
 *     never count, out-of-window wins ignored, zero-leads weeks → pct null
 *     (never a fabricated 0%), leads-with-no-wins → a true 0%.
 *  3. weeklyPageData through the PageDeps seam (MemoryStore + pinned today):
 *     the funnel card counts (all bookings incl. unattributed ÷ all leads),
 *     the 5-row series ending at the report week, no in-progress week row.
 *  4. COPY REPORT: "Bookings from Leads: X%" sits directly after
 *     "Conversion of Assigned Leads" (template order otherwise unchanged).
 */
import { describe, expect, test } from "bun:test";
import { FUNNEL_SERIES_WEEKS, recentCompletedWeekStarts, weekFunnelRows } from "../metrics/weekly";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import { weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";
import type { AppointmentRow, LeadRow } from "../metrics/compute";

const TODAY = "2026-09-29"; // Tue — the operating day of the live acceptance checks
const H = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString(); // EDT

const win = (id: string, winDate: string | null, createdDate: string, paid = true): AppointmentRow => ({
  id,
  acuity_appointment_id: id, // the memory store keys appointments on the Acuity id — omitting it would collapse every upsert
  contact_id: null,
  calendar_id: null,
  appointment_type: "Portrait Session",
  appointment_datetime: H(createdDate, "14:00"),
  created_at: H(createdDate, "12:00"),
  created_business_date: createdDate,
  booking_win_business_date: winDate,
  raw: paid ? { priceSold: "300.00", amountPaid: "300.00" } : { paid: "no", priceSold: "300.00" },
  status: "scheduled",
  cancelled: false,
});

const lead = (id: string, sourceDate: string): LeadRow => ({
  id,
  lead_type: "family",
  source_date: sourceDate,
  work_date: sourceDate,
  contact_id: null,
  assigned_rep_id: null,
  source_sheet: "family",
  source_id: id,
  provider: "google_sheets",
});

describe("recentCompletedWeekStarts (pure, injected clock)", () => {
  test("Tue 2026-09-29 → the owner's five reference weeks, oldest first", () => {
    expect(recentCompletedWeekStarts(TODAY)).toEqual([
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
  });
  test("the IN-PROGRESS week is never in the series — any weekday of the current week", () => {
    // Wed 9/30: current week Mon 9/28–Sun 10/4 is incomplete → 9/28 must not appear
    expect(recentCompletedWeekStarts("2026-09-30")).not.toContain("2026-09-28");
    expect(recentCompletedWeekStarts("2026-09-30")[4]).toBe("2026-09-21");
    // Monday-report day (9/28): the 9/21–9/27 week just completed — the series
    // is IDENTICAL to Tuesday's and the just-started 9/28 week is already excluded.
    expect(recentCompletedWeekStarts("2026-09-28")).toEqual([
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
    // Sunday 9/27: the 9/21–9/27 week is NOT complete → it must not appear either
    expect(recentCompletedWeekStarts("2026-09-27")).not.toContain("2026-09-21");
    expect(recentCompletedWeekStarts("2026-09-27")[4]).toBe("2026-09-14");
  });
  test("year boundary — Thu 2026-01-01 reaches back into 2025", () => {
    expect(recentCompletedWeekStarts("2026-01-01")).toEqual([
      "2025-11-24",
      "2025-12-01",
      "2025-12-08",
      "2025-12-15",
      "2025-12-22",
    ]);
  });
  test("count override — 1 week = exactly the last completed week; default is FUNNEL_SERIES_WEEKS", () => {
    expect(recentCompletedWeekStarts(TODAY, 1)).toEqual(["2026-09-21"]);
    expect(recentCompletedWeekStarts(TODAY, 3)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(recentCompletedWeekStarts(TODAY).length).toBe(FUNNEL_SERIES_WEEKS);
  });
});

describe("weekFunnelRows (pure bucketing)", () => {
  const weekStarts = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"];
  const wins = [
    win("w-sun-1", "2026-08-30", "2026-08-30"), // Sunday — LAST day of week 1
    win("w-mon-1", "2026-08-31", "2026-08-31"), // Monday — FIRST day of week 2
    win("w-sep6", "2026-09-06", "2026-09-06"), // Sunday — LAST day of week 2
    win("w-sep10", "2026-09-10", "2026-09-10"), // week 3
    win("w-pending", null, "2026-09-03", false), // unpaid — NEVER counts anywhere
    win("w-out", "2026-08-23", "2026-08-23"), // before the series floor — ignored
  ];
  const leads = [
    lead("l1", "2026-08-24"),
    lead("l2", "2026-08-30"), // week 1: 2 leads
    lead("l3", "2026-08-31"),
    lead("l4", "2026-09-06"), // week 2: 2 leads
    // week 3: zero leads (has a win → pct null, never 0%)
    lead("l5", "2026-09-20"), // week 4: 1 lead, no wins → a true 0%
    lead("l6", "2026-09-21"), // next week's Monday — outside every window
  ];

  test("buckets wins by booking_win_business_date and leads by source_date, week boundaries exact", () => {
    const rows = weekFunnelRows(weekStarts, wins, leads);
    expect(rows.map((r) => r.weekStart)).toEqual(weekStarts);
    expect(rows.map((r) => r.weekEnd)).toEqual(["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20"]);
    expect(rows.map((r) => r.leads)).toEqual([2, 2, 0, 1]); // l6 (9/21) excluded everywhere
    expect(rows.map((r) => r.wins)).toEqual([1, 2, 1, 0]); // pending + out-of-window never count
    expect(rows.map((r) => r.pct)).toEqual([0.5, 1, null, 0]);
  });
  test("zero-leads week → pct null; leads-with-no-wins → a true 0 (not null)", () => {
    const rows = weekFunnelRows(weekStarts, wins, leads);
    expect(rows[2].pct).toBeNull(); // 1 win / 0 leads
    expect(rows[3].pct).toBe(0); // 0 wins / 1 lead — a real 0%
  });
});

// ---------- builder end-to-end (MemoryStore + pinned clock) ----------

/**
 * Seed across the whole 5-week series (TODAY = Tue 2026-09-29, series floor
 * 2026-08-24, report week 9/21–9/27). No attributions are seeded at all —
 * every win is unattributed/online, which the funnel MUST still count
 * (owner definition: ALL bookings). Shape mirrors the owner's reference:
 *  8/24 week: 3 leads, 1 win → 33.33%
 *  8/31 week: 0 leads, 0 wins → —
 *  9/07 week: 2 leads, 0 wins → 0.00%
 *  9/14 week: 1 lead, 0 wins → 0.00%
 *  9/21 week: 4 leads, 2 wins → 50.00%   (the report week / funnel card)
 *  9/28 week: 1 win — the IN-PROGRESS week, must appear NOWHERE.
 */
async function seedFunnelStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  await store.upsertAppointments([
    win("f-w1", "2026-08-26", "2026-08-26"), // Aug 24–30 week
    win("f-w5a", "2026-09-22", "2026-09-22"), // report week (no attribution rows → online)
    win("f-w5b", "2026-09-26", "2026-09-26"), // report week, unattributed
    win("f-pending", null, "2026-09-23", false), // pending — never counts
    win("f-current", "2026-09-28", "2026-09-28"), // in-progress week — excluded everywhere
  ]);
  await store.upsertLeads([
    lead("f-l1", "2026-08-24"),
    lead("f-l2", "2026-08-26"),
    lead("f-l3", "2026-08-30"), // Aug 24–30: 3 leads
    lead("f-l4", "2026-09-08"),
    lead("f-l5", "2026-09-13"), // Sep 7–13: 2 leads
    lead("f-l6", "2026-09-20"), // Sep 14–20: 1 lead
    lead("f-l7", "2026-09-21"),
    lead("f-l8", "2026-09-23"),
    lead("f-l9", "2026-09-25"),
    lead("f-l10", "2026-09-27"), // report week: 4 leads
    lead("f-l11", "2026-09-28"), // in-progress week — excluded everywhere
  ]);
  return store;
}

describe("weeklyPageData funnel wiring (MemoryStore, pinned today)", () => {
  test("funnel card: ALL paid bookings (unattributed included) ÷ ALL sheet leads of the report week", async () => {
    const store = await seedFunnelStore();
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.funnel.wins).toBe(2); // both report-week wins count — attribution is irrelevant here
    expect(data.funnel.leads).toBe(4);
    expect(data.funnel.pct ?? -1).toBeCloseTo(0.5, 6);
  });

  test("series: exactly 5 completed Mon–Sun weeks oldest-first; in-progress week absent", async () => {
    const store = await seedFunnelStore();
    const data = await weeklyPageData({ store, today: TODAY });
    const rows = data.funnelSeries;
    expect(rows.map((r) => r.weekStart)).toEqual(["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(rows.some((r) => r.weekStart === "2026-09-28")).toBe(false); // the in-progress week never shows
    expect(rows[0]).toEqual({ weekStart: "2026-08-24", weekEnd: "2026-08-30", leads: 3, wins: 1, pct: 1 / 3 });
    expect(rows[1]).toEqual({ weekStart: "2026-08-31", weekEnd: "2026-09-06", leads: 0, wins: 0, pct: null });
    expect(rows[2]).toEqual({ weekStart: "2026-09-07", weekEnd: "2026-09-13", leads: 2, wins: 0, pct: 0 });
    expect(rows[3]).toEqual({ weekStart: "2026-09-14", weekEnd: "2026-09-20", leads: 1, wins: 0, pct: 0 });
    // the last row IS the report week and matches the funnel card exactly
    expect(rows[4].weekStart).toBe(data.week.start);
    expect(rows[4].wins).toBe(data.funnel.wins);
    expect(rows[4].leads).toBe(data.funnel.leads);
    expect(rows[4].pct).toBe(data.funnel.pct);
  });

  test("COPY REPORT: 'Bookings from Leads: X%' directly after the assigned-lead conversion line", async () => {
    const store = await seedFunnelStore();
    const data = await weeklyPageData({ store, today: TODAY });
    const lines = data.report.reportText.split("\n");
    const i = lines.findIndex((l) => l.startsWith("Conversion of Assigned Leads:"));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe("Bookings from Leads: 50.00%"); // 2 wins / 4 leads
  });
});

describe("buildWeeklyCcReportText funnel line (pure)", () => {
  const baseInput = (): WeeklyCcReportInput => ({
    week: { start: "2026-09-21", end: "2026-09-27" },
    monthKey: "2026-09",
    bookingsWeek: { total: 62, goal: 79 },
    bookingsMonth: { total: 239, goal: 316 },
    channels: { alliance: 0, auction: 0, website: null },
    channelLeads: { alliance: 0, auction: 0, website: null },
    leads: { family: 3, animalia: 1, total: 4 },
    conversion: { overall: 0.5, family: 0.5, animalia: 0.5 },
    funnel: { wins: 2, leads: 4, pct: 0.5 },
    calendar: {
      thisWeek: { appointments: 0, capacity: 63 },
      nextWeek: { appointments: 0, capacity: 63 },
      beyond: 0,
      firstFullyOpenDay: null,
    },
    notes: {},
    celebrateDefault: null,
  });

  test("the line sits directly after 'Conversion of Assigned Leads' and shows the funnel %", () => {
    const lines = buildWeeklyCcReportText(baseInput()).split("\n");
    const i = lines.findIndex((l) => l.startsWith("Conversion of Assigned Leads:"));
    expect(lines[i + 1]).toBe("Bookings from Leads: 50.00%");
    expect(lines[i + 2]).toBe(""); // the blank separator stays after it
  });
  test("zero sheet leads → 'Bookings from Leads: —' (never a fabricated 0%)", () => {
    const input = baseInput();
    input.funnel = { wins: 5, leads: 0, pct: null };
    const text = buildWeeklyCcReportText(input);
    expect(text).toContain("Bookings from Leads: —");
    expect(text).not.toContain("Bookings from Leads: 0");
  });
});
