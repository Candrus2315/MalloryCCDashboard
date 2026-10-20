/**
 * RETENTION DUE-WINDOW + ATTRIBUTION tests (stage 2, plan §8; rulings D6/D8/D11/D12).
 * All day math is ET (date-logic helpers).
 */
import { describe, expect, test } from "bun:test";
import {
  attributeCall,
  attributionWindow,
  contactDueDate,
  qualifyingAppointmentsByDueDate,
  type ApptForAttribution,
  type CallForAttribution,
} from "../retention/attribution";

const DUE_DAYS = 7;
// 2026-10-26 10:00 ET = 14:00Z (EDT, UTC-4)
const APPT_1026: ApptForAttribution = {
  appointmentId: "appt-1",
  acuityAppointmentId: "1780095979",
  appointmentDatetimeIso: "2026-10-26T14:00:00Z",
  status: "scheduled",
};
const APPT_1030: ApptForAttribution = {
  appointmentId: "appt-2",
  acuityAppointmentId: "1780095980",
  appointmentDatetimeIso: "2026-10-30T15:00:00Z",
  status: "scheduled",
};

describe("contactDueDate — the 7-day excitement-call rule", () => {
  test("appointment 10/26 ET → due date 10/19 ET (calendar days)", () => {
    expect(contactDueDate(APPT_1026.appointmentDatetimeIso, DUE_DAYS)).toBe("2026-10-19");
  });

  test("month boundary", () => {
    // 2026-11-03 10:00 ET → due 2026-10-27
    expect(contactDueDate("2026-11-03T15:00:00Z", DUE_DAYS)).toBe("2026-10-27");
  });

  test("due date crosses DST correctly (calendar, not 24h×N)", () => {
    // DST ends 2026-11-01. 2026-11-08 09:00 EST = 14:00Z → ET date 11-08 − 7 = 11-01.
    expect(contactDueDate("2026-11-08T14:00:00Z", DUE_DAYS)).toBe("2026-11-01");
  });
});

describe("qualifyingAppointmentsByDueDate — D6 population (ruling B)", () => {
  test("status filter + cancelled exclusion + due-date range bucketing", () => {
    const appts: ApptForAttribution[] = [
      APPT_1026,
      { ...APPT_1030, status: "cancelled", cancelled: true },
      { appointmentId: "appt-3", acuityAppointmentId: "x3", appointmentDatetimeIso: "2026-10-28T14:00:00Z", status: "scheduled" },
      { appointmentId: "appt-4", acuityAppointmentId: "x4", appointmentDatetimeIso: "2026-10-27T14:00:00Z", status: "completed" },
    ];
    const pop = qualifyingAppointmentsByDueDate(appts, { dueDays: DUE_DAYS, qualifyingStatuses: ["scheduled"], rangeStart: "2026-10-19", rangeEnd: "2026-10-19" });
    expect(pop.map((p) => p.appointment.appointmentId)).toEqual(["appt-1"]);
    expect(pop[0].contactDueDate).toBe("2026-10-19");
    // window = [appt − 7×24h, appt)
    const w = attributionWindow(APPT_1026.appointmentDatetimeIso, DUE_DAYS);
    expect(pop[0].windowStartMs).toBe(w.startMs);
    expect(pop[0].windowEndMs).toBe(Date.parse(APPT_1026.appointmentDatetimeIso));
  });
});

describe("attributeCall — window / nearest-future / unattributed", () => {
  const windows = qualifyingAppointmentsByDueDate([APPT_1026, APPT_1030], { dueDays: DUE_DAYS });
  const call = (iso: string, direction = "outbound", status = "voicemail"): CallForAttribution => ({
    callId: "call-1",
    startedAtIso: iso,
    direction,
    callStatus: status,
  });

  test("the LVM LR 10/19 case: a call on 10/19 attributes to the 10/26 appointment", () => {
    // 2026-10-19 ~14:00 ET = 18:00Z — inside [10/19 10:00 ET, 10/26 10:00 ET)
    const out = attributeCall(call("2026-10-19T18:00:00Z"), windows, { dueDays: DUE_DAYS });
    expect(out).toMatchObject({ appointmentId: "appt-1", attribution: "window" });
    expect(out.evidence.rule).toBe("single_window");
  });

  test("call BEFORE the window opens → unattributed", () => {
    const out = attributeCall(call("2026-10-12T18:00:00Z"), windows, { dueDays: DUE_DAYS });
    expect(out.appointmentId).toBeNull();
    expect(out.attribution).toBe("unattributed");
  });

  test("call AT the appointment instant is NOT in that appointment's window ([start, appt)) — the next appointment's window legitimately catches it", () => {
    const out = attributeCall(call("2026-10-26T14:00:00Z"), windows, { dueDays: DUE_DAYS });
    expect(out).toMatchObject({ appointmentId: "appt-2", attribution: "window" }); // 10/30's window opened 10/23
  });

  test("call AFTER every window → unattributed (purpose passed)", () => {
    const out = attributeCall(call("2026-10-31T16:00:00Z"), windows, { dueDays: DUE_DAYS });
    expect(out.appointmentId).toBeNull();
  });

  test("D12: appointments <7 days apart → nearest-future with BOTH candidates in evidence", () => {
    // appt-2 (10/30) window opens 10/23; appt-1 (10/26) window covers 10/19–10/26.
    // A call on 10/24 sits in BOTH windows → nearest future = the EARLIER appointment (10/26).
    const out = attributeCall(call("2026-10-24T18:00:00Z"), windows, { dueDays: DUE_DAYS });
    expect(out.attribution).toBe("nearest_future");
    expect(out.appointmentId).toBe("appt-1");
    expect(out.evidence.rule).toBe("nearest_future");
    expect(out.evidence.windowCandidates.map((c) => c.appointmentId).sort()).toEqual(["appt-1", "appt-2"]);
  });

  test("D8: inbound calls are not excitement attempts", () => {
    const out = attributeCall(call("2026-10-19T18:00:00Z", "inbound"), windows, { dueDays: DUE_DAYS });
    expect(out.appointmentId).toBeNull();
  });

  test("D11: failed calls still attribute as attempts (evidence comes later, at classification)", () => {
    const out = attributeCall(call("2026-10-19T18:00:00Z", "outbound", "failed"), windows, { dueDays: DUE_DAYS });
    expect(out).toMatchObject({ appointmentId: "appt-1", attribution: "window" });
  });
});
