/**
 * SMS EVIDENCE + DEAD-CONTACT RE-RESOLUTION tests (spec owner-approved
 * 2026-11-02). Pins:
 *  - an OUTBOUND rep SMS inside the attribution window SATISFIES the
 *    conversation-evidence gate → attributed, method "sms";
 *  - inbound-only SMS is NEVER evidence (team-only / no-verdict unchanged);
 *  - multi-rep SMS evidence → AMBIGUOUS (manual queue, never a silent pick);
 *  - evidence quality ordering: qualifying call (dur>0) > rep outbound SMS >
 *    a NEWER 0-second dial (the dial never outranks a real conversation);
 *  - SMS evidence NEVER touches the calls pipeline (parseEvidenceMessage
 *    returns null for TYPE_CALL; call harvest visit shape unchanged);
 *  - dead-id re-resolution hierarchy: exact phone > exact email > name with
 *    has-conversations/dateAdded ranking; ambiguous tiers never guess.
 */
import { describe, expect, test } from "bun:test";
import {
  matchAppointmentsToCalls,
  phonesEqual,
  type AttributionAppointment,
  type AttributionCall,
  type AttributionContact,
  type AttributionHarvestInteraction,
} from "../metrics/attribution";
import { parseEvidenceMessage } from "../sync/highlevel-live";
import { pickReplacement } from "../sync/dead-contact-repair";

const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24 };
// Booking created Tue 2026-10-28 (ET) → window = ET dates 10-27..10-28.
const CREATED_AT = "2026-10-28T14:00:00.000Z";
const IN_WINDOW = "2026-10-27T18:00:00.000Z"; // prior ET day
const IN_WINDOW_LATER = "2026-10-28T13:00:00.000Z"; // creation ET day
const OUT_OF_WINDOW = "2026-10-24T18:00:00.000Z";

let seq = 0;
const appt = (over: Partial<AttributionAppointment> = {}): AttributionAppointment => {
  seq += 1;
  return {
    id: `sms-appt-${seq}`,
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
const sms = (id: string, over: Partial<AttributionHarvestInteraction> = {}): AttributionHarvestInteraction => ({
  id,
  contact_external_id: null,
  rep_id: null,
  started_at: IN_WINDOW,
  duration_seconds: null,
  kind: "sms",
  direction: "outbound",
  ...over,
});
const USERS = [{ id: "rep-1", is_active: true }, { id: "rep-2", is_active: true }];

describe("SMS satisfies the conversation-evidence gate (owner approved 2026-11-02)", () => {
  test("outbound rep SMS in window → ATTRIBUTED with method 'sms'", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [], // no calls at all
      [contact("c-1", { external_id: "hl-c1" })],
      SETTINGS,
      { users: USERS, s1Interactions: [sms("m1", { contact_external_id: "hl-c1", rep_id: "rep-1" })] },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("sms");
    expect(got.repId).toBe("rep-1");
    expect(got.evidence?.source).toBe("sms");
    expect(got.callExternalId).toBeUndefined();
  });

  test("a NEWER 0-second dial does not outrank an older rep SMS (quality ordering)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("dial", { contact_id: "c-1", rep_id: "rep-1", started_at: IN_WINDOW_LATER, duration_seconds: 0 })],
      [contact("c-1", { external_id: "hl-c1" })],
      SETTINGS,
      { users: USERS, s1Interactions: [sms("m1", { contact_external_id: "hl-c1", rep_id: "rep-1" })] },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("sms");
    expect(got.repId).toBe("rep-1");
  });

  test("a qualifying call outranks a NEWER rep SMS (qualifying call > rep SMS)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("real", { contact_id: "c-1", rep_id: "rep-1", started_at: IN_WINDOW, duration_seconds: 30 })],
      [contact("c-1", { external_id: "hl-c1" })],
      SETTINGS,
      { users: USERS, s1Interactions: [sms("m1", { contact_external_id: "hl-c1", rep_id: "rep-1", started_at: IN_WINDOW_LATER })] },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("window_interaction");
    expect(got.callExternalId).toBe("real");
  });

  test("inbound-only SMS is NOT evidence — team-only stays", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("dial", { contact_id: "c-1", rep_id: "rep-1", started_at: IN_WINDOW, duration_seconds: 0 })],
      [contact("c-1", { external_id: "hl-c1" })],
      SETTINGS,
      {
        users: USERS,
        s1Interactions: [
          sms("in1", { contact_external_id: "hl-c1", rep_id: "rep-1", direction: "inbound" }),
          sms("in2", { contact_external_id: "hl-c1", rep_id: "rep-1", direction: null }),
        ],
      },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reasonCode).toBe("self-booked-no-conversation");
  });

  test("multi-rep outbound SMS evidence → AMBIGUOUS (manual queue, never a pick)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [],
      [contact("c-1", { external_id: "hl-c1" })],
      SETTINGS,
      {
        users: USERS,
        s1Interactions: [
          sms("m1", { contact_external_id: "hl-c1", rep_id: "rep-1", started_at: IN_WINDOW }),
          sms("m2", { contact_external_id: "hl-c1", rep_id: "rep-2", started_at: IN_WINDOW_LATER }),
        ],
      },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("ambiguous");
  });

  test("an SMS outside the attribution window never owns (no all-time fallback)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [],
      [contact("c-1", { external_id: "hl-c1" })],
      SETTINGS,
      { users: USERS, s1Interactions: [sms("m1", { contact_external_id: "hl-c1", rep_id: "rep-1", started_at: OUT_OF_WINDOW })] },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("no-qualifying-call");
  });

  test("unresolved rep (not a verified roster rep) SMS is not evidence", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [],
      [contact("c-1", { external_id: "hl-c1" })],
      SETTINGS,
      { users: USERS, s1Interactions: [sms("m1", { contact_external_id: "hl-c1", rep_id: null })] },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("no-qualifying-call");
  });

  test("legacy interactions without kind still behave as call evidence (back-compat)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("dial", { contact_id: "c-1", rep_id: "rep-1", started_at: IN_WINDOW, duration_seconds: 0 })],
      [contact("c-1", { external_id: "hl-c1" })],
      SETTINGS,
      { users: USERS, s1Interactions: [{ id: "hm", contact_external_id: "hl-c1", rep_id: "rep-1", started_at: IN_WINDOW, duration_seconds: null }] },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("window_interaction");
  });
});

