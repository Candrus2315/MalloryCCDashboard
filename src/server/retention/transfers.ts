/**
 * RETENTION TRANSFERS LEDGER (stage 5 — owner build order "transfers
 * (original-booker exception)"). The writer that fills the §13-declared
 * retention_transfers table: the queue's transfer rows (?queue=transfers),
 * the Needs Attention stage card, and the This Week Transfers KPI.
 *
 * MANAGEMENT TRACKING ONLY: Laura keeps working in Acuity and GHL exactly as
 * today — this engine OBSERVES appointments already synced into the DB and
 * computes. No new provider API calls: every input is a stored row. It writes
 * ONLY the internal retention_transfers ledger + Data Match Exceptions rows
 * for ambiguous evidence; nothing is ever written back to Acuity/GHL.
 *
 * WHAT A TRANSFER IS (evidence, never inference — owner ruling "never guess"):
 *   the client's session moved to a DIFFERENT service calendar (staff) while
 *   the identity chain holds. v1 evidence channel: the SAME internal client's
 *   cancelled appointment (the ORIGINAL booking, on calendar A) has a
 *   qualifying successor booking created strictly within the reschedule window
 *   (Settings reschedule_days, default 14 — the SAME candidate window the
 *   cancellations ledger derives) on a DIFFERENT KNOWN calendar B.
 *
 *   THE SAME-APPOINTMENT FLAVOR IS DEFERRED (documented honestly): an Acuity
 *   appointment whose own calendar_id changes between sync passes cannot be
 *   observed from stored data — appointments store only the CURRENT calendar
 *   and the acuity upsert rewrites it every sync, so there is no historical
 *   "original booking" calendar to compare against. Building a first-observed
 *   watch table is the follow-up; until it exists the engine never claims a
 *   same-appointment transfer it did not observe. (The owner's build order
 *   accepts honest skeletons over fabricated rows.)
 *
 * AMBIGUITY (owner directive: ambiguous evidence → the Data Match Exceptions
 * queue, NEVER a transfer ledger row):
 *   - the original's calendar is unknown, or
 *   - a candidate's calendar is unknown (cannot prove the staff changed), or
 *   - the candidate pool MIXES same-calendar and cross-calendar successors
 *     (which one is the transfer is not decidable from evidence)
 *   → one insertDataMatchExceptionIfAbsent row (kind transfer_ambiguous,
 *   dedupe key per original appointment) and NO ledger row. A pure
 *   same-calendar pool is NOT ambiguous — it is simply not a transfer (an
 *   ordinary reschedule; the cancellations ledger owns that outcome).
 *
 * ORIGINAL-BOOKER EXCEPTION (the supersession rule, retention-only):
 *   1. The transfer row is attributed to the ORIGINAL appointment's internal
 *      client — the ORIGINAL booker's client series (never the receiving
 *      staff's). The receiving appointment rides the row as evidence and never
 *      gets a row of its own.
 *   2. The candidate pool is same-client BY CONSTRUCTION (the stage-2
 *      identity chain), so a transfer is never asserted across two different
 *      client series — the receiving side cannot fabricate a new client
 *      relationship through this engine. Appointments that failed identity
 *      resolution are counted honestly (unlinkedOriginals / the candidate is
 *      invisible) and left to the stage-2 identity backfill + §7 queue.
 *   3. Supersession is DOCUMENTARY, never destructive: this engine does not
 *      rewrite ret_cancellations / retention_no_shows /
 *      retention_appointment_outcomes (a transfer's original may legitimately
 *      also read "rescheduled" there — both ledgers describe the same facts
 *      from their own angle), and it never touches the core booking
 *      attribution engine or family/booking attribution.
 *
 * IDEMPOTENCE (the stage-4a/4b discipline, content-keyed): diff desired vs
 * stored — inserts + genuine content changes only; UNCHANGED ROWS ARE NEVER
 * REWRITTEN. detected_at / original_calendar_id / original_calendar_name are
 * never part of a content change (write-once; the store COALESCEs them). A row
 * with manual_overrides is NEVER auto-recomputed over (plan §11 discipline).
 * Re-runs write nothing.
 *
 * IDENTITY: appointment → internal client via the stage-2 chain (the
 * acuity/appointment link) — the CLIENT-mediated universe, same as the
 * compute + cancellations + no-shows cohorts. Ledger rows therefore always
 * carry a resolved client (the ORIGINAL booker's side).
 *
 * COVERAGE: the SAME fetch window the whole retention module uses (the shared
 * appointment floor: today − (compute_lookback_days + due_days + 2) ET). An
 * original whose reschedule window begins below the floor has an INCOMPLETE
 * candidate pool — counted honestly (belowFetchFloor), never written (a
 * missing successor below the floor could be the transfer). Cancelled events
 * older than the D13 lookback (today − compute_lookback_days) are counted
 * honestly (outsideWindow) and never written — mirror of the cancellations
 * cohort. NOTE the owner directive 10/21 (RETENTION_DATA_START_ET): the
 * DISPLAY layer filters pre-cutoff rows; this WRITER observes everything in
 * its fetch window so the audit trail stays complete — exactly like every
 * other ret_* writer.
 */
