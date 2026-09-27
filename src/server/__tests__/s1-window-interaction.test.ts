/**
 * S1 WINDOW-INTERACTION OWNERSHIP tests (owner-frozen rule, 2026-09-27).
 *
 * s1: when the >threshold rule produces NO verdict, rep ownership = the
 * most-recent VERIFIED ROSTER-REP interaction within the SAME date-granularity
 * window (booking creation ET date + prior ET day), REGARDLESS of duration —
 * a 30-second dial is workflow evidence. Evidence = normalized calls (rep
 * resolved through the roster machinery) + harvested conversation interactions
 * (parent-conversation user ownership, pre-resolved by the caller).
 * Pins:
 *  - NO all-time fallback (s2 stays diagnostic-only in scratch) — a call
 *    outside the window NEVER owns, whatever its age or duration;
 *  - NO fuzzy identity (candidates come from the strict identity tiers only);
 *  - unverified reps (not on the active roster) are not evidence;
 *  - multi-rep in-window evidence → AMBIGUOUS (manual queue), never a pick;
 *  - ">2 MIN SEPARATION": the s1 layer never touches the >threshold verdicts,
 *    and bookingsFromOverThresholdCalls (Conversation Conversion numerator)
 *    keeps counting ONLY >threshold owned bookings (the 49-of-79 shape).
 */
import { describe, expect, test } from "bun:test";
import {
  matchAppointmentsToCalls,
  type AttributionAppointment,
  type AttributionCall,
  type AttributionContact,
  type AttributionHarvestInteraction,
} from "../metrics/attribution";
import { attributionStateOf, bookingsFromOverThresholdCalls, type AppointmentRow, type AttributionRow, type CallRow } from "../metrics/compute";
import { toAttributionRows } from "../sync/attribution-tick";

const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24 };
// Booking created Mon 2026-09-28 10:00 ET → window = ET dates 09-27..09-28.
const CREATED_AT = "2026-09-28T14:00:00.000Z";
const IN_WINDOW = "2026-09-27T18:00:00.000Z"; // ET 2026-09-27 14:00 (prior day)
const IN_WINDOW_LATER = "2026-09-28T13:00:00.000Z"; // ET 2026-09-28 09:00 (creation day)
const ALL_TIME_ONLY = "2026-09-25T18:00:00.000Z"; // ET 2026-09-25 — OUTSIDE the window

let seq = 0;
const appt = (over: Partial<AttributionAppointment> = {}): AttributionAppointment => {
  seq += 1;
  return {
    id: `s1-appt-${seq}`,
    contact_id: null,
    client_phone: null,
    client_email: null,
    appointment_datetime: CREATED_AT,
    created_at: CREATED_AT,
    ...over,
  };
};
const call = (external_call_id: string, over: Partial<AttributionCall> = {}): AttributionCall => ({
  external_call_id,
  rep_id: null,
  contact_id: null,
  started_at: IN_WINDOW,
  duration_seconds: 600,
  ...over,
});
const contact = (id: string, over: Partial<AttributionContact> = {}): AttributionContact => ({ id, ...over });
const harvest = (id: string, over: Partial<AttributionHarvestInteraction> = {}): AttributionHarvestInteraction => ({
  id,
  contact_external_id: null,
  rep_id: null,
  started_at: IN_WINDOW,
  duration_seconds: null,
  ...over,
});
const USERS = [{ id: "rep-1", is_active: true }, { id: "rep-2", is_active: true }];

