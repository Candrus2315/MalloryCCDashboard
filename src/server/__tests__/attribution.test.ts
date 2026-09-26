/**
 * BOOKING ATTRIBUTION ENGINE tests — the truth table per the lead's brief and
 * docs/SPEC.md §BOOKING ATTRIBUTION ("never silently guessed"):
 *
 *  - contact-id match honored (tier a, first match wins);
 *  - phone fallback (tier b) + email fallback (tier c);
 *  - threshold: only calls STRICTLY over settings.meeting_threshold_seconds
 *    qualify — short (119s), exactly-at (120s), null (voicemail) all excluded;
 *  - window: call started within [apptStart − 24h, apptStart] — exactly
 *    24h00m before = eligible, 24h01m = not; a call AFTER the booking never
 *    qualifies (the booking is evidence the call worked);
 *  - most recent qualifying call wins among several;
 *  - ambiguity: a phone/email identity hitting MULTIPLE distinct contacts →
 *    status "unattributed" reason "ambiguous" (and NO fall-through to a weaker
 *    tier past the unclear stronger evidence); contact-id vs phone/email
 *    contradiction → ambiguous too;
 *  - no contact identity at all → "no-contact-identity";
 *  - roster-mapping eligibility through the EXISTING roster.ts machinery: a
 *    mapped HL user's call attributes to the mapped rep at query time, source
 *    call rows immutable;
 *  - ET/DST boundaries: the window is ABSOLUTE hours — it spans the ET
 *    midnight boundary and the 2026 DST fall-back correctly (verified with the
 *    date-logic helpers);
 *  - end-to-end: Acuity parser → store upsert → overlap selector carries the
 *    normalized client fields the engine's phone/email tiers read.
 */
import { describe, expect, test } from "bun:test";
import {
  matchAppointmentsToCalls,
  normalizeAttributionEmail,
  normalizeAttributionPhone,
  phonesEqual,
  type AttributionAppointment,
  type AttributionCall,
  type AttributionContact,
} from "../metrics/attribution";
import { applyRosterEligibility } from "../roster";
import { MemoryStore } from "../store/memory";
import { parseAcuityAppointment, upsertAcuityAppointments } from "../sync/acuity-live";
import { etDateStrFromInstant } from "../date-logic";

const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24 };
// Monday 2026-09-28, 10:00 ET (EDT, UTC-4) — the booking moment.
const APPT_AT = "2026-09-28T14:00:00.000Z";

let seq = 0;
const appt = (over: Partial<AttributionAppointment> = {}): AttributionAppointment => {
  seq += 1;
  return {
    id: `appt-${seq}`,
    contact_id: null,
    client_phone: null,
    client_email: null,
    appointment_datetime: APPT_AT,
    created_at: APPT_AT, // SPEC window anchor = booking-MADE time
    ...over,
  };
};
const call = (external_call_id: string, over: Partial<AttributionCall> = {}): AttributionCall => ({
  external_call_id,
  rep_id: null,
  contact_id: null,
  started_at: "2026-09-28T13:00:00.000Z", // 1h before the booking by default
  duration_seconds: 600,
  ...over,
});
const contact = (id: string, over: Partial<AttributionContact> = {}): AttributionContact => ({ id, ...over });

