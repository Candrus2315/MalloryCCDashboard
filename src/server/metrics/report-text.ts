/**
 * Daily CC Report — text rendering (SPEC "DAILY CC REPORT" example format).
 *
 * ONE server-side builder produces the exact copy text for all three buttons:
 *  - COPY REPORT      → the base text
 *  - COPY FOR EMAIL   → "Subject: Daily CC Report — <date>" line + base text
 *  - COPY FOR SLACK   → base text fenced in a code block (pastes cleanly)
 *
 * Pure module: no DB, no clock, no React. Snapshot-tested against the SPEC
 * example. Formatting rules: percentages ONE decimal ("63.6%" — the owner's
 * clean-precision convention 2026-10-28, same as the Team/Reps pages; the
 * formatPercent 2-decimal default remains for other consumers), counts as
 * plain integers, missing data renders as "—" (never a plausible number).
 */

import type { DailyReportMetrics } from "./compute";
import { addDays, formatDateHuman, weekdayName } from "../date-logic";

export interface Big3Input {
  priority1?: string | null;
  priority2?: string | null;
  priority3?: string | null;
}

const EMPTY = "—";

/**
 * The day the Daily Report performance figures cover, as a phrase:
 * "yesterday" when the anchor is the calendar prior day, "today" when the
 * anchor IS the report date (EOD rule), otherwise the anchor's weekday name
 * ("Friday" on a Monday-morning report). Drives the KPI sublabels and the
 * missing-data banners so they never say "yesterday" about a day that isn't.
 */
export function anchorDayPhrase(anchorDate: string, reportDate: string): string {
  if (anchorDate === reportDate) return "today";
  if (anchorDate === addDays(reportDate, -1)) return "yesterday";
  return weekdayName(anchorDate, true);
}

/** KPI label for the anchor-day bookings figure ("Bookings Yesterday" / "Bookings Friday" / "Bookings Today"). */
export function bookingsAnchorLabel(anchorDate: string, reportDate: string): string {
  if (anchorDate === reportDate) return "Bookings Today";
  if (anchorDate === addDays(reportDate, -1)) return "Bookings Yesterday";
  return `Bookings ${weekdayName(anchorDate, true)}`;
}

/** Compact label for the copied report's Bookings line (owner 10/30 rename: the line always names the day it covers). */
export function bookingsAnchorLineLabel(anchorDate: string, reportDate: string): string {
  return bookingsAnchorLabel(anchorDate, reportDate);
}

/**
 * Percent with `digits` decimals, rounding exact half-values UP (63.625 →
 * "63.63%"), tolerant of float dust (a ratio like 0.63625 stored as
 * 63.624999… must still land on the .5 boundary and round half-up).
 */
export function formatPercent(ratio: number | null | undefined, digits = 2): string {
  if (ratio == null || !Number.isFinite(ratio)) return EMPTY;
  const scaled = ratio * 100;
  const f = 10 ** digits;
  const eps = Math.abs(scaled) < 1e9 ? 1e-9 : 0; // float-dust nudge only
  const rounded = Math.round((scaled + (scaled < 0 ? -eps : eps)) * f) / f;
  return `${rounded.toFixed(digits)}%`;
}

/**
 * Counts render as plain integers (e.g. 80, 700, 0).
 */
export function formatInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EMPTY;
  return String(Math.round(n));
}

/**
 * Money as USD with the currency sign and ALWAYS 2 decimals ("$240.00",
 * "$3,680.00" — thousands grouped, the established UI style). The commission
 * tracker's contract (payroll keeps 2dp, interpretation note 8). Missing data
 * renders the em dash, never $0.00.
 */
