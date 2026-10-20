/**
 * RETENTION DUE-WINDOW + CALL→APPOINTMENT ATTRIBUTION (stage 2, plan §8;
 * owner rulings D6/D8/D11/D12 approved 2026-10-19).
 *
 * Owner's 7-day excitement-call rule (D6 population B — qualifying
 * appointments by contact-due date):
 *   contact_due_date = ET(appointment_datetime) − due_days  (calendar days,
 *   configurable in Settings — production default 7; Settings surface is a
 *   later stage, so dueDays is a parameter everywhere).
 *
 * Attribution window for appointment A (plan §8):
 *   [A.appointment_datetime − due_days·24h, A.appointment_datetime)
 * Call in the window → counts for A. Two tiny-but-real definitions live
 * side by side, exactly as the plan writes them:
 *   - due DATE is ET-calendar arithmetic (etDateStrFromInstant + addDays,
 *     DST-safe) and buckets the D6 population;
 *   - the window is exact 24h·N subtraction on the instant and decides call
 *     inclusion. Across a DST boundary the two can disagree by an hour;
 *     the window (instant arithmetic) is the attribution truth, the due date
 *     is the reporting truth. Both are recorded in evidence.
 *
 * Rulings applied:
 *   D8  inbound calls are NOT excitement attempts (timeline-only) — default filter.
 *   D11 `failed` calls COUNT as attempts (a dial happened) and are attributed
 *       to their appointment; they contribute no contact EVIDENCE — that is
 *       the classification matrix's job (next stage), not attribution's.
 *   D12 multi-appointment ambiguity → NEAREST-FUTURE appointment, with ALL
 *       window candidates recorded in evidence (never a silent pick).
 */
import { addDays, etDateStrFromInstant } from "../date-logic";

export interface ApptForAttribution {
  /** Store-internal appointment id. */
  appointmentId: string;
  acuityAppointmentId?: string | null;
  /** ISO instant of the session slot. */
  appointmentDatetimeIso: string;
  /** Lifecycle status (qualifying statuses are caller/Settings-driven, default ["scheduled"]). */
  status: string;
  cancelled?: boolean;
}

export interface CallForAttribution {
  callId: string;
  startedAtIso: string;
  direction: string | null; // outbound | inbound
  callStatus: string | null;
}

export interface AppointmentDueInfo {
  appointment: ApptForAttribution;
  /** ET calendar date the excitement call is due (appt ET date − dueDays). */
  contactDueDate: string;
  /** [startMs, endMs) attribution window (endMs = the appointment instant itself). */
  windowStartMs: number;
  windowEndMs: number;
}

export type AttributionDecision =
  | { appointmentId: string; attribution: "window"; evidence: AttributionEvidence }
  | { appointmentId: string; attribution: "nearest_future"; evidence: AttributionEvidence }
  | { appointmentId: null; attribution: "unattributed"; evidence: AttributionEvidence };

export interface AttributionEvidence {
  callStartedAtMs: number;
  dueDays: number;
  /** Every qualifying appointment whose window contains the call (ids + acuity ids + windows) — D12 keeps ALL candidates visible. */
  windowCandidates: { appointmentId: string; acuityAppointmentId: string | null; appointmentDatetimeIso: string; windowStartMs: number; windowEndMs: number }[];
  /** How the decision was reached. */
  rule: "single_window" | "nearest_future" | "no_window_candidate";
}

/** ET calendar date the excitement call is due for this appointment. */
export function contactDueDate(appointmentDatetimeIso: string, dueDays: number): string {
  return addDays(etDateStrFromInstant(Date.parse(appointmentDatetimeIso)), -dueDays);
}

/** Exact attribution window: [appt − dueDays·24h, appt). */
export function attributionWindow(appointmentDatetimeIso: string, dueDays: number): { startMs: number; endMs: number } {
  const endMs = Date.parse(appointmentDatetimeIso);
  if (!Number.isFinite(endMs)) return { startMs: Number.NaN, endMs: Number.NaN };
  return { startMs: endMs - dueDays * 24 * 60 * 60 * 1000, endMs };
}

/**
 * D6 population (ruling B): qualifying appointments by contact-due date.
 * Returns every appointment with its due date + window so the caller can
 * bucket by due date in an ET date range (rangeStart/rangeEnd inclusive,
 * ET calendar dates) or compute attribution.
 */
