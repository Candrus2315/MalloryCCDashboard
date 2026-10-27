/**
 * WEEKLY REPORT helpers (pure) — the owner's Monday leadership report
 * (owner directive 2026-09-29). ONE page answers "last week + month to date"
 * without hand-pulled SQL.
 *
 * All window math reuses the centralized ET helpers in ../date-logic —
 * no new timezone arithmetic lives here:
 *  - LAST WEEK = the most recent COMPLETED Mon–Sun work week. A Mon–Sun week
 *    is complete only once the next Monday has begun, so on every ET calendar
 *    day the completed week is the one that ended the previous Sunday:
 *    lastCompletedWeekStart = weekStart(today) − 7 days. (On a Sunday the
 *    in-progress week is by definition not complete and the same subtraction
 *    already skips it.)
 *  - MONTH TO DATE = current calendar month start (ET) .. today, matching the
 *    app-wide "This Month" to-date convention (resolveRange "this-month").
 *
 * Booking numbers are BOOKING WINS (deposit-paid) bucketed on
 * booking_win_business_date — the same rev-12 win model every other page
 * counts. Attribution join: booking_attributions → users; manual overrides
 * ARE rep bookings (rep_id set); wins with no attribution rep (engine
 * unattributed/online) count in the TEAM total but NEVER in a rep row
 * (rev-13 rule) — they surface as the separate online/unattributed line.
 */
import { addDays, etDateStrFromInstant, weekStart } from "../date-logic";
import type { AppointmentRow, AttributionRow, LeadRow } from "./compute";
import { bookingWinBusinessDateOf, filterApptsInWinBucketRange, isBookingWin } from "./compute";

/** Session-type split (owner definition): animalia = type contains "animalia" (case-insensitive); everything else family. */
export function isAnimaliaSession(appointmentType: string): boolean {
  return /animalia/i.test(appointmentType ?? "");
}

/**
 * THIRD-GENRE CLASSIFIER (owner directive 2026-10-22): an Acuity appointment
 * type belongs to the Fairyland genre when the type name contains the word
 * "fairyland" (case-insensitive). Same regex convention as isAnimaliaSession;
 * checked AFTER animalia so every existing classification is preserved
 * bit-for-bit — Fairyland is a pure widening, never a re-bucketing.
 */
export function isFairylandSession(appointmentType: string): boolean {
  return /fairyland/i.test(appointmentType ?? "");
}

/**
 * CANONICAL AUCTION-GENRE CLASSIFIER: an Acuity appointment type belongs to
 * the auction genre when the type name contains the channel word
 * "auction" (case-insensitive — live types are e.g. "Auction Portrait
 * Session"). Same convention as isAnimaliaSession and the Alliance/Auction
 * BOOKINGS funnel split below; every consumer (funnel counts, attribution
 * owner rule, retro scripts) MUST use this one function — never an ad-hoc
 * string list.
 */
export function isAuctionSession(appointmentType: string | null | undefined): boolean {
  return /auction/i.test(appointmentType ?? "");
}

/** Monday starting the most recent COMPLETED Mon–Sun work week (see module doc). */
export function lastCompletedWeekStart(today: string): string {
  return addDays(weekStart(today), -7);
}

/** First ET calendar date of the month containing `today` (MTD window start). */
export function monthStartDate(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

/** Family/animalia/fairyland session-type split over booking wins (three genres, no fork). */
export function splitWinsBySessionType(wins: AppointmentRow[]): { family: number; animalia: number; fairyland: number } {
  let family = 0;
  let animalia = 0;
  let fairyland = 0;
  for (const w of wins) {
    if (isAnimaliaSession(w.appointment_type)) animalia += 1;
    else if (isFairylandSession(w.appointment_type)) fairyland += 1;
    else family += 1;
  }
  return { family, animalia, fairyland };
}

/**
 * Paid wins per ET calendar date (booking_win_business_date) — the daily
 * strip of the last-week section. Only dates in `dates` are returned, in
 * order, zero-filled; out-of-window wins are ignored by construction.
 */
export function winsByDate(wins: AppointmentRow[], dates: string[]): Map<string, number> {
  const out = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const w of wins) {
    const d = bookingWinBusinessDateOf(w);
    if (d && out.has(d)) out.set(d, out.get(d)! + 1);
  }
  return out;
}

