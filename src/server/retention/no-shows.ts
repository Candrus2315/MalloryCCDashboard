/**
 * RETENTION NO-SHOW PIPELINE (stage 4b — plan §16 + owner ruling D10; owner
 * build order "no-show pipeline"). The writer that fills the no-show family:
 * the No-Shows card + spoken split, the queue's no-show follow-up segment
 * (priority rank 3, reserved since the restructure), the no-shows drill-down,
 * and the scorecard's no_shows / no_shows_spoken / no_shows_not_spoken cells.
 *
 * MANAGEMENT TRACKING ONLY: Laura keeps working in Acuity and GHL exactly as
 * today — this engine OBSERVES appointments already synced into the DB and
 * computes. No new provider API calls: every input is a stored row. It writes
 * ONLY the internal ret_* ledger; nothing is ever written back to Acuity/GHL.
 *
 * WHAT A NO-SHOW IS (owner ruling D10, the ratified v1 proxy — Acuity's
 * payload exposes no no-show field):
 *   the session's start has passed (appointment_datetime < now, STRICT) while
 *   the appointment is still a qualifying status (Settings, default
 *   ["scheduled"]) and not cancelled — as OBSERVED by this engine on a pass.
 *   The system never invents a no-show it did not observe: an appointment
 *   that is rescheduled (its datetime moves into the future) before any pass
 *   sees it passed is simply never detected — nothing is guessed.
 *
 * DETECTION-TIME FIELDS (write-once — the store COALESCEs them on update):
 *   session_at / session_date_et  the MISSED session's instant + ET date
 *                                 (the D10 week anchor: no-shows range by
 *                                 APPOINTMENT date, never due date)
 *   detected_at                   when THIS SYSTEM first confirmed the no-show
 *   A later cancellation or reschedule of the same appointment NEVER deletes
 *   the row — the missed session happened; the state column records what came
 *   after, and the audit trail stays complete.
 *
 * FOLLOW-UP STATE (derived every pass, pure — deriveNoShowState):
 *   open                       the no-show stands; no later event (the queue's
 *                              follow-up work)
 *   rebooked                   a qualifying successor appointment for the SAME
 *                              client was created strictly after detected_at
 *                              within the reschedule window (Settings
 *                              reschedule_days, default 14) — the client came
 *                              back; the successor is a REAL appointment row,
 *                              never inferred
 *   cancelled_after_no_show    the appointment was cancelled after detection
 *                              (its save/reschedule outcome belongs to the
 *                              stage-4a cancellations ledger; the successor is
 *                              still recorded here as evidence)
 *   rescheduled_after_no_show  the appointment's OWN datetime moved into the
 *                              future after detection (Acuity reschedules move
 *                              the same appointment id); the moved-to instant
 *                              rides the notes as evidence
 *   Precedence: cancelled > rescheduled > rebooked > open.
 *
 * IDEMPOTENCE (the stage-4a discipline, content-keyed): diff desired vs
 * stored — inserts + genuine content changes only; UNCHANGED ROWS ARE NEVER
 * REWRITTEN. detected_at / session_at / session_date_et are never part of a
 * content change (write-once). A row with manual_overrides is NEVER
 * auto-recomputed over (plan §11 discipline) — the automatic writer skips it.
 * Re-runs write nothing.
 *
 * IDENTITY: appointment → internal client via the stage-2 chain (the
 * acuity/appointment link) — the CLIENT-mediated universe, same as the
 * compute + cancellations cohorts. Unlinked no-shows are counted honestly
 * (unlinkedNoShows) and NOT written; the stage-2 identity backfill already
 * exception-queues them. Ledger rows therefore always carry a resolved client.
 *
 * COVERAGE: the SAME fetch window the whole retention module uses (the shared
 * appointment floor: today − (compute_lookback_days + due_days + 2) ET; a
 * passed session older than the floor is outside the module's data coverage —
 * counted honestly (belowFetchFloor), never written). NOTE the owner
 * directive 10/21 (RETENTION_DATA_START_ET): the DISPLAY layer filters
 * pre-cutoff rows; this WRITER observes everything in its fetch window so the
 * audit trail stays complete — pre-cutoff no-shows land in the ledger and are
 * hidden from every display surface by inRetentionDataScope, exactly like
 * every other ret_* writer.
 */
