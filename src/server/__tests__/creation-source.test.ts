/**
 * CREATION-SOURCE ATTRIBUTION RULE (owner directive 2026-11-04) — the deciding
 * factor is WHO CREATED the calendar appointment:
 *
 *   1. PROVEN client-created → verdict "online-booking": TEAM-ONLY, counted in
 *      all team totals, labeled "Online Booking" — beats conversation/window
 *      evidence but LOSES to owner rulings (manual overrides are never
 *      re-processed; owner-rule-auction short-circuits first).
 *   2. PROVEN agent-created → the agent's booking stays the agent's — manual +
 *      owner-rule rows are creation ground truth, and ONLINE PAYMENT LATER
 *      must never convert or strip the credit (payment state is not an engine
 *      input at all).
 *   3. UNKNOWN creation source → the current evidence-chain verdicts stand
 *      unchanged (no mass re-classification without owner sign-off).
 *
 * W1 finding pinned here: no synced data can prove client-creation yet (the
 * Acuity raw payload has no created-by field and its payment/notes evidence is
 * LATER-snapshot state shared by both ground-truth sets; GHL sync carries no
 * appointments), so the rule is driven by caller-supplied creation evidence
 * (options.creationEvidence) — the only live source of "proven" today is the
 * sticky online-booking reason_code itself (deriveCreationSourceEvidence).
 */
import { describe, expect, test } from "bun:test";
import {
  ONLINE_BOOKING_NOTE,
  ONLINE_BOOKING_REASON,
  OWNER_RULE_AUCTION_METHOD,
  matchAppointmentsToCalls,
  type AttributionAppointment,
} from "../metrics/attribution";
import { derivePaymentState } from "../payments";
import { assertBookingInvariant, type AttributionRow } from "../metrics/compute";
import { deriveCreationSourceEvidence, toAttributionRows } from "../sync/attribution-tick";

const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24 };
const USERS = [
  { id: "u1", is_active: true },
  { id: "u2", is_active: true },
];

/** A booking created 2026-11-04 with a qualifying call the day before. */
const clientAppt = (id: string, extra: Partial<AttributionAppointment> = {}): AttributionAppointment => ({
  id,
  contact_id: "c1",
  appointment_type: "Family Session",
  client_phone: "6035550001",
  client_email: "client@example.com",
  appointment_datetime: "2026-11-05T22:30:00Z",
  created_at: "2026-11-04T15:00:00Z",
  created_business_date: "2026-11-04",
  status: "scheduled",
  cancelled: false,
  ...extra,
});

const qualifyingCall = (over: Record<string, unknown> = {}) => ({
  external_call_id: "call-1",
  rep_id: "u1",
  contact_id: "c1",
  started_at: "2026-11-04T14:00:00Z",
  duration_seconds: 300,
  ...over,
});

const baseContacts = [{ id: "c1", phone: "+16035550001", email: "client@example.com", external_id: "ext-c1" }];