describe("evidence ledger never touches the calls pipeline", () => {
  test("parseEvidenceMessage refuses TYPE_CALL and extracts SMS fields", () => {
    const callMsg = { id: "c9", messageType: "TYPE_CALL", dateAdded: "2026-10-27T18:00:00Z", contactId: "hl-c1", direction: "outbound", userId: "u9", meta: { call: { duration: 60 } } };
    expect(parseEvidenceMessage(callMsg, "conv1")).toBeNull();
    const smsMsg = { id: "s9", messageType: "TYPE_SMS", dateAdded: "2026-10-27T18:00:00Z", contactId: "hl-c1", direction: "outbound", userId: "u9", conversationId: "conv2", body: "hi there" };
    const got = parseEvidenceMessage(smsMsg, "conv1");
    expect(got).not.toBeNull();
    expect(got?.message_id).toBe("s9");
    expect(got?.message_type).toBe("TYPE_SMS");
    expect(got?.direction).toBe("outbound");
    expect(got?.user_external_id).toBe("u9");
    expect(got?.conversation_id).toBe("conv2");
    expect(got?.body).toBe("hi there");
    const noId = { messageType: "TYPE_SMS", dateAdded: "2026-10-27T18:00:00Z" };
    expect(parseEvidenceMessage(noId)).toBeNull();
  });

  test("phonesEqual stays the identity primitive (no fuzzy matching introduced)", () => {
    expect(phonesEqual("+16037243417", "6037243417")).toBe(true);
    expect(phonesEqual("6037243417", "6037243418")).toBe(false);
  });
});

describe("dead-contact re-resolution hierarchy (workstream 3)", () => {
  const dead = "dead-id";
  const base = { client_phone: null, client_email: null, client_name: null };

  test("exact phone wins", () => {
    const got = pickReplacement(
      { ...base, client_phone: "6037243417" },
      [
        { id: "a", phone: "+16037243417", email: "x@y.com", name: "Z", dateAdded: "2026-10-01", conversations: 0 },
        { id: "b", phone: "2073150473", email: "other@y.com", name: "Y", dateAdded: "2026-10-02", conversations: 5 },
      ],
      dead,
    );
    expect(got.contactId).toBe("a");
    expect(got.resolvedBy).toBe("phone");
  });

  test("exact email when phone is absent", () => {
    const got = pickReplacement(
      { ...base, client_email: "Angie@Example.com" },
      [{ id: "a", phone: null, email: "angie@example.com", name: "Angie Miller", dateAdded: "2026-10-22", conversations: 2 }],
      dead,
    );
    expect(got.contactId).toBe("a");
    expect(got.resolvedBy).toBe("email");
  });

  test("name tier picks has-conversations then most recent; ties stay ambiguous", () => {
    const two = [
      { id: "a", phone: null, email: null, name: "Angie Miller", dateAdded: "2026-10-22", conversations: 3 },
      { id: "b", phone: null, email: null, name: "Angie Miller", dateAdded: "2025-12-05", conversations: 0 },
    ];
    expect(pickReplacement({ ...base, client_name: "angie miller" }, two, dead)).toMatchObject({ contactId: "a", resolvedBy: "name" });
    const tied = [
      { id: "a", phone: null, email: null, name: "Angie Miller", dateAdded: "2026-10-22", conversations: 0 },
      { id: "b", phone: null, email: null, name: "Angie Miller", dateAdded: "2025-12-05", conversations: 0 },
    ];
    expect(pickReplacement({ ...base, client_name: "angie miller" }, tied, dead).contactId).toBe("a"); // conversations tie → most recent dateAdded wins (spec)
  });

  test("ambiguous phone never resolves (never guessed)", () => {
    const got = pickReplacement(
      { ...base, client_phone: "6037243417" },
      [
        { id: "a", phone: "6037243417", email: null, name: null, dateAdded: null, conversations: 0 },
        { id: "b", phone: "+16037243417", email: null, name: null, dateAdded: null, conversations: 9 },
      ],
      dead,
    );
    expect(got.contactId).toBeNull();
    expect(got.note).toContain("ambiguous");
  });

  test("the dead id itself is never its own replacement", () => {
    const got = pickReplacement(
      { ...base, client_phone: "6037243417" },
      [{ id: dead, phone: "6037243417", email: null, name: null, dateAdded: null, conversations: 0 }],
      dead,
    );
    expect(got.contactId).toBeNull();
  });
});
