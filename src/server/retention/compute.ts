/**
 * RETENTION COMPUTATION CORE (stage 3a — build-sequence step 3; plan §8+§9;
 * owner rulings D1–D14 approved 2026-10-19).
 *
 * ONE computation shared by the background tick (retention/tick.ts), manual
 * triggers and the outcomes backfill runner — the attempt ledger and the
 * per-appointment outcomes always come from the same engine invocation.
 *
 * What it does (per owner spec):
 *   1. COHORT (D6 population B): qualifying appointments
 *      (status ∈ settings.retention.qualifying_statuses, default scheduled;
 *      never cancelled) with contact_due_date = ET(appt) − due_days inside
 *      [today − compute_lookback_days, today] (ET calendar; D13: prospective
 *      + what the 30-day call window already covers).
 *   2. IDENTITY (stage-2 chain): appointment → internal client via the sticky
 *      acuity/appointment link; call → internal client via
 *      call.contact_id → contacts → highlevel/contact link (the CLIENT-
 *      mediated universe, plan §8 — not raw contact equality).
 *   3. ATTRIBUTION (§8): the shipped attributeCall/groupAppointmentsByClient
 *      helpers; D8 outbound only as attempts, nearest-future for overlapping
 *      windows (D12), unattributed calls stay visible in the client timeline
 *      (plan §8 edge cases).
 *   4. CLASSIFICATION (§9 matrix, classify.ts): status primary, duration
 *      supporting-only, notes resolve-or-escalate (D5), unknown → Needs
 *      Review. D8: inbound in-window calls are TRACKED in the outcome
 *      evidence (count + ids) but carry no attempt class.
 *   5. WRITE (idempotent): diff desired vs stored rows; inserts + genuine
 *      content changes only. UNCHANGED ROWS ARE NEVER REWRITTEN — computed_at
 *      keeps the last content change, so a re-run is byte-identical. A
 *      `ringing` call re-observed as terminal updates its OWN row (never a
 *      merge). Per-attempt rows are never overwritten by a different call.
 *
 * ROSTER INDEPENDENCE (owner directive 2026-10-20): classification runs on
 * every resolvable call REGARDLESS of roster membership — Laura left the
 * roster 10/20 but her users row (and every call's rep_id /
 * provider_rep_external_id) is intact; the employee fields ride the raw
 * provider ids, never is_active.
 */
import type { Store } from "../store/types";
import { addDays, etDateStrFromInstant, etDayStartUtc } from "../date-logic";
import { attributeCall, groupAppointmentsByClient } from "./attribution";
import {
  aggregateAppointmentStatus,
  classifyAttempt,
  parseNoteEvidence,
  TRANSCRIPT_AVAILABILITY_BASIS,
  type AttemptClass,
  type FinalContactStatus,
} from "./classify";
import type { RetentionAttemptWrite, RetentionOutcomeWrite } from "../store/types";
import { appointmentInScope } from "../metrics/availability";

export const RETENTION_COMPUTE_VERSION = 1;
/** Attempt rows are keyed on the normalized calls table (source discriminator for a future harvest-ledger path). */
export const RETENTION_ATTEMPT_SOURCE = "calls";

export interface RetentionComputeResult {
  outcome: "synced";
  /** Appointments evaluated (cohort = due date in window, qualifying status). */
  appointmentsEvaluated: number;
  /** Cohort appointments with no internal client — counted honestly, never written, already exception-queued by the stage-2 backfill. */
  unlinkedAppointments: number;
  unlinkedAcuityIds: string[];
  attemptsInserted: number;
  attemptsUpdated: number;
  attemptsUnchanged: number;
  outcomesInserted: number;
  outcomesUpdated: number;
  outcomesUnchanged: number;
  /** Calls in the fetch window that cannot reach a client (null contact or unlinked contact) — exception-queue territory, never silently dropped. */
  callsWithoutClient: number;
  /** In-window INBOUND calls (D8: tracked in evidence, never attempts). */
  inboundInWindowCalls: number;
  /** Final-status distribution over the written/checked cohort. */
  finalStatusCounts: Record<FinalContactStatus, number>;
  attemptClassCounts: Record<AttemptClass, number>;
  dueDays: number;
  window: { sinceDate: string; thruDate: string };
  computedAtIso: string;
}

interface ApptSourceRow {
  id: string;
  acuity_appointment_id: string | null;
  appointment_datetime: string;
  status: string;
  cancelled: boolean;
  raw: Record<string, unknown> | null;
}

