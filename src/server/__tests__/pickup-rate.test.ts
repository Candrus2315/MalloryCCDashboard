/**
 * PICKUP RATE (owner decision 10/30 — FINAL).
 *
 *   Daily Pickup Rate = Completed outbound ÷ (Completed + No Answer + Voicemail outbound)
 *
 * - Numerator: direction="outbound" AND call_status="completed".
 * - Denominator: direction="outbound" AND call_status IN
 *   ("completed","no-answer","voicemail") — voicemail counts as NOT picked up.
 * - Excluded entirely: inbound; failed/busy/ringing; null call_status
 *   (protective — the 10/30 census shows zero such rows).
 * - Zero denominator → null → "—". NO weekly average anywhere (owner
 *   explicit) — asserted below.
 * - Day boundary = the app's EXISTING call convention: calls STARTED on the
 *   ET day (etDateStrFromInstant over started_at).
 *
 * ONE shared definition (pickupRateForDay) consumed by BOTH reports.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDailyReportMetrics,
  pickupRateByDay,
  pickupRateForDay,
  type AppointmentRow,
  type CallRow,
  type LeadRow,
} from "../metrics/compute";
import { buildDailyReportText, type Big3Input } from "../metrics/report-text";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import { weekdayName } from "../date-logic";

const call = (
  id: string,
  startedAt: string,
  direction: string | null,
  status: string | null,
  durationSeconds = 45,
): CallRow => ({
  id,
  rep_id: "r1",
  contact_id: "k1",
  started_at: startedAt,
  duration_seconds: durationSeconds,
  over_two_minutes: durationSeconds > 120,
  direction,
  call_status: status,
});
const out = (id: string, startedAt: string, status: string | null, dur = 45) => call(id, startedAt, "outbound", status, dur);
const inb = (id: string, startedAt: string, status: string | null, dur = 45) => call(id, startedAt, "inbound", status, dur);
// A full ET day of 2026-10-29 (Thu) — EDT (UTC-4): the ET day spans 04:00Z..04:00Z.
const THU = "2026-10-29";

describe("pickupRateForDay (owner formula 10/30 — FINAL)", () => {
  test("numerator/denominator: completed, no-answer, voicemail — voicemail NOT picked up", () => {
    const calls = [
      out("c1", `${THU}T14:00:00.000Z`, "completed"),
      out("c2", `${THU}T15:00:00.000Z`, "completed"),
      out("c3", `${THU}T16:00:00.000Z`, "completed"),
      out("c4", `${THU}T17:00:00.000Z`, "no-answer"),
      out("c5", `${THU}T18:00:00.000Z`, "voicemail"),
    ];
    const r = pickupRateForDay(calls, THU);
    expect(r.picked).toBe(3); // completed outbound only — voicemail is NOT a pickup
    expect(r.denominator).toBe(5); // completed + no-answer + voicemail
    expect(r.rate).toBeCloseTo(3 / 5, 10);
  });

  test("inbound calls are excluded entirely (even completed ones)", () => {
    const calls = [
      out("c1", `${THU}T14:00:00.000Z`, "completed"),
      inb("c2", `${THU}T15:00:00.000Z`, "completed"),
      inb("c3", `${THU}T16:00:00.000Z`, "voicemail"),
    ];
    const r = pickupRateForDay(calls, THU);
    expect(r.picked).toBe(1);
    expect(r.denominator).toBe(1); // inbound rows never enter the denominator
    expect(r.rate).toBeCloseTo(1, 10);
  });

  test("failed / busy / ringing are excluded from BOTH sides", () => {
    const calls = [
      out("c1", `${THU}T14:00:00.000Z`, "completed"),
      out("c2", `${THU}T15:00:00.000Z`, "failed"),
      out("c3", `${THU}T16:00:00.000Z`, "busy"),
      out("c4", `${THU}T17:00:00.000Z`, "ringing"),
    ];
    const r = pickupRateForDay(calls, THU);
    expect(r.picked).toBe(1);
    expect(r.denominator).toBe(1);
  });

  test("null call_status is excluded (protective rule); so is a missing direction", () => {
    const calls = [
      out("c1", `${THU}T14:00:00.000Z`, "completed"),
      out("c2", `${THU}T15:00:00.000Z`, null), // missing status — never counted
      call("c3", `${THU}T16:00:00.000Z`, null, "completed"), // direction unknown — not outbound
    ];
    const r = pickupRateForDay(calls, THU);
    expect(r.picked).toBe(1);
    expect(r.denominator).toBe(1);
  });

  test("zero denominator → rate null (never 0, never fabricated) — counts stay honest", () => {
    expect(pickupRateForDay([], THU)).toEqual({ picked: 0, denominator: 0, rate: null });
    const onlyInbound = [inb("c1", `${THU}T14:00:00.000Z`, "completed"), out("c2", `${THU}T15:00:00.000Z`, "failed")];
    const r = pickupRateForDay(onlyInbound, THU);
    expect(r.picked).toBe(0);
    expect(r.denominator).toBe(0);
    expect(r.rate).toBeNull();
  });

  test("day boundary: the EXISTING convention — calls STARTED on the ET day (04:00Z during EDT)", () => {
    // 03:59Z on Oct 29 = Oct 28 23:59 ET → belongs to the PREVIOUS day.
    // 04:00Z on Oct 29 = Oct 29 00:00 ET → belongs to THU.
    const calls = [
      out("prev", "2026-10-29T03:59:00.000Z", "completed"),
      out("cur", "2026-10-29T04:00:00.000Z", "completed"),
      out("late", "2026-10-30T03:59:00.000Z", "completed"), // Thu 23:59 ET — still THU
      out("next", "2026-10-30T04:00:00.000Z", "completed"), // Fri 00:00 ET
    ];
    const thu = pickupRateForDay(calls, THU);
    expect(thu.picked).toBe(2); // cur + late (the 23:59 ET call)
    expect(thu.denominator).toBe(2);
    const fri = pickupRateForDay(calls, "2026-10-30");
    expect(fri.picked).toBe(1); // next only — the 03:59Z row is Thu's
    const wed = pickupRateForDay(calls, "2026-10-28");
    expect(wed.picked).toBe(1); // prev (the 03:59Z row)
  });

  test("an already-day-filtered set is idempotent (the Daily's callsAnchorDay path)", () => {
    const calls = [out("c1", `${THU}T14:00:00.000Z`, "completed"), out("c2", `${THU}T15:00:00.000Z`, "no-answer")];
    const once = pickupRateForDay(calls, THU);
    const twice = pickupRateForDay(calls.filter(() => true), THU);
    expect(twice).toEqual(once);
  });
});

describe("pickupRateByDay (the Weekly CC Report's Mon–Fri rows)", () => {
  test("one row per requested day, in order; unasked days never appear; empty days rate null", () => {
    const calls = [
      out("m1", "2026-10-26T14:00:00.000Z", "completed"),
      out("m2", "2026-10-26T15:00:00.000Z", "no-answer"),
      out("t1", "2026-10-27T14:00:00.000Z", "voicemail"),
      out("w1", "2026-10-28T14:00:00.000Z", "completed"),
      out("w2", "2026-10-28T15:00:00.000Z", "completed"),
      out("w3", "2026-10-28T16:00:00.000Z", "failed"),
    ];
    const rows = pickupRateByDay(calls, ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(rows.map((r) => r.date)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(rows[0]).toMatchObject({ picked: 1, denominator: 2, rate: 0.5 });
    expect(rows[1]).toMatchObject({ picked: 0, denominator: 1, rate: 0 }); // voicemail-only day: a real 0, not null
    expect(rows[2]).toMatchObject({ picked: 2, denominator: 2, rate: 1 }); // failed excluded
    expect(rows[3].rate).toBeNull(); // no calls that day → "—", never 0%
    expect(rows[4].rate).toBeNull();
  });
});

describe("DAILY REPORT: the anchor-day line lights up with the owner formula", () => {
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
    thresholdSeconds: 120,
  };

  test("dailyPickupRate = the anchor day's outbound rate (same call set as conversation conversion)", () => {
    const m = buildDailyReportMetrics({
      ...baseInput,
      // anchor-day calls: 7 completed + 1 no-answer + 1 voicemail outbound, 5 completed inbound, 2 failed
      callsAnchorDay: [
        ...Array.from({ length: 7 }, (_, i) => out(`oc${i}`, `${A}T${String(14 + i).padStart(2, "0")}:00:00.000Z`, "completed")),
        out("on1", `${A}T22:00:00.000Z`, "no-answer"),
        out("ov1", `${A}T23:00:00.000Z`, "voicemail"),
        ...Array.from({ length: 5 }, (_, i) => inb(`ic${i}`, `${A}T${String(8 + i).padStart(2, "0")}:00:00.000Z`, "completed")),
        out("of1", `${A}T09:00:00.000Z`, "failed"),
        out("of2", `${A}T10:00:00.000Z`, "busy"),
      ],
    });
    expect(m.dailyPickupRate).toBeCloseTo(7 / 9, 10);
    const text = buildDailyReportText(m, big3);
    expect(text).toContain("Daily Pickup Rate: 77.8%"); // ONE decimal, owner precision
  });

  test("anchor day with no outbound dial outcomes → null → the line renders — (never 0%)", () => {
    const m = buildDailyReportMetrics({
      ...baseInput,
      callsAnchorDay: [inb("ic1", `${A}T14:00:00.000Z`, "completed")],
    });
    expect(m.dailyPickupRate).toBeNull();
    expect(buildDailyReportText(m, big3)).toContain("Daily Pickup Rate: —");
  });

  test("calls on OTHER days never leak into the anchor-day rate", () => {
    const m = buildDailyReportMetrics({
      ...baseInput,
      callsAnchorDay: [
        out("ok", `${A}T14:00:00.000Z`, "completed"),
        out("other", "2026-10-28T14:00:00.000Z", "no-answer"), // Tuesday — not the anchor
      ],
    });
    expect(m.dailyPickupRate).toBeCloseTo(1, 10);
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
  /** The loader's exact chain: shared per-day function → labelled rows. */
  const loaderRows = (calls: CallRow[], days: string[]) =>
    pickupRateByDay(calls, days).map((r) => ({ date: r.date, label: weekdayName(r.date), rate: r.rate }));

  test("each occurred Mon–Fri day renders INDIVIDUALLY at one decimal", () => {
    const calls: CallRow[] = [
      out("m1", `${MON}T14:00:00.000Z`, "completed"),
      out("m2", `${MON}T15:00:00.000Z`, "no-answer"),
      out("m3", `${MON}T16:00:00.000Z`, "voicemail"),
      out("t1", "2026-10-27T14:00:00.000Z", "completed"),
      out("t2", "2026-10-27T15:00:00.000Z", "completed"),
      out("w1", "2026-10-28T14:00:00.000Z", "completed"),
      out("w2", "2026-10-28T15:00:00.000Z", "failed"),
      out("th1", THU + "T14:00:00.000Z", "completed"),
      out("th2", THU + "T15:00:00.000Z", "voicemail"),
      out("f1", "2026-10-30T14:00:00.000Z", "no-answer"),
    ];
    const text = buildWeeklyCcReportText({ ...base, pickupByDay: loaderRows(calls, [MON, "2026-10-27", "2026-10-28", THU, "2026-10-30"]) });
    expect(text).toContain("Pickup Rate by day (Mon–Fri):");
    expect(text).toContain("  Monday: 33.3%"); // 1 ÷ 3 — voicemail not picked up
    expect(text).toContain("  Tuesday: 100.0%");
    expect(text).toContain("  Wednesday: 100.0%"); // failed excluded from the denominator
    expect(text).toContain("  Thursday: 50.0%"); // voicemail in the denominator, not the numerator
    expect(text).toContain("  Friday: 0.0%"); // no-answer only: a real 0 — a dialed-and-missed day, not missing data
  });

  test("zero-denominator days render — (honest), genuinely-zero days render 0.0%", () => {
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
      out("m1", `${MON}T14:00:00.000Z`, "completed"),
      out("t1", "2026-10-27T14:00:00.000Z", "no-answer"),
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
    // The builder renders whatever rows it is given; the LOADER filters. This
    // pins the loader's day-set rule through the pure chain: Sat/Sun of the
    // week and next-Monday (a future day) must never appear.
    const days = [MON, "2026-10-27", "2026-10-28", THU, "2026-10-30"]; // Mon–Fri only
    const rows = pickupRateByDay([], days).map((r) => ({ date: r.date, label: weekdayName(r.date), rate: r.rate }));
    const text = buildWeeklyCcReportText({ ...base, pickupByDay: rows });
    expect(text).toContain("  Monday: —");
    expect(text).not.toContain("Saturday:");
    expect(text).not.toContain("Sunday:");
  });
});
