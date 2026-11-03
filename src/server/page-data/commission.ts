/**
 * COMMISSION CENTER + §26 VALIDATION payload builders — moved verbatim from page-data.ts
 * (docs/DECOMPOSITION-PLAN.md step 3). page-data.ts re-exports this
 * module; import paths and the public surface are unchanged.
 */

import type { AppointmentRow, Store } from "../store/types";
import type { AttributionRow, CallRow } from "../metrics/compute";
import { addDays, etDateStrFromInstant, etDayEndUtc, etDayStartUtc, weekStart } from "../date-logic";




















// ---------- COMMISSION CENTER + §26 VALIDATION (Phase B — presentation-only loaders) ----------
//
// These builders read STORED commission rows (Phase A schema) and run the pure
// engine for the §3.5 estimated band and the §26 fresh recompute — NO new
// calculation logic, no manual counts (spec §Q). The createServerFn wrappers
// live in queries.ts; tests inject a MemoryStore through the PageDeps seam.

import {
  commissionEmployeeOf,
  computeWeeklyCommissions,
  tierHeldForWeek,
} from "../commission/derive";
import type { CommissionEmployeeInput } from "../commission/engine";
import { estimatedWeekView, type EstimatedWeekView } from "../../components/commission-views";
import type { CommissionWeeklyRow } from "../store/types";

/** §3.5 band payload: the in-progress week's pure-engine estimate (or null on loader error). */
export interface CommissionEstimatedWeek {
  weekStart: string;
  /** null = the in-progress computation is unavailable — the band renders "—" honestly. */
  view: EstimatedWeekView | null;
  error: string | null;
}

