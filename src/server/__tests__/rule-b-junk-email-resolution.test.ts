/**
 * RULE B — deterministic email-identity resolution for junk/shared contact
 * records (owner-approved 2026-09-28).
 *
 * A stored contact is JUNK when the appointments stored against it carry ≥2
 * DISTINCT client emails. When the engine hits the stored-contact/email
 * identity conflict AND the stored contact is junk, the booking's identity
 * resolves through the exact-email-matched contact and attribution runs under
 * the UNCHANGED s1 rules. Test-pinned guards:
 *   (a) email matches MULTIPLE contacts → never resolves (stays ambiguous);
 *   (b) resolved contact's owner is not an ACTIVE roster rep → manual queue
 *       with the DISTINCT reason_code "email-resolves-non-roster";
 *   (c) the email-resolved contact is itself junk → never resolves onto it;
 *   (d) manual_override rows are never re-processed (wiring + both stores);
 *   (e) EXACT case-insensitive email equality is the only key — no fuzzy
 *       matching (no name similarity, no phone matching).
 * Observability: resolved rows carry an "identity-resolved-via-email" note
 * naming the junk stored contact id and the resolved contact id; the junk
 * contact's own calls/interactions NEVER become evidence.
 */
import { describe, expect, test } from "bun:test";
import {
  matchAppointmentsToCalls,
  computeJunkContactIds,
  type AttributionAppointment,
  type AttributionCall,
  type AttributionContact,
  type AttributionHarvestInteraction,
} from "../metrics/attribution";
import { toAttributionRows } from "../sync/attribution-tick";
import { MemoryStore } from "../store/memory";
import type { AttributionRow } from "../metrics/compute";

const USERS = [
  { id: "u_r1", is_active: true },
  { id: "u_r2", is_active: true },
  { id: "u_x", is_active: false }, // a real HL user OUTSIDE the active roster
];
const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24, rep_mappings: [] };

const JUNK = "c_junk_3b649d31_shape"; // structural stand-in — junk is COMPUTED, never hardcoded
const mkAppt = (id: string, extra: Partial<AttributionAppointment> = {}): AttributionAppointment => ({
  id,
  contact_id: null,
  client_phone: null,
  client_email: null,
  appointment_datetime: "2026-09-16T18:00:00.000Z",
  created_at: "2026-09-15T14:00:00.000Z", // Tue 2026-09-15, 10:00 ET
  created_business_date: "2026-09-15",
  cancelled: false,
  status: "confirmed",
  ...extra,
});
const mkCall = (id: string, extra: Partial<AttributionCall> = {}): AttributionCall => ({
  external_call_id: id,
  rep_id: null,
  contact_id: "c1",
  started_at: "2026-09-15T15:00:00.000Z", // 11:00 ET on the creation date (in window)
  duration_seconds: 300,
  id,
  ...extra,
});
const contact = (id: string, extra: Partial<AttributionContact> = {}): AttributionContact => ({
  id,
  phone: null,
  email: null,
  external_id: null,
  assigned_rep_id: null,
  ...extra,
});
const mkHarvest = (id: string, extra: Partial<AttributionHarvestInteraction> = {}): AttributionHarvestInteraction => ({
  id,
  contact_external_id: "hl_real",
  rep_id: null,
  started_at: "2026-09-15T15:00:00.000Z",
  duration_seconds: 5,
  ...extra,
});
/** Appointments that make JUNK a junk/shared record (two distinct client emails). */
const junkEvidence = [
  mkAppt("j1", { contact_id: JUNK, client_email: "clientA@x.com" }),
  mkAppt("j2", { contact_id: JUNK, client_email: "clientB@x.com" }),
];
/** The booking under test: stored on the junk contact, email resolves to c_real. */
const conflictBooking = mkAppt("bk", { contact_id: JUNK, client_email: "Alice@Example.com" });
const runEngine = (
  appts: AttributionAppointment[],
  calls: AttributionCall[],
  contacts: AttributionContact[],
  s1: AttributionHarvestInteraction[] = [],
) => matchAppointmentsToCalls(appts, calls, contacts, SETTINGS, { today: "2026-09-27", users: USERS, s1Interactions: s1 });

