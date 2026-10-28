/**
 * WEEKLY CC REPORT — text rendering (owner template, 2026-09-29).
 *
 * ONE pure builder assembles the full "CC Report" the owner posts every
 * Monday, in the owner's template order:
 *   Bookings (Week — Gross / Cancellations / Net ± goal) ·
 *   Bookings (Month-to-Date, gross ± goal) ·
 *   Alliance/Auction/Website (leads + bookings) · Leads ·
 *   Lead Conversion (+ by genre) · Calendar/booked-out ·
 *   placeholder fields (Empty appointments / Holes / 1st Call Completed) ·
 *   the narrative sections (editable, persisted per week).
 *
 * HONESTY RULES (SPEC: never invent data):
 *  - Alliance/Auction LEADS are synced from GHL opportunities (owner-verified
 *    2026-09-29: the channels' pipelines) → real counts, ET created-date week.
 *  - "Website" has no synced lead source and is not a distinct Acuity booking
 *    type → its leads and bookings render "—", never a number.
 *  - Empty appointments / 1st Call Completed are not yet defined against our
 *    data → blank fields the owner fills until the owner defines them.
 *  - HOLES is owner-defined (2026-09-30): empty booking slots = derived
 *    capacity (10/day, 9 Tue) − booked sessions per ET day, summed Mon–Sun —
 *    computed via the commission engine's slot derivation (derive.ts,
 *    deriveWeeklyHoles). A null value keeps the legacy blank "Holes:"
 *    placeholder BYTE-IDENTICAL (never a fabricated number).
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
  /**
   * THE OWNER'S FOUR-NUMBER VIEW (Final Booking Logic 10/28, audit-79v84).
   * When provided, the Bookings (Week) hero line renders
   * "Gross / Cancellations / Net" — gross = qualifying (paid-deposit) bookings
   * ORIGINALLY CREATED in the Mon–Sun week, identity-deduped per client,
   * cancellations INCLUDED (Oct 19–25 = 84, audit-exact); cancellations = true
   * cancellations among that gross (= 5); net = gross − cancellations (= 79).
   * Credit is permanently tied to the original creation business date —
   * reschedules never move a booking between weeks and never count as
   * cancellations. While present, the standalone "Bookings Produced (Mon–Sun)"
   * line is SUPPRESSED (gross IS the produced figure, now the hero) — the
   * Weekly tab ↔ Report digit identity holds for all four numbers.
   * OPTIONAL: absent/null keeps the legacy "Bookings (Week)" line (and the
   * legacy Bookings Produced line when bookingsProduced is provided) — the
   * template stays byte-identical for callers that don't pass it.
   */
  productionWeek?: { gross: number; cancellations: number; net: number; goal: number | null } | null;
  /**
   * GROSS MTD (owner Final Booking Logic 10/28 — one production basis with the
   * weekly hero): qualifying paid bookings ORIGINALLY CREATED month-to-date,
   * identity-deduped, cancellations included. When provided, the MTD line
   * renders the gross figure vs the monthly goal. OPTIONAL: absent keeps the
   * legacy MTD line byte-identical.
   */
  productionMonth?: { gross: number; goal: number | null } | null;
  /**
   * LEGACY fallback (superseded by productionWeek — kept so the template stays
   * tolerant of missing inputs and old callers stay byte-identical): the
   * standalone produced line only renders when productionWeek is ABSENT.
   */
  bookingsProduced?: number | null;
  /** Alliance/Auction BOOKINGS counted from Acuity types; website always null (no such Acuity type). */
  channels: ChannelSplitLine;
  /** Alliance/Auction LEADS from GHL opportunities (ET created-date week); website null (no synced source). */
  channelLeads: ChannelSplitLine;
  /**
   * Leads of the report week — ALL SEVEN sources (owner directive 2026-10-27):
   * the three genre sheets (classified by lead_type text exactly as before)
   * plus the four "Forms Data" workbook tabs (classified by SHEET identity).
   * `total` is the combined count of all seven; the four form-source lines
   * below the genre lines keep the total explainable in the copied report.
   */
  leads: {
    family: number; animalia: number; fairyland: number;
    auction_register_certificate: number; google_ads_leads: number;
    alliance_activate_certificate: number; website_applications: number;
    total: number;
  };
  /**
   * [REMOVED — owner directive 2026-10-28, "erase LEAD SOURCE PERFORMANCE from
   * the CC Report"]: the report NO LONGER accepts or renders any per-source
   * section — no header, no methodology sentence, no per-source lead lines, no
   * "Total — Leads" line, no booking-period audit footnote. The per-source
   * Leads table lives ONLY on the Weekly page (Lead Source | Leads Received);
   * the report keeps its hero (Gross / Cancellations / Net ± goal), the MTD
   * gross line and its other non-source sections. The input field is GONE from
   * the interface (the page no longer passes it) — nothing of the section
   * survives in the report text for any caller.
   */
  conversion: { overall: number | null; family: number | null; animalia: number | null; fairyland: number | null };
  /**
   * BOOKINGS FROM LEADS (owner request 2026-09-29; work-date alignment): the
   * week's work-date lead cohort ÷ its cohort-to-date produced bookings.
   * NO LONGER RENDERED — Final Booking Logic 10/28 §6 removes the
   * cohort-produced funnel from the tab AND this report (production reports
   * as Gross / Cancellations / Net). Kept on the interface only so existing
   * callers compile unchanged.
   */
  funnel: { wins: number; leads: number; pct: number | null };
  calendar: {
    thisWeek: { appointments: number; slotsOccupied: number; capacity: number };
    nextWeek: { appointments: number; slotsOccupied: number; capacity: number };
    beyond: number;
    firstFullyOpenDay: string | null;
  };
  /**
   * OWNER HOLES of the REPORT week (owner definition 2026-09-30, computed by
   * deriveWeeklyHoles). Null → the legacy blank "Holes:" placeholder is kept
   * BYTE-IDENTICAL; a number fills the placeholder as
   * "Holes (empty slots): N" — the holes line is the ONLY line this input can
   * ever change.
   */
  holes: number | null;
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