export function qualifyingAppointmentsByDueDate(
  appointments: ApptForAttribution[],
  opts: { dueDays: number; qualifyingStatuses?: string[]; rangeStart?: string; rangeEnd?: string },
): AppointmentDueInfo[] {
  const statuses = new Set(opts.qualifyingStatuses ?? ["scheduled"]);
  const out: AppointmentDueInfo[] = [];
  for (const a of appointments) {
    if (!statuses.has(a.status)) continue;
    if (a.cancelled) continue;
    const ms = Date.parse(a.appointmentDatetimeIso);
    if (!Number.isFinite(ms)) continue; // bad-datetime rows never invent a due date
    const due = contactDueDate(a.appointmentDatetimeIso, opts.dueDays);
    if (opts.rangeStart && due < opts.rangeStart) continue;
    if (opts.rangeEnd && due > opts.rangeEnd) continue;
    const w = attributionWindow(a.appointmentDatetimeIso, opts.dueDays);
    out.push({ appointment: a, contactDueDate: due, windowStartMs: w.startMs, windowEndMs: w.endMs });
  }
  return out;
}

export const DEFAULT_EXCITEMENT_CALL_DIRECTIONS = ["outbound"]; // D8
/** Statuses that still describe a real dial (everything observed; unknown future values arrive here too and are classified by the matrix later). */
export const ATTRIBUTION_DIRECTION_DEFAULT = DEFAULT_EXCITEMENT_CALL_DIRECTIONS;

/**
 * Attribute ONE call to ONE appointment of its client (plan §8 algorithm).
 * `clientAppointments` = the client's QUALIFYING appointments (already
 * status-filtered by the caller via qualifyingAppointmentsByDueDate).
 *  - exactly one window candidate → attributed "window" (the normal case);
 *  - several (appointments < dueDays apart) → "nearest_future" = the
 *    candidate with the EARLIEST appointment_datetime ≥ call instant
 *    (the session the call was most plausibly made for), all candidates in
 *    evidence (D12);
 *  - none → unattributed (call stays in the client's attempt timeline; it
 *    never silently vanishes).
 */
export function attributeCall(
  call: CallForAttribution,
  clientAppointments: AppointmentDueInfo[],
  opts: { dueDays: number; directions?: string[] },
): AttributionDecision {
  const directions = new Set(opts.directions ?? DEFAULT_EXCITEMENT_CALL_DIRECTIONS);
  const callMs = Date.parse(call.startedAtIso);
  const emptyEvidence: AttributionEvidence = {
    callStartedAtMs: callMs,
    dueDays: opts.dueDays,
    windowCandidates: [],
    rule: "no_window_candidate",
  };
  if (!directions.has(call.direction ?? "")) {
    return { appointmentId: null, attribution: "unattributed", evidence: { ...emptyEvidence, rule: "no_window_candidate" } };
  }
  if (!Number.isFinite(callMs)) {
    return { appointmentId: null, attribution: "unattributed", evidence: emptyEvidence };
  }
  const candidates = clientAppointments.filter((a) => callMs >= a.windowStartMs && callMs < a.windowEndMs);
  if (candidates.length === 1) {
    const c = candidates[0];
    return {
      appointmentId: c.appointment.appointmentId,
      attribution: "window",
      evidence: {
        callStartedAtMs: callMs,
        dueDays: opts.dueDays,
        windowCandidates: candidates.map(toCandidate),
        rule: "single_window",
      },
    };
  }
  if (candidates.length > 1) {
    // D12: nearest-future = earliest appointment_datetime among the window
    // candidates (every candidate's instant is > callMs by window def).
    const nearest = candidates.reduce((best, c) => (Date.parse(c.appointment.appointmentDatetimeIso) < Date.parse(best.appointment.appointmentDatetimeIso) ? c : best));
    return {
      appointmentId: nearest.appointment.appointmentId,
      attribution: "nearest_future",
      evidence: {
        callStartedAtMs: callMs,
        dueDays: opts.dueDays,
        windowCandidates: candidates.map(toCandidate),
        rule: "nearest_future",
      },
    };
  }
  return { appointmentId: null, attribution: "unattributed", evidence: emptyEvidence };
}

function toCandidate(a: AppointmentDueInfo) {
  return {
    appointmentId: a.appointment.appointmentId,
    acuityAppointmentId: a.appointment.acuityAppointmentId ?? null,
    appointmentDatetimeIso: a.appointment.appointmentDatetimeIso,
    windowStartMs: a.windowStartMs,
    windowEndMs: a.windowEndMs,
  };
}