/** Run the engine and return THE BOOKING'S match (junk-evidence rows also get matches). */
const runBooking = (
  appts: AttributionAppointment[],
  calls: AttributionCall[],
  contacts: AttributionContact[],
  s1: AttributionHarvestInteraction[] = [],
  bookingId = "bk",
) => runEngine(appts, calls, contacts, s1).find((m) => m.appointmentId === bookingId)!;

// ---------- junk detection ----------

describe("Rule B junk detection — computed from current appointment-client joins", () => {
  test("≥2 DISTINCT client emails on one stored contact → junk", () => {
    const junk = computeJunkContactIds([
      mkAppt("a", { contact_id: "c1", client_email: "a@x.com" }),
      mkAppt("b", { contact_id: "c1", client_email: "b@x.com" }),
    ]);
    expect(junk.has("c1")).toBe(true);
  });

  test("one email repeated across appointments → NOT junk", () => {
    const junk = computeJunkContactIds([
      mkAppt("a", { contact_id: "c1", client_email: "a@x.com" }),
      mkAppt("b", { contact_id: "c1", client_email: "a@x.com" }),
    ]);
    expect(junk.has("c1")).toBe(false);
  });

  test("case/whitespace variants are ONE distinct email (exact-insensitive equality)", () => {
    const junk = computeJunkContactIds([
      mkAppt("a", { contact_id: "c1", client_email: " Family@X.com " }),
      mkAppt("b", { contact_id: "c1", client_email: "family@x.com" }),
    ]);
    expect(junk.has("c1")).toBe(false);
  });

  test("appointments without an email contribute nothing; contactless rows are ignored", () => {
    const junk = computeJunkContactIds([
      mkAppt("a", { contact_id: "c1", client_email: null }),
      mkAppt("b", { contact_id: "c1", client_email: "" }),
      mkAppt("c", { contact_id: null, client_email: "nobody@x.com" }),
      mkAppt("d", { contact_id: "  ", client_email: "nobody@x.com" }),
    ]);
    expect(junk.size).toBe(0);
  });

  test("≥3 clients on one contact → junk (the live shared-record shape)", () => {
    const junk = computeJunkContactIds([
      mkAppt("a", { contact_id: JUNK, client_email: "one@x.com" }),
      mkAppt("b", { contact_id: JUNK, client_email: "two@x.com" }),
      mkAppt("c", { contact_id: JUNK, client_email: "three@x.com" }),
    ]);
    expect(junk.has(JUNK)).toBe(true);
  });
});

// ---------- the resolution rule ----------