/**
 * DISTINCT-SLOT fill line (owner report 2026-10-06 "CALENDAR-FILL ACCURACY"):
 * the filled count is DISTINCT studio slots occupied — a double-booked slot
 * fills ONE slot (its extra sessions never inflate the fill past capacity).
 * When the raw session count exceeds the slot count the sessions figure is
 * appended so the excess stays visible in the copied report too.
 */
function fillSummary(slotsOccupied: number, capacity: number, appointments: number): string {
  const cap = capacity > 0 ? String(capacity) : "—";
  const pct = capacity > 0 ? ` (${Math.round((slotsOccupied / capacity) * 100)}%)` : "";
  const sessions = appointments > slotsOccupied ? ` · ${formatInt(appointments)} sessions` : "";
  return `${formatInt(slotsOccupied)}/${cap} filled${pct}${sessions}`;
}

/** The full CC Report — EXACT template order from the owner's spec. */
export function buildWeeklyCcReportText(input: WeeklyCcReportInput): string {
  const lines: string[] = [];

  lines.push(`CC Report — Week of ${formatDateHumanFull(input.week.start)} – ${formatDateHumanFull(input.week.end)}`);
  lines.push("");
  // THE OWNER'S FOUR-NUMBER HERO (Final Booking Logic 10/28): Gross /
  // Cancellations / Net on the produced (created-in-week) basis, + goal.
  // Digit identity with the Weekly tab's production block is structural — the
  // page passes the SAME payload numbers it renders.
  if (input.productionWeek != null) {
    const pw = input.productionWeek;
    lines.push(
      `Bookings (Week): ${goalVsActual(pw.gross, pw.goal)} gross · Cancellations: ${formatInt(pw.cancellations)} · Net: ${formatInt(pw.net)}`,
    );
  } else {
    lines.push(`Bookings (Week): ${goalVsActual(input.bookingsWeek.total, input.bookingsWeek.goal)}`);
    // LEGACY (pre-Final-Booking-Logic callers only): the standalone produced
    // line — figure + footnote. Superseded by the four-number hero above and
    // suppressed whenever productionWeek is provided (gross IS produced).
    if (input.bookingsProduced != null) {
      lines.push(
        `Bookings Produced (Mon–Sun): ${formatInt(input.bookingsProduced)} — paid deposits on bookings created in the Mon–Sun week · per client (cancel-and-rebook counted once) · cancellations included`,
      );
    }
  }
  // GROSS MTD — one production basis with the hero (created-in-month gross
  // vs the monthly goal). Absent input keeps the legacy MTD line.
  lines.push(
    input.productionMonth != null
      ? `Bookings (Month-to-Date, ${monthKeyLabel(input.monthKey)}): ${goalVsActual(input.productionMonth.gross, input.productionMonth.goal)} gross`
      : `Bookings (Month-to-Date, ${monthKeyLabel(input.monthKey)}): ${goalVsActual(input.bookingsMonth.total, input.bookingsMonth.goal)}`,
  );
  lines.push("");
  lines.push(`Alliance — Leads: ${formatInt(input.channelLeads.alliance)} · Bookings: ${formatInt(input.channels.alliance)}`);
  lines.push(`Auction — Leads: ${formatInt(input.channelLeads.auction)} · Bookings: ${formatInt(input.channels.auction)}`);
  lines.push(`Website — Leads: ${input.channelLeads.website == null ? NO_SOURCE : formatInt(input.channelLeads.website)} · Bookings: ${input.channels.website == null ? NO_SOURCE : formatInt(input.channels.website)}`);
  lines.push("");
  const leads = input.leads;
  // FOUR FORM-WORKBOOK SOURCES (owner directive 2026-10-27): the total INCLUDES
  // them. Lines render only when the week actually has form-source leads — the
  // owner's template stays byte-stable otherwise (the "—" convention covers a
  // not-yet-synced source, a zero-form week needs no extra lines).
  const formLeadsWeek =
    (leads.auction_register_certificate ?? 0)
    + (leads.google_ads_leads ?? 0)
    + (leads.alliance_activate_certificate ?? 0)
    + (leads.website_applications ?? 0);
  lines.push(
    formLeadsWeek > 0
      ? "Leads (week — synced sheets: Family/Animalia/Fairyland + 4 Forms Data tabs):"
      : "Leads (week — synced Family/Animalia/Fairyland sheets):",
  );
  lines.push(`Family: ${formatInt(leads.family)}`);
  lines.push(`Animalia: ${formatInt(leads.animalia)}`);
  lines.push(`Fairyland: ${formatInt(leads.fairyland)}`);
  if (formLeadsWeek > 0) {
    lines.push(`Auction Certificates: ${formatInt(leads.auction_register_certificate)}`);
    lines.push(`Google Ads Leads: ${formatInt(leads.google_ads_leads)}`);
    lines.push(`Alliance Certificates: ${formatInt(leads.alliance_activate_certificate)}`);
    lines.push(`Website Applications: ${formatInt(leads.website_applications)}`);
  }
  lines.push(`Total: ${formatInt(leads.total)}`);
  lines.push("");
  // LEAD SOURCE PERFORMANCE — ERASED from the report (owner directive
  // 2026-10-28): the header, the methodology sentence, all seven per-source
  // lead lines, the "Total — Leads" line and the trailing booking-period audit
  // footnote are GONE. The report text contains NO lead-source section for any
  // input; per-source leads live only on the Weekly page's table. The optional
  // inputs stay optional elsewhere (productionWeek/productionMonth/holes…) so
  // the template still renders byte-identical when they are absent.
  // WORK-DATE ALIGNMENT: the assigned cohort is the week's work-date cohort
  // and the bookings are cohort-to-date produced (credited by lead
  // assignment) — the rep-cohort doctrine the owner's standing directive
  // protects (rep-level detail keeps its own basis, labeled in the UI).
  lines.push(
    `Conversion of Assigned Leads: ${formatPercent(input.conversion.overall)} (Family ${formatPercent(input.conversion.family)} · Animalia ${formatPercent(input.conversion.animalia)} · Fairyland ${formatPercent(input.conversion.fairyland)})`,
  );
  // "Bookings from Leads" (the overall cohort funnel rate) REMOVED — Final
  // Booking Logic 10/28 §6: cohort-produced bookings leave the Weekly tab's
  // panel AND this report; production reports as Gross / Cancellations / Net
  // in the hero line. The `funnel` input stays on the interface (template
  // tolerance for existing callers) but is no longer rendered.
  lines.push("");
  lines.push("Calendar / Booked-out:");
  lines.push(`This week: ${fillSummary(input.calendar.thisWeek.slotsOccupied, input.calendar.thisWeek.capacity, input.calendar.thisWeek.appointments)}`);
  lines.push(`Next week: ${fillSummary(input.calendar.nextWeek.slotsOccupied, input.calendar.nextWeek.capacity, input.calendar.nextWeek.appointments)}`);
  lines.push(`Beyond next week: ${formatInt(input.calendar.beyond)} sessions`);
  lines.push(`First fully open day: ${input.calendar.firstFullyOpenDay ? formatDateHumanFull(input.calendar.firstFullyOpenDay) : "—"}`);
  lines.push("");
  // Not-yet-defined placeholders — blank fields the owner fills until the
  // owner defines them against our data (never a fabricated number).
  // HOLES IS now owner-defined (9/30) and computed: the placeholder fills as
  // "Holes (empty slots): N"; null keeps the legacy blank line byte-identical.
  lines.push("Empty appointments:");
  lines.push(input.holes == null ? "Holes:" : `Holes (empty slots): ${formatInt(input.holes)}`);
  lines.push("1st Call Completed through Monday:");
  lines.push("");
  for (const section of WEEKLY_CC_SECTIONS) {
    const fallback = section.key === "celebrate" ? input.celebrateDefault : null;
    lines.push(fillLine(section.label, noteOr(input.notes, section.key, fallback)));
  }

  return lines.join("\n");
}