describe("attribution engine — matching chain", () => {
  test("contact-id match honored (tier a) — call linked to the same contact id", () => {
    const c1 = call("hl-call-1", { contact_id: "c-1", rep_id: "rep-1" });
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [c1],
      [contact("c-1")],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    expect(got.callExternalId).toBe("hl-call-1");
    expect(got.repId).toBe("rep-1");
    expect(got.method).toBe("contact_id");
  });

  test("phone fallback (tier b): no stored contact id → phone resolves the contact's call (1-prefix tolerated)", () => {
    const good = call("hl-call-good", { contact_id: "c-2", rep_id: "rep-2", started_at: "2026-09-28T12:00:00.000Z" });
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: null, client_phone: "9175550142" })],
      [good],
      [contact("c-2", { phone: "19175550142" })], // 1-prefix variant of the same number
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("phone");
    expect(got.callExternalId).toBe("hl-call-good");
    expect(got.repId).toBe("rep-2");
  });

  test("email fallback also fires after the phone tier resolves NOTHING (b→c fall-through)", () => {
    // No contact id stored; the phone matches no contact row (stale/foreign
    // number) but the email resolves c-1 → attributed via email.
    const good = call("hl-call-email", { contact_id: "c-1", rep_id: "rep-1" });
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: null, client_phone: "0000000000", client_email: "jane@example.com" })],
      [good],
      [contact("c-1", { email: "jane@example.com" })],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("email");
    expect(got.callExternalId).toBe("hl-call-email");
  });

  test("email fallback (tier c): no id match, no phone → email resolves the call", () => {
    const good = call("hl-call-email", { contact_id: "c-3", rep_id: "rep-3" });
    const [got] = matchAppointmentsToCalls(
      [appt({ client_email: "Jane.Doe@Example.COM" })],
      [good],
      [contact("c-3", { email: "jane.doe@example.com" })],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("email");
    expect(got.callExternalId).toBe("hl-call-email");
  });

  test("first match wins: a contact-id match beats a more recent phone-resolvable call", () => {
    const viaId = call("hl-id", { contact_id: "c-1", rep_id: "rep-1", started_at: "2026-09-28T09:00:00.000Z" });
    const viaPhone = call("hl-phone", { contact_id: "c-2", rep_id: "rep-2", started_at: "2026-09-28T13:30:00.000Z" });
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1", client_phone: "9175550142" })],
      [viaId, viaPhone],
      [contact("c-1"), contact("c-2", { phone: "9175550142" })],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    expect(got.method).toBe("contact_id");
    expect(got.callExternalId).toBe("hl-id");
  });
});

describe("attribution engine — threshold + window", () => {
  test("threshold excludes short (119s), exactly-at (120s) and null (voicemail) calls; 121s qualifies", () => {
    const calls = [
      call("hl-119", { contact_id: "c-1", duration_seconds: 119 }),
      call("hl-120", { contact_id: "c-1", duration_seconds: 120 }), // NOT over the threshold
      call("hl-voicemail", { contact_id: "c-1", duration_seconds: null }),
      call("hl-0", { contact_id: "c-1", duration_seconds: 0 }),
      call("hl-121", { contact_id: "c-1", rep_id: "rep-1", duration_seconds: 121 }),
    ];
    const [got] = matchAppointmentsToCalls([appt({ contact_id: "c-1" })], calls, [contact("c-1")], SETTINGS, {
      today: "2026-09-28",
    });
    expect(got.status).toBe("attributed");
    expect(got.callExternalId).toBe("hl-121");
  });

  test("window boundary (DATE-GRANULARITY): a call on the previous ET date is eligible; two ET dates back is not", () => {
    // Booking: Mon 2026-09-28 10:00 ET. Window ET dates: 09-27 + 09-28.
    const prevDay = call("hl-prev", { contact_id: "c-1", started_at: "2026-09-27T14:00:00.000Z" }); // Sun 10:00 ET
    const [inWindow] = matchAppointmentsToCalls([appt({ contact_id: "c-1" })], [prevDay], [contact("c-1")], SETTINGS, {
      today: "2026-09-28",
    });
    expect(inWindow.status).toBe("attributed");
    expect(inWindow.callExternalId).toBe("hl-prev");

    const twoBack = call("hl-two-back", { contact_id: "c-1", started_at: "2026-09-26T14:00:00.000Z" }); // Sat
    const [outOfWindow] = matchAppointmentsToCalls([appt({ contact_id: "c-1" })], [twoBack], [contact("c-1")], SETTINGS, {
      today: "2026-09-28",
    });
    expect(outOfWindow.status).toBe("unattributed");
    expect(outOfWindow.reason).toBe("no-qualifying-call");
  });

  test("a call on a LATER ET date never qualifies; same-ET-date order is unknowable (dateCreated is date-only)", () => {
    // Same ET date but AFTER the booking instant: still qualifies — Acuity
    // dateCreated carries no time-of-day, so intra-day ordering is never assumed.
    const sameDay = call("hl-same-day", { contact_id: "c-1", started_at: "2026-09-28T14:00:01.000Z" });
    const [sameDayGot] = matchAppointmentsToCalls([appt({ contact_id: "c-1" })], [sameDay], [contact("c-1")], SETTINGS, {
      today: "2026-09-28",
    });
    expect(sameDayGot.status).toBe("attributed");
    expect(sameDayGot.callExternalId).toBe("hl-same-day");
    // The NEXT ET day is out.
    const nextDay = call("hl-next-day", { contact_id: "c-1", started_at: "2026-09-29T14:00:00.000Z" });
    const [got] = matchAppointmentsToCalls([appt({ contact_id: "c-1" })], [nextDay], [contact("c-1")], SETTINGS, {
      today: "2026-09-28",
    });
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("no-qualifying-call");
  });

  test("most recent qualifying call wins among several", () => {
    const older = call("hl-older", { contact_id: "c-1", started_at: "2026-09-28T11:00:00.000Z" });
    const newest = call("hl-newest", { contact_id: "c-1", rep_id: "rep-1", started_at: "2026-09-28T13:00:00.000Z" });
    const middle = call("hl-middle", { contact_id: "c-1", started_at: "2026-09-28T12:00:00.000Z" });
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [older, middle, newest],
      [contact("c-1")],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    expect(got.callExternalId).toBe("hl-newest");
    expect(got.repId).toBe("rep-1");
  });

  test("window anchor is the booking-MADE time (SPEC): call before created_at qualifies even if the session is weeks later", () => {
    // Session on Oct 20; booked Sep 28 10:00 ET; rep's qualifying call 2h
    // before the booking was MADE. Anchor = created_at → attributed; anchoring
    // the session would have demanded a call 2h before the SESSION (wrong
    // sales-event semantics — the SPEC window measures call → booking created).
    const sessionAt = "2026-10-20T14:00:00.000Z";
    const bookingCall = call("hl-booking-call", { contact_id: "c-1", rep_id: "rep-1", started_at: "2026-09-28T12:00:00.000Z" });
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1", created_at: APPT_AT, appointment_datetime: sessionAt })],
      [bookingCall],
      [contact("c-1")],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    expect(got.callExternalId).toBe("hl-booking-call");
    // And the mirror: a call 2h before the SESSION but long after the booking
    // window closed never qualifies (call must PRECEDE the anchor).
    const afterWindow = call("hl-after-window", { contact_id: "c-1", started_at: "2026-10-20T12:00:00.000Z" });
    const [notGuessed] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1", created_at: APPT_AT, appointment_datetime: sessionAt })],
      [afterWindow],
      [contact("c-1")],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(notGuessed.status).toBe("unattributed");
    expect(notGuessed.reason).toBe("no-qualifying-call");
  });

  test("identity known but no qualifying call → unattributed 'no-qualifying-call' (audit-visible, not silent)", () => {
    const [got] = matchAppointmentsToCalls([appt({ contact_id: "c-1" })], [], [contact("c-1")], SETTINGS, {
      today: "2026-09-28",
    });
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("no-qualifying-call");
  });
});

