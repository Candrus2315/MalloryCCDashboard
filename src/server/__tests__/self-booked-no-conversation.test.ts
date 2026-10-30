/**
 * OWNER RULING 2026-10-30 — ONLINE/SELF-BOOKED BOOKINGS STAY TEAM-ONLY.
 *
 * "A booking the client made themselves online must never be credited to a
 * rep." Named case: Ariana Freddura was credited to Jennifer Stitt on the
 * basis of window_interaction confidence 0.6 whose ONLY evidence was a
 * ZERO-DURATION call (a dial attempt, no conversation). That is self-booked
 * behavior → team-only.
 *
 * Discriminator = evidence strength on the WINNING evidence, never Acuity
 * data (Ariana's and Charlotte Arredondo's raw Acuity payloads have identical
 * key sets — Acuity exposes no "booked online" flag):
 *   - KEEP crediting (conversation-grade): contact_id, phone/email (deterministic
 *     identity), manual (owner assignments), owner-rule-auction, and
 *     window_interaction whose winning evidence call has duration_seconds > 0
 *     (a real answered conversation — the invoice-flow shape).
 *   - GO TEAM-ONLY: window_interaction whose winning evidence call has
 *     duration_seconds = 0 (and unknown length — it cannot demonstrate a
 *     conversation either). Team totals (Weekly Gross/Cancel/Net, qualifying
 *     wins) are UNCHANGED — these remain wins; only rep-level credit drops.
 *
 * Pins the two live reference shapes:
 *   - Ariana Freddura, appointments.id d329f080-8e04-4a58-8de3-62571601682f —
 *     method window_interaction 0.6, evidence call FRm6Z2yowbKcVc6wha2q dur=0,
 *     rep Jennifer Stitt → AFTER the ruling: rep none/team-only.
 *   - Charlotte Arredondo, appointments.id f954699a-a29d-4c39-99a5-959a0e031438
 *     — method contact_id 1.0, rep Allison Wittner → UNCHANGED, still credited.
 */
import { describe, expect, test } from "bun:test";
import {
  matchAppointmentsToCalls,
  OWNER_RULE_AUCTION_METHOD,
  type AttributionAppointment,
  type AttributionCall,
  type AttributionContact,
} from "../metrics/attribution";
import { attributionStateOf, type AttributionRow } from "../metrics/compute";
import { toAttributionRows, ATTRIBUTION_WRITER_VERSION } from "../sync/attribution-tick";

const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24 };
// Booking created Mon 2026-09-28 10:00 ET → window = ET dates 09-27..09-28.
const CREATED_AT = "2026-09-28T14:00:00.000Z";
const IN_WINDOW = "2026-09-27T18:00:00.000Z"; // ET 2026-09-27 14:00 (prior day)
const IN_WINDOW_LATER = "2026-09-28T13:00:00.000Z"; // ET 2026-09-28 09:00 (creation day)
const JENN = "7ee136e8-9eca-4bfb-9e90-a3a740775f37"; // Jennifer Stitt (reference-case rep)
const ALLISON = "4c7433d9-64a7-4aea-b07a-961dd7aff695"; // Allison Wittner (reference-case rep)
const USERS = [
  { id: JENN, is_active: true },
  { id: ALLISON, is_active: true },
];
const RULING_CODE = "self-booked-no-conversation";

const appt = (over: Partial<AttributionAppointment> = {}): AttributionAppointment => ({
  id: "appt-x",
  contact_id: null,
  client_phone: null,
  client_email: null,
  appointment_datetime: CREATED_AT,
  created_at: CREATED_AT,
  ...over,
});
const call = (external_call_id: string, over: Partial<AttributionCall> = {}): AttributionCall => ({
  external_call_id,
  rep_id: null,
  contact_id: null,
  started_at: IN_WINDOW,
  duration_seconds: 600,
  ...over,
});
const contact = (id: string, over: Partial<AttributionContact> = {}): AttributionContact => ({ id, ...over });

// ---------- the two live reference shapes, pinned as regression fixtures ----------