describe("Rule B resolution — junk stored contact resolves via exact email match", () => {
  test("resolved contact has an in-window >threshold call from an active roster rep → ATTRIBUTED via the email tier", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" })],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(m.status).toBe("attributed");
    expect(m.method).toBe("email");
    expect(m.callExternalId).toBe("h1");
    expect(m.repId).toBe("u_r1");
    expect(m.emailResolution).toEqual({ storedContactId: JUNK, resolvedContactId: "c_real" });
  });

  test("s1 unchanged on the resolved contact: ANY-duration in-window roster interaction owns the booking", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real", duration_seconds: 30 })], // below >120s
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(m.status).toBe("attributed");
    expect(m.method).toBe("window_interaction");
    expect(m.repId).toBe("u_r1");
    expect(m.emailResolution).toBeDefined();
  });

  test("window discipline holds on the resolved contact: call outside [created−1, created] never qualifies", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real", started_at: "2026-09-12T15:00:00.000Z" })],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("no-qualifying-call");
    expect(m.noRepReason).toBe("no-window-interaction");
  });

  test("harvested conversation evidence on the resolved contact attributes under the same s1 rule", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", external_id: "hl_real", assigned_rep_id: "u_r1" })],
      [mkHarvest("m1", { rep_id: "u_r1" })],
    );
    expect(m.status).toBe("attributed");
    expect(m.method).toBe("window_interaction");
    expect(m.evidence?.id).toBe("m1");
  });

  test("multi-rep evidence on the resolved contact stays AMBIGUOUS (never a silent most-recent pick)", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [
        mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" }),
        mkCall("h2", { rep_id: "u_r2", contact_id: "c_real", started_at: "2026-09-15T16:00:00.000Z" }),
      ],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("ambiguous");
  });

  test("THE JUNK CONTACT'S OWN INTERACTIONS ARE NEVER EVIDENCE — another user's activity on the shared record cannot capture the booking", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [mkCall("h_junk", { rep_id: "u_r2", contact_id: JUNK, duration_seconds: 60 })], // in window, below >120s
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    // Tier (a) on the junk contact yields no >threshold call, so the booking
    // reaches the Rule B email tier; the junk contact's own in-window
    // interaction (u_r2's dial) is EXCLUDED from the s1 evidence pool — the
    // resolved candidate set is the email-matched contact only — and c_real
    // has no evidence → honest no-qualifying-call, never attributed to u_r2.
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("no-qualifying-call");
    expect(m.noRepReason).toBe("no-window-interaction");
    expect(m.emailResolution).toBeDefined();
  });
});

// ---------- guards ----------

describe("Rule B guard (a) — a multi-contact email match never resolves", () => {
  test("email matches TWO distinct contacts → ambiguous, even with a junk stored contact", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" })],
      [
        contact(JUNK),
        contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" }),
        contact("c_real2", { email: "Alice@Example.com" }),
      ],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("ambiguous");
    expect(m.detail).toBe("email matches 2 distinct contacts");
    expect(m.emailResolution).toBeUndefined();
  });
});

describe("Rule B guard (b) — no active-roster owner on the resolved contact queues with a DISTINCT reason_code", () => {
  test("resolved contact owned by an inactive (non-roster) user → manual queue, reason_code email-resolves-non-roster", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_x" })],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("ambiguous"); // still an identity-conflict queue row
    expect(m.reasonCode).toBe("email-resolves-non-roster");
    expect(m.detail).toContain(JUNK);
    expect(m.detail).toContain("c_real");
    expect(m.detail).toContain("not an active roster rep");
  });

  test("resolved contact with NO stored owner (assigned_rep_id NULL) → same manual queue (the live 3b649d31 follow-up shape)", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: null })],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("ambiguous");
    expect(m.reasonCode).toBe("email-resolves-non-roster");
    expect(m.detail).toContain("c_real");
  });

  test("an ACTIVE-roster owner with no evidence does NOT queue — honest no-qualifying-call instead", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("no-qualifying-call");
    expect(m.reasonCode).toBeUndefined();
    expect(m.emailResolution).toBeDefined();
  });

  test("the wiring persists the distinct code + the ambiguous note prefix (queue counts stay stable)", () => {
    const { rows } = toAttributionRows(
      [
        {
          appointmentId: "bk",
          status: "unattributed",
          reason: "ambiguous",
          reasonCode: "email-resolves-non-roster",
          detail: `email resolves a different contact than the stored contact id — stored contact ${JUNK} is a junk/shared record; resolved via email to c_real, whose owner is not an active roster rep`,
          window: { from: "2026-09-14", to: "2026-09-15", marker: "date_granularity_window", anchoredOn: "created_business_date" },
        },
      ],
      [],
      new Map(),
    );
    expect(rows[0].reason_code).toBe("email-resolves-non-roster");
    expect((rows[0].note ?? "").startsWith("ambiguous")).toBe(true);
    expect(rows[0].note).toContain(JUNK);
    expect(rows[0].note).toContain("c_real");
  });
});

