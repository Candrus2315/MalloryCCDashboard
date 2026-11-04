/**
 * CALL-SOURCE SWITCH (W3) — hl_call_records becomes the SOURCE OF TRUTH for
 * rep + team call KPIs (owner directive 2026-11-04, session 2 of 2; spec
 * /home/team/shared/call-source-implementation-spec.md §W3).
 *
 * What changed and why:
 *   - Every rep/team call KPI now reads the RAW HighLevel call export
 *     (hl_call_records, ingested by the W1 tick + Nov-1 backfill) instead of
 *     the legacy `calls` mirror. Rows are mapped to the SAME CallRow shape the
 *     metrics engine (metrics/compute.ts) already consumes — Total Calls =
 *     every TYPE_CALL record in the ET business-day window (attempts
 *     included, exactly the old definition), Over-2-Min stays
 *     duration>threshold, Pickup Rate keeps its formula.
 *   - TYPE_IVR_CALL records are EXCLUDED from rep AND team call totals
 *     everywhere (system/IVR calls were never agent work).
 *   - Null-user records (HL userId NULL — inbound/unclaimed) are a TEAM-LEVEL
 *     bucket: they count in team call totals (applyTeamCallScope) but NEVER
 *     attach to a rep (rep pages/rows drop them via applyRosterEligibility).
 *   - Range windows are the EXISTING ET business-day bounds
 *     (etDayStartUtc/etDayEndUtc on date_added, America/New_York) — no UTC
 *     drift: a 23:00 ET call buckets to its ET date, never the next day.
 *
 * The Nov-1 boundary (loadCallKpiRows): the owner-approved backfill floor is
 * 2026-11-01T00:00:00-05:00 (scripts/backfill-hl-call-records.ts
 * BACKFILL_FLOOR_ISO) — NO earlier history was requested. Windows that begin
 * before that instant therefore still draw the pre-floor slice from the
 * legacy `calls` mirror (same rows the dashboard always showed), and the
 * [floor, …) slice comes from hl_call_records. The slices partition by
 * instant (legacy rows strictly BEFORE the floor, hl rows at/after it), so
 * the same call can never double-count and pre-Nov ranges keep their
 * historical numbers ("nothing else may break" — spec §W3).
 *
 * Booking logic is UNTOUCHED: attribution joins, the attribution engine and
 * every booking count keep reading the legacy `calls` table (attribution
 * call ids reference it) — only the CALL KPI rows switched sources.
 */

import type { CallRow } from "./compute";
import { etDayStartUtc, etDayEndUtc } from "../date-logic";
import { eligibleRepId, type RosterEligibility } from "../roster";
import type { HlCallRecordRow } from "../store/types/rows-core";

/** The owner-set backfill floor — 2026-11-01T00:00:00-05:00, as an ISO instant. */
export const HL_CALL_RECORDS_FLOOR_ISO = "2026-11-01T05:00:00.000Z";

/** Records whose message_type is a REAL agent/team call (IVR excluded). */
export function typeCallRecords(records: HlCallRecordRow[]): HlCallRecordRow[] {
  return records.filter((r) => r.message_type === "TYPE_CALL");
}

/** Records the W3 switch excludes everywhere (Daily Report's optional IVR line only). */
export function ivrCallRecords(records: HlCallRecordRow[]): HlCallRecordRow[] {
  return records.filter((r) => r.message_type === "TYPE_IVR_CALL");
}

/** external_id → internal user id for HighLevel users (the rep-attribution join). */
export function hlRepMapByExternalId(
  users: { id: string; provider: string; external_id: string }[],
): Map<string, string> {
  return new Map(
    users.filter((u) => u.provider === "highlevel" && u.external_id).map((u) => [u.external_id, u.id]),
  );
}

/**
 * Map raw hl_call_records rows to the metrics engine's CallRow shape.
 *  - rep attribution: user_external_id → users.external_id (provider=highlevel)
 *    → the rep's internal id; NULL or UNKNOWN user → rep_id null (never a rep;
 *    unknown users keep their raw id on provider_rep_external_id so mapping-
 *    driven eligibility can still claim them at query time).
 *  - duration: the raw API reports NULL talk time for attempts without a
 *    connection — mapped to 0, exactly how the legacy calls mirror stores
 *    such attempts, so averages/splits stay comparable (KPI parity pinned).
 *  - started_at = date_added (the W3 day-bucket key; ET bounds applied at
 *    query time — identical instant semantics to the legacy rows).
 */