describe("s1 window-interaction ownership (owner-frozen rule)", () => {
  test("sub-threshold (30s) in-window call from a verified roster rep ATTRIBUTES (chain-1 shape)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-short", { contact_id: "c-1", rep_id: "rep-1", duration_seconds: 30 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("window_interaction");
    expect(got.callExternalId).toBe("hl-short");
    expect(got.repId).toBe("rep-1");
    expect(got.evidence?.source).toBe("calls");
    expect(got.evidence?.duration_seconds).toBe(30);
  });

  test("duration is irrelevant for OWNERSHIP: a 0-second dial in-window still owns", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-zero", { contact_id: "c-1", rep_id: "rep-1", duration_seconds: 0 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("window_interaction");
  });

  test("NO ALL-TIME FALLBACK: out-of-window evidence never owns (s2 stays diagnostic-only)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-old", { contact_id: "c-1", rep_id: "rep-1", started_at: ALL_TIME_ONLY, duration_seconds: 0 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("no-qualifying-call");
  });

  test("UNVERIFIED rep is not evidence: sub-threshold call from a non-roster rep stays unattributed", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-outsider", { contact_id: "c-1", rep_id: "rep-ghost", duration_seconds: 30 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS }, // rep-ghost is NOT an active roster user
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("no-qualifying-call");
  });

  test("harvest interaction (parent-conversation user ownership) attributes when pre-resolved", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [],
      [contact("c-1", { external_id: "hl-cnt-1" })],
      SETTINGS,
      { users: USERS, s1Interactions: [harvest("msg-1", { contact_external_id: "hl-cnt-1", rep_id: "rep-1" })] },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("window_interaction");
    expect(got.callExternalId).toBe("msg-1");
    expect(got.evidence?.source).toBe("harvest");
  });

  test("UNRESOLVED harvest user (rep null) is never evidence — no auto-assignment", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [],
      [contact("c-1", { external_id: "hl-cnt-1" })],
      SETTINGS,
      { users: USERS, s1Interactions: [harvest("msg-2", { contact_external_id: "hl-cnt-1", rep_id: null })] },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("no-qualifying-call");
  });

  test("MULTI-REP in-window evidence is AMBIGUOUS — never a silent most-recent pick", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [
        call("hl-a", { contact_id: "c-1", rep_id: "rep-1", started_at: IN_WINDOW, duration_seconds: 30 }),
        call("hl-b", { contact_id: "c-1", rep_id: "rep-2", started_at: IN_WINDOW_LATER, duration_seconds: 20 }),
      ],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("ambiguous");
    expect(got.detail ?? "").toContain("2 distinct roster reps");
    // the stored state reads AMBIGUOUS through the ONE classifier (S5b invariant)
    const [row] = toAttributionRows([got], [], new Map()).rows;
    expect(attributionStateOf(row)).toBe("ambiguous");
  });

  test("window edges: prior-day (created−1 ET) evidence qualifies, created−2 does not", () => {
    const onPriorDay = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-edge-in", { contact_id: "c-1", rep_id: "rep-1", started_at: IN_WINDOW, duration_seconds: 10 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    )[0];
    expect(onPriorDay.status).toBe("attributed");
    const tooEarly = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-edge-out", { contact_id: "c-1", rep_id: "rep-1", started_at: "2026-09-26T18:00:00.000Z", duration_seconds: 10 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    )[0];
    expect(tooEarly.status).toBe("unattributed");
  });

  test("most-recent in-window interaction wins; ties break deterministically by evidence id", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [
        call("hl-earlier", { contact_id: "c-1", rep_id: "rep-1", started_at: IN_WINDOW, duration_seconds: 30 }),
        call("hl-later", { contact_id: "c-1", rep_id: "rep-1", started_at: IN_WINDOW_LATER, duration_seconds: 15 }),
      ],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(got.callExternalId).toBe("hl-later");
  });

  test(">THRESHOLD verdicts are untouched: a qualifying call still attributes via contact_id (not s1)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-long", { contact_id: "c-1", rep_id: "rep-1", duration_seconds: 300 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("contact_id");
  });

  test(">2MIN SEPARATION: only the >threshold-owned booking enters the conversion numerator", () => {
    const long = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-long", { contact_id: "c-1", rep_id: "rep-1", duration_seconds: 300 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    )[0];
    const short = matchAppointmentsToCalls(
      [appt({ contact_id: "c-2" })],
      [call("hl-short", { contact_id: "c-2", rep_id: "rep-1", duration_seconds: 30 })],
      [contact("c-2")],
      SETTINGS,
      { users: USERS },
    )[0];
    const callIdByExternalId = new Map([
      ["hl-long", "call-internal-long"],
      ["hl-short", "call-internal-short"],
    ]);
    const { rows } = toAttributionRows([long, short], [], callIdByExternalId);
    const calls: CallRow[] = [
      {
        id: "call-internal-long",
        provider: "highlevel",
        external_call_id: "hl-long",
        rep_id: "rep-1",
        contact_id: "c-1",
        direction: "outbound",
        call_status: "completed",
        started_at: IN_WINDOW,
        duration_seconds: 300,
        over_two_minutes: true,
      },
      {
        id: "call-internal-short",
        provider: "highlevel",
        external_call_id: "hl-short",
        rep_id: "rep-1",
        contact_id: "c-2",
        direction: "outbound",
        call_status: "completed",
        started_at: IN_WINDOW,
        duration_seconds: 30,
        over_two_minutes: false,
      },
    ];
    const appts: AppointmentRow[] = [
      { id: long.appointmentId, provider: "acuity", acuity_appointment_id: "a1", calendar_name: "MALLORY PORTRAITS", appointment_type: "Consult", appointment_datetime: CREATED_AT, created_at: CREATED_AT, duration_minutes: 60, status: "scheduled", cancelled: false, contact_id: "c-1", client_name: "A", client_phone: null, client_email: null },
      { id: short.appointmentId, provider: "acuity", acuity_appointment_id: "a2", calendar_name: "MALLORY PORTRAITS", appointment_type: "Consult", appointment_datetime: CREATED_AT, created_at: CREATED_AT, duration_minutes: 60, status: "scheduled", cancelled: false, contact_id: "c-2", client_name: "B", client_phone: null, client_email: null },
    ] as unknown as AppointmentRow[];
    const over = bookingsFromOverThresholdCalls(appts, rows, calls, 120);
    expect(over.map((a) => a.id)).toEqual([long.appointmentId]); // the s1 booking does NOT leak in
    // and both rows still classify as ATTRIBUTED (ownership vs >2min are separate axes)
    expect(attributionStateOf(rows[0])).toBe("attributed");
    expect(attributionStateOf(rows[1])).toBe("attributed");
  });

  test("s1 row carries an auditable note (evidence + window) that never reads as ambiguous", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-note", { contact_id: "c-1", rep_id: "rep-1", duration_seconds: 30 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    const [row] = toAttributionRows([got], [], new Map([["hl-note", "internal-1"]])).rows;
    expect(row.note ?? "").toMatch(/^s1 window-interaction src=calls evidence=hl-note dur=30/);
    expect(attributionStateOf(row)).toBe("attributed");
    expect(row.call_id).toBe("internal-1"); // internal calls.id join preserved for metrics
  });
});
