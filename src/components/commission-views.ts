/**
 * COMMISSION VIEWS — pure, DOM-free view compositions for the Commission
 * Center + §26 validation screen (Phase B; drawer-views/reps-views precedent).
 *
 * EVERY number here comes from STORED rows (CommissionWeeklyRow /
 * CommissionCycleRow) or the pure engine's own outputs (WeeklyComputation) —
 * no recomputation, no manual totals (spec §Q). The ONLY engine call is
 * rateCommission() re-run on a stored record's OWN tier + booking count to
 * render the rate-math ANNOTATION (counts × rates); the displayed money is
 * always the stored dollars, and a mismatch between the annotation and the
 * stored money is surfaced as a divergence, never silently reconciled.
 *
 * Honesty rules: missing data renders "—" (null), never 0; unassigned/unknown
 * status literals fall back to neutral chips with the raw label; zero-bookings
 * weeks are a real state (§5 no minimum), not an error.
 */
import {
  formatDateShort,
  addDays,
  mondaysInRange,
  weekdayName,
} from "~/server/date-logic";
import { formatInt, formatMoney } from "~/server/metrics/report-text";
import {
  rateCommission,
  tierRulesFor,
  type CommissionTierNumber,
  type EmploymentType,
} from "~/server/commission/engine";
import { scheduledSlotTimesForDay } from "~/server/commission/derive";
import type {
  CommissionCycleRow,
  CommissionWeeklyRow,
  HoleAuditSnapshot,
} from "~/server/store/types";
import type { ChipKind } from "~/components/today-views";

// ---------- chips (§6 vocabulary; StatusChip kinds only) ----------

export interface ChipView {
  kind: ChipKind;
  label: string;
  /** §6.2 "assigned to current cycle" = neutral chip with a POSITIVE dot. */
  dotOverride?: "positive";
}

const CYCLE_STATUS_LABEL: Record<string, string> = {
  in_progress: "In Progress",
  ready_for_review: "Ready for Review",
  approved: "Approved",
  submitted: "Submitted",
};

/** §6.1 cycle workflow chip — unknown stored values map to neutral, never crash. */
export function cycleChip(status: string | null | undefined): ChipView {
  const label = status == null ? "—" : CYCLE_STATUS_LABEL[status] ?? status;
  const kind: ChipKind =
    status === "ready_for_review"
      ? "risk"
      : status === "approved" || status === "submitted"
        ? "positive"
        : "neutral";
  return { kind, label };
}

/** §6.2 weekly-record assignment chip. */
export function assignmentChip(assignment: string | null | undefined): ChipView {
  if (assignment === "current_cycle") return { kind: "neutral", label: "Assigned to cycle", dotOverride: "positive" };
  if (assignment === "previously_submitted") return { kind: "positive", label: "Previously submitted" };
  if (assignment === "unassigned") return { kind: "neutral", label: "Unassigned" };
  return { kind: "neutral", label: assignment == null ? "—" : String(assignment) };
}

/** §6.4 pool chip — Locked is neutral (no alarm), Unlocked positive. */
export function poolChip(unlocked: boolean | null, teamBookings: number | null): ChipView {
  if (unlocked == null && teamBookings == null) return { kind: "neutral", label: "Pool —" };
  return unlocked ?? (teamBookings ?? 0) >= 79
    ? { kind: "positive", label: "Pool Unlocked" }
    : { kind: "neutral", label: "Pool Locked" };
}

// ---------- labels / ranges ----------

/** "FT" | "PT" from the stored employment_type; null when missing. */
export function employmentAbbr(employmentType: string | null | undefined): string | null {
  if (employmentType === "full_time") return "FT";
  if (employmentType === "part_time") return "PT";
  return null;
}

/** §3.3 tier cell: "FT · T5"; the ineligible row renders "No tier · Ineligible". */
export function tierChipLabel(employmentType: string | null, tier: number | null): string | null {
  const et = employmentAbbr(employmentType);
  if (et == null || tier == null) return null;
  return `${et} · T${tier}`;
}

