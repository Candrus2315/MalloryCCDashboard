/**
 * WEEKLY CC REPORT — text rendering (owner template, 2026-09-29).
 *
 * ONE pure builder assembles the full "CC Report" the owner posts every
 * Monday, in the owner's template order:
 *   Bookings (Week ± goal) · Bookings (Month-to-Date ± goal) ·
 *   Alliance/Auction/Website (leads + bookings) · Leads ·
 *   Lead Conversion (+ by genre) · Bookings from Leads (overall funnel) ·
 *   Calendar/booked-out ·
 *   placeholder fields (Empty appointments / Holes / 1st Call Completed) ·
 *   the narrative sections (editable, persisted per week).
 *
 * HONESTY RULES (SPEC: never invent data):
 *  - Alliance/Auction LEADS are synced from GHL opportunities (owner-verified
 *    2026-09-29: the channels' pipelines) → real counts, ET created-date week.
 *  - "Website" has no synced lead source and is not a distinct Acuity booking
 *    type → its leads and bookings render "—", never a number.
 *  - Empty appointments / Holes / 1st Call Completed are not yet defined against
 *    our data → blank fields the owner fills until the owner defines them.
 *  - A missing monthly goal renders "—" (never September's goal in October).
 *
 * Pure module: no DB, no clock, no React — deterministic under tests.
 */
import { formatDateHumanFull } from "../date-logic";
import { formatInt, formatPercent } from "./report-text";
import { goalVsActual, monthKeyLabel, WEEKLY_CC_SECTIONS } from "./weekly";

const NO_SOURCE = "—";

/** Leads + bookings of one channel; website leads/bookings have no synced source (null → "—"). */
export interface ChannelSplitLine {
  alliance: number;
  auction: number;
  website: number | null;
}

export interface WeeklyCcReportInput {
  /** The report week (Monday..Sunday). */
  week: { start: string; end: string };
  /** 'YYYY-MM' month key of the MTD bucket. */
  monthKey: string;
  bookingsWeek: { total: number; goal: number | null };
  bookingsMonth: { total: number; goal: number | null };
  /** Alliance/Auction BOOKINGS counted from Acuity types; website always null (no such Acuity type). */
  channels: ChannelSplitLine;
  /** Alliance/Auction LEADS from GHL opportunities (ET created-date week); website null (no synced source). */
  channelLeads: ChannelSplitLine;
  leads: { family: number; animalia: number; total: number };
  conversion: { overall: number | null; family: number | null; animalia: number | null };
  /**
   * BOOKINGS FROM LEADS (owner request 2026-09-29): ALL paid bookings of the
   * week ÷ ALL sheet leads — the overall funnel rate. pct is null when the
   * week had no sheet leads ("—" is rendered, never a fabricated 0%).
   */
  funnel: { wins: number; leads: number; pct: number | null };
  calendar: {
    thisWeek: { appointments: number; capacity: number };
    nextWeek: { appointments: number; capacity: number };
    beyond: number;
    firstFullyOpenDay: string | null;
  };
  /** Stored narrative for the report week (section key → text; empty = unfilled). */
  notes: Record<string, string | null | undefined>;
  /** Computed Celebrate default ("Name — N paid bookings"); a stored note overrides it. */
  celebrateDefault: string | null;
}

/** Fill value for a narrative line: stored note → computed default → blank. */
function noteOr(notes: WeeklyCcReportInput["notes"], key: string, fallback: string | null): string {
  const stored = notes[key];
  if (stored != null && stored.trim().length > 0) return stored.trim();
  if (fallback != null && fallback.trim().length > 0) return fallback.trim();
  return "";
}

function fillLine(label: string, value: string): string {
  return value.length > 0 ? `${label}: ${value}` : `${label}:`;
}

function fillSummary(appointments: number, capacity: number): string {
  const cap = capacity > 0 ? String(capacity) : "—";
  const pct = capacity > 0 ? ` (${Math.round((appointments / capacity) * 100)}%)` : "";
  return `${formatInt(appointments)}/${cap} filled${pct}`;
}

/** The full CC Report — EXACT template order from the owner's spec. */
export function buildWeeklyCcReportText(input: WeeklyCcReportInput): string {
  const lines: string[] = [];

  lines.push(`CC Report — Week of ${formatDateHumanFull(input.week.start)} – ${formatDateHumanFull(input.week.end)}`);
  lines.push("");
  lines.push(`Bookings (Week): ${goalVsActual(input.bookingsWeek.total, input.bookingsWeek.goal)}`);
  lines.push(`Bookings (Month-to-Date, ${monthKeyLabel(input.monthKey)}): ${goalVsActual(input.bookingsMonth.total, input.bookingsMonth.goal)}`);
  lines.push("");
  lines.push(`Alliance — Leads: ${formatInt(input.channelLeads.alliance)} · Bookings: ${formatInt(input.channels.alliance)}`);
  lines.push(`Auction — Leads: ${formatInt(input.channelLeads.auction)} · Bookings: ${formatInt(input.channels.auction)}`);
  lines.push(`Website — Leads: ${input.channelLeads.website == null ? NO_SOURCE : formatInt(input.channelLeads.website)} · Bookings: ${input.channels.website == null ? NO_SOURCE : formatInt(input.channels.website)}`);
  lines.push("");
  lines.push("Leads (week — synced Family/Animalia sheets):");
  lines.push(`Family: ${formatInt(input.leads.family)}`);
  lines.push(`Animalia: ${formatInt(input.leads.animalia)}`);
  lines.push(`Total: ${formatInt(input.leads.total)}`);
  lines.push("");
  lines.push(
    `Conversion of Assigned Leads: ${formatPercent(input.conversion.overall)} (Family ${formatPercent(input.conversion.family)} · Animalia ${formatPercent(input.conversion.animalia)})`,
  );
  // BOOKINGS FROM LEADS (owner request 2026-09-29) — the overall funnel rate
  // right after the assigned-lead conversion; the owner edits it out freely.
  // Zero sheet leads → "—" (never a fabricated 0%).
  lines.push(`Bookings from Leads: ${formatPercent(input.funnel.pct)}`);
  lines.push("");
  lines.push("Calendar / Booked-out:");
  lines.push(`This week: ${fillSummary(input.calendar.thisWeek.appointments, input.calendar.thisWeek.capacity)}`);
  lines.push(`Next week: ${fillSummary(input.calendar.nextWeek.appointments, input.calendar.nextWeek.capacity)}`);
  lines.push(`Beyond next week: ${formatInt(input.calendar.beyond)} sessions`);
  lines.push(`First fully open day: ${input.calendar.firstFullyOpenDay ? formatDateHumanFull(input.calendar.firstFullyOpenDay) : "—"}`);
  lines.push("");
  // Not-yet-defined placeholders — blank fields the owner fills until the
  // owner defines them against our data (never a fabricated number).
  lines.push("Empty appointments:");
  lines.push("Holes:");
  lines.push("1st Call Completed through Monday:");
  lines.push("");
  for (const section of WEEKLY_CC_SECTIONS) {
    const fallback = section.key === "celebrate" ? input.celebrateDefault : null;
    lines.push(fillLine(section.label, noteOr(input.notes, section.key, fallback)));
  }

  return lines.join("\n");
}