describe("creation-source rule — proven client-created → online-booking (team-only)", () => {
  test("overrides a qualifying-call (contact_id) attribution", () => {
    const appts = [clientAppt("a1")];
    const calls = [qualifyingCall()];
    const without = matchAppointmentsToCalls(appts, calls, baseContacts, SETTINGS, { users: USERS });
    expect(without[0]!.status).toBe("attributed");
    expect(without[0]!.method).toBe("contact_id");

    const withEvidence = matchAppointmentsToCalls(appts, calls, baseContacts, SETTINGS, {
      users: USERS,
      creationEvidence: { provenClientCreated: new Set(["a1"]) },
    });
    expect(withEvidence[0]!.status).toBe("unattributed");
    expect(withEvidence[0]!.reason).toBe(ONLINE_BOOKING_REASON);
    expect(withEvidence[0]!.reasonCode).toBe(ONLINE_BOOKING_REASON);
    expect(withEvidence[0]!.repId).toBeUndefined();
    expect(withEvidence[0]!.detail).toBe(ONLINE_BOOKING_NOTE);
  });

  test("overrides window_interaction (s1 conversation) evidence", () => {
    const appts = [clientAppt("a1", { contact_id: null })];
    // no >threshold call; a rep outbound SMS in the window would normally credit
    const s1 = [
      {
        id: "msg-1",
        contact_external_id: "ext-c1",
        rep_id: "u1",
        started_at: "2026-11-04T14:00:00Z",
        duration_seconds: null,
        kind: "sms" as const,
        direction: "outbound",
      },
    ];
    const without = matchAppointmentsToCalls(appts, [], baseContacts, SETTINGS, { users: USERS, s1Interactions: s1 });
    expect(without[0]!.status).toBe("attributed");
    expect(without[0]!.method).toBe("sms");

    const withEvidence = matchAppointmentsToCalls(appts, [], baseContacts, SETTINGS, {
      users: USERS,
      s1Interactions: s1,
      creationEvidence: { provenClientCreated: new Set(["a1"]) },
    });
    expect(withEvidence[0]!.status).toBe("unattributed");
    expect(withEvidence[0]!.reasonCode).toBe(ONLINE_BOOKING_REASON);
  });

  test("persists as rep NULL / method none / reason_code online-booking (team-only row)", () => {
    const matches = matchAppointmentsToCalls([clientAppt("a1")], [qualifyingCall()], baseContacts, SETTINGS, {
      users: USERS,
      creationEvidence: { provenClientCreated: new Set(["a1"]) },
    });
    const { rows } = toAttributionRows(matches, [], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rep_id).toBeNull();
    expect(rows[0]!.method).toBe("none");
    expect(rows[0]!.reason_code).toBe(ONLINE_BOOKING_REASON);
    expect(rows[0]!.manual_override).toBe(false);
    expect(rows[0]!.note).toContain("online-booking");
  });

  test("counts as exactly one verdict per appointment (team-total invariant intact)", () => {
    const appts = [clientAppt("a1"), clientAppt("a2")];
    const calls = [qualifyingCall()];
    const matches = matchAppointmentsToCalls(appts, calls, baseContacts, SETTINGS, {
      users: USERS,
      creationEvidence: { provenClientCreated: new Set(["a1"]) },
    });
    const attributed = matches.filter((m) => m.status === "attributed").length;
    const unattributed = matches.filter((m) => m.status === "unattributed").length;
    const { rows } = toAttributionRows(matches, [], new Map());
    // online-booking is a verdict row like any other — the invariant holds
    expect(() => assertBookingInvariant(appts, rows as AttributionRow[], { engineAttributed: attributed, engineUnattributed: unattributed })).not.toThrow();
  });
});

describe("creation-source rule — owner rulings are ground truth (proven agent-created)", () => {
  test("manual_override row is carried verbatim even when the engine says online-booking", () => {
    const manualRow: AttributionRow = {
      id: "attr:a1",
      appointment_id: "a1",
      call_id: null,
      rep_id: "u2",
      method: "manual",
      confidence: 1,
      manual_override: true,
      note: "Christopher assigned",
      reason_code: null,
    };
    const matches = matchAppointmentsToCalls([clientAppt("a1")], [qualifyingCall()], baseContacts, SETTINGS, {
      users: USERS,
      creationEvidence: { provenClientCreated: new Set(["a1"]) },
    });
    const { rows, manuallyAssignedIds } = toAttributionRows(matches, [manualRow], new Map());
    expect(manuallyAssignedIds).toContain("a1");
    expect(rows[0]!.manual_override).toBe(true);
    expect(rows[0]!.rep_id).toBe("u2");
    expect(rows[0]!.method).toBe("manual");
  });

  test("owner-rule-auction outranks proven client-creation (the rule fires first)", () => {
    const appts = [clientAppt("a1", { appointment_type: "Auction Portrait Session + 20\" Portrait" })];
    const matches = matchAppointmentsToCalls(appts, [qualifyingCall()], baseContacts, SETTINGS, {
      users: USERS,
      ownerRules: { auctionRepId: "u2" },
      creationEvidence: { provenClientCreated: new Set(["a1"]) },
    });
    expect(matches[0]!.status).toBe("attributed");
    expect(matches[0]!.method).toBe(OWNER_RULE_AUCTION_METHOD);
    expect(matches[0]!.repId).toBe("u2");
  });
});