export function hlCallRecordsToCallRows(
  records: HlCallRecordRow[],
  users: { id: string; provider: string; external_id: string }[],
): CallRow[] {
  const repByExternal = hlRepMapByExternalId(users);
  return records.map((r) => {
    const repId = r.user_external_id ? repByExternal.get(r.user_external_id) ?? null : null;
    return {
      id: r.message_id,
      rep_id: repId,
      contact_id: r.contact_external_id,
      started_at: r.date_added,
      duration_seconds: r.duration_seconds ?? 0,
      over_two_minutes: (r.duration_seconds ?? 0) > 120,
      external_call_id: r.message_id,
      provider_rep_external_id: r.user_external_id,
      conversation_id: r.conversation_id,
      direction: r.direction,
      call_status: r.call_status,
    } satisfies CallRow;
  });
}

/**
 * Keep the rows whose instant falls in the ET business-day window
 * [etDayStartUtc(start), etDayEndUtc(end)) — the SAME bounds every legacy
 * call query applies (pure mirror of the SQL bounds so tests pin the real
 * boundary behavior: a 23:00 ET record belongs to its ET date, never the
 * next UTC day).
 */
export function filterCallRecordRowsInEtRange<T extends { started_at: string }>(
  rows: T[],
  start: string,
  end: string,
): T[] {
  const startUtc = etDayStartUtc(start);
  const endUtc = etDayEndUtc(end);
  return rows.filter((r) => r.started_at >= startUtc && r.started_at < endUtc);
}

/**
 * THE TEAM call scope (owner directive 11/4): roster-eligible reps' rows PLUS
 * the null-user team bucket (HL userId NULL — inbound/unclaimed) — those rows
 * count in TEAM totals but NEVER attach to a rep. Rows whose raw HL user id
 * is known and NOT roster-eligible (non-roster/erased users, mappings aside)
 * still drop from team totals exactly as before.
 * Rep-scoped surfaces keep using roster.applyRosterEligibility, which drops
 * the null-user rows (a null-user row can never be a rep's call).
 */
export function applyTeamCallScope<
  T extends { rep_id: string | null; provider_rep_external_id?: string | null },
>(rows: T[], elig: RosterEligibility): T[] {
  const out: T[] = [];
  for (const r of rows) {
    const rep = eligibleRepId(r, elig);
    if (rep != null) {
      out.push(rep === r.rep_id ? r : { ...r, rep_id: rep });
      continue;
    }
    // Null-user team bucket: rep_id NULL and NO raw HL user id at all.
    if (r.rep_id == null && (r.provider_rep_external_id ?? null) === null) out.push(r);
  }
  return out;
}

// ---------- THE OWNER'S KPI SET (directive 11/4) ----------

export interface CallRecordKpis {
  /** Every TYPE_CALL attempt in scope (voicemail/no-answer/null-duration included). */
  total: number;
  /** direction "outbound". */
  outbound: number;
  /** direction "inbound". */
  inbound: number;
  /** meta.call.status "completed" — spoke with someone (connect-rate numerator). */
  connected: number;
  /** meta.call.status "no-answer". */
  noAnswer: number;
  /** meta.call.status "failed". */
  failed: number;
  /** meta.call.status "busy". */
  busy: number;
  /** meta.call.status "voicemail". */
  voicemail: number;
  /** Any other/unknown status (e.g. "ringing"). */
  otherStatus: number;
  /** no-answer + busy + voicemail — the could-not-connect bucket. */
  missed: number;
  /** Σ talk time seconds over ALL in-scope attempts (null talk time = 0). */
  totalTalkSeconds: number;
  /** totalTalkSeconds ÷ total, rounded — the legacy Average-Call-Duration convention; null when total 0. */
  avgTalkSeconds: number | null;
  /** DISTINCT contact ids contacted (external HL contact ids). */
  uniqueLeadsContacted: number;
  /** total ÷ uniqueLeadsContacted; null when no contacts. */
  callsPerLead: number | null;
  /** connected ÷ total; null when total 0 (renders "—", never a fabricated rate). */
  connectRate: number | null;
}

