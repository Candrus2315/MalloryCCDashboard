/**
 * S4b PART A — UNATTRIBUTED REASON BREAKDOWN.
 *
 * The engine now derives an honest no-rep category (noRepReason) for every
 * UNATTRIBUTED match, from signals it already computes; the sync persists it
 * to booking_attributions.reason_code (writer v3) and the Settings queue
 * renders it per row + as a grouped count summary. VERDICTS DO NOT CHANGE:
 *   1. the invariance suite reproduces the PRE-S4b engine's verdicts exactly
 *      (fixture: fixtures/s4b-verdict-baseline.json, captured from commit
 *      b64041e by scratch/s4b-baseline-dump.ts before the modification);
 *   2. the scenario matrix here also pins the classification itself.
 */
import { describe, expect, test } from "bun:test";
import {
  matchAppointmentsToCalls,
  type AttributionAppointment,
  type AttributionCall,
  type AttributionContact,
  type AttributionHarvestInteraction,
} from "../metrics/attribution";
import { toAttributionRows, ATTRIBUTION_WRITER_VERSION } from "../sync/attribution-tick";
import { buildUnattributedQueue, type AttributionRow } from "../metrics/compute";

const USERS = [
  { id: "u_r1", is_active: true },
  { id: "u_r2", is_active: true },
  { id: "u_x", is_active: false },
];
const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24, rep_mappings: [] };

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
  ...extra,
});
const mkHarvest = (id: string, extra: Partial<AttributionHarvestInteraction> = {}): AttributionHarvestInteraction => ({
  id,
  contact_external_id: "hl_c1",
  rep_id: null,
  started_at: "2026-09-15T15:00:00.000Z",
  duration_seconds: 5,
  ...extra,
});
const runEngine = (
  appts: AttributionAppointment[],
  calls: AttributionCall[],
  contacts: AttributionContact[],
  s1: AttributionHarvestInteraction[] = [],
) => matchAppointmentsToCalls(appts, calls, contacts, SETTINGS, { today: "2026-09-27", users: USERS, s1Interactions: s1 });

// ---------- 1) VERDICT INVARIANCE vs the pre-S4b engine ----------

