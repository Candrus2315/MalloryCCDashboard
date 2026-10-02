/**
 * COMMISSION DERIVATION — pure transforms from STORED rows to the engine's
 * inputs (owner directive 2026-10-01; interpretation notes 1–3).
 *
 * NO DATABASE IMPORTS and NO SECOND CALCULATION ENGINE: qualifying bookings
 * ARE the existing Booking Wins (paid-deposit rule) bucketed by
 * booking_win_business_date, joined to the EXISTING booking_attributions
 * verdicts — the same `isBookingWin` / `filterApptsInWinBucketRange` /
 * `attributionStateOf` machinery every other page counts. Nothing here
 * re-derives payment state, win dates, or attribution.
 *
 * Interpretation note 1 (qualifying booking) = OWNER RULING 1 (confirmed
 *   10/1): a rep-attributed Booking Win — paid deposit evidence, attribution
 *   verdict in {attributed, manually-assigned} (rep_id set on the stored row;
 *   ambiguous/unattributed/without-verdict never pay a rep), win ET date
 *   inside the Mon–Sun week, cancelled + out-of-scope (Zoom) excluded (Zoom
 *   bookings never receive an attribution verdict, and unpaid rows never pass
 *   isBookingWin).
 * OWNER RULING 2 (79-pool): rep-attributed CC Booking Wins only — threshold,
 *   funding AND allocation. Online/unattributed/ambiguous/non-CC bookings
 *   never count toward 79, never fund, never receive allocation.
 * OWNER RULING 3 (filled hole, NARROW — the earlier "day under capacity"
 *   default is REJECTED as too broad): a qualifying filled hole is a SPECIFIC
 *   previously-OPEN studio appointment slot of the CURRENT week, subsequently
 *   FILLED during that same week by a rep-attributed paid-deposit CC Booking
 *   Win. Slot state is evaluated at week start (Monday 00:00 ET) against the
 *   derived schedule (10 slots/day, 9 on Tuesday — see scheduledSlotTimesForDay).
 *   Slots already filled when the week began were never holes of that week;
 *   a cancelled-then-rebooked slot was not open at week start either (the
 *   pre-existing record blocks the hole — conservative, never pays a false $10).
 */
import { etDateStrFromInstant, addDays, weekday } from "../date-logic";
import type { AppointmentRow, AttributionRow } from "../metrics/compute";
import { attributionStateOf, createdBusinessDateOf, filterApptsInWinBucketRange, isBookingWin } from "../metrics/compute";
import type { UserRow } from "../store/types";
import {
  HOLE_BONUS_CENTS,
  HOLE_BONUS_MAX_OPEN_SLOTS,
  holeBonusCents,
  poolBonusCents,
  rateCommission,
  type CommissionEmployeeInput,
  type CommissionTierNumber,
  type EmploymentType,
  type EmployeeWeeklyCommission,
} from "./engine";

/** Commission-relevant slice of a stored rep row (already eligibility-gated). */
export function commissionEmployeeOf(user: UserRow): CommissionEmployeeInput | null {
  if (!user.commission_eligible) return null;
  if (user.commission_tier == null || user.employment_type == null) return null;
  const tier = user.commission_tier as CommissionTierNumber;
  if (tier < 1 || tier > 5) return null;
  if (user.employment_type !== "full_time" && user.employment_type !== "part_time") return null;
  return {
    userId: user.id,
    name: user.name,
    employmentType: user.employment_type as EmploymentType,
    tier,
    tierEffectiveDate: user.tier_effective_date ?? null,
  };
}

/**
 * §B "each week uses the tier held during that week": the CURRENT profile
 * governs a week only when the week overlaps [tier_effective_date,
 * tier_end_date]. Null = the tier does not apply that week (the employee is
 * skipped for it — never silently re-tiered). Phase A stores one profile per
 * rep; a future phase can add tier history rows for mid-window changes.
 */