describe("self-booked ruling — the live reference cases", () => {
  test("ARIANA FREDDURA shape: window_interaction on a 0-duration call → rep none, team-only", () => {
    const [match] = matchAppointmentsToCalls(
      [
        appt({
          id: "d329f080-8e04-4a58-8de3-62571601682f",
          contact_id: "c-ariana",
          client_email: "ariana@example.com",
        }),
      ],
      // the ONLY evidence: a dial attempt, dur=0 (HL evidence FRm6Z2yowbKcVc6wha2q)
      [call("FRm6Z2yowbKcVc6wha2q", { id: "call-67a47c8b", contact_id: "c-ariana", rep_id: JENN, duration_seconds: 0 })],
      [contact("c-ariana")],
      SETTINGS,
      { users: USERS },
    );
    expect(match.status).toBe("unattributed");
    expect(match.reason).toBe(RULING_CODE);
    expect(match.reasonCode).toBe(RULING_CODE);
    expect(match.repId).toBeUndefined(); // no rep credit — team-only
    expect(match.evidence?.id).toBe("FRm6Z2yowbKcVc6wha2q"); // evidence trail kept
    expect(match.evidence?.duration_seconds).toBe(0);

    const [row] = toAttributionRows([match], [], new Map([["FRm6Z2yowbKcVc6wha2q", "call-67a47c8b"]])).rows;
    expect(row.rep_id).toBeNull();
    expect(row.method).toBe("none");
    expect(row.confidence).toBe(0);
    expect(row.reason_code).toBe(RULING_CODE);
    expect(row.manual_override).toBe(false);
    // the audit note stays honest: the ruling AND the ruled-out evidence
    expect(row.note ?? "").toContain(RULING_CODE);
    expect(row.note ?? "").toContain("owner ruling 2026-10-30");
    expect(row.note ?? "").toContain("s1 window-interaction src=calls evidence=FRm6Z2yowbKcVc6wha2q dur=0");
    expect(attributionStateOf(row)).toBe("unattributed");
  });

  test("CHARLOTTE ARREDONDO shape: contact_id 1.0 with a real call → UNCHANGED, still credited", () => {
    const [match] = matchAppointmentsToCalls(
      [
        appt({
          id: "f954699a-a29d-4c39-99a5-959a0e031438",
          contact_id: "c-charlotte",
          client_email: "charlotte@example.com",
        }),
      ],
      // a real answered conversation in-window (>threshold, the invoice-flow shape)
      [call("hl-charlotte", { id: "call-f95", contact_id: "c-charlotte", rep_id: ALLISON, duration_seconds: 540 })],
      [contact("c-charlotte")],
      SETTINGS,
      { users: USERS },
    );
    expect(match.status).toBe("attributed");
    expect(match.method).toBe("contact_id");
    expect(match.repId).toBe(ALLISON);
    const [row] = toAttributionRows([match], [], new Map([["hl-charlotte", "call-f95"]])).rows;
    expect(row.rep_id).toBe(ALLISON);
    expect(row.method).toBe("contact_id");
    expect(row.confidence).toBe(1);
    expect(row.reason_code).toBeNull();
    expect(attributionStateOf(row)).toBe("attributed");
  });
});

// ---------- the ruling's keep/team-only boundary ----------

describe("self-booked ruling — conversation-grade vs dial attempts", () => {
  test("window_interaction with a REAL call (dur>0) as winning evidence is still credited", () => {
    const [match] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-real", { contact_id: "c-1", rep_id: JENN, duration_seconds: 45 })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(match.status).toBe("attributed");
    expect(match.method).toBe("window_interaction");
    expect(match.repId).toBe(JENN);
    expect(match.evidence?.duration_seconds).toBe(45);
  });

  test("unknown-duration call evidence cannot demonstrate a conversation → team-only", () => {
    const [match] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [call("hl-unknown", { contact_id: "c-1", rep_id: JENN, duration_seconds: null })],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(match.status).toBe("unattributed");
    expect(match.reasonCode).toBe(RULING_CODE);
    expect(match.evidence?.duration_seconds).toBeNull();
  });

  test("harvest-message evidence (a real conversation) is unaffected by the ruling", () => {
    const [match] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [],
      [contact("c-1", { external_id: "hl-cnt-1" })],
      SETTINGS,
      {
        users: USERS,
        s1Interactions: [
          { id: "msg-1", contact_external_id: "hl-cnt-1", rep_id: JENN, started_at: IN_WINDOW, duration_seconds: null },
        ],
      },
    );
    expect(match.status).toBe("attributed");
    expect(match.method).toBe("window_interaction");
    expect(match.repId).toBe(JENN);
  });

  test("the ruling keys off the WINNING evidence: a later dial wins the pick and is ruled team-only (selection unchanged)", () => {
    // Earlier real conversation, later stray dial — most-recent-wins selection
    // is UNCHANGED by the ruling; the 0-duration winner is then ruled out.
    // (Deliberate literal reading of "whose winning evidence call has
    // duration_seconds = 0" — flagged to the lead: 8 live October rows have
    // this shape and an owner refinement could fall back to the conversation.)
    const [match] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-1" })],
      [
        call("hl-talk", { contact_id: "c-1", rep_id: JENN, started_at: IN_WINDOW, duration_seconds: 90 }),
        call("hl-dial", { contact_id: "c-1", rep_id: JENN, started_at: IN_WINDOW_LATER, duration_seconds: 0 }),
      ],
      [contact("c-1")],
      SETTINGS,
      { users: USERS },
    );
    expect(match.status).toBe("unattributed");
    expect(match.reasonCode).toBe(RULING_CODE);
    expect(match.evidence?.id).toBe("hl-dial");
  });

  test("stronger tiers are untouched: contact_id / email / owner-rule-auction still credit", () => {
    // contact_id tier (sub-threshold call would NOT credit; use >threshold for the tier)
    const [viaContact] = matchAppointmentsToCalls(
      [appt({ contact_id: "c-2" })],
      [call("hl-c2", { contact_id: "c-2", rep_id: ALLISON, duration_seconds: 300 })],
      [contact("c-2")],
      SETTINGS,
      { users: USERS },
    );
    expect(viaContact.status).toBe("attributed");
    expect(viaContact.method).toBe("contact_id");

    // email tier: no calls at all → unattributed no-qualifying-call (NOT the ruling code)
    const [viaEmail] = matchAppointmentsToCalls(
      [appt({ client_email: "someone@example.com" })],
      [],
      [contact("c-3", { email: "someone@example.com" })],
      SETTINGS,
      { users: USERS },
    );
    expect(viaEmail.status).toBe("unattributed");
    expect(viaEmail.reason).toBe("no-qualifying-call");
    expect(viaEmail.reasonCode).toBeUndefined();

    // owner-rule-auction: evidence-independent, unaffected
    const [viaAuction] = matchAppointmentsToCalls(
      [appt({ appointment_type: "Auction Session", client_email: "bidder@example.com" })],
      [],
      [],
      SETTINGS,
      { users: USERS, ownerRules: { auctionRepId: ALLISON } },
    );
    expect(viaAuction.status).toBe("attributed");
    expect(viaAuction.method).toBe(OWNER_RULE_AUCTION_METHOD);
    expect(viaAuction.repId).toBe(ALLISON);
  });
});