export function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EMPTY;
  return (
    "$" +
    (Math.round(n * 100) / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/**
 * Counts that may be fractional from team-goal shares (79 ÷ 6 = 13.166…):
 * integers render whole, otherwise 1 decimal. Missing data → em dash.
 */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EMPTY;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Duration seconds → "4m 32s" ("1h 04m" past an hour); missing data → em dash. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return EMPTY;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Team-comparison difference, unit-aware per SPEC:
 *  - "pct"    → counts as % difference, 1 decimal: "+8.8%"
 *  - "pp"     → rates as percentage points, 1 decimal: "+2.6 pp"
 *  - "seconds"→ duration delta: "+45 s"
 * Zero renders "+0.0 …" (explicitly not negative); missing data → em dash.
 */
export function formatDiff(diff: number | null | undefined, unit: "pct" | "pp" | "seconds"): string {
  if (diff == null || !Number.isFinite(diff)) return EMPTY;
  const f = 10 ** 1;
  const rounded = Math.round(diff * f) / f;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "+";
  const abs = Math.abs(rounded).toFixed(1);
  if (unit === "pp") return `${sign}${abs} pp`;
  if (unit === "seconds") return `${sign}${Math.round(Math.abs(diff))} s`;
  return `${sign}${abs}%`;
}

function big3Lines(big3: Big3Input): string[] {
  const val = (v: string | null | undefined) => (v && v.trim().length > 0 ? v.trim() : EMPTY);
  return [`1. ${val(big3.priority1)}`, `2. ${val(big3.priority2)}`, `3. ${val(big3.priority3)}`];
}

/** The base report — EXACT format from the SPEC example. */
export function buildDailyReportText(m: DailyReportMetrics, big3: Big3Input): string {
  const formToday =
    (m.formLeadsToday?.auction_register_certificate ?? 0)
    + (m.formLeadsToday?.google_ads_leads ?? 0)
    + (m.formLeadsToday?.alliance_activate_certificate ?? 0)
    + (m.formLeadsToday?.website_applications ?? 0);
  return [
    "Daily CC Report",
    "",
    `${bookingsAnchorLineLabel(m.anchorDate, m.reportDate)}: ${formatInt(m.bookingsAnchorDay)}`,
    // OWNER DIRECTIVE 10/30 (post-#126 fix): the week figure is the canonical
    // QUALIFYING WTD count (weekBookings) — the same deposit-date numerator
    // the Today strip shows and the Weekly CC Report's goal tracker uses for
    // the same cutoff (parity suite pins it). The Weekly hero's created-basis
    // gross is a different display and is NOT reproduced here.
    `Bookings for the Week: ${formatInt(m.weekBookings)}`,
    `Key Driver: ${formatInt(m.weeklyBookingGoal)}`,
    `Left: ${formatInt(m.bookingsLeft)}`,
    `Daily: ${formatInt(m.dailyBookingsNeeded)}`,
    // ONE-DECIMAL convention (owner-flagged precision 2026-10-28): every
    // percentage in the copied report renders like the page above — one
    // decimal, half-up, never float dust (e.g. "71.8%", not 71.7857…%).
    // OWNER DIRECTIVE 10/30 (Mallory's metrics): the three legacy performance
    // lines (Conversion of Calls Over 2 Mins / Conversion of Assigned Leads /
    // % of Appt Achieved) are REPLACED by the two total-lead conversion lines
    // + the pickup line (owner decision 10/30 — the approved formula).
    // Same structure, same one-decimal convention.
    `Total Lead Conversion — Yesterday: ${formatPercent(m.totalLeadConversionYesterday, 1)}`,
    `Total Lead Conversion — Week: ${formatPercent(m.totalLeadConversionWeek, 1)}`,
    // PICKUP (owner decision 10/30 — FINAL): the anchor day's outbound pickup
    // rate — completed outbound ÷ (completed + no-answer + voicemail
    // outbound), the ONE shared definition (pickupRateForDay). Null (no dial
    // outcomes) renders "—" — never a fabricated 0%.
    `Daily Pickup Rate: ${formatPercent(m.dailyPickupRate, 1)}`,
    "",
    "Leads:",
    `Weekly Lead Budget: ${formatInt(m.weeklyLeadBudget)}`,
    `Leads Today: ${formatInt(m.leadsToday)}`,
    `Family: ${formatInt(m.familyLeadsToday)}`,
    `Animalia: ${formatInt(m.animaliaLeadsToday)}`,
    `Fairyland: ${formatInt(m.fairylandLeadsToday)}`,
    // FOUR FORM-WORKBOOK SOURCES (owner directive 2026-10-27): Leads Today
    // includes them, so when any exist the copy names them — otherwise the
    // owner's SPEC template stays byte-identical.
    ...(formToday > 0
      ? [
          `Auction Certificates: ${formatInt(m.formLeadsToday.auction_register_certificate)}`,
          `Google Ads Leads: ${formatInt(m.formLeadsToday.google_ads_leads)}`,
          `Alliance Certificates: ${formatInt(m.formLeadsToday.alliance_activate_certificate)}`,
          `Website Applications: ${formatInt(m.formLeadsToday.website_applications)}`,
        ]
      : []),
    `Total Weekly Leads: ${formatInt(m.weeklyLeads)}`,
    `% of Budget Used: ${formatPercent(m.leadBudgetUsedPct, 1)}`,
    `Leads Remaining: ${formatInt(m.leadsRemaining)}`,
    "",
    "Big 3:",
    ...big3Lines(big3),
  ].join("\n");
}

/** Email variant: subject line prefixed, then the base text. */
export function buildDailyReportEmail(m: DailyReportMetrics, big3: Big3Input): string {
  return `Subject: Daily CC Report — ${formatDateHuman(m.reportDate)}\n\n${buildDailyReportText(m, big3)}`;
}

/** Slack variant: fenced code block so it pastes cleanly. */
export function buildDailyReportSlack(m: DailyReportMetrics, big3: Big3Input): string {
  return "```\n" + buildDailyReportText(m, big3) + "\n```";
}

/** True when any Big 3 slot is unset — the page warns before copying. */
export function big3Incomplete(big3: Big3Input): boolean {
  return [big3.priority1, big3.priority2, big3.priority3].some((v) => !v || v.trim().length === 0);
}