import type { Store, RetentionTransferWrite } from "../store/types";
import { addDays, etDateStrFromInstant, etDayStartUtc } from "../date-logic";
import { appointmentInScope } from "../metrics/availability";

export const RETENTION_TRANSFERS_VERSION = 1;

/** The v1 detection channel recorded on every ledger row's basis column. */
export const TRANSFER_BASIS = "rebooked_other_calendar";

/** The detection basis, verbatim for the notes evidence. */
export const TRANSFER_DETECTION_BASIS =
  "the SAME internal client's cancelled original booking (calendar A) has a qualifying successor created strictly within the reschedule window on a DIFFERENT known calendar B — evidence from stored rows, never inferred";

/** The exceptions-queue kind for ambiguous transfer evidence. */
export const TRANSFER_AMBIGUOUS_KIND = "transfer_ambiguous";

export interface TransferCandidate {
  appointmentId: string;
  acuityAppointmentId: string;
  calendarId: string | null;
  calendarName: string | null;
  createdAtIso: string;
  appointmentDatetimeIso: string;
  appointmentType: string | null;
}

export type TransferDerivation =
  | { kind: "transfer"; receiving: TransferCandidate; selectionRule: string }
  | { kind: "not_transfer"; rule: string }
  | { kind: "ambiguous"; rule: string };

/**
 * Pure transfer derivation for ONE cancelled original (deterministic + total).
 * The candidate pool must already be the cancellations engine's window
 * (created strictly after cancelled_at within reschedule_days, qualifying,
 * same client, not the original itself). Every fact combination maps to
 * exactly one outcome — never a guess.
 */
export function deriveTransfer(input: {
  originalCalendarId: string | null;
  candidates: TransferCandidate[];
}): TransferDerivation {
  const { originalCalendarId, candidates } = input;
  const ordered = [...(candidates ?? [])].sort((a, b) => {
    const d = Date.parse(a.createdAtIso) - Date.parse(b.createdAtIso);
    return d !== 0 ? d : a.acuityAppointmentId.localeCompare(b.acuityAppointmentId);
  });
  if (ordered.length === 0) {
    return {
      kind: "not_transfer",
      rule: "no qualifying successor within the reschedule window — the client did not rebook; the cancellations ledger owns this outcome",
    };
  }
  if (originalCalendarId == null) {
    return {
      kind: "ambiguous",
      rule: "the original booking's calendar is unknown — the staff change can be neither proven nor refuted (ambiguous evidence → the Data Match Exceptions queue)",
    };
  }
  const same = ordered.filter((c) => c.calendarId != null && c.calendarId === originalCalendarId);
  const cross = ordered.filter((c) => c.calendarId != null && c.calendarId !== originalCalendarId);
  const unknown = ordered.filter((c) => c.calendarId == null);
  if (unknown.length > 0) {
    return {
      kind: "ambiguous",
      rule: "a successor's calendar is unknown — the staff change can be neither proven nor refuted (ambiguous evidence → the Data Match Exceptions queue)",
    };
  }
  if (same.length > 0 && cross.length > 0) {
    return {
      kind: "ambiguous",
      rule: "the candidate pool mixes same-calendar and cross-calendar successors — which one is the transfer is not decidable from evidence (ambiguous evidence → the Data Match Exceptions queue)",
    };
  }
  if (cross.length > 0) {
    // earliest cross-calendar rebooking wins; tiebreak acuity id (the SAME
    // deterministic order the cancellations + no-shows derivations use)
    const chosen = cross[0];
    return {
      kind: "transfer",
      receiving: chosen,
      selectionRule:
        "earliest cross-calendar rebooking after the cancellation within the reschedule window (tiebreak acuity id); candidates ordered by created_at then acuity id",
    };
  }
  return {
    kind: "not_transfer",
    rule: "every successor rebooked the SAME calendar — an ordinary reschedule, not a staff transfer; the cancellations ledger owns this outcome",
  };
}

