/**
 * HISTORICAL BOOKING-WIN AGGREGATION REGRESSION (rev 12/15 reconciliation pass).
 *
 * Pins the three invariants every historical surface must satisfy after the
 * deposit-paid re-baseline:
 *   1. Each win counts EXACTLY ONCE, on its booking_win_business_date (the ET
 *      date the deposit was received) — NEVER on created_business_date, and
 *      never in both buckets. A booking created Fri and paid the NEXT week
 *      moves weeks; the created week must NOT also count it.
 *   2. Paid + unattributed (online) wins count toward TEAM totals but NEVER
 *      enter any rep-level aggregate (bookingsByRep / repRangeSummaries).
 *   3. Pending (unpaid) bookings never enter ANYTHING — not team totals, not
 *      rep rows, not trend buckets, not the Daily Report.
 *
 * Pure-layer tests over the metrics/compute helpers every page path calls
 * (buildTodayMetrics / buildDailyReportMetrics / buildTeamRangeMetrics /
 * buildTeamTrends all funnel through countBookingsCreatedBetween,
 * filterApptsInWinBucketRange and bookingsByRep).
 */
import { describe, expect, test } from "bun:test";
import {
  bookingsByRep,
  bookingWinBusinessDateOf,
  buildDailyReportMetrics,
  buildTeamRangeMetrics,
  buildTeamTrends,
  countBookingsCreatedBetween,
  filterApptsInWinBucketRange,
  isBookingWin,
  repRangeSummaries,
} from "../metrics/compute";
import type { AppointmentRow, AttributionRow, CallRow, LeadRow } from "../metrics/compute";

// Monday + the following Friday (two different weeks — the moved-win case).
const W1_MON = "2026-09-21";
const W2_FRI = "2026-10-02";
const W2_MON = "2026-09-28";

/** Raw Acuity payload fragment; paymentTimestamp present = the deposit date evidence. */
const raw = (paid: "yes" | "no", price: string, paymentTimestamp?: string) => ({
  paid,
  price,
  priceSold: price,
  amountPaid: paid === "yes" ? price : "0.00",
  certificate: null,
  canceled: false,
  ...(paymentTimestamp ? { paymentTimestamp } : {}),
});

let seq = 0;
function appt(opts: {
  id: string;
  paid: "yes" | "no";
  price?: string;
  created: string; // ET business date the booking was made
  paymentTimestamp?: string;
  cancelled?: boolean;
}): AppointmentRow {
  seq += 1;
  return {
    id: opts.id,
    contact_id: `contact-${seq}`,
    calendar_id: "cal-mallory",
    appointment_type: "Animalia Session",
    appointment_datetime: `${opts.created}T14:00:00.000Z`,
    created_at: `${opts.created}T14:00:00.000Z`,
    created_business_date: opts.created,
    created_time_source: `${opts.created}T09:00:00-0500`,
    created_time_precision: "full",
    raw: raw(opts.paid, opts.price ?? "300.00", opts.paymentTimestamp),
    status: opts.cancelled ? "cancelled" : "scheduled",
    cancelled: !!opts.cancelled,
  };
}

const rep = "rep-allison";
const attribution = (id: string, repId: string | null): AttributionRow => ({
  id: `v-${id}`,
  appointment_id: id,
  call_id: null,
  rep_id: repId,
  method: repId ? "contact_id" : "none",
  confidence: repId ? 1 : 0,
  manual_override: false,
});