describe("Rule B guard (c) — the resolved contact being junk itself blocks resolution", () => {
  test("email resolves to ANOTHER junk record → stays ambiguous with the original conflict detail", () => {
    const m = runBooking(
      [
        ...junkEvidence,
        mkAppt("j3", { contact_id: "c_also_junk", client_email: "x@y.com" }),
        mkAppt("j4", { contact_id: "c_also_junk", client_email: "z@y.com" }),
        conflictBooking,
      ],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_also_junk" })],
      [contact(JUNK), contact("c_also_junk", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("ambiguous");
    expect(m.detail).toBe("email resolves a different contact than the stored contact id");
    expect(m.reasonCode).toBeUndefined();
    expect(m.emailResolution).toBeUndefined();
  });
});

describe("Rule B guard (d) — manual_override rows are never re-processed", () => {
  const attrRow = (over: Partial<AttributionRow>): AttributionRow => ({
    id: "",
    appointment_id: over.appointment_id ?? "bk",
    call_id: null,
    rep_id: null,
    method: "none",
    confidence: 0,
    manual_override: false,
    ...over,
  });

  test("the wiring carries the manual row VERBATIM even when the engine would now resolve the booking", () => {
    const manual = attrRow({
      appointment_id: "bk",
      rep_id: "u_r1",
      call_id: "call-internal-9",
      method: "manual",
      confidence: 1,
      manual_override: true,
      note: "manual",
      reason_code: null,
    });
    const resolved = runBooking(
      [...junkEvidence, conflictBooking],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" })],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(resolved.status).toBe("attributed"); // the engine WOULD resolve it…
    const { rows, manuallyAssignedIds } = toAttributionRows(
      [resolved as never],
      [manual],
      new Map([["h1", "call-internal-9"]]),
    );
    expect(manuallyAssignedIds).toEqual(["bk"]);
    expect(rows[0]).toEqual(manual); // …but the manual row wins untouched
  });

  test("the memory store's upsert skips manual rows (mirror of the PG WHERE manual_override = false)", async () => {
    const store = new MemoryStore();
    await store.setManualAttribution({
      id: "",
      appointment_id: "bk",
      call_id: "call-internal-9",
      rep_id: "u_r1",
      method: "manual",
      confidence: 1,
      manual_override: true,
      note: "manual",
      reason_code: null,
    });
    // The engine's recompute produces a DIFFERENT verdict for the same booking;
    // the store must refuse to overwrite the manual assignment.
    await store.upsertAttributions([
      {
        id: "attr:bk",
        appointment_id: "bk",
        call_id: "other-call",
        rep_id: "u_r2",
        method: "email",
        confidence: 0.8,
        manual_override: false,
        note: "identity-resolved-via-email",
        reason_code: null,
      },
    ]);
    const stored = (await store.getAttributions()).find((r) => r.appointment_id === "bk");
    expect(stored?.manual_override).toBe(true);
    expect(stored?.rep_id).toBe("u_r1");
    expect(stored?.call_id).toBe("call-internal-9");
  });
});

describe("Rule B guard (e) — exact email equality only, no fuzzy matching", () => {
  test("case-insensitive EXACT equality resolves; a near-miss email resolves to NOTHING", () => {
    // Exact-insensitive: Alice@Example.com === alice@example.com → resolves.
    const hit = runBooking(
      [...junkEvidence, conflictBooking],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" })],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(hit.status).toBe("attributed");
    // One changed character → no contact matches → not a resolution, and never
    // a guess onto a lookalike.
    const miss = runBooking(
      [...junkEvidence, mkAppt("bk2", { contact_id: JUNK, client_email: "alice2@example.com" })],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" })],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
      [],
      "bk2",
    );
    expect(miss.status).toBe("unattributed");
    expect(miss.reason).toBe("no-qualifying-call");
    // The stored (junk) contact id IS a candidate, so the honest category is
    // no-window-interaction — the point is NO resolution happened and nothing
    // was guessed onto the lookalike contact.
    expect(miss.noRepReason).toBe("no-window-interaction");
    expect(miss.emailResolution).toBeUndefined();
  });

  test("a PHONE identity conflict stays ambiguous — Rule B is email-only (no phone resolution)", () => {
    // The booking carries no email → no Rule B path exists at all; the phone
    // resolving to a different contact than the stored id keeps the ORIGINAL
    // tier-(b) conflict verdict (junk detection changes nothing here).
    const m = runBooking(
      [...junkEvidence, mkAppt("bk3", { contact_id: JUNK, client_phone: "5088891019" })],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real", duration_seconds: 30 })],
      [contact(JUNK), contact("c_real", { phone: "+15088891019", assigned_rep_id: "u_r1" })],
      [],
      "bk3",
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("ambiguous");
    expect(m.detail).toBe("phone resolves a different contact than the stored contact id");
    expect(m.emailResolution).toBeUndefined();
  });

  test("a phone that resolves to a DIFFERENT contact than the email blocks the resolution", () => {
    const m = runBooking(
      [
        ...junkEvidence,
        mkAppt("bk4", { contact_id: JUNK, client_phone: "5088891019", client_email: "alice@example.com" }),
      ],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" })],
      [
        contact(JUNK),
        contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" }),
        contact("c_phone", { phone: "+15088891019", assigned_rep_id: "u_r2" }),
      ],
      [],
      "bk4",
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("ambiguous");
    // Ambiguity clause 1: the phone tier hard-stops on its own conflict with
    // the stored contact id BEFORE the email tier is ever reached — a real
    // identity disagreement is never bypassed by the junk-contact resolution.
    expect(m.detail).toBe("phone resolves a different contact than the stored contact id");
    expect(m.emailResolution).toBeUndefined();
  });

  test("a phone resolving to the STORED (junk) contact does not block the resolution", () => {
    const m = runBooking(
      [
        ...junkEvidence,
        mkAppt("bk5", { contact_id: JUNK, client_phone: "5088891019", client_email: "alice@example.com" }),
      ],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" })],
      [
        contact(JUNK, { phone: "+15088891019" }),
        contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" }),
      ],
      [],
      "bk5",
    );
    expect(m.status).toBe("attributed");
    expect(m.method).toBe("email");
    expect(m.emailResolution).toBeDefined();
  });
});

// ---------- non-junk regression + observability ----------

describe("Rule B regression + observability", () => {
  test("a NON-junk stored contact keeps the ORIGINAL ambiguous conflict behavior", () => {
    const m = runBooking(
      [conflictBooking], // one appointment, one email → c_junk NOT junk here
      [mkCall("h1", { rep_id: "u_r2", contact_id: "c_real" })],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("ambiguous");
    expect(m.detail).toBe("email resolves a different contact than the stored contact id");
    expect(m.emailResolution).toBeUndefined();
    expect(m.reasonCode).toBeUndefined();
  });

  test("resolved + attributed rows persist an identity-resolved-via-email note and NULL reason_code", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [mkCall("h1", { rep_id: "u_r1", contact_id: "c_real" })],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    const { rows } = toAttributionRows([m], [], new Map([["h1", "call-internal-1"]]));
    expect(rows[0].reason_code).toBeNull(); // attributed rows never carry a code
    expect(rows[0].note).toContain("identity-resolved-via-email");
    expect(rows[0].note).toContain(`stored-contact=${JUNK}`);
    expect(rows[0].note).toContain("resolved-contact=c_real");
    expect(rows[0].rep_id).toBe("u_r1");
  });

  test("resolved + no-evidence rows keep their S4b no-rep category AND carry the resolution note", () => {
    const m = runBooking(
      [...junkEvidence, conflictBooking],
      [],
      [contact(JUNK), contact("c_real", { email: "alice@example.com", assigned_rep_id: "u_r1" })],
    );
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("no-qualifying-call");
    expect(m.noRepReason).toBe("no-window-interaction");
    const { rows } = toAttributionRows([m], [], new Map());
    expect(rows[0].reason_code).toBe("no-window-interaction");
    expect(rows[0].note).toContain("identity-resolved-via-email");
    expect(rows[0].note).toContain(`stored-contact=${JUNK}`);
  });
});
