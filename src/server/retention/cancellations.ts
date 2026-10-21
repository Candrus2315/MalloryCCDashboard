/**
 * RETENTION CANCELLATIONS LEDGER (stage 4a — plan §11; owner build order
 * "cancellations/reschedules ledger"). The writer that fills every honest
 * "—" the cancellations family left on /retention: Active Cancellations,
 * the queue's cancellation rows, Saves / Reschedules / Recovery Rate, and
 * the scorecard's cancellation-family columns.
 *
 * MANAGEMENT TRACKING ONLY: Laura keeps working in Acuity and GHL exactly as
 * today — this engine OBSERVES appointments already synced into the DB and
 * computes. No new provider API calls: every input is a stored row.
 *
 * WHAT A CANCELLATION IS (evidence, never inference):
 *   appointments.cancelled = true + cancelled_at (write-once stamp set by the
 *   shipped Acuity cancellation reconciliation — Acuity exposes no client-side
 *   cancellation timestamp, so cancelled_at is WHEN THIS SYSTEM CONFIRMED the
 *   cancellation). cancelled_at is COPIED into the ledger and never moved.
 *
 * OUTCOME DERIVATION (plan §11 "derived automatically", made concrete):
 *   A successor is an ACTUAL appointment row for the same internal client,
 *   qualifying status (Settings), in scope, non-cancelled, created strictly
 *   AFTER cancelled_at and within settings.retention.reschedule_days
 *   (default 14). successor_appointment_id always points at that real row —
 *   a save/recovery is never asserted without one.
 *   - successor re-booked the SAME session instant      → 'saved_original'
 *     (the original appointment, kept — Saves card; owner definition of a
 *     save: the client who tried to cancel keeps their original session)
 *   - successor on a DIFFERENT instant                  → 'rescheduled'
 *     (rebooked within the window; earliest rebooking wins, tiebreak acuity id)
 *   - no successor, save window still open              → 'pending'
 *     (Active Cancellations — the actionable queue)
 *   - no successor, window elapsed, attempts > 0, none answered
 *                                                       → 'unable_to_reach'
 *   - no successor, window elapsed, otherwise           → 'confirmed_cancellation'
 *   - 'transferred' / 'other' / override 'saved_original' → management-override
 *     stage (this writer never sets them; manual_overrides reserved)
 *   recovered = saved_original OR rescheduled (owner definition); recovered_at
 *   = the successor's created_at (the moment the recovery actually landed).
 *
 * IDEMPOTENCE (stage-3a discipline): diff desired vs stored — inserts +
 * genuine content changes only; UNCHANGED ROWS ARE NEVER REWRITTEN. A row
 * with manual_overrides is NEVER auto-recomputed over (plan §11) — the
 * automatic writer skips it entirely. Re-runs write nothing.
 *
 * IDENTITY: appointment → internal client via the stage-2 chain (the
 * acuity/appointment link) — the CLIENT-mediated universe, same as the
 * compute cohort. Unlinked cancellations are counted honestly
 * (unlinkedCancellations) and NOT written; the stage-2 identity backfill
 * already exception-queues them. Ledger rows therefore always carry a
 * resolved client — the §11 recovery denominator ("eligible cancellations:
 * internal client resolved") equals the ledger itself.
 *
 * COVERAGE: the SAME fetch window the whole retention module uses
 * (compute_lookback_days on cancelled_at + the shared appointment fetch
 * floor); scorecard weeks always sit inside it. Attempts/final-contact
 * fields ride the attempt ledger + outcome rows for the cancelled
 * appointment where they exist (pre-cancellation history).
 */
import type { Store, RetentionCancellationWrite } from "../store/types";
import { addDays, etDateStrFromInstant, etDayStartUtc } from "../date-logic";
import { appointmentInScope } from "../metrics/availability";

export const RETENTION_CANCELLATIONS_VERSION = 1;

/** The plan §11 outcome vocabulary (the writer's derivable subset + overrides). */
export const CANCELLATION_OUTCOMES = [
  "saved_original",
  "rescheduled",
  "confirmed_cancellation",
  "unable_to_reach",
  "pending",
  "transferred",
  "other",
] as const;
export type CancellationOutcome = (typeof CANCELLATION_OUTCOMES)[number];

/** Owner definition (plan §11): a recovered client kept the original session OR rescheduled. */
export const RECOVERED_OUTCOMES: ReadonlySet<string> = new Set(["saved_original", "rescheduled"]);

