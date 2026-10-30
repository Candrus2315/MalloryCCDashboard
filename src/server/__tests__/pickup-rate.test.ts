/**
 * PICKUP RATE — the OWNER'S OFFICIAL DEFINITION (directive 10/30 evening;
 * supersedes the PR #128 connect-semantics formula everywhere).
 *
 *   Pickup Rate = (Calls Over 2 Min + Calls Under 2 Min) ÷ Total Calls
 *
 * Owner verbatim: "A pickup means the number of people we actually spoke
 * with" — BOTH short and long conversations count as pickups. Worked example
 * (the owner's): Over=20, Under=10, Total=50 → (20+10)÷50 = 60%.
 *
 * - The three source fields are the EXISTING quantities: "Calls Over 2 Min"
 *   (duration > threshold — the summarizeCalls().overThreshold the Team page
 *   shows), "Calls Under 2 Min" (0 < duration ≤ threshold — an answered short
 *   conversation), "Total Calls" (every attempt in scope). NOT re-derived
 *   from raw statuses; direction/status are never consulted.
 * - Zero denominator → null → "—" (never 0%). NO weekly average anywhere
 *   (owner explicit) — asserted structurally below.
 * - Day boundary = the app's EXISTING call convention: calls STARTED on the
 *   ET day (etDateStrFromInstant over started_at).
 *
 * ONE shared definition (pickupRateForDay) consumed by BOTH reports — the
 * parity suite pins loader-level equality plus exact reuse of the fields.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDailyReportMetrics,
  pickupRateByDay,
  pickupRateForDay,
  summarizeCalls,
  type AppointmentRow,
  type CallRow,
  type LeadRow,
} from "../metrics/compute";
import { buildDailyReportText, formatPercent, type Big3Input } from "../metrics/report-text";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import { weekdayName, etDayStartUtc, etDayEndUtc } from "../date-logic";
import { dailyReportPageData, weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";

const TH = 120; // settings.meaningful_call_threshold_seconds default

const call = (
  id: string,
  startedAt: string,
  durationSeconds: number,
  opts: { direction?: string | null; status?: string | null; overFlag?: boolean; rep?: string | null } = {},
): CallRow => ({
  id,
  rep_id: opts.rep ?? "r1",
  contact_id: "k1",
  started_at: startedAt,
  duration_seconds: durationSeconds,
  // The persisted flag is deliberately INDEPENDENT of duration here: pickup
  // must reuse the duration > threshold definition, never the stored flag.
  over_two_minutes: opts.overFlag ?? durationSeconds > TH,
  direction: opts.direction ?? "outbound",
  call_status: opts.status ?? "completed",
});
const out = (id: string, startedAt: string, dur: number, status = "completed") =>
  call(id, startedAt, dur, { status });
const inb = (id: string, startedAt: string, dur: number, status = "completed") =>
  call(id, startedAt, dur, { direction: "inbound", status });
// A full ET day of 2026-10-29 (Thu) — EDT (UTC-4): the ET day spans 04:00Z..04:00Z.
const THU = "2026-10-29";

describe("pickupRateForDay (owner's OFFICIAL formula, directive 10/30 evening)", () => {
  test("THE OWNER'S WORKED EXAMPLE: Over=20, Under=10, Total=50 → 60%", () => {
    const calls: CallRow[] = [
      ...Array.from({ length: 20 }, (_, i) => out(`ov${i}`, `${THU}T${String(8 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`, 150 + i)),
      ...Array.from({ length: 10 }, (_, i) => out(`un${i}`, `${THU}T${String(8 + (i % 12)).padStart(2, "0")}:${String((i + 7) % 60).padStart(2, "0")}:00.000Z`, 30 + i)),
      ...Array.from({ length: 20 }, (_, i) => out(`no${i}`, `${THU}T${String(8 + (i % 12)).padStart(2, "0")}:${String((i + 13) % 60).padStart(2, "0")}:00.000Z`, 0, i % 2 === 0 ? "no-answer" : "voicemail")),
    ];
    const r = pickupRateForDay(calls, THU, TH);
    expect(r.overTwoMin).toBe(20); // the existing "Calls Over 2 Min"
    expect(r.underTwoMin).toBe(10); // "Calls Under 2 Min" — answered, short
    expect(r.totalCalls).toBe(50); // "Total Calls" — every attempt
    expect(r.picked).toBe(30); // people actually spoken with (20 + 10)
    expect(r.rate).toBeCloseTo(30 / 50, 12); // 60%
    expect(formatPercent(r.rate, 1)).toBe("60.0%");
  });

  test("answered calls UNDER the threshold ARE pickups; zero duration never is", () => {
    const calls = [
      out("over121", `${THU}T14:00:00.000Z`, 121), // strictly over → Over 2 Min
      out("exactly120", `${THU}T15:00:00.000Z`, 120), // boundary: not over; spoke → Under
      out("short", `${THU}T16:00:00.000Z`, 1), // one second spoken → pickup
      out("zero", `${THU}T17:00:00.000Z`, 0, "no-answer"), // nothing spoken → NOT a pickup
      out("zero2", `${THU}T18:00:00.000Z`, 0, "voicemail"),
    ];
    const r = pickupRateForDay(calls, THU, TH);
    expect(r.overTwoMin).toBe(1);
    expect(r.underTwoMin).toBe(2);
    expect(r.picked).toBe(3);
    expect(r.totalCalls).toBe(5); // the denominator stays Total Calls
    expect(r.rate).toBeCloseTo(3 / 5, 12);
  });

  test("direction and status are NEVER consulted — the fields are duration/count-based", () => {
    const calls = [
      inb("i1", `${THU}T14:00:00.000Z`, 300), // inbound conversation = a person spoken with
      out("v1", `${THU}T15:00:00.000Z`, 0, "voicemail"), // voicemail drop: nothing spoken
      out("f1", `${THU}T16:00:00.000Z`, 0, "failed"), // failed attempt: still Total Calls
      inb("i2", `${THU}T17:00:00.000Z`, 45, "completed"), // inbound short → pickup
      out("m1", `${THU}T18:00:00.000Z`, 90, null), // missing status, real conversation → pickup
      call("u1", `${THU}T19:00:00.000Z`, 200, { direction: null }), // unknown direction, spoken → pickup
    ];
    const r = pickupRateForDay(calls, THU, TH);
    expect(r.overTwoMin).toBe(2); // i1 + u1
    expect(r.underTwoMin).toBe(2); // i2 + m1
    expect(r.totalCalls).toBe(6); // EVERY attempt — no direction/status exclusions
    expect(r.picked).toBe(4);
    expect(r.rate).toBeCloseTo(4 / 6, 12);
  });

  test("the persisted over_two_minutes flag is never read — duration > threshold is", () => {
    const r = pickupRateForDay([call("x", `${THU}T14:00:00.000Z`, 300, { overFlag: false })], THU, TH);
    expect(r.overTwoMin).toBe(1); // the flag said false; the duration says over
  });

  test("the Over/Under/Total reuse is EXACT: identical to summarizeCalls' fields at the same threshold", () => {
    const calls = [
      out("a", `${THU}T14:00:00.000Z`, 150),
      out("b", `${THU}T15:00:00.000Z`, 90),
      out("c", `${THU}T16:00:00.000Z`, 120),
      out("d", `${THU}T17:00:00.000Z`, 0),
      inb("e", `${THU}T18:00:00.000Z`, 240),
    ];
    const s = summarizeCalls(calls, TH);
    const r = pickupRateForDay(calls, THU, TH);
    expect(r.totalCalls).toBe(s.total); // "Total Calls" — the same number
    expect(r.overTwoMin).toBe(s.overThreshold); // "Calls Over 2 Min" — the same number
    expect(r.underTwoMin).toBe(s.total - s.overThreshold - calls.filter((c) => c.duration_seconds <= 0).length);
    // …and at a DIFFERENT threshold both fields move together (the setting is wired, not hard-coded):
    const s60 = summarizeCalls(calls, 60);
    const r60 = pickupRateForDay(calls, THU, 60);
    expect(r60.overTwoMin).toBe(s60.overThreshold);
    expect(r60.totalCalls).toBe(s60.total);
    expect(r60.rate).toBe(r.rate); // the over/under split moved; pickups did not
  });

  test("zero denominator → rate null (never 0, never fabricated) — counts stay honest", () => {
    expect(pickupRateForDay([], THU, TH)).toEqual({
      overTwoMin: 0,
      underTwoMin: 0,
      totalCalls: 0,
      picked: 0,
      denominator: 0,
      rate: null,
    });
  });

  test("a day whose calls all went unanswered is a REAL 0.0% (dialed-and-missed), not missing data", () => {
    const r = pickupRateForDay(
      [out("n1", `${THU}T14:00:00.000Z`, 0, "no-answer"), out("n2", `${THU}T15:00:00.000Z`, 0, "voicemail")],
      THU,
      TH,
    );
    expect(r.totalCalls).toBe(2);
    expect(r.picked).toBe(0);
    expect(r.rate).toBe(0);
    expect(formatPercent(r.rate, 1)).toBe("0.0%");
  });

  test("day boundary: the EXISTING convention — calls STARTED on the ET day (04:00Z during EDT)", () => {
    // 03:59Z on Oct 29 = Oct 28 23:59 ET → belongs to the PREVIOUS day.
    // 04:00Z on Oct 29 = Oct 29 00:00 ET → belongs to THU.
    const calls = [
      call("prev", "2026-10-29T03:59:00.000Z", 300),
      call("cur", "2026-10-29T04:00:00.000Z", 300),
      call("late", "2026-10-30T03:59:00.000Z", 300), // Thu 23:59 ET — still THU
      call("next", "2026-10-30T04:00:00.000Z", 300), // Fri 00:00 ET
    ];
    const thu = pickupRateForDay(calls, THU, TH);
    expect(thu.totalCalls).toBe(2); // cur + late (the 23:59 ET call)
    expect(thu.picked).toBe(2);
    expect(thu.rate).toBe(1);
    const fri = pickupRateForDay(calls, "2026-10-30", TH);
    expect(fri.totalCalls).toBe(1); // next only — the 03:59Z row is Thu's
    const wed = pickupRateForDay(calls, "2026-10-28", TH);
    expect(wed.totalCalls).toBe(1); // prev (the 03:59Z row)
  });

  test("an already-day-filtered set is idempotent (the Daily's callsAnchorDay path)", () => {
    const calls = [out("c1", `${THU}T14:00:00.000Z`, 200), out("c2", `${THU}T15:00:00.000Z`, 0)];
    const once = pickupRateForDay(calls, THU, TH);
    const twice = pickupRateForDay(calls.filter(() => true), THU, TH);
    expect(twice).toEqual(once);
  });
});

// etDateStr helper local to the suite (keeps the import list tight).
import { etDateStrFromInstant } from "../date-logic";
const etDateStr = (iso: string): string => etDateStrFromInstant(Date.parse(iso));

describe("pickupRateByDay (the Weekly CC Report's Mon–Fri rows)", () => {
  test("one row per requested day, in order; unasked days never appear; empty days rate null", () => {
    const calls = [
      out("m1", "2026-10-26T14:00:00.000Z", 300),
      out("m2", "2026-10-26T15:00:00.000Z", 0),
      out("t1", "2026-10-27T14:00:00.000Z", 0),
      out("w1", "2026-10-28T14:00:00.000Z", 45),
      out("w2", "2026-10-28T15:00:00.000Z", 200),
      out("w3", "2026-10-28T16:00:00.000Z", 0),
    ];
    const rows = pickupRateByDay(calls, ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"], TH);
    expect(rows.map((r) => r.date)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(rows[0]).toMatchObject({ overTwoMin: 1, underTwoMin: 0, totalCalls: 2, picked: 1, rate: 0.5 });
    expect(rows[1]).toMatchObject({ totalCalls: 1, picked: 0, rate: 0 }); // unanswered-only day: a real 0
    expect(rows[2]).toMatchObject({ overTwoMin: 1, underTwoMin: 1, totalCalls: 3, picked: 2, rate: 2 / 3 });
    expect(rows[3].rate).toBeNull(); // no calls that day → "—", never 0%
    expect(rows[4].rate).toBeNull();
  });
});

describe("DAILY REPORT: the anchor-day tile + copied line run the official formula", () => {
  const T = "2026-10-30"; // Friday report → anchor = calendar yesterday (no threaded clock)
  const A = "2026-10-29";
  const appt = (id: string, createdAt: string): AppointmentRow => ({
    id,
    contact_id: "k1",
    calendar_id: "cal-1",
    appointment_type: "Family Portrait Session",
    appointment_datetime: "2026-11-01T14:00:00.000Z",
    created_at: createdAt,
    status: "scheduled",
    cancelled: false,
  });
  const lead = (id: string, type: string, work: string): LeadRow => ({
    id,
    lead_type: type,
    source_date: work,
    work_date: work,
    contact_id: "k1",
    assigned_rep_id: "r1",
    source_sheet: type,
  });
  const big3: Big3Input = { priority1: "a", priority2: "b", priority3: "c" };
  const baseInput = {
    reportDate: T,
    apptsCreatedAnchorDay: [appt("a1", `${A}T16:00:00.000Z`)],
    apptsCreatedWtd: [appt("a1", `${A}T16:00:00.000Z`)],
    allCallsForWeek: [],
    attributions: [],
    leadsAllRecent: [lead("l1", "family", A)],
    teamBookingGoal: 79,
    weeklyLeadBudget: 700,
    thresholdSeconds: TH,
  };

  test("dailyPickupRate = (Over + Under) ÷ Total from the SAME anchor-day call set", () => {
    // 3 over + 2 under + 2 unanswered + 1 inbound conversation = 8 total, 6 spoken with.
    const anchorCalls = [
      out("o1", `${A}T14:00:00.000Z`, 300),
      out("o2", `${A}T15:00:00.000Z`, 150),
      out("o3", `${A}T16:00:00.000Z`, 121),
      out("u1", `${A}T17:00:00.000Z`, 45),
      out("u2", `${A}T18:00:00.000Z`, 120),
      out("n1", `${A}T19:00:00.000Z`, 0, "no-answer"),
      out("n2", `${A}T20:00:00.000Z`, 0, "voicemail"),
      inb("i1", `${A}T21:00:00.000Z`, 90),
    ];
    const m = buildDailyReportMetrics({ ...baseInput, callsAnchorDay: anchorCalls });
    const s = summarizeCalls(anchorCalls, TH);
    expect(s.total).toBe(8);
    expect(s.overThreshold).toBe(3);
    // The metrics value IS the fields' arithmetic: (3 over + 3 under) ÷ 8.
    expect(m.dailyPickupRate).toBeCloseTo((s.overThreshold + 3) / s.total, 12);
    expect(m.dailyPickupRate).toBeCloseTo(6 / 8, 12);
    const text = buildDailyReportText(m, big3);
    expect(text).toContain("Daily Pickup Rate: 75.0%"); // ONE decimal, owner precision
  });

  test("anchor day with no calls → null → the line renders — (never 0%)", () => {
    const m = buildDailyReportMetrics({ ...baseInput, callsAnchorDay: [] });
    expect(m.dailyPickupRate).toBeNull();
    expect(buildDailyReportText(m, big3)).toContain("Daily Pickup Rate: —");
  });

  test("calls on OTHER days never leak into the anchor-day rate", () => {
    const m = buildDailyReportMetrics({
      ...baseInput,
      callsAnchorDay: [
        out("ok", `${A}T14:00:00.000Z`, 300),
        out("other", "2026-10-28T14:00:00.000Z", 0), // Tuesday — not the anchor
      ],
    });
    expect(m.dailyPickupRate).toBe(1);
  });
});

describe("WEEKLY CC REPORT: per-day Mon–Fri rows, NO weekly average", () => {
  const MON = "2026-10-26";
  const SUN = "2026-11-01";
  const base: WeeklyCcReportInput = {
    week: { start: MON, end: SUN },
    monthKey: "2026-10",
    bookingsWeek: { total: 71, goal: 79 },
    bookingsMonth: { total: 162, goal: 316 },
    productionWeek: { gross: 74, cancellations: 3, net: 71, goal: 79 },
    productionMonth: { gross: 162, goal: 316 },
    channels: { alliance: 0, auction: 0, website: null },
    channelLeads: { alliance: 0, auction: 0, website: null },
    leads: {
      family: 100, animalia: 50, fairyland: 20,
      auction_register_certificate: 0, google_ads_leads: 0,
      alliance_activate_certificate: 0, website_applications: 0,
      total: 170,
    },
    calendar: {
      thisWeek: { appointments: 0, slotsOccupied: 0, capacity: 69 },
      nextWeek: { appointments: 0, slotsOccupied: 0, capacity: 69 },
      beyond: 0,
      firstFullyOpenDay: null,
    },
    holes: null,
    notes: {},
    celebrateDefault: null,
  };
  /** The loader's exact chain: shared per-day function (WITH the threshold) → labelled rows. */
  const loaderRows = (calls: CallRow[], days: string[]) =>
    pickupRateByDay(calls, days, TH).map((r) => ({ date: r.date, label: weekdayName(r.date), rate: r.rate }));

  test("each occurred Mon–Fri day renders INDIVIDUALLY at one decimal", () => {
    const calls: CallRow[] = [
      out("m1", `${MON}T14:00:00.000Z`, 300),
      out("m2", `${MON}T15:00:00.000Z`, 0),
      out("m3", `${MON}T16:00:00.000Z`, 60),
      out("t1", "2026-10-27T14:00:00.000Z", 90),
      out("t2", "2026-10-27T15:00:00.000Z", 130),
      out("w1", "2026-10-28T14:00:00.000Z", 45),
      out("w2", "2026-10-28T15:00:00.000Z", 0),
      out("th1", THU + "T14:00:00.000Z", 300),
      out("th2", THU + "T15:00:00.000Z", 0),
      out("f1", "2026-10-30T14:00:00.000Z", 0),
    ];
    const text = buildWeeklyCcReportText({ ...base, pickupByDay: loaderRows(calls, [MON, "2026-10-27", "2026-10-28", THU, "2026-10-30"]) });
    expect(text).toContain("Pickup Rate by day (Mon–Fri):");
    expect(text).toContain("  Monday: 66.7%"); // (1 over + 1 under) ÷ 3
    expect(text).toContain("  Tuesday: 100.0%"); // one short + one long conversation — BOTH pickups
    expect(text).toContain("  Wednesday: 50.0%"); // 45s counts; the no-answer does not
    expect(text).toContain("  Thursday: 50.0%");
    expect(text).toContain("  Friday: 0.0%"); // dialed-and-missed day: a real 0, not missing data
  });

  test("zero-denominator days render — (honest); genuinely-zero days render 0.0%", () => {
    const text = buildWeeklyCcReportText({
      ...base,
      pickupByDay: [
        { date: MON, label: weekdayName(MON), rate: null },
        { date: "2026-10-27", label: weekdayName("2026-10-27"), rate: 0 },
      ],
    });
    expect(text).toContain("  Monday: —");
    expect(text).toContain("  Tuesday: 0.0%");
  });

  test("NO weekly average anywhere — the owner explicitly declined one", () => {
    const calls: CallRow[] = [
      out("m1", `${MON}T14:00:00.000Z`, 300),
      out("t1", "2026-10-27T14:00:00.000Z", 0),
    ];
    const text = buildWeeklyCcReportText({ ...base, pickupByDay: loaderRows(calls, [MON, "2026-10-27", "2026-10-28", THU, "2026-10-30"]) });
    // Exactly ONE line may mention pickup: the per-day header. No aggregate/average line exists.
    const pickupLines = text.split("\n").filter((l) => l.toLowerCase().includes("pickup"));
    expect(pickupLines).toEqual(["Pickup Rate by day (Mon–Fri):"]);
    expect(text.toLowerCase()).not.toContain("average");
    expect(text.toLowerCase()).not.toContain("avg");
    expect(text).not.toContain("Weekly Pickup");
  });

  test("template tolerance: no pickupByDay input → byte-identical template (parity callers unaffected)", () => {
    const without = buildWeeklyCcReportText(base);
    const withUndefined = buildWeeklyCcReportText({ ...base, pickupByDay: undefined });
    const withNull = buildWeeklyCcReportText({ ...base, pickupByDay: null });
    const withEmpty = buildWeeklyCcReportText({ ...base, pickupByDay: [] });
    expect(withUndefined).toBe(without);
    expect(withNull).toBe(without);
    expect(withEmpty).toBe(without);
    expect(without).not.toContain("Pickup Rate");
  });

  test("weekend rows and future days are structurally impossible — the loader only passes occurred workdays", () => {
    const days = [MON, "2026-10-27", "2026-10-28", THU, "2026-10-30"]; // Mon–Fri only
    const rows = pickupRateByDay([], days, TH).map((r) => ({ date: r.date, label: weekdayName(r.date), rate: r.rate }));
    const text = buildWeeklyCcReportText({ ...base, pickupByDay: rows });
    expect(text).toContain("  Monday: —");
    expect(text).not.toContain("Saturday:");
    expect(text).not.toContain("Sunday:");
  });
});