/** One "by rep" row of the weekly report. Unattributed wins never land here. */
export interface WeeklyRepRow {
  rep_id: string;
  rep_name: string;
  /** Attributed paid wins (manual overrides included — they are rep bookings). */
  total: number;
  /** How many of those were manual overrides (owner rulings) — provenance. */
  manual: number;
}

/** Attribution state of one win: a rep (with manual flag) or unattributed/online. */
export interface WinOwnership {
  repCounts: Map<string, { total: number; manual: number }>;
  /** Wins with NO attribution rep — the online/unattributed line (team total only). */
  unattributed: number;
  /** Rep-attributed subset, for the assigned-lead conversion numerator. */
  repWins: AppointmentRow[];
}

/**
 * Ownership split of paid wins via booking_attributions (rev-13 rule):
 * rep_id set → that rep (manual_override flagged separately); no attribution
 * row or rep_id NULL → unattributed/online — visible, team-total only.
 */
export function splitWinOwnership(wins: AppointmentRow[], attributions: AttributionRow[]): WinOwnership {
  const byAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  const repCounts = new Map<string, { total: number; manual: number }>();
  let unattributed = 0;
  const repWins: AppointmentRow[] = [];
  for (const w of wins) {
    const attr = byAppt.get(w.id);
    if (attr?.rep_id) {
      const cur = repCounts.get(attr.rep_id) ?? { total: 0, manual: 0 };
      cur.total += 1;
      if (attr.manual_override) cur.manual += 1;
      repCounts.set(attr.rep_id, cur);
      repWins.push(w);
    } else {
      unattributed += 1;
    }
  }
  return { repCounts, unattributed, repWins };
}

/** Build the ordered rep rows: name map lookups, largest first; a rep with zero wins still appears. */
export function buildWeeklyRepRows(
  repCounts: Map<string, { total: number; manual: number }>,
  nameById: Map<string, string>,
  rosterIds: string[],
): WeeklyRepRow[] {
  const ids = new Set<string>([...rosterIds, ...repCounts.keys()]);
  const rows: WeeklyRepRow[] = [];
  for (const id of ids) {
    const c = repCounts.get(id);
    rows.push({
      rep_id: id,
      rep_name: nameById.get(id) ?? "Unknown rep",
      total: c?.total ?? 0,
      manual: c?.manual ?? 0,
    });
  }
  return rows.sort((a, b) => b.total - a.total || a.rep_name.localeCompare(b.rep_name));
}

// ---------- PER-DAY × PER-REP WINS GRID (owner request 2026-10-19) ----------

/** One rep row of the per-day wins grid: counts aligned to `dates` (same order), zero-filled. */
export interface WeeklyDayByRepRow {
  rep_id: string;
  rep_name: string;
  /** Paid wins whose DEPOSIT was received on each date of `dates`; 0 where none. */
  counts: number[];
  /** Sum of `counts` — equals the rep's WeeklyRepRow.total (same ownership rule). */
  total: number;
}

/** The per-day (booking_win_business_date) × rep matrix of one Mon–Sun week. */
export interface WeeklyDayByRepGrid {
  /** The week's ET calendar dates (Mon..Sun), in order — Sat/Sun always present. */
  dates: string[];
  /** One row per rep, in `repRows` order (roster + attributed, largest first). */
  reps: WeeklyDayByRepRow[];
  /** Wins with NO attribution rep, per day — team total only, never a rep row (rev-13). */
  unattributed: number[];
  /** ALL wins per day (reps + unattributed) — identical to winsByDate(wins, dates). */
  team: number[];
}

/**
 * Bucket in-window BOOKING WINS by DEPOSIT-PAID ET date (bookingWinBusinessDateOf —
 * Ruling 1/1a) AND attributed rep (booking_attributions, same splitWinOwnership
 * rule) — the per-day × per-rep grid. NO new counting rule: the input `wins` is
 * the same isBookingWin+scope+window set every other figure counts, the bucket
 * is the same win date the daily strip uses, and the ownership split is the
 * same rev-13 join (manual overrides ARE rep bookings; no-rep → unattributed
 * line, team total only). A session HELD Monday whose deposit PAID Saturday
 * buckets under Saturday — the bucket is the deposit date, never the session
 * date. Out-of-window wins are ignored by construction (the date index gates).
 */