describe("S4b verdict invariance — the engine's verdicts are byte-identical to the pre-S4b baseline", () => {
  /**
   * The EXACT scenario matrix scratch/s4b-baseline-dump.ts ran through the
   * PRE-change engine (commit b64041e) to produce
   * fixtures/s4b-verdict-baseline.json. Keep the two in sync: the fixture is
   * the before, this matrix is the after.
   */
  const matrix: Array<[string, AttributionAppointment[], AttributionCall[], AttributionContact[], AttributionHarvestInteraction[]]> = [
    ["cid-attributed", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")], []],
    ["cid-most-recent", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-15T14:00:00.000Z" }), mkCall("h2", { rep_id: "u_r1", started_at: "2026-09-15T16:00:00.000Z" })], [contact("c1")], []],
    ["cid-multi-rep-ambiguous", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1" }), mkCall("h2", { rep_id: "u_r2" })], [contact("c1")], []],
    ["s1-below-threshold-call-owns", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", duration_seconds: 30 })], [contact("c1")], []],
    ["no-window-interaction", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1")], []],
    ["interaction-without-roster-rep-call", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_x", duration_seconds: 30 })], [contact("c1")], []],
    ["interaction-without-roster-rep-call-over-threshold", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_x", duration_seconds: 900 })], [contact("c1")], []],
    ["interaction-without-roster-rep-harvest", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [mkHarvest("m1")]],
    ["s1-harvest-owns", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [mkHarvest("m1", { rep_id: "u_r1" })]],
    ["s1-harvest-multi-rep-ambiguous", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [mkHarvest("m1", { rep_id: "u_r1" }), mkHarvest("m2", { rep_id: "u_r2", started_at: "2026-09-15T16:00:00.000Z" })]],
    ["no-contact-identity", [mkAppt("a1")], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")], []],
    ["bad-datetime", [mkAppt("a1", { contact_id: "c1", created_at: "not-a-date", created_business_date: null, appointment_datetime: "also-bad" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")], []],
    ["dangling-cid-no-window", [mkAppt("a1", { contact_id: "c_missing" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1")], []],
    ["phone-no-matching-contact", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "9998887777" })], []],
    ["phone-attributed", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" })], []],
    ["phone-multi-contact-ambiguous", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" }), contact("c2", { phone: "5088891019" })], []],
    ["phone-contradicts-cid-ambiguous", [mkAppt("a1", { contact_id: "c1", client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c2" })], [contact("c1"), contact("c2", { phone: "+15088891019" })], []],
    ["email-different-contact-than-cid-ambiguous", [mkAppt("a1", { contact_id: "c1", client_email: "A@B.com" })], [mkCall("h1", { rep_id: "u_r2", contact_id: "c2" })], [contact("c1"), contact("c2", { email: "a@b.com" })], []],
    ["phone-tier-wins-before-email-reached", [mkAppt("a1", { client_phone: "5088891019", client_email: "a@b.com" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" }), contact("c2", { email: "a@b.com" })], []],
    ["window-day-minus-one", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-14T20:00:00.000Z" })], [contact("c1")], []],
    ["window-day-minus-two-out", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-13T20:00:00.000Z" })], [contact("c1")], []],
    ["threshold-equal-out", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", duration_seconds: 120 })], [contact("c1")], []],
    ["mapping-resolved-attributes", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: null, provider_rep_external_id: "hl_u9" })], [contact("c1")], []],
    ["cancelled-still-judged", [mkAppt("a1", { contact_id: "c1", cancelled: true, status: "cancelled" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")], []],
    ["legacy-date-only-anchor", [mkAppt("a1", { contact_id: "c1", created_at: "2026-09-15", created_business_date: null })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-15T15:00:00.000Z" })], [contact("c1")], []],
  ];

  test("every verdict field (status, rep, call, method, reason, detail, evidence, window) is unchanged", async () => {
    const baseline = JSON.parse(
      await Bun.file(new URL("./fixtures/s4b-verdict-baseline.json", import.meta.url).pathname).text(),
    ).scenarios as Array<{ name: string; matches: Array<Record<string, unknown>> }>;
    const KEYS = ["appointmentId", "status", "repId", "callExternalId", "method", "reason", "detail", "evidence", "window"] as const;
    const strip = (m: Record<string, unknown>) => Object.fromEntries(KEYS.map((k) => [k, m[k] === undefined ? null : m[k]]));
    for (const [name, appts, calls, contacts, s1] of matrix) {
      const got = runEngine(appts, calls, contacts, s1).map(strip);
      const want = baseline.find((b) => b.name === name)?.matches.map(strip);
      expect(want).toBeDefined();
      expect(got).toEqual(want);
    }
  });
});

// ---------- 2) the classification itself ----------

describe("S4b no-rep classification — honest categories from engine signals", () => {
  test("identity resolved, nothing in the window → no-window-interaction", () => {
    const [m] = runEngine([mkAppt("a1", { contact_id: "c1" })], [], [contact("c1")]);
    expect(m.status).toBe("unattributed");
    expect(m.reason).toBe("no-qualifying-call");
    expect(m.noRepReason).toBe("no-window-interaction");
  });

  test("dangling contact id (no contact row, no calls for the id) → no-window-interaction (evidence checked on the id)", () => {
    const [m] = runEngine([mkAppt("a1", { contact_id: "c_missing" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1")]);
    expect(m.reason).toBe("no-qualifying-call");
    expect(m.noRepReason).toBe("no-window-interaction");
  });

  test("in-window call with a NON-ROSTER rep (any duration) → interaction-without-roster-rep", () => {
    const [m] = runEngine([mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_x", duration_seconds: 30 })], [contact("c1")]);
    expect(m.reason).toBe("no-qualifying-call");
    expect(m.noRepReason).toBe("interaction-without-roster-rep");
  });

  test("in-window harvested message whose HL user does not resolve → interaction-without-roster-rep", () => {
    const [m] = runEngine([mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [mkHarvest("m1")]);
    expect(m.noRepReason).toBe("interaction-without-roster-rep");
  });

  test("out-of-window activity does NOT trigger the category (window discipline) — day-2-only call is no-window-interaction", () => {
    const [m] = runEngine([mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_x", started_at: "2026-09-13T20:00:00.000Z" })], [contact("c1")]);
    expect(m.noRepReason).toBe("no-window-interaction");
  });

  test("phone/email carry identity but no contact record matches → no-matching-contact", () => {
    const [m] = runEngine([mkAppt("a1", { client_phone: "5088891019", client_email: "nobody@x.com" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "9998887777", email: "other@x.com" })]);
    expect(m.reason).toBe("no-qualifying-call");
    expect(m.noRepReason).toBe("no-matching-contact");
  });

  test("no identity at all → no-contact-identity; unparseable anchor → bad-datetime", () => {
    const [a] = runEngine([mkAppt("a1")], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")]);
    expect(a.noRepReason).toBe("no-contact-identity");
    const [b] = runEngine([mkAppt("a2", { contact_id: "c1", created_at: "junk", created_business_date: null, appointment_datetime: "junk" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")]);
    expect(b.noRepReason).toBe("bad-datetime");
  });

  test("AMBIGUOUS rows never carry a no-rep category — their identity-conflict presentation is unchanged", () => {
    const multiRep = runEngine([mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1" }), mkCall("h2", { rep_id: "u_r2" })], [contact("c1")]);
    expect(multiRep[0].reason).toBe("ambiguous");
    expect(multiRep[0].noRepReason).toBeUndefined();
    const multiContact = runEngine([mkAppt("a2", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" }), contact("c2", { phone: "5088891019" })]);
    expect(multiContact[0].noRepReason).toBeUndefined();
  });

  test("ATTRIBUTED rows never carry a no-rep category", () => {
    const rows = runEngine(
      [mkAppt("a1", { contact_id: "c1" }), mkAppt("a2", { contact_id: "c1" }), mkAppt("a3", { contact_id: "c2" })],
      [
        mkCall("h1", { rep_id: "u_r1", contact_id: "c1" }),
        mkCall("h2", { rep_id: "u_r1", contact_id: "c1", duration_seconds: 30 }),
        mkCall("h3", { rep_id: "u_x", contact_id: "c2", duration_seconds: 30 }),
      ],
      [contact("c1")],
      [],
    );
    // a1 (qualifying call) and a2 (s1 any-duration ownership) attribute; a3's
    // contact has only an owner-less in-window interaction.
    expect(rows.find((m) => m.appointmentId === "a1")?.status).toBe("attributed");
    expect(rows.find((m) => m.appointmentId === "a1")?.noRepReason).toBeUndefined();
    expect(rows.find((m) => m.appointmentId === "a2")?.noRepReason).toBeUndefined();
    expect(rows.find((m) => m.appointmentId === "a3")?.noRepReason).toBe("interaction-without-roster-rep");
  });
});

// ---------- 3) persistence: toAttributionRows → reason_code ----------

describe("S4b reason_code persistence — the sync wiring stores the category", () => {
  const attrRow = (over: Partial<AttributionRow>): AttributionRow => ({
    id: "",
    appointment_id: over.appointment_id ?? "a1",
    call_id: null,
    rep_id: null,
    method: "none",
    confidence: 0,
    manual_override: false,
    ...over,
  });

  test("writer version bumped to 3 (a v2 writer would leave stale reason_code behind conflict-updates)", () => {
    expect(ATTRIBUTION_WRITER_VERSION).toBe(3);
  });

  test("unattributed rows carry reason_code; attributed rows are NULL; note format unchanged", () => {
    const { rows } = toAttributionRows(
      [
        { appointmentId: "a1", status: "attributed", callExternalId: "h1", repId: "u_r1", method: "contact_id" },
        { appointmentId: "a2", status: "unattributed", reason: "no-qualifying-call", noRepReason: "no-window-interaction", window: { from: "2026-09-14", to: "2026-09-15", marker: "date_granularity_window", anchoredOn: "created_business_date" } },
        { appointmentId: "a3", status: "unattributed", reason: "ambiguous", detail: "phone matches 2 distinct contacts" },
      ],
      [],
      new Map([["h1", "call-internal-1"]]),
    );
    expect(rows.find((r) => r.appointment_id === "a1")?.reason_code).toBeNull();
    const a2 = rows.find((r) => r.appointment_id === "a2")!;
    expect(a2.reason_code).toBe("no-window-interaction");
    expect((a2.note ?? "").startsWith("no-qualifying-call")).toBe(true);
    expect(a2.note).toContain("date_granularity_window");
    const a3 = rows.find((r) => r.appointment_id === "a3")!;
    expect(a3.reason_code).toBe("ambiguous");
    expect((a3.note ?? "").startsWith("ambiguous")).toBe(true);
  });

  test("a match without a refined category (legacy callers) persists NULL, never a guess", () => {
    const { rows } = toAttributionRows([{ appointmentId: "a1", status: "unattributed", reason: "no-qualifying-call" }], [], new Map());
    expect(rows[0].reason_code).toBeNull();
  });

  test("MANUAL WINS: a manual_override row is carried verbatim (its reason_code stays whatever manual assignment left — NULL)", () => {
    const manual = attrRow({ appointment_id: "a1", rep_id: "u_r1", method: "manual", confidence: 1, manual_override: true, reason_code: null });
    const { rows, manuallyAssignedIds } = toAttributionRows(
      [{ appointmentId: "a1", status: "unattributed", reason: "no-qualifying-call", noRepReason: "no-window-interaction" }],
      [manual],
      new Map(),
    );
    expect(manuallyAssignedIds).toEqual(["a1"]);
    expect(rows[0].manual_override).toBe(true);
    expect(rows[0].reason_code).toBeNull();
  });
});

// ---------- 4) the queue row carries the stored category ----------

describe("S4b queue rows — reason_code sourcing (stored tick classification first)", () => {
  const queueInput = (over: Partial<Parameters<typeof buildUnattributedQueue>[0]> = {}) => ({
    appointments: [
      {
        id: "a1",
        contact_id: "c1",
        calendar_id: null,
        appointment_type: "Family Portrait Session",
        appointment_datetime: "2026-09-16T18:00:00.000Z",
        created_at: "2026-09-15T14:00:00.000Z",
        status: "scheduled",
        cancelled: false,
        client_name: "Test Client",
        client_phone: null,
        client_email: null,
        calendar_name: "Family Studio",
      },
    ],
    attributions: [] as AttributionRow[],
    calls: [],
    contacts: [{ id: "c1", phone: null, email: null, assigned_rep_id: null }],
    thresholdSeconds: 120,
    ...over,
  });

  test("stored reason_code wins over the live match's noRepReason (the queue's live run sees no harvest)", () => {
    const rows = buildUnattributedQueue(
      queueInput({
        attributions: [attrRowLite("a1", "interaction-without-roster-rep")],
        matches: [{ appointmentId: "a1", reason: "no-qualifying-call", noRepReason: "no-window-interaction" }],
      }),
    );
    expect(rows[0].reason).toBe("no-qualifying-call");
    expect(rows[0].reason_code).toBe("interaction-without-roster-rep");
  });

  test("no stored row → the live engine match's noRepReason is the fallback", () => {
    const rows = buildUnattributedQueue(
      queueInput({ matches: [{ appointmentId: "a1", reason: "no-qualifying-call", noRepReason: "no-window-interaction" }] }),
    );
    expect(rows[0].reason_code).toBe("no-window-interaction");
  });

  test("neither available → NULL, never guessed", () => {
    const rows = buildUnattributedQueue(queueInput({}));
    expect(rows[0].reason_code).toBeNull();
  });
});

/** Minimal stored-row builder for queue tests (AttributionRow shape). */
function attrRowLite(appointmentId: string, reasonCode: string | null): AttributionRow {
  return {
    id: `attr:${appointmentId}`,
    appointment_id: appointmentId,
    call_id: null,
    rep_id: null,
    method: "none",
    confidence: 0,
    manual_override: false,
    note: "no-qualifying-call — test",
    reason_code: reasonCode,
  };
}