// ---------- persist layer: manual overrides, idempotency, team totals ----------

describe("self-booked ruling — recompute safety", () => {
  const matches = () =>
    matchAppointmentsToCalls(
      [
        appt({ id: "appt-ariana", contact_id: "c-ariana" }),
        appt({ id: "appt-charlotte", contact_id: "c-charlotte" }),
        appt({ id: "appt-auction", appointment_type: "Auction Sitting", contact_id: "c-auction" }),
      ],
      [
        call("FRm6Z2yowbKcVc6wha2q", { contact_id: "c-ariana", rep_id: JENN, duration_seconds: 0 }),
        call("hl-charlotte", { contact_id: "c-charlotte", rep_id: ALLISON, duration_seconds: 540 }),
      ],
      [contact("c-ariana"), contact("c-charlotte"), contact("c-auction")],
      SETTINGS,
      { users: USERS, ownerRules: { auctionRepId: ALLISON } },
    );

  test("exactly one verdict row per appointment — team win counts unchanged", () => {
    // Team totals come from the appointments table (the qualifying chain), never
    // from attributions — the ruling only relabels WHO gets credit. The
    // invariant here: every appointment keeps exactly ONE verdict row, so no
    // win loses its record and no extra rows appear.
    const m = matches();
    expect(m).toHaveLength(3);
    const { rows } = toAttributionRows(m, [], new Map());
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.appointment_id)).size).toBe(3);
    const byRep = rows.filter((r) => r.rep_id != null);
    expect(byRep.map((r) => r.appointment_id).sort()).toEqual(["appt-auction", "appt-charlotte"]);
  });

  test("manual_override rows are never touched by the recompute (existing contract)", () => {
    const manual: AttributionRow = {
      id: "attr:appt-ariana",
      appointment_id: "appt-ariana",
      call_id: null,
      rep_id: JENN,
      method: "manual",
      confidence: 1,
      manual_override: true,
      note: "owner assignment",
      reason_code: null,
    };
    const { rows, manuallyAssignedIds } = toAttributionRows(matches(), [manual], new Map());
    const carried = rows.find((r) => r.appointment_id === "appt-ariana");
    expect(carried).toEqual(manual); // verbatim — the engine's judgment never overwrites it
    expect(manuallyAssignedIds).toContain("appt-ariana");
  });

  test("recompute is IDEMPOTENT — same inputs derive byte-identical rows", () => {
    const first = toAttributionRows(matches(), [], new Map());
    const second = toAttributionRows(matches(), [], new Map());
    expect(second.rows).toEqual(first.rows);
    expect(second.manuallyAssignedIds).toEqual(first.manuallyAssignedIds);
    // and a re-run over its own output reproduces the same rows again
    const third = toAttributionRows(matches(), first.rows, new Map());
    expect(third.rows).toEqual(first.rows);
  });

  test("writer version is 6 — stale v5 writers cannot re-credit the ruled-out rows", () => {
    expect(ATTRIBUTION_WRITER_VERSION).toBe(6);
  });
});