export function weeklyDayByRepGrid(
  wins: AppointmentRow[],
  attributions: AttributionRow[],
  dates: string[],
  repRows: WeeklyRepRow[],
): WeeklyDayByRepGrid {
  const idxOf = new Map(dates.map((d, i) => [d, i]));
  const byAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  const rows: WeeklyDayByRepRow[] = repRows.map((r) => ({
    rep_id: r.rep_id,
    rep_name: r.rep_name,
    counts: dates.map(() => 0),
    total: 0,
  }));
  const rowByRep = new Map(rows.map((r) => [r.rep_id, r]));
  const unattributed = dates.map(() => 0);
  const team = dates.map(() => 0);
  for (const w of wins) {
    const d = bookingWinBusinessDateOf(w);
    const i = d ? idxOf.get(d) : undefined;
    if (i == null) continue; // not one of the grid's dates — out by construction
    team[i] += 1;
    const repId = byAppt.get(w.id)?.rep_id;
    if (repId) {
      const row = rowByRep.get(repId);
      if (row) {
        row.counts[i] += 1;
        row.total += 1;
      }
    } else {
      unattributed[i] += 1;
    }
  }
  return { dates, reps: rows, unattributed, team };
}

/** Conversion rate; null when the denominator is 0 (never a fabricated 0%). */
export function conversionRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Assigned-lead conversion denominator rows: leads whose SOURCE_DATE falls in
 * [start, end] with an assigned rep. The weekly report converts the week's
 * lead cohorts (source-dated) against the wins attributed that week —
 * different from the work-date cohort the operational pages use, and labeled
 * as such in the UI.
 */
export function assignedLeadsInRange(leads: LeadRow[], start: string, end: string): LeadRow[] {
  return leads.filter((l) => l.source_date >= start && l.source_date <= end && l.assigned_rep_id != null);
}

/**
 * Per-SOURCE lead counts over the fetched lead rows (no date filter — callers
 * pass the window). Seven sources since the 10/27 form-workbook directive:
 * the three genre sheets classify by lead_type text with the SHEET-IDENTITY
 * FALLBACK for Fairyland (/animalia/i → animalia; /fairyland/i → fairyland;
 * OR the row was ingested from the fairyland sheet → fairyland; else family —
 * the Fairyland sheet's Campaign Name column says "Fairies", which
 * /fairyland/i never matches, so without the fallback every genuine
 * Fairyland-sheet lead silently counted as Family); the four "Forms Data"
 * workbook sheets classify by SHEET IDENTITY — their lead_type text
 * ("Family"/"Pet" project names on the Google Ads tab) is never a genre vote,
 * so genre counts stay byte-identical to their pre-forms behavior.
 * `total` is the combined lead count (all seven sources).
 */
export function splitLeadsByType(leads: LeadRow[]): {
  family: number; animalia: number; fairyland: number;
  auction_register_certificate: number; google_ads_leads: number;
  alliance_activate_certificate: number; website_applications: number;
  total: number;
} {
  let family = 0;
  let animalia = 0;
  let fairyland = 0;
  let auction_register_certificate = 0;
  let google_ads_leads = 0;
  let alliance_activate_certificate = 0;
  let website_applications = 0;
  for (const l of leads) {
    if (l.source_sheet === "auction_register_certificate") { auction_register_certificate += 1; continue; }
    if (l.source_sheet === "google_ads_leads") { google_ads_leads += 1; continue; }
    if (l.source_sheet === "alliance_activate_certificate") { alliance_activate_certificate += 1; continue; }
    if (l.source_sheet === "website_applications") { website_applications += 1; continue; }
    if (/animalia/i.test(l.lead_type)) animalia += 1;
    // SHEET-IDENTITY FALLBACK (owner directive 2026-10-27, item 4): a lead
    // ingested from the fairyland SHEET is fairyland even when its lead_type
    // text ("Fairies" — the sheet's Campaign Name) doesn't contain
    // "fairyland". Same convention summarizeLeadRows/assigned-by-day already
    // use; text-first order keeps animalia/family outcomes byte-identical.
    else if (/fairyland/i.test(l.lead_type) || l.source_sheet === "fairyland") fairyland += 1;
    else family += 1;
  }
  return {
    family, animalia, fairyland,
    auction_register_certificate, google_ads_leads, alliance_activate_certificate, website_applications,
    total: leads.length,
  };
}

