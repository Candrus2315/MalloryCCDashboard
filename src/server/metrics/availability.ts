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
 *  - PADDING (S4b hardening, owner-caught): booked counts only slots the
 *    appointment SESSION occupies. A slot overlapping just the turnover buffer
 *    (padding around the session) is blockedCount — removed from open, never
 *    inflated into booked. paddingMin = 0 reproduces the pre-S4b output
 *    byte-for-byte.
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
  /**
   * AVAILABILITY REBUILD PR-2 (additive): EVERY candidate slot the engine
   * generated for the day, as the SAME labels openSlotTimes uses, in
   * chronological order. The Day view's per-slot state machine classifies
   * exactly these (booked + blockedCount + open === slotTimes.length — the
   * invariant is per-block and therefore per-day). Consumers that only read
   * the counts are untouched; nothing previously rendered changes.
   */
  slotTimes: string[];
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

/**
 * "9:00 AM" → 540 — the EXACT inverse of the engine's slot label (PR-2: the
 * Day view's per-slot state machine classifies the engine's slotTimes labels).
 * Null on anything the formatter could not have produced (never guessed).
 */
export function slotLabelToMinutes(label: string): number | null {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(label);
  if (!m) return null;
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (mins > 59) return null;
  const hh = (h % 12) + (m[3] === "PM" ? 12 : 0);
  return hh * 60 + mins;
}

/** Engine slot minutes → "09:00" (HH:mm ET — the availability feed's time_et shape). */
export function slotMinutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "13:30" (feed time_et) → "1:30 PM" (the engine's slot label shape). Null when unparseable. */
export function slotTimeToLabel(time: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return slotLabel(minutes);
}

/** "9:00 AM" → "09:00" — label → feed shape (null when unparseable). */
export function slotLabelToTime(label: string): string | null {
  const minutes = slotLabelToMinutes(label);
  return minutes == null ? null : slotMinutesToTime(minutes);
}

const overlaps = (s: number, e: number, intervals: Array<[number, number]>): boolean =>
  intervals.some(([bs, be]) => s < be && e > bs);

/**
 * Full availability truth for ONE ET calendar date. Pure — the payload builder
 * feeds store rows; Today's computeOpenSlots delegates here for its slot list.
 *
 * TWO-BLOCK DAILY SCHEDULE (owner directive 2026-09-27): a weekday may carry
 * SEVERAL active hour-blocks (e.g. morning 09:00–13:00 + afternoon 13:30–18:30).
 * EVERY active rule for the weekday contributes its own slot run (slot_interval
 * from open to close − duration); blocks concatenate in time order. The
 * accounting is per-block: within each block every slot lands in exactly one of
 * booked / blockedCount / open, so
 *   booked + blockedCount + openSlotTimes.length === totalCapacity
 * holds per block AND for the day (the day total is the sum over blocks).
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
    slotTimes: [],
  };
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  // EVERY active rule for this weekday contributes its own slot run (not just
  // the first). Sorted by open time so slots concatenate in time order even
  // when the stored rule order differs. Degenerate windows (close <= open or
  // unparseable times) contribute nothing.
  const blocks = input.rules
    .filter((r) => r.weekday === weekday(input.date) && r.active)
    .map((r) => ({ openMin: toMin(r.open_time), closeMin: toMin(r.close_time) }))
    .filter((b) => Number.isFinite(b.openMin) && Number.isFinite(b.closeMin) && b.closeMin > b.openMin)
    .sort((a, b) => a.openMin - b.openMin || a.closeMin - b.closeMin);
  if (blocks.length === 0) return empty;

  const dayStart = etDayStartUtc(input.date);
  const dayEnd = etDayStartUtc(addDays(input.date, 1));
  const dayStartMs = new Date(dayStart).getTime();
  const dayEndMs = new Date(dayEnd).getTime();

  // busy intervals as minute-offsets within the ET day. S4b PADDING HARDENING
  // (owner-caught): booked counts slots the APPOINTMENT ITSELF occupies
  // (apptReal — the session interval only); padding is a TURNOVER BUFFER, and
  // a slot overlapping ONLY the buffer (not the session) is removed from open
  // as blockedCount, never counted as booked. With paddingMin = 0 the buffer
  // list is empty and output is byte-identical to the pre-S4b engine.
  const apptReal: Array<[number, number]> = [];
  const apptBuffer: Array<[number, number]> = [];
  for (const a of input.appointments) {
    if (!isBookingRow(a) || !appointmentInScope(a, input.scope)) continue;
    const start = Date.parse(a.appointment_datetime);
    const end = appointmentEndMs(a, input.durationMin);
    if (start == null || end == null || !Number.isFinite(start)) continue;
    if (end <= dayStartMs || start >= dayEndMs) continue;
    apptReal.push([(start - dayStartMs) / 60_000, (end - dayStartMs) / 60_000]);
    const padMs = input.paddingMin * 60_000;
    if (padMs > 0) apptBuffer.push([(start - padMs - dayStartMs) / 60_000, (end + padMs - dayStartMs) / 60_000]);
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
  const slotTimes: string[] = [];
  for (const { openMin, closeMin } of blocks) {
    // per-block run: within THIS block every slot lands in exactly one bucket
    // (booked / blocked / open), so the invariant holds per block; the day
    // total below is the sum over blocks.
    for (let t = openMin; t + input.durationMin <= closeMin; t += input.slotIntervalMin) {
      totalCapacity += 1;
      slotTimes.push(slotLabel(t));
      // an appointment wins the slot when the SESSION itself overlaps it (it
      // is booked — the studio is using it). A slot overlapping only the
      // turnover BUFFER is removed from open as blockedCount, never booked.
      // A block only removes slots NOT already counted as booked, so
      // booked + blockedCount + openSlotTimes.length === totalCapacity always
      if (overlaps(t, t + input.durationMin, apptReal)) {
        booked += 1;
        continue;
      }
      if (overlaps(t, t + input.durationMin, apptBuffer)) {
        blockedCount += 1;
        continue;
      }
      if (overlaps(t, t + input.durationMin, blockBusy)) {
        blockedCount += 1;
        continue;
      }
      openSlotTimes.push(slotLabel(t));
    }
  }

  return {
    date: input.date,
    totalCapacity,
    booked,
    openSlotTimes,
    utilization: totalCapacity > 0 ? booked / totalCapacity : null,
    blockedCount,
    slotTimes,
  };
}

/** Local mirror of compute.ts isBooking (kept here to avoid a runtime import cycle). */
function isBookingRow(a: AppointmentRow): boolean {
  return !a.cancelled && a.status !== "cancelled";
}