export interface CancellationCandidate {
  appointmentId: string;
  acuityAppointmentId: string;
  appointmentDatetimeIso: string;
  createdAtIso: string;
  appointmentType: string | null;
}

export interface CancellationDerivation {
  outcome: CancellationOutcome;
  successorAppointmentId: string | null;
  recovered: boolean;
  recoveredAtIso: string | null;
  /** Every candidate considered (evidence — the derivation is auditable). */
  candidates: CancellationCandidate[];
  selectionRule: string;
}

/**
 * Pure outcome derivation (plan §11, made concrete). `windowElapsed` = the
 * reschedule/save window has fully passed (cancelled_at + reschedule_days ≤
 * now); a cancellation inside its window stays 'pending' — the team can still
 * save it. No successor is ever invented: the candidate list comes from real
 * appointment rows, and the chosen successor keeps its own identity.
 */
export function deriveCancellationOutcome(input: {
  cancelledAtMs: number;
  rescheduleDays: number;
  nowMs: number;
  attemptsCount: number;
  anyAnswered: boolean;
  candidates: CancellationCandidate[];
  /** The cancelled session's own instant — a candidate re-booked at it means the ORIGINAL appointment, kept (saved_original). */
  cancelledSessionMs: number | null;
}): CancellationDerivation {
  const { cancelledAtMs, rescheduleDays, nowMs, attemptsCount, anyAnswered, cancelledSessionMs } = input;
  const candidates = input.candidates ?? []; // defensive: derivation stays total over a missing list
  const windowEndMs = cancelledAtMs + rescheduleDays * 24 * 3_600_000;
  const windowElapsed = windowEndMs <= nowMs;

  // Candidates ordered by created_at then acuity id (deterministic evidence).
  const ordered = [...candidates].sort((a, b) => {
    const d = Date.parse(a.createdAtIso) - Date.parse(b.createdAtIso);
    return d !== 0 ? d : a.acuityAppointmentId.localeCompare(b.acuityAppointmentId);
  });

  const rule = (kind: string): string =>
    `${kind}; candidates ordered by created_at then acuity id; successor always an actual appointment row (never inferred)`;

  if (ordered.length) {
    // SAME-SLOT first: a re-booking at the cancelled session's exact instant is
    // the client who cancelled and then re-took THEIR ORIGINAL SLOT — the
    // owner's save ("original appointment kept"). Everything else rescheduled.
    const sameSlot = cancelledSessionMs == null
      ? []
      : ordered.filter((c) => {
          const ms = Date.parse(c.appointmentDatetimeIso);
          return Number.isFinite(ms) && ms === cancelledSessionMs;
        });
    const chosen = sameSlot.length ? sameSlot[0] : ordered[0];
    const outcome: CancellationOutcome = sameSlot.length ? "saved_original" : "rescheduled";
    return {
      outcome,
      successorAppointmentId: chosen!.appointmentId,
      recovered: true,
      recoveredAtIso: chosen!.createdAtIso,
      candidates: ordered,
      selectionRule: rule(
        sameSlot.length
          ? "a candidate re-booked the cancelled session's exact instant → saved_original (the original appointment, kept)"
          : "earliest rebooking after the cancellation within the reschedule window → rescheduled",
      ),
    };
  }
  if (!windowElapsed) {
    return { outcome: "pending", successorAppointmentId: null, recovered: false, recoveredAtIso: null, candidates: [], selectionRule: rule("no successor yet; save window still open") };
  }
  if (attemptsCount > 0 && !anyAnswered) {
    return { outcome: "unable_to_reach", successorAppointmentId: null, recovered: false, recoveredAtIso: null, candidates: [], selectionRule: rule("window elapsed; attempts recorded but none answered") };
  }
  return { outcome: "confirmed_cancellation", successorAppointmentId: null, recovered: false, recoveredAtIso: null, candidates: [], selectionRule: rule("window elapsed with no rebooking") };
}

export interface RetentionCancellationsResult {
  outcome: "synced";
  /** Cancellations evaluated (in-scope, cancelled, cancelled_at in window, client resolved). */
  cancellationsEvaluated: number;
  /** In-scope cancellations whose client could not be resolved — counted honestly, never written (identity backfill already exception-queues them). */
  unlinkedCancellations: number;
  unlinkedAcuityIds: string[];
  /** Cancelled rows with no cancelled_at stamp — no place on the timeline, never written (honest count). */
  missingCancelledAt: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Rows with management overrides — skipped by the automatic writer (never recomputed over). */
  skippedOverrides: number;
  outcomeCounts: Record<string, number>;
  rescheduleDays: number;
  window: { sinceDate: string; thruDate: string };
  computedAtIso: string;
}