/** Format "X/Goal (±N)" — the weekly bookings-vs-goal string (−/±/+, goal "—" when unset). */
export function goalVsActual(actual: number, goal: number | null): string {
  if (goal == null) return `${actual}/—`;
  const diff = actual - goal;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  return `${actual}/${goal} (${sign}${Math.abs(diff)})`;
}

// ---------- MONTHLY BOOKING GOAL (owner-approved 2026-09-29) ----------
// Month keys are ET calendar months 'YYYY-MM'. Months NEVER inherit each
// other's goals (October does not inherit September's 316) — resolution is
// always by exact key.

/**
 * Shift a 'YYYY-MM' month key by n months, clamping the day away by
 * construction (no Date object — pure string arithmetic, no timezone edges).
 * "2026-12" + 1 → "2027-01"; "2026-01" − 1 → "2025-12".
 */
export function addMonthsKey(month: string, n: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!m) return month;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const total = y * 12 + (mo - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/** "2026-09" → "September 2026" (display label for Settings/MTD; unparsable keys pass through). */
export function monthKeyLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!m) return month;
  const label = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)),
  );
  return `${label} ${m[1]}`;
}

/** The 'YYYY-MM' ET calendar month containing `today` (matches monthStartDate's bucket). */
export function monthKeyOf(today: string): string {
  return today.slice(0, 7);
}

// ---------- CC REPORT channel split (owner template, 2026-09-29) ----------

/**
 * Alliance/Auction/Website BOOKINGS of the report week: paid wins whose Acuity
 * appointment_type contains the channel word (case-insensitive — live types
 * are "Alliance Portrait Session + 20\" Portrait", "Auction Animalia Session…").
 * Independent counters (a type matching both words would count in both);
 * Website is deliberately NOT computed here — no "Website" booking type exists
 * in Acuity, and inventing a bucket from "everything else" would be wrong.
 */
export function splitWinsByChannel(wins: AppointmentRow[]): { alliance: number; auction: number } {
  let alliance = 0;
  let auction = 0;
  for (const w of wins) {
    if (/alliance/i.test(w.appointment_type ?? "")) alliance += 1;
    if (isAuctionSession(w.appointment_type)) auction += 1;
  }
  return { alliance, auction };
}

// ---------- ALLIANCE/AUCTION LEADS (owner-verified 2026-09-29: they live in GHL opportunities) ----------

/**
 * The GHL pipeline ids for the two outreach channels, verified live against
 * GET /opportunities/pipelines on 2026-09-29 (names: "Alliance Booking Calls",
 * "Auction Booking Calls"). Opportunities synced from these pipelines ARE the
 * channels' leads — created-date bucketing below feeds the Weekly page and the
 * CC Report. Hardcoded ids, never guessed: the pipeline list is fetched/verified
 * in scratch/probe-opp-pages.ts and the ids are stable GHL identifiers.
 */
export const ALLIANCE_PIPELINE_ID = "lBNmeGNAJQxs29XPRpJW";
export const AUCTION_PIPELINE_ID = "BWTfoJF6nfoFgUT1EBpP";

/** Minimal shape of a synced GHL opportunity row this counter needs. */
export interface ChannelLeadRow {
  pipeline_id: string | null;
  source_created_at: string | null;
}

/**
 * Alliance/Auction LEADS of one Mon–Sun week: opportunities on the channel
 * pipelines whose CREATED timestamp (source_created_at) falls in [weekStart,
 * weekEnd] by ET calendar date — the same America/New_York bucketing every
 * other weekly figure uses. Every opportunity on the pipeline counts (open,
 * won, lost, abandoned — a lead is a lead however it later resolved);
 * independent counters; website stays null (no synced source — never invented).
 */
