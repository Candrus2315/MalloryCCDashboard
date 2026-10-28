/**
 * ASSIGNED LEADS BY DAY (owner directive 2026-10-01) — the Reps-page grid the
 * owner currently assembles by hand every week: one row per rep, one column
 * per ET day of a Mon–Sun week, each cell split by genre.
 *
 * NO NEW MATH — two existing verified sources, joined per rep × day:
 *  - SHEET LEADS: rows the store returns for the week's WORK DATES
 *    (getLeadsByWorkDates — the ET work-date cohort every operational page
 *    uses) with an assigned rep. Unassigned sheet leads are EXCLUDED (owner:
 *    ASSIGNED leads only). Genre: /animalia/i → animalia, everything else
 *    family — the splitLeadsByType rule verbatim. The four FORM-WORKBOOK
 *    sources (10/27) are excluded from the genre columns (never guessed into
 *    Family) and surfaced in the warnings line — per-source counts live on
 *    the Weekly breakdown.
 *  - ALLIANCE/AUCTION: GHL opportunities on the channel pipelines (owner-
 *    verified 2026-09-29 ids), bucketed by the ET calendar date of
 *    source_created_at — the EXACT splitChannelLeads semantics (every
 *    opportunity counts regardless of status; unparsable created time never
 *    guessed into a day). The owner of an opportunity is its rep_id (join
 *    users for the name) — never hardcoded to any rep.
 *
 * Pure module: no store, no clock — the caller passes fetched rows. Both the
 * page-data builder (server) and the CSV serializer (client button) consume
 * the same grid, so the download can never disagree with the table.
 */
import { addDays, etDateStrFromInstant, weekdayName } from "../date-logic";
import { FORM_SOURCE_SHEETS, isFormSourceSheet, LEAD_SOURCE_LABELS, type FormSourceSheet } from "../../components/lead-sources";
import { ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID, type ChannelLeadRow } from "./weekly";
import type { LeadRow } from "./compute";

/** The grid genres in their fixed display/CSV order (Fairyland appends LAST — owner directive 2026-10-22). */
export const ASSIGNED_GENRES = ["animalia", "family", "alliance", "auction", "fairyland"] as const;
export type AssignedGenre = (typeof ASSIGNED_GENRES)[number];

/** CSV/display label per genre (the owner's hand-made table wording). */
export const ASSIGNED_GENRE_LABELS: Record<AssignedGenre, string> = {
  animalia: "Animalia",
  family: "Family",
  alliance: "Alliance",
  auction: "Auction",
  fairyland: "Fairyland",
};

/**
 * Stable machine key the CSV `genre` column holds for each FORM-WORKBOOK
 * source (they have no session genre — never guessed into Family, and distinct
 * from the Alliance/Auction CHANNEL buckets "Alliance"/"Auction"). Explained
 * in the grid InfoTip so the export stays machine-readable end to end.
 */
export const FORM_CSV_GENRE: Record<FormSourceSheet, string> = {
  auction_register_certificate: "auction_certificate",
  google_ads_leads: "google_ads",
  alliance_activate_certificate: "alliance_certificate",
  website_applications: "website",
};

/** One rep × one day cell — all five genres, zero-filled. */
export interface AssignedByDayCell {
  animalia: number;
  family: number;
  alliance: number;
  auction: number;
  fairyland: number;
}

/** One rep row: seven day cells (Mon..Sun) plus the week total per genre. */
export interface AssignedByDayRow {
  rep_id: string;
  rep_name: string;
  days: AssignedByDayCell[]; // 7 entries, index 0 = Monday
  total: AssignedByDayCell;
}

/**
 * ONE FORM-SOURCE TEAM ROW (owner directive 2026-10-27 — propagation): form
 * leads have NO rep (owner rule: sheet leads → team totals, never rep
 * metrics), so they cannot land in a rep × day cell — but the grid must still
 * account for them or its totals silently miss four live sources. One row per
 * form source, per-day counts over the SAME work-date cohort (same bucketing
 * as every cell), team-level, labeled "(no rep)" everywhere it renders.
 */
export interface AssignedByDayFormRow {
  source: FormSourceSheet;
  /** The source's display label (LEAD_SOURCE_LABELS — the owner's own tab names). */
  label: string;
  days: number[]; // 7 entries, index 0 = Monday
  total: number;
}

/** The whole week's grid plus day/week totals and honesty warnings. */
export interface AssignedByDayGrid {
  week_start: string;
  week_end: string;
  /** The seven ET dates Mon..Sun. */
  dates: string[];
  rows: AssignedByDayRow[];
  /** Sum across all reps per day (same index order as dates). */
  dayTotals: AssignedByDayCell[];
  /** Sum across all reps and days. */
  weekTotal: AssignedByDayCell;
  /** The four form-workbook sources as labeled TEAM rows (never rep cells). */
  formSources: AssignedByDayFormRow[];
  /** Combined form-source leads per day (sum of formSources) — one glanceable line. */
  formTotals: number[];
  /** Missing-ownership notes — data that exists but cannot land in a row is never silently dropped. */
  warnings: string[];
}

