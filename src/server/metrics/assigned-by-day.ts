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
 *    family — the splitLeadsByType rule verbatim.
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
import { ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID, type ChannelLeadRow } from "./weekly";
import type { LeadRow } from "./compute";

/** The four grid genres in their fixed display/CSV order. */
export const ASSIGNED_GENRES = ["animalia", "family", "alliance", "auction"] as const;
export type AssignedGenre = (typeof ASSIGNED_GENRES)[number];

/** CSV/display label per genre (the owner's hand-made table wording). */
export const ASSIGNED_GENRE_LABELS: Record<AssignedGenre, string> = {
  animalia: "Animalia",
  family: "Family",
  alliance: "Alliance",
  auction: "Auction",
};

/** One rep × one day cell — all four genres, zero-filled. */
export interface AssignedByDayCell {
  animalia: number;
  family: number;
  alliance: number;
  auction: number;
}

/** One rep row: seven day cells (Mon..Sun) plus the week total per genre. */
export interface AssignedByDayRow {
  rep_id: string;
  rep_name: string;
  days: AssignedByDayCell[]; // 7 entries, index 0 = Monday
  total: AssignedByDayCell;
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

const emptyCell = (): AssignedByDayCell => ({ animalia: 0, family: 0, alliance: 0, auction: 0 });

const addInto = (into: AssignedByDayCell, genre: AssignedGenre, n: number) => {
  into[genre] += n;
};

const isAllZero = (c: AssignedByDayCell): boolean =>
  c.animalia === 0 && c.family === 0 && c.alliance === 0 && c.auction === 0;

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
  for (const l of leads) {
    if (l.assigned_rep_id == null) continue; // unassigned sheet leads are excluded
    const i = dateIndex.get(l.work_date);
    if (i == null) continue; // defensive: store fetch already scopes work dates
    const genre: AssignedGenre = /animalia/i.test(l.lead_type) ? "animalia" : "family";
    addInto(ensureRep(l.assigned_rep_id)[i], genre, 1);
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
    for (const c of cells) {
      total.animalia += c.animalia;
      total.family += c.family;
      total.alliance += c.alliance;
      total.auction += c.auction;
    }
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
  visible.sort((a, b) => {
    const ta = a.total.animalia + a.total.family + a.total.alliance + a.total.auction;
    const tb = b.total.animalia + b.total.family + b.total.alliance + b.total.auction;
    return tb - ta || a.rep_name.localeCompare(b.rep_name) || a.rep_id.localeCompare(b.rep_id);
  });

  // ---- day + week totals ----
  const dayTotals = dates.map(() => emptyCell());
  const weekTotal = emptyCell();
  for (const r of visible) {
    r.days.forEach((c, i) => {
      dayTotals[i].animalia += c.animalia;
      dayTotals[i].family += c.family;
      dayTotals[i].alliance += c.alliance;
      dayTotals[i].auction += c.auction;
    });
    weekTotal.animalia += r.total.animalia;
    weekTotal.family += r.total.family;
    weekTotal.alliance += r.total.alliance;
    weekTotal.auction += r.total.auction;
  }

  return {
    week_start: mon,
    week_end: sun,
    dates,
    rows: visible,
    dayTotals,
    weekTotal,
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
  return `${lines.join("\n")}\n`;
}