describe("HISTORICAL WIN AGGREGATION — rev 12/15 re-baseline invariants", () => {
  // ---- invariant 1: each win exactly once, on its WIN date ----
  test("a win counts on its payment win-date, never on its created date, never twice", () => {
    // Created Fri 9/25, deposit received Mon 9/28 (paymentTimestamp ET evidence).
    const moved = appt({ id: "moved", paid: "yes", created: "2026-09-25", paymentTimestamp: "2026-09-28T14:30:00-0400" });
    expect(bookingWinBusinessDateOf(moved)).toBe(W2_MON);

    // The OLD created-date bucket must NOT count it; the win bucket does; a
    // range covering BOTH dates counts it EXACTLY ONCE.
    expect(countBookingsCreatedBetween([moved], "2026-09-25", "2026-09-25")).toBe(0);
    expect(countBookingsCreatedBetween([moved], W2_MON, W2_MON)).toBe(1);
    expect(countBookingsCreatedBetween([moved], "2026-09-25", W2_MON)).toBe(1);

    // Range filter mirrors the store selector's contract.
    expect(filterApptsInWinBucketRange([moved], "2026-09-25", "2026-09-25")).toEqual([]);
    expect(filterApptsInWinBucketRange([moved], W2_MON, W2_MON)).toEqual([moved]);
  });

  test("persisted booking_win_business_date is authoritative over raw timestamp", () => {
    // Write-once: the persisted win column wins over a re-derived raw ts.
    const a = appt({ id: "persisted", paid: "yes", created: "2026-09-25", paymentTimestamp: "2026-09-28T14:30:00-0400" });
    a.booking_win_business_date = "2026-09-29";
    expect(bookingWinBusinessDateOf(a)).toBe("2026-09-29");
    expect(countBookingsCreatedBetween([a], "2026-09-25", "2026-09-29")).toBe(1);
  });

  // ---- invariant 2: online (paid + unattributed) never enters rep aggregates ----
  test("online wins count in team totals but never in any rep's numbers", () => {
    const repWin = appt({ id: "rw", paid: "yes", created: W1_MON });
    const online = appt({ id: "on", paid: "yes", created: W1_MON });
    const pending = appt({ id: "pd", paid: "no", created: W1_MON });
    const appts = [repWin, online, pending];
    const attrs = [attribution("rw", rep), attribution("on", null), attribution("pd", rep)];

    // TEAM total: 2 (both paid wins — the online one included)
    const team = buildTeamRangeMetrics({
      calls: [],
      appts,
      attributions: attrs,
      allCallsForJoin: [],
      leads: [],
      workStart: W1_MON,
      workEnd: W1_MON,
      weeks: [W1_MON],
      teamGoalByWeek: new Map([[W1_MON, 10]]),
      today: W1_MON,
      thresholdSeconds: 120,
    });
    expect(team.totalBookings).toBe(2);

    // REP aggregate: only the attributed win — the online booking NEVER lands
    // on a rep, and the pending never counts anywhere.
    const summaries = repRangeSummaries({
      reps: [{ id: rep, name: "Allison" }],
      calls: [],
      appts,
      attributions: attrs,
      allCallsForJoin: [],
      leads: [],
      workStart: W1_MON,
      workEnd: W1_MON,
      thresholdSeconds: 120,
    });
    expect(summaries.get(rep)?.totalBookings).toBe(1);
    expect(bookingsByRep(appts, attrs).get(rep)).toBe(1);
    expect(bookingsByRep(appts, attrs).size).toBe(1);
  });

  // ---- invariant 3: pendings never enter anything ----
  test("pendings are invisible to team totals, rep rows, trends and the daily report", () => {
    const win = appt({ id: "w1", paid: "yes", created: W1_MON });
    const pending = appt({ id: "p1", paid: "no", created: W1_MON });
    const cancelledWin = appt({ id: "cx", paid: "yes", created: W1_MON, cancelled: true });
    const appts = [win, pending, cancelledWin];
    const attrs = [attribution("w1", rep), attribution("p1", rep), attribution("cx", rep)];

    expect(isBookingWin(pending)).toBe(false);
    expect(bookingWinBusinessDateOf(pending)).toBe(null);

    const team = buildTeamRangeMetrics({
      calls: [],
      appts,
      attributions: attrs,
      allCallsForJoin: [],
      leads: [],
      workStart: W1_MON,
      workEnd: W1_MON,
      weeks: [W1_MON],
      teamGoalByWeek: new Map([[W1_MON, 10]]),
      today: W1_MON,
      thresholdSeconds: 120,
    });
    expect(team.totalBookings).toBe(1); // the win only — pending AND cancelled excluded
    expect(team.actual).toBe(1);

    // Trends: the win-date bucket holds the win; no bucket holds the pending.
    const trends = buildTeamTrends({
      calls: [] as CallRow[],
      appts,
      attributions: attrs,
      allCallsForJoin: [],
      leads: [] as LeadRow[],
      start: W1_MON,
      end: W1_MON,
      weeklyBudgetByWeek: new Map([[W1_MON, 700]]),
      thresholdSeconds: 120,
    });
    expect(trends.points).toHaveLength(1);
    expect(trends.points[0].bookings).toBe(1);

    // Daily Report (yesterday bucket = W1_MON): bookingsYesterday counts only wins.
    const report = buildDailyReportMetrics({
      reportDate: W2_MON,
      callsYesterday: [],
      apptsCreatedYesterday: appts,
      apptsCreatedWtd: appts,
      allCallsForWeek: [],
      attributions: attrs,
      leadsAllRecent: [],
      teamBookingGoal: 10,
      weeklyLeadBudget: 700,
      thresholdSeconds: 120,
    });
    expect(report.bookingsYesterday).toBe(1);
    expect(report.bookingsWtd).toBe(1);
  });

  // ---- historical week views: the full weekly aggregation uses win buckets ----
  test("weekly aggregation (historical week view) buckets by win date, not created date", () => {
    // Win paid in week 2 for a booking created in week 1: week-1 view 0, week-2 view 1.
    const moved = appt({ id: "moved2", paid: "yes", created: "2026-09-24", paymentTimestamp: "2026-10-02T15:00:00-0400" });
    const attrs = [attribution("moved2", rep)];
    const week1 = repRangeSummaries({
      reps: [{ id: rep, name: "Allison" }],
      calls: [],
      appts: filterApptsInWinBucketRange([moved], W1_MON, "2026-09-27"),
      attributions: attrs,
      allCallsForJoin: [],
      leads: [],
      workStart: W1_MON,
      workEnd: "2026-09-27",
      thresholdSeconds: 120,
    });
    const week2 = repRangeSummaries({
      reps: [{ id: rep, name: "Allison" }],
      calls: [],
      appts: filterApptsInWinBucketRange([moved], W2_MON, W2_FRI),
      attributions: attrs,
      allCallsForJoin: [],
      leads: [],
      workStart: W2_MON,
      workEnd: W2_FRI,
      thresholdSeconds: 120,
    });
    expect(week1.get(rep)?.totalBookings).toBe(0);
    expect(week2.get(rep)?.totalBookings).toBe(1);
  });
});