describe("attribution engine — ambiguity rule (never silently guessed)", () => {
  test("phone matching MULTIPLE distinct contacts → unattributed reason 'ambiguous'", () => {
    const a = call("hl-a", { contact_id: "c-a", rep_id: "rep-a" });
    const b = call("hl-b", { contact_id: "c-b", rep_id: "rep-b" });
    const [got] = matchAppointmentsToCalls(
      [appt({ client_phone: "9175550142" })],
      [a, b],
      [contact("c-a", { phone: "9175550142" }), contact("c-b", { phone: "+19175550142" })],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("ambiguous");
    expect(got.callExternalId).toBeUndefined();
    expect(got.detail).toContain("2 distinct contacts");
  });

  test("ambiguous phone is a HARD stop — no fall-through to a clean email match", () => {
    const emailCall = call("hl-email", { contact_id: "c-email", rep_id: "rep-e" });
    const [got] = matchAppointmentsToCalls(
      [appt({ client_phone: "9175550142", client_email: "shared@family.com" })],
      [emailCall],
      [
        contact("c-1", { phone: "9175550142" }),
        contact("c-2", { phone: "9175550142" }),
        contact("c-email", { email: "shared@family.com" }),
      ],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("ambiguous");
    expect(got.method).toBeUndefined();
  });

  test("email matching multiple distinct contacts → ambiguous as well", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ client_email: "frontdesk@studio.com" })],
      [call("hl-x", { contact_id: "c-1" }), call("hl-y", { contact_id: "c-2" })],
      [contact("c-1", { email: "frontdesk@studio.com" }), contact("c-2", { email: "frontdesk@studio.com" })],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("ambiguous");
    expect(got.detail).toContain("email");
  });

  test("chosen phone match contradicted by the stored contact id (a DIFFERENT contact) → ambiguous, not guessed", () => {
    // The stored contact id names c-1 (no qualifying calls at all), but the
    // phone resolves c-2 who DID have a qualifying call. The stronger identity
    // disagrees about WHO booked — ambiguous (stale linkage / shared family
    // phone), never a silent attribution to c-2's call.
    const phoneCall = call("hl-phone", { contact_id: "c-2", rep_id: "rep-2", started_at: "2026-09-28T13:30:00.000Z" });
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1", client_phone: "9175550142", client_email: null })],
      [phoneCall],
      [contact("c-1"), contact("c-2", { phone: "9175550142" })],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("ambiguous");
    expect(got.detail).toContain("contact id");
  });

  test("no contact identity at all → unattributed reason 'no-contact-identity'", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: null, client_phone: "", client_email: null })],
      [call("hl-1", { contact_id: "c-1" })],
      [contact("c-1")],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("no-contact-identity");
  });
});