export function tierHeldForWeek(
  employee: CommissionEmployeeInput,
  weekStart: string,
  weekEnd: string,
): CommissionEmployeeInput | null {
  if (employee.tierEffectiveDate != null && employee.tierEffectiveDate > weekEnd) return null;
  return employee;
}

/** One rep-owned qualifying win (the commission-counted record). */
export interface RepWin {
  appointmentId: string;
  userId: string;
  /** booking_win_business_date (ET) — the date the deposit was received. */
  winDate: string;
  manual: boolean;
  acuity_appointment_id?: string | null;
  client_name?: string | null;
  appointment_type?: string | null;
  /** The session's exact start instant (ISO UTC) — matches the slot it occupies. */
  appointmentDatetime: string;
}

/**
 * The week's rep-attributed qualifying wins (interpretation note 1). Wins with
 * NO stored verdict row (withoutVerdict) are excluded — they are honest gaps,
 * never rep credit; the audit surfaces them elsewhere.
 */
export function qualifyingRepWinsForWeek(
  appts: AppointmentRow[],
  attributions: AttributionRow[],
  weekStart: string,
  weekEnd: string,
): RepWin[] {
  const wins = filterApptsInWinBucketRange(appts, weekStart, weekEnd).filter((a) => isBookingWin(a));
  const byAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  const out: RepWin[] = [];
  for (const w of wins) {
    const attr = byAppt.get(w.id);
    if (!attr) continue; // no verdict — never guessed into rep credit
    if (attributionStateOf(attr) !== "attributed") continue; // ambiguous/unattributed excluded
    if (attr.rep_id == null) continue; // defensive (state says attributed ⇒ rep set)
    out.push({
      appointmentId: w.id,
      userId: attr.rep_id,
      winDate: bookingWinDateOf(w, weekStart, weekEnd) as string,
      manual: attr.manual_override,
      acuity_appointment_id: w.acuity_appointment_id ?? null,
      client_name: (w as { client_name?: string | null }).client_name ?? null,
      appointment_type: w.appointment_type ?? null,
      appointmentDatetime: w.appointment_datetime,
    });
  }
  return out;
}

/** The in-week win date of an already win-bucketed paid appointment (the SAME fallback chain filterApptsInWinBucketRange applies — one derivation, never re-invented). */
function bookingWinDateOf(a: AppointmentRow, weekStart: string, weekEnd: string): string | null {
  if (a.booking_win_business_date != null && a.booking_win_business_date >= weekStart && a.booking_win_business_date <= weekEnd) {
    return a.booking_win_business_date;
  }
  const created = createdBusinessDateOf(a);
  if (created != null && created >= weekStart && created <= weekEnd) return created;
  return null;
}

// ---------------------------------------------------------------------------
// OWNER RULING 3 — FILLED HOLES, NARROW (slot-level, owner-confirmed 10/1).
// A qualifying filled hole is a SPECIFIC previously-open studio appointment
// slot of the CURRENT week that is subsequently filled during that same week
// by a rep-attributed paid-deposit CC Booking Win. NOT "any booking on an
// under-capacity day" — slots already filled when the week began were never
// holes of that week.
// ---------------------------------------------------------------------------

/** 1-hour slot positions (ET clock) of the derived schedule: morning block + afternoon block. */
const MORNING_SLOTS = ["08:00", "09:00", "10:00", "11:00", "12:00"] as const;
const AFTERNOON_SLOTS = ["13:30", "14:30", "15:30", "16:30", "17:30"] as const;

/**
 * The derived schedule's slot times for one ET day (owner ruling 9/29: first
 * slot 08:00 every day EXCEPT Tuesday 09:00; 10 slots/day, 9 on Tuesday =
 * 69/week): non-Tue morning 08:00–12:00 ×5 + afternoon 13:30–17:30 ×5;
 * Tuesday morning 09:00–12:00 ×4 + the same afternoon ×5.
 */