export interface RetentionTransfersResult {
  outcome: "synced";
  /** Cancelled originals evaluated inside the lookback window (client resolved). */
  transfersEvaluated: number;
  /** In-scope originals whose client could not be resolved — counted honestly, never written (identity backfill owns them). */
  unlinkedOriginals: number;
  unlinkedAcuityIds: string[];
  /** Originals whose reschedule window begins below the module fetch floor — the candidate pool is incomplete, never written (honest count). */
  belowFetchFloor: number;
  /** Originals cancelled before the module lookback (outsideWindow) + existing ledger rows whose original is no longer fetched — left untouched, never re-derived from missing data. */
  outsideWindow: number;
  /** Cancelled rows with no cancelled_at stamp — no timeline anchor, never written. */
  missingCancelledAt: number;
  /** Ambiguous-evidence originals NEWLY queued this pass (Data Match Exceptions). */
  ambiguousQueued: number;
  /** Ambiguous-evidence originals already sitting in the queue (deduped). */
  alreadyQueued: number;
  /** Plain same-calendar reschedules — not transfers, not ambiguous (the cancellations ledger owns them). */
  notTransfers: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Rows with management overrides — skipped by the automatic writer (never recomputed over). */
  skippedOverrides: number;
  window: { sinceDate: string; thruDate: string };
  computedAtIso: string;
}

interface ApptSourceRow {
  id: string;
  acuity_appointment_id: string | null;
  calendar_id: string | null;
  calendar_name: string | null;
  appointment_datetime: string;
  created_at: string;
  appointment_type: string | null;
  status: string;
  cancelled: boolean;
  cancelled_at: string | null;
}

/** Fetch floor: the SAME shape compute.ts / cancellations.ts / no-shows.ts use (lookback + due span + 2 ET days of margin) — one shared window for the module. */
function fetchFloorIso(todayEt: string, lookbackDays: number, dueDays: number): string {
  return etDayStartUtc(addDays(todayEt, -(lookbackDays + dueDays + 2)));
}

/**
 * Compute + persist the transfers ledger. Injectable clock for tests;
 * everything else reads from the store. Never called from the UI (the
 * "do not write to retention tables from the UI" rule) — the tick owns it.
 */