/** An opportunity row shape this counter needs (OpportunityRow satisfies it). */
export type ChannelOppOwnerRow = ChannelLeadRow & { rep_id: string | null };

export interface AssignedByDayInput {
  /** Sheet-lead rows for the week's work dates (getLeadsByWorkDates output). */
  leads: LeadRow[];
  /** Opportunities already filtered to the two channel pipelines. */
  opps: ChannelOppOwnerRow[];
  /** Active roster reps (getUsers) — zero weeks still render their row. */
  rosterReps: { id: string; name: string }[];
  /** ALL users by id (getAllUsers) — names data-owning reps off the roster. */
  nameById: Map<string, string>;
  mon: string;
  sun: string;
}

const emptyCell = (): AssignedByDayCell => ({ animalia: 0, family: 0, alliance: 0, auction: 0, fairyland: 0 });

const addInto = (into: AssignedByDayCell, genre: AssignedGenre, n: number) => {
  into[genre] += n;
};

const isAllZero = (c: AssignedByDayCell): boolean => ASSIGNED_GENRES.every((g) => c[g] === 0);

const addCellInto = (into: AssignedByDayCell, from: AssignedByDayCell) => {
  for (const g of ASSIGNED_GENRES) into[g] += from[g];
};

const cellTotal = (c: AssignedByDayCell): number => ASSIGNED_GENRES.reduce((n, g) => n + c[g], 0);

/**
 * Build the assigned-leads-by-day grid. Deterministic: rows sort by week
 * total (all genres) descending then name — the app's largest-first "by rep"
 * convention. Roster reps keep a zero row; an off-roster rep appears only
 * when the week's data actually names them.
 */
export function buildAssignedLeadsByDay(input: AssignedByDayInput): AssignedByDayGrid {
  const { leads, opps, rosterReps, nameById, mon, sun } = input;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const dateIndex = new Map(dates.map((d, i) => [d, i] as const));

  const warnings: string[] = [];

  // rep_id → row cells; roster reps seeded first (zero rows are kept).
  const cellByRep = new Map<string, AssignedByDayCell[]>();
  const order: string[] = [];
  const ensureRep = (repId: string): AssignedByDayCell[] => {
    let cells = cellByRep.get(repId);
    if (!cells) {
      cells = dates.map(() => emptyCell());
      cellByRep.set(repId, cells);
      order.push(repId);
    }
    return cells;
  };
  for (const r of rosterReps) ensureRep(r.id);

  // ---- sheet leads (ASSIGNED only — the owner's definition) ----
  let formSourceAssigned = 0;
  // FORM-SOURCE TEAM ROWS: per-source per-day counts over the SAME cohort —
  // ALL form leads in the cohort count here (they have no rep by definition;
  // counting only the assigned subset would understate the team row).
  const formBySource = new Map<FormSourceSheet, number[]>(FORM_SOURCE_SHEETS.map((s) => [s, dates.map(() => 0)]));
  for (const l of leads) {
    if (isFormSourceSheet(l.source_sheet)) {
      const i = dateIndex.get(l.work_date);
      if (i != null) formBySource.get(l.source_sheet as FormSourceSheet)![i] += 1;
      if (l.assigned_rep_id != null) formSourceAssigned += 1;
      continue; // never a rep cell — form leads are team totals (owner rule)
    }
    if (l.assigned_rep_id == null) continue; // unassigned sheet leads are excluded
    const i = dateIndex.get(l.work_date);
    if (i == null) continue; // defensive: store fetch already scopes work dates
    // SHEET-IDENTITY FALLBACK (Fairyland wiring): a lead ingested from the
    // fairyland SHEET is fairyland even when its lead_type text doesn't
    // contain "fairyland". Text-first order keeps animalia/family outcomes
    // exactly as before.
    const genre: AssignedGenre = /animalia/i.test(l.lead_type)
      ? "animalia"
      : (/fairyland/i.test(l.lead_type) || l.source_sheet === "fairyland")
        ? "fairyland"
        : "family";
    addInto(ensureRep(l.assigned_rep_id)[i], genre, 1);
  }
  const formSources: AssignedByDayFormRow[] = FORM_SOURCE_SHEETS.map((s) => {
    const days = formBySource.get(s)!;
    return { source: s, label: LEAD_SOURCE_LABELS[s], days, total: days.reduce((n, x) => n + x, 0) };
  });
  const formTotals = dates.map((_, i) => formSources.reduce((n, f) => n + f.days[i], 0));
  if (formSourceAssigned > 0) {
    warnings.push(
      `${formSourceAssigned} form-workbook lead${formSourceAssigned === 1 ? "" : "s"} (Auction/Alliance certificates, Google Ads, Website) ${
        formSourceAssigned === 1 ? "carries" : "carry"
      } a rep assignment — still excluded from rep cells (form leads are team totals) and counted in the form-source team rows below.`,
    );
  }

  // ---- Alliance/Auction channel leads (per-rep, per-day) ----
  let unownedChannel = 0;
  let unparsableChannel = 0;
  for (const o of opps) {
    if (o.pipeline_id !== ALLIANCE_PIPELINE_ID && o.pipeline_id !== AUCTION_PIPELINE_ID) continue;
    if (!o.source_created_at) {
      unparsableChannel += 1;
      continue; // splitChannelLeads semantics: no parsable created time → no day, never guessed
    }
    const ms = Date.parse(o.source_created_at);
    if (!Number.isFinite(ms)) {
      unparsableChannel += 1;
      continue;
    }
    const d = etDateStrFromInstant(ms);
    const i = dateIndex.get(d);
    if (i == null) continue; // outside the picked week
    const genre: AssignedGenre = o.pipeline_id === ALLIANCE_PIPELINE_ID ? "alliance" : "auction";
    if (o.rep_id == null) {
      unownedChannel += 1;
      continue; // visible as a warning below — never silently dropped
    }
    addInto(ensureRep(o.rep_id)[i], genre, 1);
  }
  if (unownedChannel > 0) {
    warnings.push(
      `${unownedChannel} Alliance/Auction lead${unownedChannel === 1 ? "" : "s"} this week ${
        unownedChannel === 1 ? "has" : "have"
      } no owning rep in HighLevel — not shown in any rep row.`,
    );
  }
  if (unparsableChannel > 0) {
    warnings.push(
      `${unparsableChannel} Alliance/Auction opportunit${unparsableChannel === 1 ? "y has" : "ies have"} no parsable created time — bucketed nowhere rather than guessed.`,
    );
  }

  // ---- rows: names, week totals, sort (total desc, name asc) ----
  const rows: AssignedByDayRow[] = order.map((repId) => {
    const cells = cellByRep.get(repId)!;
    const total = emptyCell();
    for (const c of cells) addCellInto(total, c);
    return {
      rep_id: repId,
      rep_name: nameById.get(repId) ?? "Unknown rep",
      days: cells,
      total,
    };
  });
  // Off-roster reps with an entirely empty week carry no information — drop them
  // (a roster rep's zero row stays: "one row per roster rep").
  const rosterIds = new Set(rosterReps.map((r) => r.id));
  const visible = rows.filter((r) => rosterIds.has(r.rep_id) || !isAllZero(r.total));
  visible.sort((a, b) => cellTotal(b.total) - cellTotal(a.total) || a.rep_name.localeCompare(b.rep_name) || a.rep_id.localeCompare(b.rep_id));

  // ---- day + week totals ----
  const dayTotals = dates.map(() => emptyCell());
  const weekTotal = emptyCell();
  for (const r of visible) {
    r.days.forEach((c, i) => addCellInto(dayTotals[i], c));
    addCellInto(weekTotal, r.total);
  }

  return {
    week_start: mon,
    week_end: sun,
    dates,
    rows: visible,
    dayTotals,
    weekTotal,
    formSources,
    formTotals,
    warnings,
  };
}

