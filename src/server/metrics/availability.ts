/**
 * AVAILABILITY ENGINE (pure) — one source of truth for studio availability
 * per ET calendar day (owner spec design/availability-spec.md).
 *
 * EQUATION (accuracy standard): configured studio hours → candidate slots;
 * appointments occupy slots (with padding); blocked times remove slots.
 *   openSlotTimes = capacity − booked − blocked   (exactly, every day)
 *   utilization   = booked / totalCapacity        (null when capacity is 0)
 *
 * Guarantees:
 *  - A CANCELLED appointment never occupies a slot (isBooking excludes it) —
 *    a cancellation frees its slot again.
 *  - A RESCHEDULED appointment is ONE row (upserted by Acuity id) at the NEW
 *    time — the new slot is occupied, the old one is free.
 *  - Blocked times (manual, Acuity, recurring) NEVER appear as open; they are
 *    counted separately in blockedCount (not as booked, not as open).
 *  - Padding removes adjacent slots around each appointment (turnover rule).
 *  - Every instant is compared as an absolute UTC ms number; day membership is
 *    resolved with the centralized ET helpers (America/New_York, DST-safe) —
 *    never by string-slicing the ISO timestamp.
 *
 * Type-only dependency on compute.ts (no runtime cycle): compute.ts delegates
 * computeOpenSlots here so Today and Availability can never diverge.
 */
import type { AppointmentRow, AvailabilityRule, BlockedTimeRow } from "./compute";
import { addDays, etDayStartUtc, weekday } from "../date-logic";

/** Settings → Acuity scope. Empty selection = EVERYTHING counts (owner rule). */
export interface AcuityScope {
  calendars_included: string[];
  types_included: string[];
}

/** One day of the Availability payload (merged-build playbook contract). */
export interface DayAvailability {
  date: string; // ET YYYY-MM-DD
  totalCapacity: number;
  booked: number;
  openSlotTimes: string[]; // "10:00 AM" style labels, ET
  utilization: number | null; // booked / totalCapacity; null when capacity 0
  blockedCount: number;
}

/**
 * Scope filter: an appointment counts when its calendar and its appointment
 * type are included. Empty selection list = everything counts (Settings copy:
 * "Empty selection = everything counts"). Calendars are matched by NAME first
 * (the Settings value is a name, e.g. "Family Studio") with the calendar ID
 * accepted as a fallback so raw-id rows still match an id-typed scope entry.
 */
export function appointmentInScope(a: AppointmentRow, scope: AcuityScope | undefined): boolean {
  const calendars = scope?.calendars_included ?? [];
  const types = scope?.types_included ?? [];
  if (calendars.length > 0) {
    const calName = (a.calendar_name ?? null) as string | null;
    const calId = (a.calendar_id ?? null) as string | null;
    const hit = calendars.some((c) => c === calName || c === calId);
    if (!hit) return false;
  }
  if (types.length > 0 && !types.includes(a.appointment_type)) return false;
  return true;
}

/**
 * Appointment session end: the stored duration when present (Acuity provides
 * per-appointment duration — "availability must respect the selected type's
 * duration"), else the configured studio duration. Non-finite datetimes are
 * skipped rather than guessed.
 */
export function appointmentEndMs(a: AppointmentRow, fallbackDurationMin: number): number | null {
  const start = Date.parse(a.appointment_datetime);
  if (!Number.isFinite(start)) return null;
  const dur =
    typeof a.duration_minutes === "number" && Number.isFinite(a.duration_minutes) && a.duration_minutes > 0
      ? a.duration_minutes
      : fallbackDurationMin;
  return start + dur * 60_000;
}

const slotLabel = (minutes: number): string =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(
    new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)),
  );

const overlaps = (s: number, e: number, intervals: Array<[number, number]>): boolean =>
  intervals.some(([bs, be]) => s < be && e > bs);

/**
 * Full availability truth for ONE ET calendar date. Pure — the payload builder
 * feeds store rows; Today's computeOpenSlots delegates here for its slot list.
 */
export function computeDayAvailability(input: {
  date: string;
  rules: AvailabilityRule[];
  blocked: BlockedTimeRow[];
  appointments: AppointmentRow[]; // appointments whose session overlaps the day
  slotIntervalMin: number;
  durationMin: number;
  paddingMin: number;
  scope?: AcuityScope;
}): DayAvailability {
  const empty: DayAvailability = {
    date: input.date,
    totalCapacity: 0,
    booked: 0,
    openSlotTimes: [],
    utilization: null,
    blockedCount: 0,
  };
  const rule = input.rules.find((r) => r.weekday === weekday(input.date) && r.active);
  if (!rule) return empty;

  const dayStart = etDayStartUtc(input.date);
  const dayEnd = etDayStartUtc(addDays(input.date, 1));
  const dayStartMs = new Date(dayStart).getTime();
  const dayEndMs = new Date(dayEnd).getTime();

  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const openMin = toMin(rule.open_time);
  const closeMin = toMin(rule.close_time);

  // busy intervals as minute-offsets within the ET day
  const apptBusy: Array<[number, number]> = [];
  for (const a of input.appointments) {
    if (!isBookingRow(a) || !appointmentInScope(a, input.scope)) continue;
    const start = Date.parse(a.appointment_datetime);
    const end = appointmentEndMs(a, input.durationMin);
    if (start == null || end == null || !Number.isFinite(start)) continue;
    if (end <= dayStartMs || start >= dayEndMs) continue;
    const padMs = input.paddingMin * 60_000;
    apptBusy.push([(start - padMs - dayStartMs) / 60_000, (end + padMs - dayStartMs) / 60_000]);
  }
  const blockBusy: Array<[number, number]> = [];
  for (const b of input.blocked) {
    const start = new Date(b.start_at).getTime();
    const end = new Date(b.end_at).getTime();
    if (end <= dayStartMs || start >= dayEndMs) continue;
    blockBusy.push([(start - dayStartMs) / 60_000, (end - dayStartMs) / 60_000]);
  }

  let totalCapacity = 0;
  let booked = 0;
  let blockedCount = 0;
  const openSlotTimes: string[] = [];
  for (let t = openMin; t + input.durationMin <= closeMin; t += input.slotIntervalMin) {
    totalCapacity += 1;
    // an appointment wins the slot (it is booked — the studio is using it);
    // a block only removes slots NOT already counted as booked, so
    // booked + blockedCount + openSlotTimes.length === totalCapacity always
    if (overlaps(t, t + input.durationMin, apptBusy)) {
      booked += 1;
      continue;
    }
    if (overlaps(t, t + input.durationMin, blockBusy)) {
      blockedCount += 1;
      continue;
    }
    openSlotTimes.push(slotLabel(t));
  }

  return {
    date: input.date,
    totalCapacity,
    booked,
    openSlotTimes,
    utilization: totalCapacity > 0 ? booked / totalCapacity : null,
    blockedCount,
  };
}

/** Local mirror of compute.ts isBooking (kept here to avoid a runtime import cycle). */
function isBookingRow(a: AppointmentRow): boolean {
  return !a.cancelled && a.status !== "cancelled";
}