import type { Store, RetentionNoShowWrite } from "../store/types";
import { addDays, etDateStrFromInstant, etDayStartUtc } from "../date-logic";
import { appointmentInScope } from "../metrics/availability";

export const RETENTION_NO_SHOWS_VERSION = 1;

/** The closed follow-up state vocabulary (see the module doc). */
export const NOSHOW_STATES = ["open", "rebooked", "cancelled_after_no_show", "rescheduled_after_no_show"] as const;
export type NoShowState = (typeof NOSHOW_STATES)[number];

/** The queue's actionable states: a no-show with no outcome yet (the follow-up work). */
export const NOSHOW_OPEN_STATES: ReadonlySet<string> = new Set<string>(["open"]);

/** The D10 detection basis, verbatim for the notes evidence. */
export const NOSHOW_DETECTION_BASIS =
  "D10 (owner-ratified proxy): the session's start passed while the appointment was still a qualifying status and not cancelled, as observed by the no-shows engine on a pass";

export interface NoShowSuccessorCandidate {
  appointmentId: string;
  acuityAppointmentId: string;
  createdAtIso: string;
  appointmentDatetimeIso: string;
  appointmentType: string | null;
}

export interface NoShowStateDerivation {
  state: NoShowState;
  successorAppointmentId: string | null;
  /** The moved-to instant when the appointment itself was rescheduled forward (evidence; null otherwise). */
  rescheduledToIso: string | null;
  /** Why the state was counted this way (audit + tests). */
  rule: string;
}

/**
 * Pure follow-up state derivation. Deterministic + total: every fact
 * combination maps to exactly one state (precedence: cancelled >
 * rescheduled > rebooked > open). `currentSessionMs` null means the
 * appointment row is missing or its datetime unparseable — no evidence of a
 * move, so the state never claims one (never a guess).
 */
export function deriveNoShowState(input: {
  cancelled: boolean;
  currentSessionMs: number | null;
  successor: { appointmentId: string } | null;
  nowMs: number;
}): NoShowStateDerivation {
  const { cancelled, currentSessionMs, successor, nowMs } = input;
  if (cancelled) {
    return {
      state: "cancelled_after_no_show",
      successorAppointmentId: successor?.appointmentId ?? null,
      rescheduledToIso: null,
      rule: "the appointment is cancelled — cancelled AFTER the no-show was confirmed (the missed session stands; the save/reschedule outcome lives in the cancellations ledger)",
    };
  }
  if (currentSessionMs != null && currentSessionMs >= nowMs) {
    return {
      state: "rescheduled_after_no_show",
      successorAppointmentId: successor?.appointmentId ?? null,
      rescheduledToIso: new Date(currentSessionMs).toISOString(),
      rule: "the appointment's own datetime moved into the future after detection — Acuity reschedules move the same appointment id; the missed session stands",
    };
  }
  if (successor) {
    return {
      state: "rebooked",
      successorAppointmentId: successor.appointmentId,
      rescheduledToIso: null,
      rule: "a qualifying successor appointment for the same client was created after detection within the reschedule window (earliest rebooking wins, tiebreak acuity id)",
    };
  }
  return { state: "open", successorAppointmentId: null, rescheduledToIso: null, rule: "no later event — the no-show stands as the open follow-up work" };
}

export interface RetentionNoShowsResult {
  outcome: "synced";
  /** No-shows detected this pass (the D10 cohort). */
  noShowsEvaluated: number;
  /** In-scope passed-and-still-scheduled appointments whose client could not be resolved — counted honestly, never written (identity backfill owns them). */
  unlinkedNoShows: number;
  unlinkedAcuityIds: string[];
  /** Passed sessions older than the module fetch floor — outside the module's data coverage, never written (honest count). */
  belowFetchFloor: number;
  /** Existing ledger rows whose appointment row is no longer inside the fetch window — left untouched (never re-derived from missing data). */
  outsideWindow: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Rows with management overrides — skipped by the automatic writer (never recomputed over). */
  skippedOverrides: number;
  stateCounts: Record<string, number>;
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
}

/** Fetch floor: the SAME shape compute.ts / cancellations.ts use (lookback + due span + 2 ET days of margin) — one shared window for the module. */
function fetchFloorIso(todayEt: string, lookbackDays: number, dueDays: number): string {
  return etDayStartUtc(addDays(todayEt, -(lookbackDays + dueDays + 2)));
}