describe("creation-source rule — UNKNOWN keeps the evidence-chain verdicts", () => {
  test("no creationEvidence → qualifying call still credits (regression pin)", () => {
    const matches = matchAppointmentsToCalls([clientAppt("a1")], [qualifyingCall()], baseContacts, SETTINGS, { users: USERS });
    expect(matches[0]!.status).toBe("attributed");
    expect(matches[0]!.method).toBe("contact_id");
    expect(matches[0]!.repId).toBe("u1");
  });

  test("empty evidence set behaves exactly like omitted", () => {
    const a = matchAppointmentsToCalls([clientAppt("a1")], [qualifyingCall()], baseContacts, SETTINGS, {
      users: USERS,
      creationEvidence: { provenClientCreated: new Set() },
    });
    const b = matchAppointmentsToCalls([clientAppt("a1")], [qualifyingCall()], baseContacts, SETTINGS, { users: USERS });
    expect(a).toEqual(b);
  });

  test("an appointment NOT in the evidence set is untouched while a sibling is flipped", () => {
    const appts = [clientAppt("a1"), clientAppt("a2")];
    const matches = matchAppointmentsToCalls(appts, [qualifyingCall()], baseContacts, SETTINGS, {
      users: USERS,
      creationEvidence: { provenClientCreated: new Set(["a1"]) },
    });
    const byId = new Map(matches.map((m) => [m.appointmentId, m]));
    expect(byId.get("a1")!.reasonCode).toBe(ONLINE_BOOKING_REASON);
    expect(byId.get("a2")!.status).toBe("attributed");
    expect(byId.get("a2")!.method).toBe("contact_id");
  });
});

describe("payment state never mutates attribution (owner case 2 pinned)", () => {
  test("the engine takes no payment input — verdicts are identical regardless of payment evidence", () => {
    // The AttributionAppointment shape carries NO payment fields: a booking that
    // is unpaid at creation and paid online later produces the SAME engine input
    // and therefore the SAME verdict — online payment cannot convert or strip.
    const appt = clientAppt("a1");
    const run = () => matchAppointmentsToCalls([appt], [qualifyingCall()], baseContacts, SETTINGS, { users: USERS });
    expect(run()).toEqual(run());
    expect(run()[0]!.status).toBe("attributed");
    expect(run()[0]!.repId).toBe("u1");
  });

  test(`paid:"yes" with amountPaid 0.00 still counts paid (invoice-paid-later shape, informational amount)`, () => {
    const d = derivePaymentState({ paid: "yes", amountPaid: "0.00", price: "300.00", priceSold: "300.00" });
    expect(d.state).toBe("paid");
    expect(d.paid).toBe(true);
    expect(d.amountPaid).toBe(0);
  });
});

describe("deriveCreationSourceEvidence — the sticky provenance sets", () => {
  test("online-booking reason_code → provenClientCreated; manual/owner-rule → provenAgentCreated; else unknown", () => {
    const rows: AttributionRow[] = [
      { id: "attr:a1", appointment_id: "a1", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false, reason_code: "online-booking" },
      { id: "attr:a2", appointment_id: "a2", call_id: null, rep_id: "u2", method: "manual", confidence: 1, manual_override: true },
      { id: "attr:a3", appointment_id: "a3", call_id: null, rep_id: "u2", method: "owner-rule-auction", confidence: 1, manual_override: false, reason_code: "owner-rule-auction" },
      { id: "attr:a4", appointment_id: "a4", call_id: null, rep_id: "u1", method: "window_interaction", confidence: 0.6, manual_override: false },
      { id: "attr:a5", appointment_id: "a5", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false, reason_code: "no-window-interaction" },
    ];
    const { provenClientCreated, provenAgentCreated } = deriveCreationSourceEvidence(rows);
    expect([...provenClientCreated]).toEqual(["a1"]);
    expect([...provenAgentCreated].sort()).toEqual(["a2", "a3"]);
    // a4/a5 are UNKNOWN — neither set contains them
    expect(provenClientCreated.has("a4")).toBe(false);
    expect(provenAgentCreated.has("a5")).toBe(false);
  });
});