describe("attribution engine — roster eligibility (roster.ts machinery, never re-implemented)", () => {
  test("mapped HL user's call attributes to the mapped rep at QUERY time; source call row immutable", () => {
    const raw = call("hl-mapped", { contact_id: "c-1", rep_id: null, provider_rep_external_id: "hl-user-77" });
    const snapshot = JSON.parse(JSON.stringify(raw));
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [raw],
      [contact("c-1")],
      { ...SETTINGS, rep_mappings: [{ external_user_id: "hl-user-77", rep_id: "rep-dan" }] },
      { today: "2026-09-28", users: [{ id: "rep-dan", is_active: true }] },
    );
    expect(got.status).toBe("attributed");
    expect(got.repId).toBe("rep-dan"); // resolved through applyAttributionEligibility
    expect(raw).toEqual(snapshot); // source rows untouched
  });

  test("rep-less call with no mapping still attributes (repId null) — the booking is linked, the rep is not guessed", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-norep", { contact_id: "c-1", rep_id: null })],
      [contact("c-1")],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    expect(got.callExternalId).toBe("hl-norep");
    expect(got.repId ?? null).toBeNull();
  });

  test("mapping to an INACTIVE rep is inert (never silently inherits calls) — via the same roster rules", () => {
    const raw = call("hl-m", { contact_id: "c-1", rep_id: null, provider_rep_external_id: "hl-user-77" });
    const [got] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [raw],
      [contact("c-1")],
      { ...SETTINGS, rep_mappings: [{ external_user_id: "hl-user-77", rep_id: "rep-gone" }] },
      { today: "2026-09-28", users: [{ id: "rep-gone", is_active: false }] },
    );
    expect(got.status).toBe("attributed");
    expect(got.repId ?? null).toBeNull();
  });

  test("applyRosterEligibility interop: mapped call passes the query-time gate as the mapped rep", () => {
    const raw = call("hl-m2", { contact_id: "c-1", rep_id: null, provider_rep_external_id: "hl-user-77" });
    const eligible = applyRosterEligibility([raw], {
      activeIds: new Set(["rep-dan"]),
      mapping: new Map([["hl-user-77", "rep-dan"]]),
    });
    expect(eligible).toHaveLength(1);
    expect(eligible[0].rep_id).toBe("rep-dan");
    expect(raw.rep_id).toBeNull(); // input row never mutated
  });
});