export function splitChannelLeads(
  opps: ChannelLeadRow[],
  mon: string,
  sun: string,
): { alliance: number; auction: number; website: number | null } {
  let alliance = 0;
  let auction = 0;
  for (const o of opps) {
    if (!o.source_created_at) continue;
    const ms = Date.parse(o.source_created_at);
    if (!Number.isFinite(ms)) continue; // unparsable created time — never guessed
    const d = etDateStrFromInstant(ms);
    if (d < mon || d > sun) continue;
    if (o.pipeline_id === ALLIANCE_PIPELINE_ID) alliance += 1;
    if (o.pipeline_id === AUCTION_PIPELINE_ID) auction += 1;
  }
  return { alliance, auction, website: null };
}

// ---------- BOOKINGS FROM LEADS funnel (owner request 2026-09-29) ----------

/** Weeks in the "recent weeks" funnel strip (the owner's 5-week view). */
export const FUNNEL_SERIES_WEEKS = 5;

/**
 * Mondays of the last N COMPLETED Mon–Sun work weeks, OLDEST first. The
 * in-progress week is NEVER in the series — its funnel % is meaningless
 * mid-week (a Mon–Sun week completes only when the next Monday has begun,
 * the same rule as lastCompletedWeekStart, which this builds on).
 */
export function recentCompletedWeekStarts(today: string, count: number = FUNNEL_SERIES_WEEKS): string[] {
  const latest = lastCompletedWeekStart(today);
  return Array.from({ length: count }, (_, i) => addDays(latest, -7 * (count - 1 - i)));
}

/** One "bookings from leads" row: sheet leads vs paid bookings of one Mon–Sun week. */
export interface WeekFunnelRow {
  weekStart: string;
  weekEnd: string;
  /** Sheet leads whose source_date falls in the week — ALL sheets, no rep filter. */
  leads: number;
  /** Paid bookings whose booking_win_business_date falls in the week — ALL bookings incl. online/unattributed. */
  wins: number;
  /** wins ÷ leads; null when the week had no sheet leads (never a fabricated 0%). */
  pct: number | null;
}

/**
 * Bucket in-scope BOOKING WINS + sheet leads into Mon–Sun weeks.
 * Wins are bucketed with the SAME win-bucket filter every page counts
 * (filterApptsInWinBucketRange — win date, created-date fallback for legacy
 * paid rows); leads by source_date, the funnel's sheet-date convention.
 * Callers pass wins already filtered to isBookingWin + scope over the SERIES
 * window — sub-window filtering of that set is lossless.
 * READ-ONLY: pure bucketing over rows the caller already fetched.
 */
export function weekFunnelRows(weekStarts: string[], wins: AppointmentRow[], leads: LeadRow[]): WeekFunnelRow[] {
  return weekStarts.map((mon) => {
    const sun = addDays(mon, 6);
    const weekWins = filterApptsInWinBucketRange(wins, mon, sun).length;
    const weekLeads = leads.filter((l) => l.source_date >= mon && l.source_date <= sun).length;
    return { weekStart: mon, weekEnd: sun, leads: weekLeads, wins: weekWins, pct: conversionRate(weekWins, weekLeads) };
  });
}

/**
 * The owner's CC Report narrative sections, in the owner's template order.
 * Keys are the STABLE persistence ids (weekly_report_notes jsonb keys +
 * manual_overrides field names) — never rename, only append.
 */
export const WEEKLY_CC_SECTIONS: { key: string; label: string }[] = [
  { key: "department_updates", label: "Department Updates" },
  { key: "big3", label: "Big 3" },
  { key: "big3_followup", label: "Update on Last Week's Big Three" },
  { key: "celebrate", label: "Celebrate / Top Performer" },
  { key: "culture", label: "Company Culture / Team Building" },
  { key: "escalations", label: "Escalations" },
  { key: "customer_service", label: "Customer Service" },
  { key: "recruitment", label: "Recruitment / Training" },
  { key: "roadblocks", label: "Roadblocks / Support Needed" },
  { key: "leadership_learning", label: "Leadership Learning" },
];

/** Auto-fill text for the Celebrate line — the week's computed top performer (still editable). */
export function celebrateDefaultLine(top: { repName: string; total: number } | null): string | null {
  if (!top) return null;
  return `${top.repName} — ${top.total} paid bookings`;
}