/**
 * The owner KPI set over one already-scoped row set (TYPE_CALL only, IVR
 * pre-excluded, rep/team scope applied by the caller). Pure — the same
 * function serves rep rows, the team block and the reports.
 */
export function summarizeCallRecordKpis(rows: CallRow[]): CallRecordKpis {
  let total = 0;
  let outbound = 0;
  let inbound = 0;
  let connected = 0;
  let noAnswer = 0;
  let failed = 0;
  let busy = 0;
  let voicemail = 0;
  let otherStatus = 0;
  let totalTalkSeconds = 0;
  const leads = new Set<string>();
  for (const c of rows) {
    total += 1;
    if (c.direction === "outbound") outbound += 1;
    else if (c.direction === "inbound") inbound += 1;
    switch (c.call_status) {
      case "completed": connected += 1; break;
      case "no-answer": noAnswer += 1; break;
      case "failed": failed += 1; break;
      case "busy": busy += 1; break;
      case "voicemail": voicemail += 1; break;
      default: otherStatus += 1; break;
    }
    totalTalkSeconds += c.duration_seconds;
    if (c.contact_id) leads.add(c.contact_id);
  }
  return {
    total,
    outbound,
    inbound,
    connected,
    noAnswer,
    failed,
    busy,
    voicemail,
    otherStatus,
    missed: noAnswer + busy + voicemail,
    totalTalkSeconds,
    avgTalkSeconds: total > 0 ? Math.round(totalTalkSeconds / total) : null,
    uniqueLeadsContacted: leads.size,
    callsPerLead: leads.size > 0 ? total / leads.size : null,
    connectRate: total > 0 ? connected / total : null,
  };
}

/** Calls per booking (owner KPI): the scoped call count ÷ the rep's qualifying bookings; null when 0 bookings (renders "—"). */
export function callsPerBooking(calls: number, qualifyingBookings: number): number | null {
  return qualifyingBookings > 0 ? calls / qualifyingBookings : null;
}

// ---------- THE KPI SOURCE (hl_call_records + the Nov-1 legacy slice) ----------

/** Minimal store surface loadCallKpiRows needs (both stores implement it). */
export interface CallKpiSource {
  getHlCallRecordsBetween(startUtc: string, endUtc: string): Promise<HlCallRecordRow[]>;
  getCallsBetween(startUtc: string, endUtc: string): Promise<CallRow[]>;
}

/**
 * THE call-KPI row loader — the ONE source switch every call-KPI surface
 * goes through. Returns metrics-engine CallRow[] for the window:
 *   - [windowStart, HL floor) → the legacy `calls` mirror (pre-backfill
 *     history the owner kept on purpose — the floor has NO hl records),
 *   - [HL floor, windowEnd)   → hl_call_records, TYPE_CALL only, rep
 *     resolved via users.
 * Partitions by instant — never double-counts, never rewrites a source row.
 */
export async function loadCallKpiRows(input: {
  store: CallKpiSource;
  users: { id: string; provider: string; external_id: string }[];
  startUtc: string;
  endUtc: string;
}): Promise<CallRow[]> {
  const floor = HL_CALL_RECORDS_FLOOR_ISO;
  const legacyEnd = input.endUtc < floor ? input.endUtc : floor;
  const needsLegacy = input.startUtc < floor;
  const [hlRecords, legacyRows] = await Promise.all([
    input.store.getHlCallRecordsBetween(input.startUtc, input.endUtc),
    needsLegacy ? input.store.getCallsBetween(input.startUtc, legacyEnd) : Promise.resolve([] as CallRow[]),
  ]);
  const legacySlice = legacyRows.filter((c) => c.started_at < floor);
  return [
    ...legacySlice,
    ...hlCallRecordsToCallRows(typeCallRecords(hlRecords), input.users),
  ];
}