describe("CROSS-SURFACE PARITY (owner-requested): every pickup surface returns the SAME rate", () => {
  const MON = "2026-10-26";
  const SUN = "2026-11-01";
  /** The shared call fixture: THU = 2 over + 1 under + 1 unanswered (4 total, 3 pickups). */
  const weekCalls: CallRow[] = [
    out("p-m1", `${MON}T14:00:00.000Z`, 200),
    out("p-m2", `${MON}T15:00:00.000Z`, 0),
    out("p-t1", "2026-10-27T14:00:00.000Z", 30),
    out("p-w1", "2026-10-28T14:00:00.000Z", 0),
    out("p-th1", `${THU}T14:00:00.000Z`, 300),
    out("p-th2", `${THU}T15:00:00.000Z`, 240),
    out("p-th3", `${THU}T16:00:00.000Z`, 60),
    out("p-th4", `${THU}T17:00:00.000Z`, 0),
    out("p-f1", "2026-10-30T14:00:00.000Z", 90),
  ];
  const THU_CALLS = weekCalls.filter((c) => etDateStr(c.started_at) === THU);
  const THU_EXPECTED = 3 / 4; // (2 over + 1 under) ÷ 4 total

  test("the pure chain: Daily metric == shared per-day function == the fields' arithmetic", () => {
    const appt = (id: string, createdAt: string): AppointmentRow => ({
      id,
      contact_id: "k1",
      calendar_id: "cal-1",
      appointment_type: "Family Portrait Session",
      appointment_datetime: "2026-11-01T14:00:00.000Z",
      created_at: createdAt,
      status: "scheduled",
      cancelled: false,
    });
    const lead = (id: string, type: string, work: string): LeadRow => ({
      id,
      lead_type: type,
      source_date: work,
      work_date: work,
      contact_id: "k1",
      assigned_rep_id: "r1",
      source_sheet: type,
    });
    const m = buildDailyReportMetrics({
      reportDate: "2026-10-30", // Friday report → anchor = Thursday
      callsAnchorDay: THU_CALLS,
      apptsCreatedAnchorDay: [appt("a1", `${THU}T16:00:00.000Z`)],
      apptsCreatedWtd: [appt("a1", `${THU}T16:00:00.000Z`)],
      allCallsForWeek: [],
      attributions: [],
      leadsAllRecent: [lead("l1", "family", THU)],
      teamBookingGoal: 79,
      weeklyLeadBudget: 700,
      thresholdSeconds: TH,
    });
    // SAME float through every path — identical expressions, not approximations.
    expect(m.dailyPickupRate).toBe(THU_EXPECTED);
    expect(m.dailyPickupRate).toBe(pickupRateForDay(weekCalls, THU, TH).rate);
    expect(m.dailyPickupRate).toBe(pickupRateByDay(weekCalls, [THU], TH)[0].rate!);
    // The fields' arithmetic — (Over + Under) ÷ Total over the SAME rows.
    const s = summarizeCalls(THU_CALLS, TH);
    expect(m.dailyPickupRate).toBe((s.overThreshold + 1) / s.total);
    // Rendered strings share the digits.
    const dailyText = buildDailyReportText(m, { priority1: "a", priority2: "b", priority3: "c" });
    expect(dailyText).toContain(`Daily Pickup Rate: ${formatPercent(THU_EXPECTED, 1)}`);
    const weeklyText = buildWeeklyCcReportText({
      week: { start: MON, end: SUN },
      monthKey: "2026-10",
      bookingsWeek: { total: 1, goal: 79 },
      bookingsMonth: { total: 1, goal: 316 },
      productionWeek: { gross: 1, cancellations: 0, net: 1, goal: 79 },
      productionMonth: { gross: 1, goal: 316 },
      channels: { alliance: 0, auction: 0, website: null },
      channelLeads: { alliance: 0, auction: 0, website: null },
      leads: { family: 1, animalia: 0, fairyland: 0, auction_register_certificate: 0, google_ads_leads: 0, alliance_activate_certificate: 0, website_applications: 0, total: 1 },
      calendar: { thisWeek: { appointments: 0, slotsOccupied: 0, capacity: 69 }, nextWeek: { appointments: 0, slotsOccupied: 0, capacity: 69 }, beyond: 0, firstFullyOpenDay: null },
      holes: null,
      notes: {},
      celebrateDefault: null,
      pickupByDay: pickupRateByDay(weekCalls, [MON, "2026-10-27", "2026-10-28", THU, "2026-10-30"], TH)
        .map((r) => ({ date: r.date, label: weekdayName(r.date), rate: r.rate })),
    });
    expect(weeklyText).toContain(`  Thursday: ${formatPercent(THU_EXPECTED, 1)}`);
  });

  test("LOADER-level parity (MemoryStore): the Daily Report's anchor-day rate == the Weekly CC Report's by-day row == a recomputation from the store's raw Call Log rows", async () => {
    const store = new MemoryStore();
    await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
    // One active roster rep — the loaders' roster-eligibility keeps the seeded calls.
    await store.upsertUsers([
      { id: "", provider: "highlevel", external_id: "usr_rep", name: "Alex Morgan", email: "alex@mallory.test", is_active: true, call_start_date: null },
    ]);
    const rep = (await store.getAllUsers()).find((u) => u.external_id === "usr_rep")!.id;
    // Week of Mon 2026-09-21 … Sun 2026-09-27 (the parity suite's week).
    // THU 2026-09-24: 2 over + 1 under + 1 unanswered; MON: 1 over + 1 unanswered.
    const seeded: (CallRow & { external_call_id: string; provider: string })[] = weekCalls.map((c, i) => ({
      ...c,
      id: "",
      rep_id: rep,
      started_at: c.started_at.replace(/^2026-10-2[6789]|^2026-10-30/, (d) =>
        d === "2026-10-26" ? "2026-09-21" : d === "2026-10-27" ? "2026-09-22" : d === "2026-10-28" ? "2026-09-23" : d === THU ? "2026-09-24" : "2026-09-25"),
      external_call_id: `pc-${i}`,
      provider: "highlevel",
    }));
    await store.upsertCalls(seeded);
    // The Daily Report rendered Friday 9/25 10:00 ET → anchor = Thursday 9/24.
    const daily = await dailyReportPageData({ store, today: "2026-09-25", etNowMinutes: 10 * 60 });
    // The Weekly CC Report rendered the NEXT Monday covers LAST week (9/21–27) — the same week.
    const weekly = await weeklyPageData({ store, today: "2026-09-28" });
    // PARITY: Daily anchor-day rate == the Weekly's Thursday row — exact float…
    const thuRow = pickupRateForDay(weekCalls.map((c, i) => ({ ...c, started_at: seeded[i].started_at })), "2026-09-24", TH);
    expect(daily.metrics.dailyPickupRate).toBe(thuRow.rate);
    // …and the rendered digits agree (75.0% both places).
    const dailyLine = daily.reportText.split("\n").find((l) => l.startsWith("Daily Pickup Rate:")) ?? "<missing>";
    const thuLine = weekly.report.reportText.split("\n").find((l) => l.startsWith("  Thursday:")) ?? "<missing>";
    expect(dailyLine).toBe(`Daily Pickup Rate: ${formatPercent(thuRow.rate, 1)}`);
    expect(thuLine).toBe(`  Thursday: ${formatPercent(thuRow.rate, 1)}`);
    expect(dailyLine).toContain("75.0%");
    // RECOMPUTATION from the store's RAW Call Log rows (the three existing
    // fields): Over 2 Min / Under 2 Min / Total for the anchor ET-day window
    // must produce exactly the rate both surfaces rendered.
    const raw = await store.getCallsBetween(etDayStartUtc("2026-09-24"), etDayEndUtc("2026-09-24"));
    const s = summarizeCalls(raw, TH);
    const under = raw.filter((c) => c.duration_seconds > 0 && c.duration_seconds <= TH).length;
    expect(s.total).toBe(4);
    expect(s.overThreshold).toBe(2);
    expect(under).toBe(1);
    expect((s.overThreshold + under) / s.total).toBe(daily.metrics.dailyPickupRate);
    // The Weekly block stays by-day only — no aggregate line exists to disagree with.
    const pickupLines = weekly.report.reportText.split("\n").filter((l) => l.toLowerCase().includes("pickup"));
    expect(pickupLines).toEqual(["Pickup Rate by day (Mon–Fri):"]);
  });
});