/** CSV-quote one field (RFC 4180: wrap when needed, double inner quotes). */
function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** "2026-09-21 Mon" — the shared CSV files' day label format. */
export function assignedByDayLabel(date: string): string {
  return `${date} ${weekdayName(date, false)}`;
}

/**
 * Client-side CSV for the download button — the SAME schema as the owner's
 * shared files: header `rep,day,genre,assigned_leads`, one row per rep × day
 * × genre in day order (Mon..Sun) then fixed genre order; zero cells are
 * omitted (the owner's files list only non-zero counts). Deterministic.
 *
 * FORM-WORKBOOK SOURCES (owner directive 2026-10-27; machine keys 2026-10-28):
 * after the rep rows, one row per form source × day with a non-zero count, rep
 * labeled "(no rep — team total)" — form leads have no rep, and the export must
 * account for all seven sources, not just the five genre/channel buckets. The
 * `genre` column holds FORM_CSV_GENRE keys (auction_certificate, google_ads,
 * alliance_certificate, website) — stable snake_case, never a display label.
 */
export function assignedLeadsCsv(grid: AssignedByDayGrid): string {
  const lines: string[] = ["rep,day,genre,assigned_leads"];
  for (const row of grid.rows) {
    row.days.forEach((cell, i) => {
      const day = assignedByDayLabel(grid.dates[i]);
      for (const genre of ASSIGNED_GENRES) {
        const n = cell[genre];
        if (n > 0) lines.push(`${csvField(row.rep_name)},${csvField(day)},${ASSIGNED_GENRE_LABELS[genre]},${n}`);
      }
    });
  }
  const FORM_TEAM_REP = "(no rep — team total)";
  for (const f of grid.formSources) {
    f.days.forEach((n, i) => {
      if (n > 0) lines.push(`${csvField(FORM_TEAM_REP)},${csvField(assignedByDayLabel(grid.dates[i]))},${csvField(FORM_CSV_GENRE[f.source])},${n}`);
    });
  }
  return `${lines.join("\n")}\n`;
}