export async function estimatedCommissionWeek(
  store: Store,
  users: Awaited<ReturnType<Store["getUsers"]>>,
  today: string,
  opts?: { attributions?: Awaited<ReturnType<Store["getAttributions"]>> },
): Promise<CommissionEstimatedWeek> {
  try {
    const ws = weekStart(today);
    const weekEnd = addDays(ws, 6);
    const [wins, sessions, attributions] = await Promise.all([
      store.getAppointmentsByWinBusinessDateBetween(ws, weekEnd),
      store.getAppointmentsOverlapping(etDayStartUtc(ws), etDayEndUtc(weekEnd)),
      opts?.attributions ? Promise.resolve(opts.attributions) : store.getAttributions(),
    ]);
    const employees = users
      .map(commissionEmployeeOf)
      .filter((e): e is CommissionEmployeeInput => e !== null)
      .map((e) => tierHeldForWeek(e, ws, weekEnd))
      .filter((e): e is CommissionEmployeeInput => e !== null);
    const computation = computeWeeklyCommissions({
      weekStart: ws,
      wins,
      attributions,
      sessionAppts: sessions,
      employees,
    });
    return { weekStart: ws, view: estimatedWeekView(computation), error: null };
  } catch (e) {
    return {
      weekStart: weekStart(today),
      view: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------- §26 VALIDATION payload ----------

export interface CancelledWinFlag {
  appointmentId: string;
  acuityAppointmentId: string;
  clientName: string | null;
  appointmentType: string | null;
  /** ET deposit date the win was counted on (booking_win_business_date). */
  winDate: string;
  /** ET session date of the (now cancelled) appointment. */
  sessionDate: string;
  /** Monday ET week the win was counted in. */
  weekStart: string;
  weekEnd: string;
  /** True when stored commission records exist for that week — counted in stored data; corrections only via the audited reason-required manual path on the owner's direction. */
  weekClosed: boolean;
  /** Attributed rep at flag time (may be null — unattributed never paid). */
  repName: string | null;
  /** When the sync confirmed the cancellation (write-once stamp). */
  confirmedAt: string | null;
}

/**
 * CANCELLATION FLAG LIST (owner report 2026-10-06): the report-only surface
 * for Booking Wins that the sync has since confirmed cancelled. Pure: given
 * the cancelled win rows + the set of weeks that HAVE stored commission
 * records, classifies each flag closed (counted in stored data — never
 * rewritten; corrections via the audited manual path only on the owner's
 * direction) vs open (the live week — the exclusion simply applies at the
 * Sunday close). No number is rewritten here; the list exists so the owner
 * can reconcile stored totals against current truth.
 */
export function buildCancelledWinFlags(
  rows: (AppointmentRow & { acuity_appointment_id: string | null; client_name: string | null })[],
  closedWeekStarts: ReadonlySet<string>,
  repNameFor: (appointmentId: string) => string | null,
): CancelledWinFlag[] {
  return rows
    .filter((a) => !!a.booking_win_business_date && !!a.acuity_appointment_id)
    .map((a) => {
      const winDate = a.booking_win_business_date as string;
      const ws = weekStart(winDate);
      return {
        appointmentId: a.id,
        acuityAppointmentId: a.acuity_appointment_id as string,
        clientName: a.client_name ?? null,
        appointmentType: a.appointment_type ?? null,
        winDate,
        sessionDate: etDateStrFromInstant(Date.parse(a.appointment_datetime)),
        weekStart: ws,
        weekEnd: etDateStrFromInstant(Date.parse(`${ws}T12:00:00-04:00`) + 6 * 86_400_000),
        weekClosed: closedWeekStarts.has(ws),
        repName: repNameFor(a.id),
        confirmedAt: a.cancelled_at ?? null,
      };
    })
    .sort((x, y) => (x.weekStart + x.winDate).localeCompare(y.weekStart + y.winDate));
}

/**
 * QA PHASE 3 — S26 DIVERGENCE SPLIT (display-only; w1-recompute-anomaly 2026-10-08
 * section 5): among the counted bookings of the STORED weekly records, classifies
 * the ones whose attribution row was re-derived AFTER the record closed
 * (rep NULL, manual=false, updated_at > calc_date — the tick-wipe fingerprint)
 * AND whose in-window active-roster call still exists in `calls` (source
 * evidence intact). These render as the "Attribution evidence restored —
 * source intact" bucket with rewritten-at beside calc_date so the wipe is
 * dated. Everything else stays in the plain field-level delta list — manual
 * rows (they survive ticks), still-attributed rows, cancelled rows (those live
 * in the cancellation flag list), rows with no recorded rewrite time, and
 * bookings whose call evidence is genuinely absent. Never silently whitewashed.
 */
export interface DriftedWinFlag {
  appointmentId: string;
  clientName: string | null;
  appointmentType: string | null;
  winDate: string;
  weekStart: string;
  weekEnd: string;
  /** Name snapshot from the stored record (records stay readable). */
  repName: string | null;
  /** attribution row's updated_at — the instant the verdict was re-derived. */
  rewrittenAt: string;
  /** The weekly record's calc_date — shown beside rewrittenAt so the wipe is dated. */
  calcDate: string;
  /** ET date the booking was made on (created_business_date) — the evidence-window anchor. */
  createdDate: string | null;
}

export function buildAttributionDriftFlags(
  stored: CommissionWeeklyRow[],
  apptsById: ReadonlyMap<string, AppointmentRow>,
  attributions: AttributionRow[],
  calls: ReadonlyArray<Pick<CallRow, "rep_id" | "started_at">>,
  activeRepIds: ReadonlySet<string>,
): DriftedWinFlag[] {
  const attrByAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  // ET business dates carrying at least one active-roster call in the source.
  const callEtDates = new Set<string>();
  for (const c of calls) {
    if (!c.rep_id || !activeRepIds.has(c.rep_id)) continue;
    const t = Date.parse(c.started_at);
    if (Number.isFinite(t)) callEtDates.add(etDateStrFromInstant(t));
  }
  const out: DriftedWinFlag[] = [];
  for (const rec of stored) {
    for (const cb of rec.counted_bookings) {
      if (cb.manual) continue; // manual owner assignments survive ticks and agree
      const appt = apptsById.get(cb.id);
      if (!appt || appt.cancelled_at) continue; // cancellations live in the cancelled flag list
      const attr = attrByAppt.get(cb.id);
      if (!attr || attr.rep_id != null || attr.manual_override) continue; // still attributed — not a wipe
      if (!attr.updated_at) continue; // unknown rewrite time — never claimed as drift
      if (Date.parse(attr.updated_at) <= Date.parse(rec.calc_date)) continue; // written at/before close
      const created = appt.created_business_date ?? null;
      // source-intact check: an active-roster call in the s1 window (created - 1 .. created ET)
      if (!created || (!callEtDates.has(created) && !callEtDates.has(addDays(created, -1)))) continue;
      out.push({
        appointmentId: cb.id,
        clientName: cb.client_name ?? null,
        appointmentType: cb.appointment_type ?? null,
        winDate: cb.win_date,
        weekStart: rec.week_start,
        weekEnd: rec.week_end,
        repName: rec.rep_name,
        rewrittenAt: attr.updated_at,
        calcDate: rec.calc_date,
        createdDate: created,
      });
    }
  }
  return out.sort((x, y) => (x.weekStart + x.winDate).localeCompare(y.weekStart + y.winDate));
}