/** Cohort + calls fetch floor: lookback + due span + 2 ET days of margin (session datetimes and calls both predate their due dates). */
function fetchFloorIso(todayEt: string, lookbackDays: number, dueDays: number): string {
  return etDayStartUtc(addDays(todayEt, -(lookbackDays + dueDays + 2)));
}

/**
 * Compute + persist retention attempts and per-appointment outcomes.
 * Injectable clock for tests; everything else reads from the store.
 */
export async function computeRetention(
  store: Store,
  options?: { now?: () => Date },
): Promise<RetentionComputeResult> {
  const now = options?.now ?? (() => new Date());
  const settings = await store.getSettings();
  const retention = settings.retention ?? {
    due_days: 7,
    qualifying_statuses: ["scheduled"],
    compute_lookback_days: 30,
    employee_initials: {},
    max_attempts: null,
    max_attempt_days: null,
    max_contact_days: null,
  };
  const dueDays = retention.due_days;
  const todayEt = etDateStrFromInstant(now().getTime());
  const sinceDate = addDays(todayEt, -retention.compute_lookback_days);
  const floorIso = fetchFloorIso(todayEt, retention.compute_lookback_days, dueDays);

  const [appts, calls, links] = await Promise.all([
    store.getAppointmentsWithClientsSince(floorIso),
    store.getAllCallsSince(floorIso),
    store.listClientMatchLinks(),
  ]);

  const clientByAppointment = new Map<string, string>(); // acuity_appointment_id → internal client id
  const clientByContactExternal = new Map<string, string>(); // contacts.external_id → internal client id
  for (const l of links) {
    if (l.provider === "acuity" && l.entity === "appointment") clientByAppointment.set(l.external_id, l.internal_client_id);
    else if (l.provider === "highlevel" && l.entity === "contact") clientByContactExternal.set(l.external_id, l.internal_client_id);
  }

  // ---- cohort: qualifying appointments by due date ----
  const statuses = new Set(retention.qualifying_statuses.length ? retention.qualifying_statuses : ["scheduled"]);
  const cohort: (ApptSourceRow & { dueDate: string; apptDateEt: string; internalClientId: string | null })[] = [];
  const unlinkedAcuityIds: string[] = [];
  for (const a of appts as (import("../metrics/compute").AppointmentRow & { acuity_appointment_id: string | null })[]) {
    if (!statuses.has(a.status)) continue;
    if (a.cancelled) continue;
    // OWNER SCOPE RULE (same rule every booking-feeding read applies): Zoom
    // bookings never enter the engine.
    if (!appointmentInScope(a, settings.acuity)) continue;
    if (!a.acuity_appointment_id) continue; // cannot link → cannot participate
    const ms = Date.parse(a.appointment_datetime);
    if (!Number.isFinite(ms)) continue; // bad-datetime rows never invent a due date
    const due = addDays(etDateStrFromInstant(ms), -dueDays);
    if (due < sinceDate || due > todayEt) continue; // cohort = due window already opened
    const clientId = clientByAppointment.get(a.acuity_appointment_id) ?? null;
    if (!clientId) {
      unlinkedAcuityIds.push(a.acuity_appointment_id);
      continue; // honest count; the stage-2 backfill has queued/exceptioned these
    }
    cohort.push({
      id: a.id,
      acuity_appointment_id: a.acuity_appointment_id,
      appointment_datetime: a.appointment_datetime,
      status: a.status,
      cancelled: a.cancelled,
      raw: (a as { raw?: Record<string, unknown> | null }).raw ?? null,
      dueDate: due,
      apptDateEt: etDateStrFromInstant(ms),
      internalClientId: clientId,
    });
  }
  unlinkedAcuityIds.sort();

  // ---- client-mediated appointment universe (§8, shared tested builder) ----
  const infosByClient = groupAppointmentsByClient(
    cohort.map((c) => ({
      appointmentId: c.id,
      acuityAppointmentId: c.acuity_appointment_id,
      appointmentDatetimeIso: c.appointment_datetime,
      internalClientId: c.internalClientId!,
    })),
    dueDays,
  );
  const apptById = new Map(cohort.map((c) => [c.id, c]));

  // ---- calls → client → attribution ----
  const callClientPairs = calls.filter((c) => c.id).map((c) => c.id);
  const callClients = callClientPairs.length ? await store.getInternalClientsForCallIds(callClientPairs) : [];
  const clientOfCall = new Map(callClients.map((r) => [r.call_id, r.internal_client_id]));

  const attemptWrites: RetentionAttemptWrite[] = [];
  const inboundByAppointment = new Map<string, { count: number; callIds: string[] }>();
  let callsWithoutClient = 0;
  let inboundInWindowCalls = 0;
  const attemptClassCounts: Record<AttemptClass, number> = {
    answered: 0,
    answered_uncorroborated: 0,
    voicemail: 0,
    no_answer: 0,
    non_contact: 0,
    transient: 0,
    unknown: 0,
  };

  // Deterministic order: calls by started_at then id (stable evidence).
  const orderedCalls = [...calls].sort((a, b) => {
    const d = Date.parse(a.started_at) - Date.parse(b.started_at);
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
  });
  for (const call of orderedCalls) {
    const clientId = clientOfCall.get(String(call.id)) ?? null;
    if (!clientId) {
      callsWithoutClient += 1;
      continue;
    }
    const infos = infosByClient.get(clientId) ?? [];
    if (!infos.length) continue; // client with no cohort appointment — timeline-only, no attempt rows
    const decision = attributeCall(
      {
        callId: String(call.id),
        startedAtIso: call.started_at,
        direction: call.direction ?? null,
        callStatus: call.call_status ?? null,
      },
      infos,
      { dueDays, directions: ["outbound", "inbound"] },
    );
    if (decision.appointmentId == null) continue; // outside every window → stays in the client's timeline (§8)
    const appt = apptById.get(decision.appointmentId)!;
    const direction = call.direction == null ? null : String(call.direction);
    if (direction !== "outbound") {
      // D8: inbound is tracked, never an attempt.
      inboundInWindowCalls += 1;
      const cur = inboundByAppointment.get(appt.id) ?? { count: 0, callIds: [] };
      cur.count += 1;
      cur.callIds.push(call.external_call_id ?? String(call.id));
      inboundByAppointment.set(appt.id, cur);
      continue;
    }
    const employeeBasis =
      call.rep_id
        ? `calls.rep_id → users row (roster-independent; is_active not consulted)`
        : call.provider_rep_external_id
          ? `provider_rep_external_id ${call.provider_rep_external_id} (raw HL user id; no users row)`
          : "none";
    const cls = classifyAttempt({
      callStatus: call.call_status ?? null,
      durationSeconds: call.duration_seconds ?? null,
      direction,
      externalCallId: call.external_call_id ?? null,
      employeeBasis,
      source: RETENTION_ATTEMPT_SOURCE,
    });
    attemptClassCounts[cls.attemptClass] += 1;
    const evidence: Record<string, unknown> = {
      ...cls.evidence,
      call_internal_id: call.id,
      conversation_id: call.conversation_id ?? null,
      contact_id: call.contact_id ?? null,
      contact_resolution_method: call.contact_resolution_method ?? null,
      d8_rule: "outbound = attempt; inbound tracked but never an attempt (owner ruling D8)",
      attribution_rule: decision.evidence.rule,
      window_candidates: decision.evidence.windowCandidates,
      due_days: dueDays,
      attributed_to: {
        internal_client_id: clientId,
        acuity_appointment_id: appt.acuity_appointment_id,
        appointment_datetime: appt.appointment_datetime,
        contact_due_date: appt.dueDate,
      },
      matrix_version: `retention-classify v${RETENTION_COMPUTE_VERSION}`,
    };
    attemptWrites.push({
      internalClientId: clientId,
      appointmentId: decision.appointmentId,
      callId: call.id,
      source: RETENTION_ATTEMPT_SOURCE,
      externalMessageId: call.external_call_id ?? String(call.id),
      employeeUserId: call.rep_id ?? null,
      employeeExternalId: call.provider_rep_external_id ?? null,
      attemptAtIso: call.started_at,
      callStatus: call.call_status ?? null,
      durationSeconds: call.duration_seconds ?? null,
      direction,
      attemptClass: cls.attemptClass,
      evidence,
      attribution: decision.attribution,
    });
  }

  // ---- per-appointment outcomes ----
  const attemptsByAppointment = new Map<string, RetentionAttemptWrite[]>();
  for (const w of attemptWrites) {
    if (!w.appointmentId) continue;
    const list = attemptsByAppointment.get(w.appointmentId) ?? [];
    list.push(w);
    attemptsByAppointment.set(w.appointmentId, list);
  }
  const outcomeWrites: RetentionOutcomeWrite[] = [];
  const finalStatusCounts: Record<FinalContactStatus, number> = {
    verified_spoke_with: 0,
    voicemail: 0,
    no_answer: 0,
    attempted_unclear: 0,
    needs_review: 0,
  };
  // Cohort order deterministic: by due date then acuity id.
  const orderedCohort = [...cohort].sort((a, b) => (a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : String(a.acuity_appointment_id).localeCompare(String(b.acuity_appointment_id))));
  for (const appt of orderedCohort) {
    const attempts = (attemptsByAppointment.get(appt.id) ?? []).sort((a, b) => {
      const d = Date.parse(a.attemptAtIso) - Date.parse(b.attemptAtIso);
      return d !== 0 ? d : a.externalMessageId.localeCompare(b.externalMessageId);
    });
    const notes = parseNoteEvidence(appt.raw && typeof appt.raw.notes === "string" ? (appt.raw.notes as string) : null);
    const agg = aggregateAppointmentStatus(
      attempts.map((a) => ({ attemptClass: a.attemptClass as AttemptClass, durationSeconds: a.durationSeconds, externalCallId: a.externalMessageId, callStatus: a.callStatus })),
      notes,
      { dueDate: appt.dueDate, appointmentDate: appt.apptDateEt },
    );
    const inbound = inboundByAppointment.get(appt.id) ?? { count: 0, callIds: [] };
    const anyAnswered = attempts.some((a) => a.attemptClass === "answered");
    finalStatusCounts[agg.finalStatus] += 1;
    const evidence: Record<string, unknown> = {
      computed_by: `retention-compute v${RETENTION_COMPUTE_VERSION}`,
      internal_client_id: appt.internalClientId,
      acuity_appointment_id: appt.acuity_appointment_id,
      appointment_status: appt.status,
      contact_due_date: appt.dueDate,
      due_days: dueDays,
      window: {
        rule: "instant arithmetic [appt − due_days·24h, appt)",
        due_date_calendar: appt.dueDate,
        appointment_date_et: appt.apptDateEt,
      },
      attempts: attempts.map((a) => ({
        external_message_id: a.externalMessageId,
        call_id: a.callId,
        attempt_at: a.attemptAtIso,
        call_status: a.callStatus,
        duration_seconds: a.durationSeconds,
        attempt_class: a.attemptClass,
        attribution: a.attribution,
        employee_user_id: a.employeeUserId,
        employee_external_id: a.employeeExternalId,
      })),
      inbound_in_window: { count: inbound.count, call_ids: inbound.callIds, d8_rule: "tracked, never attempts (owner ruling D8)" },
      note_evidence: notes,
      notes_excerpt:
        appt.raw && typeof appt.raw.notes === "string" ? (appt.raw.notes as string).slice(0, 1000) : null,
      notes_source: "appointments.raw->>'notes' (Acuity; coverage from 2026-09-28, plan §1)",
      aggregation: { final_status: agg.finalStatus, basis: agg.basis, needs_review_reason: agg.needsReviewReason, note_overlay: agg.noteOverlay },
      transcript_availability: null,
      transcript_basis: TRANSCRIPT_AVAILABILITY_BASIS,
      identity_basis: "stage-2 chain: acuity/appointment link + highlevel/contact link (client-mediated attribution)",
    };
    outcomeWrites.push({
      appointmentId: appt.id,
      internalClientId: appt.internalClientId!,
      contactDueDate: appt.dueDate,
      eligible: true,
      eligibilityBasis: `qualifying_status:${appt.status}`,
      attemptsCount: attempts.length,
      firstAttemptAtIso: attempts.length ? attempts[0]!.attemptAtIso : null,
      lastAttemptAtIso: attempts.length ? attempts[attempts.length - 1]!.attemptAtIso : null,
      anyAnswered,
      finalStatus: agg.finalStatus,
      evidence,
      needsReviewReason: agg.needsReviewReason,
    });
  }

  // ---- idempotent write: diff desired vs stored ----
  const [existingAttempts, existingOutcomes] = await Promise.all([store.listRetentionAttempts(), store.listRetentionAppointmentOutcomes()]);
  const existingAttemptByKey = new Map(existingAttempts.map((r) => [`${r.source}:${r.external_message_id}`, r]));
  const attemptKey = (w: RetentionAttemptWrite) => `${w.source}:${w.externalMessageId}`;
  const attemptsToInsert: RetentionAttemptWrite[] = [];
  const attemptsToUpdate: { id: string; patch: Partial<Omit<RetentionAttemptWrite, "source" | "externalMessageId">> }[] = [];
  let attemptsUnchanged = 0;
  for (const w of attemptWrites) {
    const cur = existingAttemptByKey.get(attemptKey(w));
    if (!cur) {
      attemptsToInsert.push(w);
      continue;
    }
    const same =
      cur.internal_client_id === w.internalClientId &&
      (cur.appointment_id ?? null) === (w.appointmentId ?? null) &&
      (cur.call_id ?? null) === (w.callId ?? null) &&
      (cur.employee_user_id ?? null) === (w.employeeUserId ?? null) &&
      (cur.employee_external_id ?? null) === (w.employeeExternalId ?? null) &&
      sameInstant(cur.attempt_at, w.attemptAtIso) &&
      (cur.call_status ?? null) === (w.callStatus ?? null) &&
      (cur.duration_seconds ?? null) === (w.durationSeconds ?? null) &&
      (cur.direction ?? null) === (w.direction ?? null) &&
      cur.attempt_class === w.attemptClass &&
      cur.attribution === w.attribution &&
      canonicalJson(cur.evidence) === canonicalJson(w.evidence);
    if (same) attemptsUnchanged += 1;
    else
      attemptsToUpdate.push({
        id: cur.id,
        patch: {
          internalClientId: w.internalClientId,
          appointmentId: w.appointmentId,
          callId: w.callId,
          employeeUserId: w.employeeUserId,
          employeeExternalId: w.employeeExternalId,
          attemptAtIso: w.attemptAtIso,
          callStatus: w.callStatus,
          durationSeconds: w.durationSeconds,
          direction: w.direction,
          attemptClass: w.attemptClass,
          evidence: w.evidence,
          attribution: w.attribution,
        },
      });
  }
  const insertedAttempts = attemptsToInsert.length ? await store.insertRetentionAttempts(attemptsToInsert) : 0;
  for (const u of attemptsToUpdate) await store.updateRetentionAttempt(u.id, u.patch);

  const existingOutcomeById = new Map(existingOutcomes.map((r) => [r.appointment_id, r]));
  const outcomesToInsert: RetentionOutcomeWrite[] = [];
  const outcomesToUpdate: RetentionOutcomeWrite[] = [];
  let outcomesUnchanged = 0;
  for (const w of outcomeWrites) {
    const cur = existingOutcomeById.get(w.appointmentId);
    if (!cur) {
      outcomesToInsert.push(w);
      continue;
    }
    const same =
      cur.internal_client_id === w.internalClientId &&
      cur.contact_due_date === w.contactDueDate &&
      cur.eligible === w.eligible &&
      (cur.eligibility_basis ?? null) === (w.eligibilityBasis ?? null) &&
      cur.attempts_count === w.attemptsCount &&
      sameInstant(cur.first_attempt_at, w.firstAttemptAtIso) &&
      sameInstant(cur.last_attempt_at, w.lastAttemptAtIso) &&
      cur.any_answered === w.anyAnswered &&
      cur.final_status === w.finalStatus &&
      (cur.needs_review_reason ?? null) === (w.needsReviewReason ?? null) &&
      canonicalJson(cur.evidence) === canonicalJson(w.evidence);
    if (same) outcomesUnchanged += 1;
    else outcomesToUpdate.push(w);
  }
  const insertedOutcomes = outcomesToInsert.length ? await store.insertRetentionAppointmentOutcomes(outcomesToInsert) : 0;
  for (const u of outcomesToUpdate) await store.updateRetentionAppointmentOutcome(u);

  return {
    outcome: "synced",
    appointmentsEvaluated: cohort.length,
    unlinkedAppointments: unlinkedAcuityIds.length,
    unlinkedAcuityIds,
    attemptsInserted: insertedAttempts,
    attemptsUpdated: attemptsToUpdate.length,
    attemptsUnchanged,
    outcomesInserted: insertedOutcomes,
    outcomesUpdated: outcomesToUpdate.length,
    outcomesUnchanged,
    callsWithoutClient,
    inboundInWindowCalls,
    finalStatusCounts,
    attemptClassCounts,
    dueDays,
    window: { sinceDate, thruDate: todayEt },
    computedAtIso: now().toISOString(),
  };
}

/** Instant comparison tolerant of precision drift (ms vs µs round-trips). */
function sameInstant(a: string | null, b: string | null): boolean {
  if ((a ?? null) === (b ?? null)) return true;
  if (a == null || b == null) return false;
  const da = Date.parse(a);
  const db = Date.parse(b);
  return Number.isFinite(da) && Number.isFinite(db) && da === db;
}

/**
 * Key-order-insensitive JSON comparison — the pg-jsonb shape. Postgres jsonb
 * does NOT preserve object key order (keys sort by length, then bytewise), so
 * a stored evidence blob NEVER stringifies equal to the freshly built desired
 * object even when the content is identical: the live-fire re-run of
 * 2026-10-20 rewrote every row on every pass (139/139 attempts, 239/239
 * outcomes "updated", unchanged 0) while the MemoryStore suite stayed green
 * (JS objects preserve insertion order). Canonical form sorts object keys
 * recursively on BOTH sides; array order is preserved (jsonb keeps it too).
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