/** "Aug 31 – Sep 6" (cycle label already carries the year). */
export function shortRange(weekStart: string, weekEnd: string): string {
  return `${formatDateShort(weekStart)} – ${formatDateShort(weekEnd)}`;
}

/** "Mon Oct 5, 2026" — weekday + short date + year. */
export function dateWithWeekday(dateStr: string): string {
  return `${weekdayName(dateStr, false)} ${formatDateShort(dateStr)}, ${dateStr.slice(0, 4)}`;
}

/** The cycle's Mon–Sun weeks, oldest first, from the stored cycle row. */
export function cycleWeekStarts(cycle: CommissionCycleRow | null): string[] {
  if (!cycle) return [];
  try {
    return mondaysInRange(cycle.start_date, cycle.end_date);
  } catch {
    return [];
  }
}

/** W1…Wn index of a week inside the cycle (1-based); null when outside. */
export function weekIndex(cycle: CommissionCycleRow | null, weekStart: string): number | null {
  const weeks = cycleWeekStarts(cycle);
  const i = weeks.indexOf(weekStart);
  return i === -1 ? null : i + 1;
}

/** §3.1 context line: "Cycle Aug 31 – Sep 27, 2026 · 4 weeks · submission Mon Oct 5 · payroll Fri Oct 9 · America/New_York". */
export function cycleContextLine(cycle: CommissionCycleRow | null): string {
  if (!cycle) return "No commission cycle stored yet";
  const weeks = cycleWeekStarts(cycle).length;
  return `Cycle ${cycle.label} · ${weeks} weeks · submission ${dateWithWeekday(cycle.submission_date)} · payroll ${dateWithWeekday(cycle.payroll_date)} · America/New_York`;
}

/** §5.4 cycle identity line (owner §R wording, stored values verbatim). */
export function cycleIdentityLine(cycle: CommissionCycleRow | null): string {
  if (!cycle) return "No commission cycle stored yet";
  return `Commission Cycle: ${cycle.label} · Submission ${dateWithWeekday(cycle.submission_date)} · Payroll Date ${dateWithWeekday(cycle.payroll_date)}`;
}

// ---------- employee × week grid (§3.3) ----------

/** Commission-relevant roster slice (includes ineligible members like Dan McKillop). */
export interface RosterEntry {
  userId: string;
  name: string;
  employmentType: string | null;
  tier: number | null;
  tierEffectiveDate: string | null;
  commissionEligible: boolean;
}

/** One week cell: null = no stored record (honest "—", not clickable, never 0). */
export interface WeekCellView {
  bookings: string;
  money: string;
  /** Visible only when hole money is nonzero — the money source stays readable (§H). */
  holesLine: string | null;
}

export function weekCellView(record: CommissionWeeklyRow | null): WeekCellView | null {
  if (!record) return null;
  const holes = record.hole_bonus ?? 0;
  return {
    bookings: formatInt(record.qualifying_bookings),
    money: formatMoney(record.total),
    holesLine:
      holes > 0
        ? `+${formatMoney(holes)} holes (${formatInt(record.hole_audit?.length ?? 0)})`
        : null,
  };
}

export interface GridRowView {
  userId: string;
  name: string;
  eligible: boolean;
  /** "FT · T5" | "No tier · Ineligible" | null. */
  tierLabel: string | null;
  cells: Array<WeekCellView | null>;
  monthlyBookings: number | null;
  monthlyBonus: number | null;
  status: ChipView;
}

/**
 * Grid rows from the roster + the cycle's stored records. Ranked Monthly Bonus
 * desc → Monthly Bookings desc → name (RankedRepTable convention); ineligible
 * rows sort last (no money to rank). Every week column is parallel to `weeks`.
 */