export async function computeRetentionTransfers(store: Store, options?: { now?: () => Date }): Promise<RetentionTransfersResult> {
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
  const rescheduleDays = retention.reschedule_days ?? 14;
  const todayEt = etDateStrFromInstant(nowMs);
  const sinceDate = addDays(todayEt, -retention.compute_lookback_days);
  const floorIso = fetchFloorIso(todayEt, retention.compute_lookback_days, retention.due_days);
  const floorMs = Date.parse(floorIso);
  const sinceMs = Date.parse(etDayStartUtc(sinceDate));

  const [appts, links, clients, existing] = await Promise.all([
    store.getAppointmentsWithClientsSince(floorIso) as Promise<(ApptSourceRow & { raw?: Record<string, unknown> | null })[]>,
    store.listClientMatchLinks(),
    store.listInternalClients(),
    store.listRetentionTransfers(),
  ]);

  const clientByAppointment = new Map<string, string>(); // acuity_appointment_id → internal client id
  for (const l of links) {
    if (l.provider === "acuity" && l.entity === "appointment") clientByAppointment.set(l.external_id, l.internal_client_id);
  }
  const ghlByClient = new Map<string, string | null>();
  for (const c of clients) ghlByClient.set(c.id, c.ghl_contact_external_id ?? null);

  const statuses = new Set(retention.qualifying_statuses.length ? retention.qualifying_statuses : ["scheduled"]);
  const inScope = (a: ApptSourceRow & { raw?: Record<string, unknown> | null }): boolean => {
    try {
      return appointmentInScope(a as unknown as Parameters<typeof appointmentInScope>[0], settings.acuity);
    } catch {
      return false;
    }
  };

  // ---- qualifying pool (successor candidates): the SAME shape the
  // ---- cancellations engine scans — non-cancelled, qualifying status, in
  // ---- scope, client resolved, parseable created_at. Plus calendar identity
  // ---- for the staff-change comparison.
  const qualifyingByClient = new Map<string, TransferCandidate[]>();
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
      calendarId: a.calendar_id ?? null,
      calendarName: a.calendar_name ?? null,
      createdAtIso: a.created_at,
      appointmentDatetimeIso: a.appointment_datetime,
      appointmentType: a.appointment_type ?? null,
    });
    qualifyingByClient.set(clientId, list);
  }

  // ---- cohort: the D13-style lookback pass over the cancelled originals ----
  const cohort: (ApptSourceRow & { cancelledAtMs: number; internalClientId: string })[] = [];
  const unlinkedAcuityIds: string[] = [];
  let belowFetchFloor = 0;
  let outsideWindow = 0;
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
    if (!Number.isFinite(cAt)) {
      missingCancelledAt += 1;
      continue;
    }
    if (cAt < floorMs) {
      belowFetchFloor += 1; // reschedule window begins below the fetch floor — the successor pool is incomplete, never derived
      continue;
    }
    if (cAt < sinceMs || cAt > nowMs) {
      outsideWindow += 1; // outside the D13 lookback — counted, never written
      continue;
    }
    const clientId = clientByAppointment.get(a.acuity_appointment_id) ?? null;
    if (!clientId) {
      unlinkedAcuityIds.push(a.acuity_appointment_id);
      continue; // honest count; stage-2 identity backfill owns these
    }
    cohort.push({ ...a, cancelledAtMs: cAt, internalClientId: clientId });
  }
  unlinkedAcuityIds.sort();

  // ---- derive + diff-write (deterministic order: cancelled_at then acuity id) ----
  const existingByAppointment = new Map(existing.map((r) => [r.appointment_id, r]));
  const apptById = new Map(appts.map((a) => [a.id, a]));
  const { sameInstant, canonicalJson } = await import("./compute");
  const writes: RetentionTransferWrite[] = [];
  const skippedOverrides = existing.reduce((n, r) => {
    const mo = r.manual_overrides;
    return n + (mo && typeof mo === "object" && Object.keys(mo).length > 0 ? 1 : 0);
  }, 0);

  // EXISTING rows first: re-derive the receiving side from CURRENT facts. A
  // row whose original fell out of the fetch window is left untouched (never
  // re-derived from missing data — counted honestly). A confirmed transfer is
  // never deleted: if the current derivation says ambiguous/not_transfer the
  // row stands (the detection evidence was real when confirmed; the audit
  // trail stays complete). Overrides are skipped (plan §11 discipline).
  let existingOutsideWindow = 0;
  for (const row of [...existing].sort((a, b) => (a.detected_at < b.detected_at ? -1 : a.detected_at > b.detected_at ? 1 : a.appointment_id < b.appointment_id ? -1 : 1))) {
    if (row.manual_overrides && typeof row.manual_overrides === "object" && Object.keys(row.manual_overrides).length > 0) continue;
    const appt = apptById.get(row.appointment_id);
    if (!appt || !appt.cancelled || appt.cancelled_at == null) {
      existingOutsideWindow += 1;
      continue;
    }
    const cAtMs = Date.parse(appt.cancelled_at);
    if (!Number.isFinite(cAtMs)) {
      existingOutsideWindow += 1;
      continue;
    }
    const pool = qualifyingByClient.get(row.internal_client_id ?? "") ?? [];
    const candidates = pool.filter(
      (c) =>
        c.appointmentId !== appt.id &&
        c.acuityAppointmentId !== appt.acuity_appointment_id && // never the original row itself
        Date.parse(c.createdAtIso) > cAtMs &&
        Date.parse(c.createdAtIso) <= cAtMs + rescheduleDays * 24 * 3_600_000,
    );
    const derivation = deriveTransfer({ originalCalendarId: appt.calendar_id ?? null, candidates });
    const receiving = derivation.kind === "transfer" ? derivation.receiving : null;
    writes.push({
      appointmentId: row.appointment_id,
      internalClientId: row.internal_client_id,
      ghlContactExternalId: row.ghl_contact_external_id,
      originalCalendarId: row.original_calendar_id ?? appt.calendar_id ?? null,
      originalCalendarName: row.original_calendar_name ?? appt.calendar_name ?? null,
      receivingAppointmentId: receiving?.appointmentId ?? row.receiving_appointment_id,
      receivingCalendarId: receiving?.calendarId ?? row.receiving_calendar_id,
      receivingCalendarName: receiving?.calendarName ?? row.receiving_calendar_name,
      detectedAtIso: row.detected_at, // write-once: the store preserves it on update
      basis: row.basis,
      notes: buildNotes({
        version: RETENTION_TRANSFERS_VERSION,
        original: appt,
        internalClientId: row.internal_client_id,
        derivation,
        rescheduleDays,
        candidates,
        confirmed: true,
      }),
    });
  }
  outsideWindow += existingOutsideWindow;

  // NEW detections: the cohort pass. A derivation that is ambiguous queues a
  // Data Match Exceptions row (if-absent) and writes NO ledger row.
  let ambiguousQueued = 0;
  let alreadyQueued = 0;
  let notTransfers = 0;
  const orderedCohort = [...cohort].sort((a, b) =>
    a.cancelledAtMs !== b.cancelledAtMs ? a.cancelledAtMs - b.cancelledAtMs : String(a.acuity_appointment_id).localeCompare(String(b.acuity_appointment_id)),
  );
  for (const appt of orderedCohort) {
    if (existingByAppointment.has(appt.id)) continue;
    const pool = qualifyingByClient.get(appt.internalClientId) ?? [];
    const candidates = pool.filter(
      (c) =>
        c.appointmentId !== appt.id &&
        c.acuityAppointmentId !== appt.acuity_appointment_id && // never the original row itself
        Date.parse(c.createdAtIso) > appt.cancelledAtMs &&
        Date.parse(c.createdAtIso) <= appt.cancelledAtMs + rescheduleDays * 24 * 3_600_000,
    );
    const derivation = deriveTransfer({ originalCalendarId: appt.calendar_id ?? null, candidates });
    if (derivation.kind === "ambiguous") {
      const exc = await store.insertDataMatchExceptionIfAbsent({
        kind: TRANSFER_AMBIGUOUS_KIND,
        dedupeKey: `transfer-ambiguous:${appt.id}`,
        payload: {
          subject: { appointment_id: appt.id, acuity_appointment_id: appt.acuity_appointment_id, calendar_id: appt.calendar_id, calendar_name: appt.calendar_name },
          internal_client_id: appt.internalClientId,
          candidates: candidates.map((c) => ({
            appointment_id: c.appointmentId,
            acuity_appointment_id: c.acuityAppointmentId,
            calendar_id: c.calendarId,
            calendar_name: c.calendarName,
            created_at: c.createdAtIso,
            session: c.appointmentDatetimeIso,
          })),
          ambiguity_rule: derivation.rule,
          derived_by: `retention-transfers v${RETENTION_TRANSFERS_VERSION}`,
          detection_basis: TRANSFER_DETECTION_BASIS,
        },
        context: { appointment_id: appt.id, internal_client_id: appt.internalClientId, origin: "retention-transfers" },
      });
      if (exc.created) ambiguousQueued += 1;
      else alreadyQueued += 1;
      continue;
    }
    if (derivation.kind === "not_transfer") {
      notTransfers += 1;
      continue; // ordinary reschedule / no rebooking — the cancellations ledger owns it
    }
    const receiving = derivation.receiving;
    writes.push({
      appointmentId: appt.id,
      internalClientId: appt.internalClientId, // ORIGINAL-BOOKER EXCEPTION: the ORIGINAL booker's client series
      ghlContactExternalId: ghlByClient.get(appt.internalClientId) ?? null,
      originalCalendarId: appt.calendar_id,
      originalCalendarName: appt.calendar_name,
      receivingAppointmentId: receiving.appointmentId,
      receivingCalendarId: receiving.calendarId,
      receivingCalendarName: receiving.calendarName,
      detectedAtIso: now().toISOString(),
      basis: TRANSFER_BASIS,
      notes: buildNotes({
        version: RETENTION_TRANSFERS_VERSION,
        original: appt,
        internalClientId: appt.internalClientId,
        derivation,
        rescheduleDays,
        candidates,
        confirmed: false,
      }),
    });
  }

  // ---- idempotent write: diff desired vs stored (content-keyed) ----
  const toInsert: RetentionTransferWrite[] = [];
  const toUpdate: RetentionTransferWrite[] = [];
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
      sameInstant(cur.original_calendar_id ?? null, w.originalCalendarId) &&
      (cur.original_calendar_name ?? null) === (w.originalCalendarName ?? null) &&
      (cur.receiving_appointment_id ?? null) === (w.receivingAppointmentId ?? null) &&
      sameInstant(cur.receiving_calendar_id ?? null, w.receivingCalendarId) &&
      (cur.receiving_calendar_name ?? null) === (w.receivingCalendarName ?? null) &&
      cur.basis === w.basis &&
      canonicalJson(cur.notes ?? null) === canonicalJson(w.notes);
    if (same) unchanged += 1;
    else toUpdate.push(w);
  }
  const inserted = toInsert.length ? await store.insertRetentionTransfers(toInsert) : 0;
  for (const u of toUpdate) await store.updateRetentionTransfer(u);

  return {
    outcome: "synced",
    transfersEvaluated: cohort.length,
    unlinkedOriginals: unlinkedAcuityIds.length,
    unlinkedAcuityIds,
    belowFetchFloor,
    outsideWindow,
    missingCancelledAt,
    ambiguousQueued,
    alreadyQueued,
    notTransfers,
    inserted,
    updated: toUpdate.length,
    unchanged,
    skippedOverrides,
    window: { sinceDate, thruDate: todayEt },
    computedAtIso: now().toISOString(),
  };
}