export function scheduledSlotTimesForDay(dateStr: string): string[] {
  return weekday(dateStr) === 2
    ? ["09:00", "10:00", "11:00", "12:00", ...AFTERNOON_SLOTS]
    : [...MORNING_SLOTS, ...AFTERNOON_SLOTS];
}

/** Which studio block a slot position belongs to (audit context). */
export function slotBlockOf(time: string): "morning" | "afternoon" {
  return (time < "13:00" ? "morning" : "afternoon");
}

/** ET clock time ("HH:mm") of an instant. */
export function etTimeOfInstant(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

/** ET session date of an appointment (the calendar day its slot occupies). */
export function sessionDateOf(a: AppointmentRow): string | null {
  const ms = Date.parse(a.appointment_datetime);
  if (!Number.isFinite(ms)) return null;
  return etDateStrFromInstant(ms);
}

/**
 * Per-bonus audit row (RULING 3, REQUIRED): rep · appointment date/time ·
 * slot previously open (day + block/position) · filling booking · qualifying
 * Booking Win · $10 · week credited.
 */
export interface FilledHoleAudit {
  userId: string;
  appointmentId: string;
  acuity_appointment_id?: string | null;
  client_name?: string | null;
  appointment_type?: string | null;
  appointment_date_et: string;
  appointment_time_et: string;
  slot_date: string;
  slot_time: string;
  slot_block: "morning" | "afternoon";
  win_date: string;
  bonus_cents: number;
  week_start: string;
}

/** Per-day slot-state audit (validation-screen context: how open the week was when it began, and what got filled). */
export interface DaySlotDetail {
  date: string;
  capacity: number;
  /** Slots still open at Monday 00:00 ET — that day's holes when the week began. */
  openAtStart: number;
  /** Open-at-start slots actually filled in-week by rep-attributed qualifying wins. */
  filledByRep: number;
}

export interface HoleDerivation {
  /** Rep → count of qualifying filled holes ($10 each). */
  byRep: Map<string, number>;
  /** One audit row per $10 bonus. */
  audit: FilledHoleAudit[];
  /** Per-day slot-state detail. */
  days: DaySlotDetail[];
  /** Total scheduled slots this week (69 under the current model). */
  totalSlots: number;
  /** Total slots open at week start (the week's holes when it began). */
  openAtStart: number;
}

/**
 * RULING 3 derivation. Slot open/filled state is evaluated against the DERIVED
 * schedule (10/day, 9 Tue); a slot is a hole of this week only when it was
 * still open at Monday 00:00 ET, and it qualifies only when the booking that
 * filled it during the week is a rep-attributed paid-deposit Booking Win.
 *
 * Occupancy at week start is deliberately CONSERVATIVE: any appointment record
 * created before the week (including a since-cancelled one) occupying the slot
 * blocks the hole — the owner's cancelled-then-rebooked edge case must never
 * pay, and without cancellation timestamps a cancelled pre-week record cannot
 * be proven open at Monday 00:00. Under-payment risk is surfaced honestly in
 * the per-day audit rather than paying a false $10.
 *
 * Fillings by wins created IN-week are exactly the qualifying case; bookings
 * made during the week for LATER weeks fill no current-week hole (their
 * session days are outside this week's schedule) and never earn retroactively.
 */
export function deriveFilledHolesForWeek(input: {
  weekStart: string;
  /** ALL appointment records whose session could touch the week's ET days (getAppointmentsOverlapping window). */
  sessionAppts: AppointmentRow[];
  /** The week's rep-attributed qualifying wins (qualifyingRepWinsForWeek). */
  repWins: RepWin[];
}): HoleDerivation {
  const { weekStart } = input;
  const audit: FilledHoleAudit[] = [];
  const days: DaySlotDetail[] = [];
  const byRep = new Map<string, number>();
  // slot key = `${date}|${time}` → records occupying the slot (any state).
  const occupants = new Map<string, AppointmentRow[]>();
  for (const a of input.sessionAppts) {
    const sd = sessionDateOf(a);
    if (sd == null || sd < weekStart || sd > addDays(weekStart, 6)) continue; // sessions outside this week's schedule are irrelevant
    const slotTimes = scheduledSlotTimesForDay(sd);
    const t = etTimeOfInstant(Date.parse(a.appointment_datetime));
    if (!slotTimes.includes(t)) continue; // off-grid session — occupies no derived slot
    const key = `${sd}|${t}`;
    const list = occupants.get(key);
    if (list) list.push(a);
    else occupants.set(key, [a]);
  }
  // Index the week's qualifying wins by the slot they occupy.
  const winBySlot = new Map<string, RepWin>();
  for (const w of input.repWins) {
    const wMs = Date.parse(w.appointmentDatetime);
    if (!Number.isFinite(wMs)) continue;
    const sd = etDateStrFromInstant(wMs);
    const t = etTimeOfInstant(wMs);
    const key = `${sd}|${t}`;
    if (!scheduledSlotTimesForDay(sd).includes(t)) continue; // off-grid — fills no derived slot
    const existing = winBySlot.get(key);
    // One slot, one hole: if two wins ever collide, the earliest-created one fills it.
    if (existing == null || Date.parse(w.appointmentDatetime) < Date.parse(existing.appointmentDatetime)) {
      winBySlot.set(key, w);
    }
  }
  let totalSlots = 0;
  let openAtStart = 0;
  let cur = weekStart;
  for (let i = 0; i < 7; i++) {
    const d = cur;
    cur = addDays(cur, 1);
    const slotTimes = scheduledSlotTimesForDay(d);
    totalSlots += slotTimes.length;
    let dayOpen = 0;
    let dayFilled = 0;
    for (const t of slotTimes) {
      const key = `${d}|${t}`;
      const recs = occupants.get(key) ?? [];
      // (b) OPEN AT WEEK START: no record created before Monday 00:00 ET occupies it.
      const preExisting = recs.some((r) => (createdBusinessDateOf(r) ?? "0000-01-01") < weekStart);
      if (preExisting) continue; // filled when the week began — never a hole of this week
      dayOpen += 1;
      // (c) subsequently filled IN-WEEK by a rep-attributed qualifying win.
      const filler = winBySlot.get(key);
      if (filler == null) continue;
      dayFilled += 1;
      byRep.set(filler.userId, (byRep.get(filler.userId) ?? 0) + 1);
      audit.push({
        userId: filler.userId,
        appointmentId: filler.appointmentId,
        acuity_appointment_id: filler.acuity_appointment_id ?? null,
        client_name: filler.client_name ?? null,
        appointment_type: filler.appointment_type ?? null,
        appointment_date_et: d,
        appointment_time_et: t,
        slot_date: d,
        slot_time: t,
        slot_block: slotBlockOf(t),
        win_date: filler.winDate,
        bonus_cents: HOLE_BONUS_CENTS,
        week_start: weekStart,
      });
    }
    days.push({ date: d, capacity: slotTimes.length, openAtStart: dayOpen, filledByRep: dayFilled });
    openAtStart += dayOpen;
  }
  return { byRep, audit, days, totalSlots, openAtStart };
}

export interface WeeklyComputationInput {
  weekStart: string; // Monday (ET)
  /** Win-bucket appointment superset for the week (store selector; filtered inside). */
  wins: AppointmentRow[];
  attributions: AttributionRow[];
  /** Session-occupancy superset covering the week's ET days (store selector; filtered inside). */
  sessionAppts: AppointmentRow[];
  /** Commission-eligible employees with the tier held that week (tierHeldForWeek applied by the caller). */
  employees: CommissionEmployeeInput[];
}

export interface WeeklyComputation {
  weekStart: string;
  weekEnd: string;
  /** Rep-attributed qualifying wins = the pool team total (OWNER RULING 2). */
  teamQualifyingBookings: number;
  poolUnlocked: boolean;
  poolTotalCents: number;
  /** Per-employee results — EVERY eligible employee appears, zero bookings included (§5: no minimum to earn). */
  employees: EmployeeWeeklyCommission[];
  repWins: RepWin[];
  /** RULING 3 slot-level hole derivation — per-bonus audit + per-day state. */
  holeAudit: FilledHoleAudit[];
  holeDays: DaySlotDetail[];
  totalSlots: number;
  openAtStart: number;
  /**
   * RULING 5 (owner directive 10/2): true when this week began with more than
   * HOLE_BONUS_MAX_OPEN_SLOTS (8) slots open — hole_bonus is $0 for EVERY rep
   * this week (holeAudit rows retained but bonus_cents zeroed so the drawer
   * can still show what WAS filled). UI wording: "week had >8 open slots —
   * hole bonus not paid (owner ruling 10/2)".
   */
  holeBonusCapped: boolean;
}

/**
 THE weekly calc (pure): pull the week's rep-attributed qualifying wins, apply
 the assigned tier formula (§C/§D/§E), evaluate the 79 pool (§G, RULING 2) and
 the narrow filled holes (§H, RULING 3), and itemize per employee.
 Deterministic: same inputs → identical outputs (the backfill acceptance test
 relies on it).
 */
export function computeWeeklyCommissions(input: WeeklyComputationInput): WeeklyComputation {
  const { weekStart } = input;
  const weekEnd = addDays(weekStart, 6);
  const repWins = qualifyingRepWinsForWeek(input.wins, input.attributions, weekStart, weekEnd);
  const holes = deriveFilledHolesForWeek({ weekStart, sessionAppts: input.sessionAppts, repWins });
  const teamQualifyingBookings = repWins.length; // rep-attributed only (RULING 2)
  const poolUnlocked = teamQualifyingBookings >= 79;
  const poolTotalCents = poolUnlocked ? teamQualifyingBookings * 500 : 0;
  // RULING 5 (owner directive 10/2): hole bonuses pay ONLY in weeks with ≤ 8
  // open-at-week-start slots. When the week began with more open slots than
  // HOLE_BONUS_MAX_OPEN_SLOTS, hole money is $0 for EVERY rep — the slot-level
  // audit rows stay derived but their bonus_cents zero out, so the weekly
  // drawer still shows exactly which open-at-start slots got filled (at $0).
  // The per-rep filledHoles COUNT is likewise retained (facts, not money).
  const holeBonusCapped = holes.openAtStart > HOLE_BONUS_MAX_OPEN_SLOTS;
  const holeAudit = holeBonusCapped ? holes.audit.map((h) => ({ ...h, bonus_cents: 0 })) : holes.audit;
  const employees = input.employees.map((emp) => {
    const myWins = repWins.filter((w) => w.userId === emp.userId);
    const bookings = myWins.length;
    const rate = rateCommission(emp.employmentType, emp.tier, bookings);
    const poolCents = poolBonusCents(teamQualifyingBookings, bookings);
    const myHoles = holes.byRep.get(emp.userId) ?? 0;
    const holeCents = holeBonusCapped ? 0 : holeBonusCents(myHoles);
    return {
      userId: emp.userId,
      name: emp.name,
      employmentType: emp.employmentType,
      tier: emp.tier,
      tierEffectiveDateUsed: emp.tierEffectiveDate,
      qualifyingBookings: bookings,
      baseCents: rate.baseCents,
      additionalCents: rate.additionalCents ?? 0,
      poolCents,
      filledHoles: myHoles,
      holeCents,
      totalCents: rate.totalCents + poolCents + holeCents,
      breakdown: rate,
    };
  });
  return { weekStart, weekEnd, teamQualifyingBookings, poolUnlocked, poolTotalCents, employees, repWins, holeAudit, holeDays: holes.days, totalSlots: holes.totalSlots, openAtStart: holes.openAtStart, holeBonusCapped };
}