export function gridRows(roster: RosterEntry[], records: CommissionWeeklyRow[], weeks: string[]): GridRowView[] {
  const byUser = new Map<string, CommissionWeeklyRow[]>();
  for (const r of records) {
    const list = byUser.get(r.user_id);
    if (list) list.push(r);
    else byUser.set(r.user_id, [r]);
  }
  const rows: GridRowView[] = roster.map((emp) => {
    const mine = (byUser.get(emp.userId) ?? []).sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
    const cells = weeks.map((w) => weekCellView(mine.find((r) => r.week_start === w) ?? null));
    const eligible = emp.commissionEligible && emp.tier != null && emp.employmentType != null;
    if (!eligible) {
      return {
        userId: emp.userId,
        name: emp.name,
        eligible,
        tierLabel: null,
        cells: weeks.map(() => null),
        monthlyBookings: null,
        monthlyBonus: null,
        status: { kind: "neutral" as ChipKind, label: "Ineligible" },
      };
    }
    // A missing week record = Partial (e.g. a tier effective mid-cycle); zero
    // records at all renders "—" totals and never a plausible 0.
    const withRecords = mine.filter((r) => weeks.includes(r.week_start));
    const missing = weeks.length - withRecords.length;
    const status: ChipView =
      missing === 0
        ? { kind: "positive", label: "Complete" }
        : { kind: "risk", label: `Partial ${formatInt(withRecords.length)}/${formatInt(weeks.length)}` };
    const monthlyBookings = withRecords.length > 0 ? withRecords.reduce((s, r) => s + r.qualifying_bookings, 0) : null;
    const monthlyBonus = withRecords.length > 0 ? withRecords.reduce((s, r) => s + r.total, 0) : null;
    return {
      userId: emp.userId,
      name: emp.name,
      eligible,
      tierLabel: tierChipLabel(emp.employmentType, emp.tier),
      cells,
      monthlyBookings,
      monthlyBonus,
      status,
    };
  });
  return rows.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible) {
      const bonusDiff = (b.monthlyBonus ?? 0) - (a.monthlyBonus ?? 0);
      if (bonusDiff !== 0) return bonusDiff;
      const bookDiff = (b.monthlyBookings ?? 0) - (a.monthlyBookings ?? 0);
      if (bookDiff !== 0) return bookDiff;
    }
    return a.name.localeCompare(b.name);
  });
}

// ---------- drawer views (§4) ----------

/** "{name} — Week of Aug 31" (drawerHeading convention). */
export function drawerTitle(row: CommissionWeeklyRow): string {
  return `${row.rep_name} — Week of ${formatDateShort(row.week_start)}`;
}

/** Team-week drawer heading (§4.9). */
export function teamDrawerTitle(row: CommissionWeeklyRow): string {
  return `Week of ${formatDateShort(row.week_start)} — team detail`;
}

/**
 * Rate-math annotation for a STORED record: the counts × rates come from
 * re-running the pure engine on the record's own tier + stored booking count;
 * the displayed money is the STORED base/additional. engineMatchesStored
 * flags when the formula no longer reproduces the stored money (amber
 * divergence in the drawer — never silently reconciled).
 */
export interface RateMathView {
  flat: boolean;
  inCount: number;
  appliedRate: number | null;
  threshold: number | null;
  baseMoney: string;
  outCount: number;
  overRate: number | null;
  additionalMoney: string;
  subtotalMoney: string;
  /** The engine's own reproduction of base+additional (annotation for the divergence banner). */
  engineMoney: number;
  engineMatchesStored: boolean;
}

export function rateMathView(row: CommissionWeeklyRow): RateMathView | null {
  const et = employmentAbbr(row.employment_type);
  if (et == null || row.tier == null) return null;
  let breakdown;
  try {
    breakdown = rateCommission(
      row.employment_type as EmploymentType,
      row.tier as CommissionTierNumber,
      row.qualifying_bookings,
    );
  } catch {
    return null; // invalid stored profile — honest gap, never invented math
  }
  const rule = tierRulesFor(row.employment_type as EmploymentType)[row.tier as CommissionTierNumber];
  const storedBaseCents = Math.round((row.base_commission ?? 0) * 100);
  const storedAdditionalCents = Math.round((row.additional_commission ?? 0) * 100);
  const engineMatchesStored =
    breakdown.baseCents === storedBaseCents &&
    (breakdown.additionalCents ?? 0) === storedAdditionalCents;
  return {
    flat: breakdown.appliedOverRate == null,
    inCount: breakdown.inThresholdBookings,
    appliedRate: breakdown.appliedRate,
    threshold: rule.threshold ?? null,
    baseMoney: formatMoney(row.base_commission),
    outCount: breakdown.outThresholdBookings,
    overRate: breakdown.appliedOverRate,
    additionalMoney: formatMoney(row.additional_commission),
    subtotalMoney: formatMoney((row.base_commission ?? 0) + (row.additional_commission ?? 0)),
    engineMoney: (breakdown.baseCents + (breakdown.additionalCents ?? 0)) / 100,
    engineMatchesStored,
  };
}

