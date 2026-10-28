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
   * LEAD SOURCE PERFORMANCE (owner directive 2026-10-27, Step 5; SIMPLIFIED
   * report presentation — same table as the Weekly tab): per-source leads (the
   * week's source_date cohort), CURRENT-PERIOD bookings (matched lead's sheet
   * date inside the week — the only conversion-numerator feed) and one-decimal
   * cohort conversion (Bookings ÷ Leads). The report prints ONLY the simple
   * per-source lines + Total + ONE compact auditability footnote (prior-period
   * / later-period / no-link / coverage) — the three-category fields below all
   * stay complete for the Weekly tab's detail view; nothing in the data layer
   * changed. Selection rule unchanged: the contact's NEAREST sheet lead
   * (nearest source_date to the booking's creation ET date, tie → most
   * recently ingested). Truly Unattributed = no reliable lead link — the ONLY
   * meaning of Unattributed. `best`/`worst`/`overlapNote` are carried for the
   * Weekly tab's detail view (the report section no longer prints them).
   * OPTIONAL: absent/null keeps the owner's template BYTE-IDENTICAL — the
   * section only renders when the page passes it.
   */
  sourcePerformance?: {
    rows: {
      source: string;
      label: string;
      leads: number;
      /** COHORT-TO-DATE (work-date alignment): cohort leads that produced a qualifying paid booking — the conversion numerator. */
      bookings: number;
      /** Unused on the cohort rows (always 0) — the prior/later audit lives in the footnote aggregates. */
      priorBookings: number;
      /** Unused on the cohort rows (always 0) — see priorBookings. */
      laterBookings: number;
      conv: number | null;
    }[];
    totalLeads: number;
    /** ALL paid wins of the week = current + prior + later + truly unattributed. */
    totalBookings: number;
    /** COHORT conversion (cohort-to-date produced ÷ cohort leads) — the table-consistent total. */
    totalConv: number | null;
    /** Cohort-to-date produced bookings (the table-consistent numerator). */
    totalCurrentBookings: number;
    totalPriorBookings: number;
    totalLaterBookings: number;
    /** Wins with no reliable lead link — the ONLY "Unattributed" meaning. */
    trulyUnattributedBookings: number;
    /** Wins that resolved to a known lead/source. */
    sourceResolvedBookings: number;
    /** sourceResolvedBookings ÷ totalBookings; null when the week had no wins. */
    coverage: number | null;
    best: string | null;
    worst: string | null;
    overlapNote: string | null;
  } | null;
  conversion: { overall: number | null; family: number | null; animalia: number | null; fairyland: number | null };
  /**
   * BOOKINGS FROM LEADS (owner request 2026-09-29; work-date alignment): the
   * week's work-date lead cohort ÷ its cohort-to-date produced bookings —
   * the SAME doctrine as the tab's primary table. pct is null when the week
   * had no cohort leads ("—" is rendered, never a fabricated 0%).
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
  lines.push(`Bookings (Week): ${goalVsActual(input.bookingsWeek.total, input.bookingsWeek.goal)}`);
  lines.push(`Bookings (Month-to-Date, ${monthKeyLabel(input.monthKey)}): ${goalVsActual(input.bookingsMonth.total, input.bookingsMonth.goal)}`);
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
  // LEAD SOURCE PERFORMANCE (owner directive 2026-10-27, SIMPLIFIED; WORK-DATE
  // ALIGNMENT amendment): per source "Leads / Bookings / Conversion %" + a
  // Total row — the SAME lines the Weekly tab's primary table shows. Leads =
  // the source's WORK-DATE cohort for the week; Bookings = those cohort leads
  // that have produced a qualifying paid booking, COUNTED TO DATE (a booking
  // made weeks later still credits the original week); Conversion = Bookings
  // ÷ Leads (strict cohort, numerator and denominator the same cohort).
  // Auditability stays, in ONE compact footnote: the booking-period audit
  // (wins won in the week, prior-period bookings kept under their resolved
  // source — never a numerator, later-period when nonzero, Truly Unattributed
  // (no reliable sheet-lead link — the only "Unattributed" meaning) and
  // attribution coverage); the full three-category breakdown lives on the
  // Weekly tab. Renders ONLY when the page provides the input — the template
  // stays byte-identical otherwise.
  if (input.sourcePerformance) {
    const sp = input.sourcePerformance;
    lines.push("LEAD SOURCE PERFORMANCE (report week):");
    lines.push(
      "Cohort = leads received for this work week (work-date). Bookings = those cohort leads that have produced a qualifying paid booking, counted to date. Conversion = Bookings ÷ Leads.",
    );
    for (const r of sp.rows) {
      if (r.source === "total" || r.source === "unattributed") continue;
      lines.push(
        `${r.label} — Leads: ${formatInt(r.leads)} · Bookings: ${formatInt(r.bookings)} · Conversion: ${r.conv == null ? NO_SOURCE : formatPercent(r.conv, 1)}`,
      );
    }
    lines.push(
      `Total — Leads: ${formatInt(sp.totalLeads)} · Bookings: ${formatInt(sp.totalCurrentBookings)} · Conversion: ${sp.totalConv == null ? NO_SOURCE : formatPercent(sp.totalConv, 1)}`,
    );
    const foot: string[] = [`Booking-period audit: ${formatInt(sp.totalBookings)} wins in week`];
    foot.push(`Prior-period: ${formatInt(sp.totalPriorBookings)}`);
    if (sp.totalLaterBookings > 0) foot.push(`Later-period: ${formatInt(sp.totalLaterBookings)}`);
    foot.push(`No reliable link: ${formatInt(sp.trulyUnattributedBookings)}`);
    if (sp.coverage != null) {
      foot.push(
        `Coverage: ${formatInt(sp.sourceResolvedBookings)}/${formatInt(sp.totalBookings)} (${(sp.coverage * 100).toFixed(2)}%)`,
      );
    }
    lines.push(`${foot.join(" · ")} — detail on the Weekly tab`);
    lines.push("");
  }
  // WORK-DATE ALIGNMENT: the assigned cohort is the week's work-date cohort
  // and the bookings are cohort-to-date produced (credited by lead
  // assignment) — same doctrine as the LEAD SOURCE PERFORMANCE lines above.
  lines.push(
    `Conversion of Assigned Leads: ${formatPercent(input.conversion.overall)} (Family ${formatPercent(input.conversion.family)} · Animalia ${formatPercent(input.conversion.animalia)} · Fairyland ${formatPercent(input.conversion.fairyland)})`,
  );
  // BOOKINGS FROM LEADS (owner request 2026-09-29) — the overall funnel rate
  // right after the assigned-lead conversion; the owner edits it out freely.
  // Zero sheet leads → "—" (never a fabricated 0%).
  lines.push(`Bookings from Leads: ${formatPercent(input.funnel.pct)}`);
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