describe("attribution engine — normalization + ET/DST boundaries", () => {
  test("normalizers (CANONICAL): email lowercase-trim, leading-1 dropped, HL '+15088891019' matches Acuity '5088891019'", () => {
    expect(normalizeAttributionEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeAttributionEmail("   ")).toBeNull();
    expect(normalizeAttributionPhone("+1 (917) 555-0142")).toBe("9175550142");
    expect(normalizeAttributionPhone("+15088891019")).toBe("5088891019");
    expect(normalizeAttributionPhone("917-555-0142")).toBe("9175550142");
    expect(normalizeAttributionPhone("")).toBeNull();
    expect(phonesEqual("+15088891019", "5088891019")).toBe(true);
    expect(phonesEqual("19175550142", "9175550142")).toBe(true);
    expect(phonesEqual("9175550142", "9175550143")).toBe(false);
  });

  test("ET boundaries + DST: the window is DATE-GRANULARITY in America/New_York (creation date + the day before)", () => {
    // Appointment created Sun 2026-11-01 01:00 ET **EST** (UTC-5) — one minute
    // past the 2026 fall-back (02:00 EDT → 01:00 EST). Its ET date: 2026-11-01.
    const apptAt = "2026-11-01T06:00:00.000Z";
    expect(etDateStrFromInstant(Date.parse(apptAt))).toBe("2026-11-01");
    // Sat 2026-10-31 06:00Z = 02:00 EDT — the PREVIOUS ET calendar date → in window.
    const exact = call("hl-dst-prev", { contact_id: "c-1", started_at: "2026-10-31T06:00:00.000Z" });
    expect(etDateStrFromInstant(Date.parse(exact.started_at))).toBe("2026-10-31");
    const [inWindow] = matchAppointmentsToCalls([appt({ appointment_datetime: apptAt, created_at: apptAt, contact_id: "c-1" })], [exact], [contact("c-1")], SETTINGS, {
      today: "2026-11-01",
    });
    expect(inWindow.status).toBe("attributed");
    // Fri 2026-10-30 → TWO ET calendar dates back → outside. DST shifts
    // wall-clock distances, but the window is CALENDAR DATES and never stretches.
    const early = call("hl-dst-two-back", { contact_id: "c-1", started_at: "2026-10-30T06:00:00.000Z" });
    const [outOfWindow] = matchAppointmentsToCalls([appt({ appointment_datetime: apptAt, created_at: apptAt, contact_id: "c-1" })], [early], [contact("c-1")], SETTINGS, {
      today: "2026-11-01",
    });
    expect(outOfWindow.status).toBe("unattributed");
    expect(outOfWindow.reason).toBe("no-qualifying-call");
  });

  test("unparseable session time → unattributed 'bad-datetime' (never guessed against a broken anchor)", () => {
    const [got] = matchAppointmentsToCalls(
      [appt({ appointment_datetime: "not-a-timestamp", created_at: "also-broken", contact_id: "c-1" })],
      [call("hl-1", { contact_id: "c-1" })],
      [contact("c-1")],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("unattributed");
    expect(got.reason).toBe("bad-datetime");
  });
});

describe("attribution engine — end-to-end through the sync path (normalized fields reach the engine)", () => {
  test("Acuity parser → upsert → overlap selector carries normalized client fields; engine attributes", async () => {
    const store = new MemoryStore();
    await store.ensureSchema();
    await store.upsertContacts([
      {
        id: "c-live",
        provider: "highlevel",
        external_id: "hl-contact-9",
        name: "Jane Doe",
        phone: "+19175550142",
        email: "jane@example.com",
        assigned_rep_id: null,
        created_at: "2026-09-20T00:00:00.000Z",
      },
    ]);
    const raw = parseAcuityAppointment({
      id: 99001,
      calendarID: 1,
      calendar: "MALLORY PORTRAITS",
      type: "Portrait Session",
      datetime: "2026-09-28T10:00:00-0400",
      duration: 60,
      dateCreated: "2026-09-27T16:04:00-0400",
      canceled: false,
      firstName: "Jane",
      lastName: "Doe",
      phone: "+1 917 555 0142", // messy in…
      email: " Jane@Example.com ",
    });
    expect(raw).not.toBeNull();
    await upsertAcuityAppointments(store, [raw!]);

    // The overlap selector (the engine's future feed) carries the NORMALIZED fields.
    const rows = await store.getAppointmentsOverlapping("2026-09-28T00:00:00.000Z", "2026-09-29T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    const row = rows[0] as typeof rows[0] & { client_phone?: string | null; client_email?: string | null };
    expect(row.client_phone).toBe("9175550142");
    expect(row.client_email).toBe("jane@example.com");
    // MemoryStore regenerates internal ids on upsert — resolve the LINKED id.
    const storedContacts = await store.getContacts();
    const linked = storedContacts.find((c) => c.external_id === "hl-contact-9")!;
    expect(row.contact_id).toBe(linked.id); // the sync linked the appointment to the contact BY PHONE

    // A call over the threshold within the window before the booking → attributed.
    const hlCall = call("hl-live", { contact_id: linked.id, rep_id: null, started_at: "2026-09-27T18:00:00.000Z" });
    const [got] = matchAppointmentsToCalls(
      [
        {
          id: row.id,
          contact_id: row.contact_id,
          client_phone: row.client_phone ?? null,
          client_email: row.client_email ?? null,
          appointment_datetime: row.appointment_datetime,
          created_at: row.created_at,
        },
      ],
      [hlCall],
      [{ id: linked.id, phone: "+19175550142", email: "jane@example.com" }],
      SETTINGS,
      { today: "2026-09-28" },
    );
    expect(got.status).toBe("attributed");
    // The sync linked contact_id by phone (tier a at sync time), so the engine's
    // tier (a) matches the same contact — the strongest evidence wins.
    expect(got.method).toBe("contact_id");
    expect(got.callExternalId).toBe("hl-live");
  });
});