/** §4.2 rate-math lines (threshold vs flat), money from the STORED record. */
export function rateMathLines(v: RateMathView): string[] {
  if (v.flat) {
    return [`${formatInt(v.inCount)} × ${formatMoney(v.appliedRate)} = ${v.baseMoney}`];
  }
  const lines = [
    `${formatInt(v.inCount)} × ${formatMoney(v.appliedRate)} (first ${formatInt(v.threshold ?? 0)}) = ${v.baseMoney}`,
  ];
  if (v.outCount > 0) {
    lines.push(
      `${formatInt(v.outCount)} × ${formatMoney(v.overRate)} (beyond threshold) = ${v.additionalMoney}`,
    );
  }
  return lines;
}

/** §4.3 79-pool block view — the STORED pool_bonus is the authoritative amount. */
export interface PoolBlockView {
  unlocked: boolean;
  teamBookings: number | null;
  poolTotalMoney: string | null;
  shareLine: string | null;
  bonusMoney: string;
}

export function poolBlockView(row: CommissionWeeklyRow, teamBookings: number | null): PoolBlockView {
  const unlocked = teamBookings != null ? teamBookings >= 79 : (row.pool_bonus ?? 0) > 0;
  const poolTotalMoney = teamBookings != null && unlocked ? formatMoney(teamBookings * 5) : null;
  const shareLine =
    teamBookings != null && unlocked
      ? `Pool ${formatMoney(teamBookings * 5)} · your share ${formatInt(row.qualifying_bookings)}/${formatInt(teamBookings)} × pool = ${formatMoney(row.pool_bonus)}`
      : null;
  return { unlocked, teamBookings, poolTotalMoney, shareLine, bonusMoney: formatMoney(row.pool_bonus) };
}

// 12h clock label ("08:00" → "8:00 AM") for slot audit rows.
function time12h(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m ?? 0).padStart(2, "0")} ${suffix}`;
}

/** §4.4 per-bonus audit row — ALL seven RULING-3 fields presentable. */
export interface HoleRowView {
  rep: string;
  when: string;
  slot: string;
  filledBy: string;
  win: string;
  amount: string;
  week: string;
}

export function holeAuditViews(row: CommissionWeeklyRow): HoleRowView[] {
  return (row.hole_audit ?? []).map((h: HoleAuditSnapshot) => {
    const slots = scheduledSlotTimesForDay(h.slot_date);
    const pos = slots.indexOf(h.slot_time) + 1;
    const who = h.client_name?.trim() ? h.client_name : "(client unavailable)";
    const id = h.acuity_appointment_id ?? h.appointmentId;
    return {
      rep: row.rep_name,
      when: `${formatDateShort(h.appointment_date_et)} · ${time12h(h.appointment_time_et)}`,
      slot: `${weekdayName(h.slot_date, false)} ${time12h(h.slot_time)} — ${h.slot_block} ${pos > 0 ? pos : "?"} (open at week start)`,
      filledBy: `#${id} ${who}`,
      win: `win ${formatDateShort(h.win_date)}`,
      amount: formatMoney(h.bonus_cents / 100),
      week: shortRange(row.week_start, row.week_end),
    };
  });
}

/** §4.7 counted-booking rows, win_date asc then client_name. */
export interface CountedBookingView {
  key: string;
  rep: string;
  client: string;
  type: string;
  sub: string;
  manual: boolean;
}