/**
 * Compute + persist the no-show ledger. Injectable clock for tests; everything
 * else reads from the store. Never called from the UI (the "do not write to
 * retention tables from the UI" rule) — the tick owns it.
 */
export async function computeRetentionNoShows(store: Store, options?: { now?: () => Date }): Promise<RetentionNoShowsResult> {
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
  const rescheduleDays = retention.reschedule_days ?? 14;
  const todayEt = etDateStrFromInstant(nowMs);
  const sinceDate = addDays(todayEt, -retention.compute_lookback_days);
  const floorIso = fetchFloorIso(todayEt, retention.compute_lookback_days, dueDays);
  const floorMs = Date.parse(floorIso);

  const [appts, links, clients, attempts, outcomes, existing] = await Promise.all([
    store.getAppointmentsWithClientsSince(floorIso) as Promise<(ApptSourceRow & { raw?: Record<string, unknown> | null })[]>,
    store.listClientMatchLinks(),
    store.listInternalClients(),
    store.listRetentionAttempts(),
    store.listRetentionAppointmentOutcomes(),
    store.listRetentionNoShows(),
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
  const apptMsOf = (a: ApptSourceRow): number | null => {
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) ? ms : null;
  };

  // ---- qualifying pool (successor candidates): non-cancelled, qualifying
  // ---- status, in scope, client resolved — the SAME shape the cancellations
  // ---- engine scans (the successor is always an actual appointment row).
  const qualifyingByClient = new Map<string, NoShowSuccessorCandidate[]>();
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
      createdAtIso: a.created_at,
      appointmentDatetimeIso: a.appointment_datetime,
      appointmentType: a.appointment_type ?? null,
    });
    qualifyingByClient.set(clientId, list);
  }

  // ---- cohort: the D10 detection pass over the fetched appointments ----
  const cohort: (ApptSourceRow & { sessionMs: number; internalClientId: string })[] = [];
  const unlinkedAcuityIds: string[] = [];
  let belowFetchFloor = 0;
  for (const a of appts) {
    if (a.cancelled) continue; // cancelled appointments belong to the stage-4a ledger
    if (!inScope(a)) continue; // owner scope rule: Zoom bookings never enter the engine
    if (!a.acuity_appointment_id) continue; // cannot link → cannot participate
    if (!statuses.has(a.status)) continue; // qualifying statuses only (Settings)
    const ms = apptMsOf(a);
    if (ms == null) continue; // undatable — never guessed
    if (ms >= nowMs) continue; // D10 STRICT: the session's start must have PASSED
    if (ms < floorMs) {
      belowFetchFloor += 1; // outside the module's data coverage — counted, never written
      continue;
    }
    const clientId = clientByAppointment.get(a.acuity_appointment_id) ?? null;
    if (!clientId) {
      unlinkedAcuityIds.push(a.acuity_appointment_id);
      continue; // honest count; stage-2 identity backfill owns these
    }
    cohort.push({ ...a, sessionMs: ms, internalClientId: clientId });
  }
  unlinkedAcuityIds.sort();

  // ---- desired writes (deterministic order: session instant then acuity id) ----
  const existingByAppointment = new Map(existing.map((r) => [r.appointment_id, r]));
  const { sameInstant, canonicalJson } = await import("./compute");
  const writes: RetentionNoShowWrite[] = [];
  const skippedOverrides = existing.reduce((n, r) => {
    const mo = r.manual_overrides;
    return n + (mo && typeof mo === "object" && Object.keys(mo).length > 0 ? 1 : 0);
  }, 0);

  // Existing rows first: follow-up re-evaluation from CURRENT facts. A row
  // whose appointment fell out of the fetch window is left untouched (never
  // re-derived from missing data — counted honestly). Overrides are skipped
  // (plan §11 discipline — management edits are never recomputed over).
  let outsideWindow = 0;
  const apptById = new Map(appts.map((a) => [a.id, a]));
  for (const row of [...existing].sort((a, b) => {
    const am = Date.parse(a.session_at ?? "");
    const bm = Date.parse(b.session_at ?? "");
    return am !== bm ? (Number.isFinite(am) && Number.isFinite(bm) ? am - bm : 1) : a.appointment_id < b.appointment_id ? -1 : 1;
  })) {
    if (row.manual_overrides && typeof row.manual_overrides === "object" && Object.keys(row.manual_overrides).length > 0) continue;
    const appt = apptById.get(row.appointment_id);
    if (!appt) {
      outsideWindow += 1;
      continue;
    }
    const detectedMs = Date.parse(row.detected_at);
    const detectedAtMs = Number.isFinite(detectedMs) ? detectedMs : nowMs;
    const successor = pickSuccessor({
      pool: qualifyingByClient.get(row.internal_client_id ?? "") ?? [],
      selfAppointmentId: row.appointment_id,
      selfAcuityId: appt.acuity_appointment_id,
      anchorMs: detectedAtMs, // rebookings AFTER the detection confirmation answer "did they come back?"
      rescheduleDays,
    });
    const derivation = deriveNoShowState({
      cancelled: appt.cancelled,
      currentSessionMs: apptMsOf(appt),
      successor,
      nowMs,
    });
    const currentSessionIso = appt.appointment_datetime;
    const sessionAtIso = row.session_at ?? currentSessionIso; // write-once: never move the missed session
    const parsedSession = Date.parse(sessionAtIso);
    const sessionDateEt = row.session_date_et ?? (Number.isFinite(parsedSession) ? etDateStrFromInstant(parsedSession) : null);
    const clientId = row.internal_client_id ?? clientByAppointment.get(appt.acuity_appointment_id ?? "") ?? null;
    writes.push({
      appointmentId: row.appointment_id,
      internalClientId: clientId,
      ghlContactExternalId: clientId ? ghlByClient.get(clientId) ?? null : row.ghl_contact_external_id,
      sessionAtIso,
      sessionDateEt,
      detectedAtIso: row.detected_at, // the store preserves it on update
      attemptsCount: attemptsByAppointment.get(row.appointment_id)?.count ?? 0,
      anyAnswered: attemptsByAppointment.get(row.appointment_id)?.anyAnswered ?? false,
      finalContactStatus: finalStatusByAppointment.get(row.appointment_id) ?? null,
      state: derivation.state,
      successorAppointmentId: derivation.successorAppointmentId,
      notes: buildNotes({
        version: RETENTION_NO_SHOWS_VERSION,
        appt,
        sessionAtIso,
        detectionBasis: NOSHOW_DETECTION_BASIS,
        derivation,
        rescheduleDays,
        anchorMs: detectedAtMs,
        anchorLabel: "detected_at",
        windowElapsedAtCompute: detectedAtMs + rescheduleDays * 24 * 3_600_000 <= nowMs,
      }),
    });
  }

  // New detections: state is ALWAYS 'open' at insert (a rebooking created
  // after detected_at = now cannot exist yet; later passes advance the state).
  for (const a of [...cohort].sort((x, y) =>
    x.sessionMs !== y.sessionMs ? x.sessionMs - y.sessionMs : String(x.acuity_appointment_id).localeCompare(String(y.acuity_appointment_id)),
  )) {
    if (existingByAppointment.has(a.id)) continue;
    writes.push({
      appointmentId: a.id,
      internalClientId: a.internalClientId,
      ghlContactExternalId: ghlByClient.get(a.internalClientId) ?? null,
      sessionAtIso: a.appointment_datetime,
      sessionDateEt: etDateStrFromInstant(a.sessionMs),
      detectedAtIso: now().toISOString(),
      attemptsCount: attemptsByAppointment.get(a.id)?.count ?? 0,
      anyAnswered: attemptsByAppointment.get(a.id)?.anyAnswered ?? false,
      finalContactStatus: finalStatusByAppointment.get(a.id) ?? null,
      state: "open",
      successorAppointmentId: null,
      notes: buildNotes({
        version: RETENTION_NO_SHOWS_VERSION,
        appt: a,
        sessionAtIso: a.appointment_datetime,
        detectionBasis: NOSHOW_DETECTION_BASIS,
        derivation: deriveNoShowState({ cancelled: false, currentSessionMs: a.sessionMs, successor: null, nowMs }),
        rescheduleDays,
        anchorMs: nowMs,
        anchorLabel: "detected_at",
        windowElapsedAtCompute: false,
      }),
    });
  }

  // ---- idempotent write: diff desired vs stored (content-keyed) ----
  const toInsert: RetentionNoShowWrite[] = [];
  const toUpdate: RetentionNoShowWrite[] = [];
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
      sameInstant(cur.session_at, w.sessionAtIso) &&
      (cur.session_date_et ?? null) === (w.sessionDateEt ?? null) &&
      cur.attempts_count === w.attemptsCount &&
      cur.any_answered === w.anyAnswered &&
      (cur.final_contact_status ?? null) === (w.finalContactStatus ?? null) &&
      cur.state === w.state &&
      (cur.successor_appointment_id ?? null) === (w.successorAppointmentId ?? null) &&
      canonicalJson(cur.notes ?? null) === canonicalJson(w.notes);
    if (same) unchanged += 1;
    else toUpdate.push(w);
  }
  const inserted = toInsert.length ? await store.insertRetentionNoShows(toInsert) : 0;
  for (const u of toUpdate) await store.updateRetentionNoShow(u);

  // Final states of the rows this pass WROTE (insert + update); skipped
  // override rows and outside-window rows keep their stored state untouched.
  const stateCounts: Record<string, number> = {};
  for (const w of toInsert) stateCounts[w.state] = (stateCounts[w.state] ?? 0) + 1;
  for (const w of toUpdate) stateCounts[w.state] = (stateCounts[w.state] ?? 0) + 1;
  for (const w of writes) if (!toInsert.includes(w) && !toUpdate.includes(w)) stateCounts[w.state] = (stateCounts[w.state] ?? 0) + 1;

  return {
    outcome: "synced",
    noShowsEvaluated: cohort.length,
    unlinkedNoShows: unlinkedAcuityIds.length,
    unlinkedAcuityIds,
    belowFetchFloor,
    outsideWindow,
    inserted,
    updated: toUpdate.length,
    unchanged,
    skippedOverrides,
    stateCounts,
    window: { sinceDate, thruDate: todayEt },
    computedAtIso: now().toISOString(),
  };
}