/** The engine's derivation evidence, verbatim (audit per owner spec §17). */
function buildNotes(input: {
  version: number;
  original: ApptSourceRow;
  internalClientId: string | null;
  derivation: TransferDerivation;
  rescheduleDays: number;
  candidates: TransferCandidate[];
  confirmed: boolean;
}): Record<string, unknown> {
  const receiving = input.derivation.kind === "transfer" ? input.derivation.receiving : null;
  const selectionRule = input.derivation.kind === "transfer" ? input.derivation.selectionRule : null;
  const ambiguityRule = input.derivation.kind === "ambiguous" ? input.derivation.rule : null;
  const notTransferRule = input.derivation.kind === "not_transfer" ? input.derivation.rule : null;
  return {
    derived_by: `retention-transfers v${input.version}`,
    acuity_appointment_id: input.original.acuity_appointment_id,
    original_status: input.original.status,
    original_calendar_id: input.original.calendar_id,
    original_calendar_name: input.original.calendar_name,
    detection_basis: TRANSFER_DETECTION_BASIS,
    basis_rule: selectionRule ?? ambiguityRule ?? notTransferRule ?? null,
    // ORIGINAL-BOOKER EXCEPTION: internal_client_id is the ORIGINAL booking's
    // client series (the identity chain resolves through the original
    // appointment); the receiving appointment is recorded as evidence below
    // and never gets a ledger row of its own. Cross-client candidates are
    // structurally impossible (the pool is same-client by construction).
    original_booker_exception:
      "row attributed to the ORIGINAL appointment's internal client (the original booker's client series); the receiving appointment rides this row as evidence and never gets its own row; cross-client assertions are structurally impossible (same-client candidate pool)",
    internal_client_id: input.internalClientId,
    receiving_appointment: receiving
      ? { appointment_id: receiving.appointmentId, acuity_appointment_id: receiving.acuityAppointmentId, calendar_id: receiving.calendarId, calendar_name: receiving.calendarName, created_at: receiving.createdAtIso, session: receiving.appointmentDatetimeIso }
      : null,
    reschedule_rule: {
      reschedule_days: input.rescheduleDays,
      window: "created_at ∈ (cancelled_at, cancelled_at + reschedule_days] — the SAME candidate window the cancellations ledger derives",
      candidates: input.candidates.map((c) => ({
        appointment_id: c.appointmentId,
        acuity_appointment_id: c.acuityAppointmentId,
        calendar_id: c.calendarId,
        calendar_name: c.calendarName,
        created_at: c.createdAtIso,
        session: c.appointmentDatetimeIso,
        same_calendar_as_original: c.calendarId != null && c.calendarId === input.original.calendar_id,
      })),
      confirmed_at_detect: input.confirmed,
    },
    identity_basis: "stage-2 chain: acuity/appointment link (client-mediated) — resolved through the ORIGINAL appointment",
    write_once_basis: "detected_at / original_calendar_id / original_calendar_name are copied at detection and never moved — a later re-derivation never deletes or re-anchors the row",
    display_note:
      "owner directive 10/21: the DISPLAY layer filters pre-cutoff rows via inRetentionDataScope on the ORIGINAL appointment's session instant; this writer observes everything in its fetch window so the audit trail stays complete",
  };
}