export function countedBookingViews(row: CommissionWeeklyRow): CountedBookingView[] {
  return [...(row.counted_bookings ?? [])]
    .sort((a, b) => (a.win_date < b.win_date ? -1 : a.win_date > b.win_date ? 1 : (a.client_name ?? "").localeCompare(b.client_name ?? "")))
    .map((c) => ({
      key: c.id,
      rep: row.rep_name,
      client: c.client_name?.trim() ? c.client_name : "(client unavailable)",
      type: c.appointment_type ?? "—",
      sub: `win ${formatDateShort(c.win_date)} (ET) · #${c.acuity_appointment_id ?? c.id}`,
      manual: c.manual === true,
    }));
}

/** §16 reconciliation: the drawer's record count must equal qualifying_bookings. */
export function countedReconciliation(row: CommissionWeeklyRow): { ok: boolean; text: string } {
  const n = row.counted_bookings?.length ?? 0;
  const m = row.qualifying_bookings;
  return n === m
    ? { ok: true, text: `${formatInt(n)} counted records — matches ${formatInt(m)} qualifying bookings.` }
    : {
        ok: false,
        text: `Counted records (${formatInt(n)}) ≠ qualifying bookings (${formatInt(m)}) — investigate before trusting this view.`,
      };
}

/** §4.9 team-week variant: per-employee booking-commission rows for one week (stored). */
export function teamEmployeeViews(
  records: CommissionWeeklyRow[],
  weekStart: string,
): Array<{ name: string; bookings: number; baseAdditional: number }> {
  return records
    .filter((r) => r.week_start === weekStart)
    .map((r) => ({
      name: r.rep_name,
      bookings: r.qualifying_bookings,
      baseAdditional: (r.base_commission ?? 0) + (r.additional_commission ?? 0),
    }))
    .sort((a, b) => b.bookings - a.bookings || a.name.localeCompare(b.name));
}

// ---------- stored cycle rollup (§3.3 footer + §5.4 acceptance table) ----------

export interface StoredRollupEmployee {
  userId: string;
  name: string;
  employmentType: string | null;
  tier: number | null;
  tierEffectiveDateUsed: string | null;
  /** Per-week {bookings, total} parallel to the cycle's weeks — null when that week lacks a record. */
  weeks: Array<{ bookings: number | null; total: number | null }>;
  totalBookings: number | null;
  totalBase: number | null;
  totalPool: number | null;
  totalHoles: number | null;
  totalAdjustments: number | null;
  total: number | null;
}

export interface StoredCycleRollup {
  rows: StoredRollupEmployee[];
  teamBookings: number;
  teamTotal: number;
  teamBase: number;
  teamPool: number;
  teamHoles: number;
  teamAdjustments: number;
  /** Distinct calc_versions across the cycle's records (mixed = surfaced, never hidden). */
  calcVersions: number[];
}

/**
 * Sum STORED weekly records into the cycle rollup (the stored-rows variant of
 * backfill's rollupCycle, which consumes computations). Rows missing for a
 * week stay null in that week's slot — never a zero.
 */
export function rollupStoredCycle(records: CommissionWeeklyRow[], weeks: string[]): StoredCycleRollup {
  const byUser = new Map<string, StoredRollupEmployee>();
  for (const r of records) {
    let row = byUser.get(r.user_id);
    if (!row) {
      row = {
        userId: r.user_id,
        name: r.rep_name,
        employmentType: r.employment_type,
        tier: r.tier,
        tierEffectiveDateUsed: r.tier_effective_date_used,
        weeks: weeks.map(() => ({ bookings: null, total: null })),
        totalBookings: 0,
        totalBase: 0,
        totalPool: 0,
        totalHoles: 0,
        totalAdjustments: 0,
        total: 0,
      };
      byUser.set(r.user_id, row);
    }
    const i = weeks.indexOf(r.week_start);
    if (i >= 0) {
      row.weeks[i] = { bookings: r.qualifying_bookings, total: r.total };
    }
    row.totalBookings = (row.totalBookings ?? 0) + r.qualifying_bookings;
    row.totalBase = (row.totalBase ?? 0) + (r.base_commission + r.additional_commission);
    row.totalPool = (row.totalPool ?? 0) + r.pool_bonus;
    row.totalHoles = (row.totalHoles ?? 0) + r.hole_bonus;
    row.totalAdjustments = (row.totalAdjustments ?? 0) + r.manual_adjustment;
    row.total = (row.total ?? 0) + r.total;
  }
  const rows = [...byUser.values()].sort((a, b) => (b.total ?? 0) - (a.total ?? 0) || a.name.localeCompare(b.name));
  const sum = (pick: (r: CommissionWeeklyRow) => number) => records.reduce((s, r) => s + pick(r), 0);
  return {
    rows,
    teamBookings: sum((r) => r.qualifying_bookings),
    teamTotal: sum((r) => r.total),
    teamBase: sum((r) => r.base_commission + r.additional_commission),
    teamPool: sum((r) => r.pool_bonus),
    teamHoles: sum((r) => r.hole_bonus),
    teamAdjustments: sum((r) => r.manual_adjustment),
    calcVersions: [...new Set(records.map((r) => r.calc_version))].sort((a, b) => a - b),
  };
}