/** Earliest qualifying rebooking strictly after the anchor within the reschedule window (tiebreak acuity id) — the cancellations scan's shape. */
function pickSuccessor(input: {
  pool: NoShowSuccessorCandidate[];
  selfAppointmentId: string;
  selfAcuityId: string | null;
  anchorMs: number;
  rescheduleDays: number;
}): NoShowSuccessorCandidate | null {
  const ordered = [...input.pool]
    .filter((c) => c.appointmentId !== input.selfAppointmentId && c.acuityAppointmentId !== input.selfAcuityId) // never the no-show row itself
    .sort((a, b) => {
      const d = Date.parse(a.createdAtIso) - Date.parse(b.createdAtIso);
      return d !== 0 ? d : a.acuityAppointmentId.localeCompare(b.acuityAppointmentId);
    });
  for (const c of ordered) {
    const created = Date.parse(c.createdAtIso);
    if (created > input.anchorMs && created <= input.anchorMs + input.rescheduleDays * 24 * 3_600_000) return c;
  }
  return null;
}

/** The engine's derivation evidence, verbatim (audit per owner spec §17). */
function buildNotes(input: {
  version: number;
  appt: ApptSourceRow;
  sessionAtIso: string;
  detectionBasis: string;
  derivation: NoShowStateDerivation;
  rescheduleDays: number;
  anchorMs: number;
  anchorLabel: string;
  windowElapsedAtCompute: boolean;
}): Record<string, unknown> {
  return {
    derived_by: `retention-no-shows v${input.version}`,
    acuity_appointment_id: input.appt.acuity_appointment_id,
    appointment_status: input.appt.status,
    detection_basis: input.detectionBasis,
    session_instant: input.sessionAtIso,
    state_rule: input.derivation.rule,
    rescheduled_to: input.derivation.rescheduledToIso,
    rebook_rule: {
      reschedule_days: input.rescheduleDays,
      window: `created_at ∈ (${input.anchorLabel}, ${input.anchorLabel} + reschedule_days]`,
      window_elapsed_at_compute: input.windowElapsedAtCompute,
    },
    attempts_basis: "retention_attempts rows attributed to this appointment (coverage bounded by the module fetch window)",
    final_contact_status_basis: "retention_appointment_outcomes row where one exists (the spoken-with split reads it)",
    identity_basis: "stage-2 chain: acuity/appointment link (client-mediated)",
    write_once_basis: "session_at / session_date_et / detected_at are copied at detection and never moved — a later cancellation or reschedule never deletes the row",
  };
}