interface ApptSourceRow {
  id: string;
  acuity_appointment_id: string | null;
  appointment_datetime: string;
  created_at: string;
  appointment_type: string | null;
  status: string;
  cancelled: boolean;
  cancelled_at: string | null;
  cancellation_source: string | null;
}

/** Fetch floor: the SAME shape compute.ts uses (lookback + due span + 2 ET days of margin) — one shared window for the module. */
function fetchFloorIso(todayEt: string, lookbackDays: number, dueDays: number): string {
  return etDayStartUtc(addDays(todayEt, -(lookbackDays + dueDays + 2)));
}

/**
 * Compute + persist the cancellations ledger. Injectable clock for tests;
 * everything else reads from the store. Never called from the UI (the
 * "do not write to retention tables from the UI" rule) — the tick owns it.
 */
export async function computeRetentionCancellations(
  store: Store,
  options?: { now?: () => Date },
): Promise<RetentionCancellationsResult> {
  const now = options?.now ?? (() => new Date());
  const nowMs = now().getTime();
  const settings = await store.getSettings();
  const retention = settings.retention ?? {
    due_days: 7,
    qualifying_statuses: ["scheduled"],
    compute_lookback_days: 30,
    employee_initials: {},
    max_attempts: null,
    max_attempt_days: null,
    max_contact_days: null,
    reschedule_days: 14,
  };
  const dueDays = retention.due_days;
  const rescheduleDays = retention.reschedule_days;
  const todayEt = etDateStrFromInstant(nowMs);
  const sinceDate = addDays(todayEt, -retention.compute_lookback_days);
  const floorIso = fetchFloorIso(todayEt, retention.compute_lookback_days, dueDays);
  const sinceMs = Date.parse(etDayStartUtc(sinceDate));

  const [appts, links, clients, attempts, outcomes, existing] = await Promise.all([
    store.getAppointmentsWithClientsSince(floorIso) as Promise<(ApptSourceRow & { raw?: Record<string, unknown> | null })[]>,
    store.listClientMatchLinks(),
    store.listInternalClients(),
    store.listRetentionAttempts(),
    store.listRetentionAppointmentOutcomes(),
    store.listRetentionCancellations(),
  ]);

  const clientByAppointment = new Map<string, string>(); // acuity_appointment_id → internal client id
  for (const l of links) {
    if (l.provider === "acuity" && l.entity === "appointment") clientByAppointment.set(l.external_id, l.internal_client_id);
  }
  const ghlByClient = new Map<string, string | null>();
  for (const c of clients) ghlByClient.set(c.id, c.ghl_contact_external_id ?? null);

  const attemptsByAppointment = new Map<string, { count: number; anyAnswered: boolean }>();
  for (const a of attempts) {
    if (!a.appointment_id) continue;
    const cur = attemptsByAppointment.get(a.appointment_id) ?? { count: 0, anyAnswered: false };
    cur.count += 1;
    if (a.attempt_class === "answered") cur.anyAnswered = true;
    attemptsByAppointment.set(a.appointment_id, cur);
  }
  const finalStatusByAppointment = new Map<string, string>();
  for (const o of outcomes) finalStatusByAppointment.set(o.appointment_id, o.final_status);

  const statuses = new Set(retention.qualifying_statuses.length ? retention.qualifying_statuses : ["scheduled"]);
  const inScope = (a: ApptSourceRow & { raw?: Record<string, unknown> | null }): boolean => {
    try {
      return appointmentInScope(a as unknown as Parameters<typeof appointmentInScope>[0], settings.acuity);
    } catch {
      return false;
    }
  };

  // ---- cohort: in-scope cancelled appointments, cancelled_at inside the lookback ----
  const cohort: (ApptSourceRow & { cancelledAtMs: number; internalClientId: string })[] = [];
  const unlinkedAcuityIds: string[] = [];
  let missingCancelledAt = 0;
  for (const a of appts) {
    if (!a.cancelled) continue;
    if (!inScope(a)) continue; // owner scope rule: Zoom bookings never enter the engine
    if (!a.acuity_appointment_id) continue; // cannot link → cannot participate
    if (a.cancelled_at == null) {
      missingCancelledAt += 1; // no timeline anchor — counted, never written
      continue;
    }
    const cAt = Date.parse(a.cancelled_at);
    if (!Number.isFinite(cAt) || cAt < sinceMs || cAt > nowMs) continue; // D13 lookback on the cancellation event
    const clientId = clientByAppointment.get(a.acuity_appointment_id) ?? null;
    if (!clientId) {
      unlinkedAcuityIds.push(a.acuity_appointment_id);
      continue; // honest count; stage-2 identity backfill owns these
    }
    cohort.push({ ...a, cancelledAtMs: cAt, internalClientId: clientId });
  }
  unlinkedAcuityIds.sort();

  // ---- successor candidates: qualifying appointments by the SAME client ----
  const qualifyingByClient = new Map<string, CancellationCandidate[]>();
  for (const a of appts) {
    if (a.cancelled) continue;
    if (!statuses.has(a.status)) continue;
    if (!inScope(a)) continue;
    if (!a.acuity_appointment_id) continue;
    const clientId = clientByAppointment.get(a.acuity_appointment_id);
    if (!clientId) continue;
    const createdMs = Date.parse(a.created_at);
    if (!Number.isFinite(createdMs)) continue; // bad creation instant — never a candidate
    const list = qualifyingByClient.get(clientId) ?? [];
    list.push({
      appointmentId: a.id,
      acuityAppointmentId: a.acuity_appointment_id,
      appointmentDatetimeIso: a.appointment_datetime,
      createdAtIso: a.created_at,
      appointmentType: a.appointment_type ?? null,
    });
    qualifyingByClient.set(clientId, list);
  }

  // ---- derive + diff-write (deterministic order: cancelled_at then acuity id) ----
  const existingByAppointment = new Map(existing.map((r) => [r.appointment_id, r]));
  const writes: RetentionCancellationWrite[] = [];
  const skippedOverrides = existing.reduce((n, r) => {
    const mo = r.manual_overrides;
    return n + (mo && typeof mo === "object" && Object.keys(mo).length > 0 ? 1 : 0);
  }, 0);
  const outcomeCounts: Record<string, number> = {};
  const orderedCohort = [...cohort].sort((a, b) =>
    a.cancelledAtMs !== b.cancelledAtMs ? a.cancelledAtMs - b.cancelledAtMs : String(a.acuity_appointment_id).localeCompare(String(b.acuity_appointment_id)),
  );
  for (const appt of orderedCohort) {
    const cur = existingByAppointment.get(appt.id);
    if (cur && cur.manual_overrides && typeof cur.manual_overrides === "object" && Object.keys(cur.manual_overrides).length > 0) {
      continue; // plan §11: management overrides are never auto-recomputed over
    }
    const pool = qualifyingByClient.get(appt.internalClientId) ?? [];
    const sessionMs = Date.parse(appt.appointment_datetime);
    const candidates = pool.filter(
      (c) =>
        c.appointmentId !== appt.id &&
        c.acuityAppointmentId !== appt.acuity_appointment_id && // never the cancelled row itself
        Date.parse(c.createdAtIso) > appt.cancelledAtMs && // strictly AFTER the cancellation (confirmation stamp)
        Date.parse(c.createdAtIso) <= appt.cancelledAtMs + rescheduleDays * 24 * 3_600_000,
    );
    const derivation = deriveCancellationOutcome({
      cancelledAtMs: appt.cancelledAtMs,
      rescheduleDays,
      nowMs,
      attemptsCount: attemptsByAppointment.get(appt.id)?.count ?? 0,
      anyAnswered: attemptsByAppointment.get(appt.id)?.anyAnswered ?? false,
      candidates: candidates.map((c) => ({ ...c })),
      cancelledSessionMs: Number.isFinite(sessionMs) ? sessionMs : null,
    });
    const outcome = derivation.outcome;
    const successor = derivation.candidates.length ? derivation.candidates[0] : null;
    const recovered = RECOVERED_OUTCOMES.has(outcome);
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;

    const notes: Record<string, unknown> = {
      derived_by: `retention-cancellations v${RETENTION_CANCELLATIONS_VERSION}`,
      acuity_appointment_id: appt.acuity_appointment_id,
      appointment_status: appt.status,
      cancellation_source: appt.cancellation_source ?? null,
      cancelled_at_basis:
        "appointments.cancelled_at (write-once; THIS SYSTEM's confirmation stamp via the Acuity cancellation reconciliation — Acuity exposes no client-side cancellation timestamp)",
      session_instant: appt.appointment_datetime,
      reschedule_rule: {
        reschedule_days: rescheduleDays,
        window: "created_at ∈ (cancelled_at, cancelled_at + reschedule_days]",
        window_elapsed_at_compute: appt.cancelledAtMs + rescheduleDays * 24 * 3_600_000 <= nowMs,
        candidates: derivation.candidates.map((c) => ({
          appointment_id: c.appointmentId,
          acuity_appointment_id: c.acuityAppointmentId,
          created_at: c.createdAtIso,
          session: c.appointmentDatetimeIso,
          appointment_type: c.appointmentType,
          same_slot_as_cancelled: Number.isFinite(sessionMs) && Date.parse(c.appointmentDatetimeIso) === sessionMs,
        })),
        selected_successor: successor ? { appointment_id: successor.appointmentId, acuity_appointment_id: successor.acuityAppointmentId } : null,
        selection_rule: derivation.selectionRule,
      },
      saved_original_rule:
        "outcome saved_original ⇔ a candidate re-booked the cancelled session's exact instant (the original appointment, kept); else earliest candidate = rescheduled",
      attempts_basis: "retention_attempts rows attributed to this appointment (coverage bounded by the module fetch window)",
      final_contact_status_basis: finalStatusByAppointment.has(appt.id) ? "retention_appointment_outcomes row (pre-cancellation history)" : null,
      identity_basis: "stage-2 chain: acuity/appointment link (client-mediated)",
    };

    writes.push({
      appointmentId: appt.id,
      internalClientId: appt.internalClientId,
      ghlContactExternalId: ghlByClient.get(appt.internalClientId) ?? null,
      cancelledAtIso: appt.cancelled_at,
      attemptsCount: attemptsByAppointment.get(appt.id)?.count ?? 0,
      anyAnswered: attemptsByAppointment.get(appt.id)?.anyAnswered ?? false,
      finalContactStatus: finalStatusByAppointment.get(appt.id) ?? null,
      outcome,
      successorAppointmentId: successor ? successor.appointmentId : null,
      recovered,
      recoveredAtIso: recovered && successor ? successor.createdAtIso : null,
      notes,
    });
  }

  // ---- idempotent write: diff desired vs stored ----
  const { sameInstant, canonicalJson } = await import("./compute");
  const toInsert: RetentionCancellationWrite[] = [];
  const toUpdate: RetentionCancellationWrite[] = [];
  let unchanged = 0;
  for (const w of writes) {
    const cur = existingByAppointment.get(w.appointmentId);
    if (!cur) {
      toInsert.push(w);
      continue;
    }
    const same =
      (cur.internal_client_id ?? null) === (w.internalClientId ?? null) &&
      (cur.ghl_contact_external_id ?? null) === (w.ghlContactExternalId ?? null) &&
      sameInstant(cur.cancelled_at, w.cancelledAtIso) &&
      cur.attempts_count === w.attemptsCount &&
      cur.any_answered === w.anyAnswered &&
      (cur.final_contact_status ?? null) === (w.finalContactStatus ?? null) &&
      cur.outcome === w.outcome &&
      (cur.successor_appointment_id ?? null) === (w.successorAppointmentId ?? null) &&
      cur.recovered === w.recovered &&
      sameInstant(cur.recovered_at, w.recoveredAtIso) &&
      canonicalJson(cur.notes ?? null) === canonicalJson(w.notes);
    if (same) unchanged += 1;
    else toUpdate.push(w);
  }
  const inserted = toInsert.length ? await store.insertRetentionCancellations(toInsert) : 0;
  for (const u of toUpdate) await store.updateRetentionCancellation(u);

  return {
    outcome: "synced",
    cancellationsEvaluated: cohort.length,
    unlinkedCancellations: unlinkedAcuityIds.length,
    unlinkedAcuityIds,
    missingCancelledAt,
    inserted,
    updated: toUpdate.length,
    unchanged,
    skippedOverrides,
    outcomeCounts,
    rescheduleDays,
    window: { sinceDate, thruDate: todayEt },
    computedAtIso: now().toISOString(),
  };
}