// ---------- cycle composition strip (§3.4) ----------

export interface WeekCardView {
  weekStart: string;
  label: string;
  assignment: ChipView;
  teamBookings: number | null;
  poolUnlocked: boolean | null;
  poolMoney: string | null;
  bonusSum: number | null;
  employeesWithRecords: number;
}

/** One card per cycle week, from the cycle's stored records grouped by week. */
export function compositionWeekCards(records: CommissionWeeklyRow[], weeks: string[]): WeekCardView[] {
  return weeks.map((w, i) => {
    const mine = records.filter((r) => r.week_start === w);
    const teamBookings = mine.length > 0 ? mine.reduce((s, r) => s + r.qualifying_bookings, 0) : null;
    const unlocked = teamBookings != null && teamBookings >= 79;
    return {
      weekStart: w,
      label: `W${i + 1} — ${shortRange(w, addDays(w, 6))}`,
      assignment: assignmentChip(mine[0]?.assignment ?? null),
      teamBookings,
      poolUnlocked: teamBookings == null ? null : unlocked,
      poolMoney: unlocked && teamBookings != null ? formatMoney(teamBookings * 5) : null,
      bonusSum: mine.length > 0 ? mine.reduce((s, r) => s + r.total, 0) : null,
      employeesWithRecords: mine.length,
    };
  });
}

/**
 * RULING 4 default assembly: complete unassigned weeks whose Sunday close
 * ended ≥7 days before the submission Monday ride THIS cycle; the boundary
 * week (e.g. Sep 28 – Oct 4, closing Oct 4) rides the NEXT one. Returns the
 * unassigned records the assembly line should name (the just-closed boundary
 * weeks), oldest first.
 */
export function unassignedRidingNextCycle(
  unassigned: CommissionWeeklyRow[],
  cycle: CommissionCycleRow | null,
): CommissionWeeklyRow[] {
  if (!cycle) return [];
  return unassigned
    .filter((r) => r.week_start > cycle.end_date || addDays(r.week_end, 7) > cycle.submission_date)
    .sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
}

// ---------- estimated in-progress week (§3.5) ----------

export interface EstimatedEmployeeView {
  name: string;
  bookings: number;
  bonusMoney: string | null;
  poolStatus: ChipView;
}

export interface EstimatedWeekView {
  employees: EstimatedEmployeeView[];
  teamBookings: number;
  poolUnlocked: boolean;
}

/** Compose the estimated band from a fresh pure-engine computation (loader-provided). */
export function estimatedWeekView(computation: {
  employees: Array<{ name: string; qualifyingBookings: number; totalCents: number }>;
  teamQualifyingBookings: number;
  poolUnlocked: boolean;
} | null): EstimatedWeekView | null {
  if (!computation) return null;
  return {
    employees: computation.employees.map((e) => ({
      name: e.name,
      bookings: e.qualifyingBookings,
      bonusMoney: formatMoney(Math.round(e.totalCents) / 100),
      poolStatus: poolChip(computation.poolUnlocked, computation.teamQualifyingBookings),
    })),
    teamBookings: computation.teamQualifyingBookings,
    poolUnlocked: computation.poolUnlocked,
  };
}

// ---------- §26 validation screen (§5) ----------

export interface ValidationDelta {
  employee: string;
  field: string;
  stored: string;
  computed: string;
}

export interface StoredVsComputed {
  weekStart: string;
  matches: boolean;
  deltas: ValidationDelta[];
}

/** Field-by-field reconcile of stored records vs a fresh pure-path recompute. */
export function reconcileStoredVsComputed(
  records: CommissionWeeklyRow[],
  computed: {
    weekStart: string;
    employees: Array<{ userId: string; name: string; qualifyingBookings: number; totalCents: number; poolCents: number }>;
    repWins: Array<{ appointmentId: string; userId: string }>;
    holeAudit: Array<{ userId: string; bonus_cents: number }>;
  },
): StoredVsComputed {
  const deltas: ValidationDelta[] = [];
  const forWeek = records.filter((r) => r.week_start === computed.weekStart);
  const storedByUser = new Map(forWeek.map((r) => [r.user_id, r]));
  const computedByUser = new Map(computed.employees.map((e) => [e.userId, e]));
  const userIds = new Set([...storedByUser.keys(), ...computedByUser.keys()]);
  for (const userId of userIds) {
    const stored = storedByUser.get(userId);
    const comp = computedByUser.get(userId);
    const name = stored?.rep_name ?? comp?.name ?? userId;
    if (stored == null || comp == null) {
      deltas.push({
        employee: name,
        field: "record",
        stored: stored == null ? "—" : "record exists",
        computed: comp == null ? "—" : "computed",
      });
      continue;
    }
    if (stored.qualifying_bookings !== comp.qualifyingBookings) {
      deltas.push({ employee: name, field: "qualifying_bookings", stored: formatInt(stored.qualifying_bookings), computed: formatInt(comp.qualifyingBookings) });
    }
    const storedTotal = Math.round(stored.total * 100);
    const computedTotal = Math.round(comp.totalCents);
    if (storedTotal !== computedTotal) {
      deltas.push({ employee: name, field: "total", stored: formatMoney(stored.total), computed: formatMoney(computedTotal / 100) });
    }
    const storedPool = Math.round(stored.pool_bonus * 100);
    const computedPool = Math.round(comp.poolCents);
    if (storedPool !== computedPool) {
      deltas.push({ employee: name, field: "pool_bonus", stored: formatMoney(stored.pool_bonus), computed: formatMoney(computedPool / 100) });
    }
    const storedHoles = Math.round(stored.hole_bonus * 100);
    const computedHoles = computed.holeAudit
      .filter((h) => h.userId === userId)
      .reduce((s, h) => s + Math.round(h.bonus_cents), 0);
    if (storedHoles !== computedHoles) {
      deltas.push({ employee: name, field: "hole_bonus", stored: formatMoney(stored.hole_bonus), computed: formatMoney(computedHoles / 100) });
    }
    const storedIds = stored.counted_bookings.map((c) => c.id).sort().join(",");
    const computedIds = computed.repWins.filter((w) => w.userId === userId).map((w) => w.appointmentId).sort().join(",");
    if (storedIds !== computedIds) {
      deltas.push({
        employee: name,
        field: "counted booking ids",
        stored: `${formatInt(stored.counted_bookings.length)} records`,
        computed: `${formatInt(computed.repWins.filter((w) => w.userId === userId).length)} records`,
      });
    }
  }
  return { weekStart: computed.weekStart, matches: deltas.length === 0, deltas };
}

/** §5.1 provenance banner strings. */
export function provenanceHeadline(written: boolean, recordsWritten: number, calcVersion: number | null): { tone: "neutral" | "risk"; headline: string } {
  if (written) {
    return {
      tone: "neutral",
      headline: `Validation cycle written — ${formatInt(recordsWritten)} weekly records + cycle row (calc v${calcVersion == null ? "?" : formatInt(calcVersion)}).`,
    };
  }
  return {
    tone: "risk",
    headline:
      "Dry-run only — computed numbers below are NOT persisted yet. Run `bun scripts/commission-backfill.ts --write` after reviewing.",
  };
}
