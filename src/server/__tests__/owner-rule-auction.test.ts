/**
 * OWNER RULE: auction-genre bookings → Allison Wittner (owner directive
 * 2026-10-19, verbatim "if there is ever any auction bookings it came from
 * Allison, always contribute those to her").
 *
 * Covers the task's required regression cases:
 *  - an auction-genre appointment with NO interaction evidence still
 *    attributes to Allison (engine rule, end-to-end through the tick wiring
 *    into the store);
 *  - a NON-auction appointment with no evidence stays UNATTRIBUTED (rule
 *    does not leak into other genres);
 *  - the rule wins over qualifying-call evidence naming another rep, and
 *    over the ambiguity queue;
 *  - the persist layer supersedes a different-rep manual override (flip
 *    audited into manual_overrides) and leaves an Allison manual row
 *    verbatim;
 *  - fail-honest: without the rule rep resolved, auction bookings are NOT
 *    guessed.
 */
import { describe, expect, test } from "bun:test";
import {
  matchAppointmentsToCalls,
  OWNER_RULE_AUCTION_METHOD,
  OWNER_RULE_AUCTION_NOTE,
  OWNER_RULE_AUCTION_REASON,
  type AttributionAppointment,
  type AttributionCall,
  type AttributionContact,
} from "../metrics/attribution";
import { toAttributionRows, computeAndPersistAttributions } from "../sync/attribution-tick";
import { isAuctionSession } from "../metrics/weekly";
import type { AppSettings, AttributionRow } from "../store/types";
import { MemoryStore } from "../store/memory";

const ALLISON = "user-allison";
const OTHER = "user-other";

const baseSettings: AppSettings = {
  meaningful_call_threshold_seconds: 120,
  attribution_window_hours: 24,
  acuity: {} as AppSettings["acuity"],
  rep_mappings: [],
} as unknown as AppSettings;

function appt(overrides: Partial<AttributionAppointment> & { id: string }): AttributionAppointment {
  return {
    contact_id: null,
    appointment_datetime: "2026-10-17T18:30:00Z",
    created_at: "2026-10-17T14:00:00Z",
    created_business_date: "2026-10-17",
    appointment_type: "Portrait Session + 20\" Portrait",
    ...overrides,
  };
}

function call(overrides: Partial<AttributionCall> & { id: string; external_call_id: string }): AttributionCall {
  return {
    rep_id: OTHER,
    contact_id: "contact-1",
    started_at: "2026-10-17T13:00:00Z",
    duration_seconds: 600,
    ...overrides,
  };
}

const contact: AttributionContact = { id: "contact-1", phone: "5551234567", email: "client@example.com" };

describe("isAuctionSession (canonical auction-genre classifier)", () => {
  test("matches live auction types, case-insensitive; rejects other genres", () => {
    expect(isAuctionSession('Auction Portrait Session + 20" Portrait + Hotel')).toBe(true);
    expect(isAuctionSession("Auction Animalia Session + 20\" Portrait")).toBe(true);
    expect(isAuctionSession("auction portrait session")).toBe(true);
    expect(isAuctionSession('Portrait Session + 20" Portrait')).toBe(false);
    expect(isAuctionSession("Alliance Portrait Session")).toBe(false);
    expect(isAuctionSession("Animalia Session")).toBe(false);
    expect(isAuctionSession(null)).toBe(false);
    expect(isAuctionSession("")).toBe(false);
  });
});

describe("matchAppointmentsToCalls — owner rule (auction → Allison)", () => {
  test("auction appointment with NO interaction evidence still attributes to Allison", () => {
    const matches = matchAppointmentsToCalls(
      [appt({ id: "a1", appointment_type: 'Auction Portrait Session + 20" Portrait' })],
      [],
      [contact],
      baseSettings,
      { ownerRules: { auctionRepId: ALLISON } },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.status).toBe("attributed");
    expect(matches[0]!.repId).toBe(ALLISON);
    expect(matches[0]!.method).toBe(OWNER_RULE_AUCTION_METHOD);
  });

  test("non-auction appointment with no evidence stays unattributed (rule does not leak)", () => {
    const matches = matchAppointmentsToCalls(
      [appt({ id: "a2", appointment_type: 'Portrait Session + 20" Portrait' })],
      [],
      [contact],
      baseSettings,
      { ownerRules: { auctionRepId: ALLISON } },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.status).toBe("unattributed");
  });

  test("rule WINS OVER qualifying-call evidence naming another rep", () => {
    const matches = matchAppointmentsToCalls(
      [appt({ id: "a3", appointment_type: "Auction Animalia Session + 20\" Portrait", contact_id: "contact-1" })],
      [call({ id: "c1", external_call_id: "hl-1" })],
      [contact],
      baseSettings,
      { ownerRules: { auctionRepId: ALLISON } },
    );
    expect(matches[0]!.status).toBe("attributed");
    expect(matches[0]!.repId).toBe(ALLISON);
    expect(matches[0]!.method).toBe(OWNER_RULE_AUCTION_METHOD);
  });

  test("rule wins over the ambiguity queue (multi-rep evidence)", () => {
    const matches = matchAppointmentsToCalls(
      [appt({ id: "a4", appointment_type: 'Auction Portrait Session + 20" Portrait + Hotel', contact_id: "contact-1" })],
      [
        call({ id: "c1", external_call_id: "hl-1", rep_id: OTHER }),
        call({ id: "c2", external_call_id: "hl-2", rep_id: "user-third", started_at: "2026-10-17T12:00:00Z" }),
      ],
      [contact],
      baseSettings,
      { ownerRules: { auctionRepId: ALLISON } },
    );
    expect(matches[0]!.status).toBe("attributed");
    expect(matches[0]!.repId).toBe(ALLISON);
    expect(matches[0]!.method).toBe(OWNER_RULE_AUCTION_METHOD);
  });

  test("fail-honest: rule inactive without auctionRepId — nothing guessed", () => {
    const matches = matchAppointmentsToCalls(
      [appt({ id: "a5", appointment_type: 'Auction Portrait Session + 20" Portrait' })],
      [],
      [contact],
      baseSettings,
      {},
    );
    expect(matches[0]!.status).toBe("unattributed");
  });
});

describe("toAttributionRows — owner rule row shaping + manual-override composition", () => {
  test("rule match → owner-rule row with directive note + reason_code", () => {
    const matches = matchAppointmentsToCalls(
      [appt({ id: "a6", appointment_type: 'Auction Portrait Session + 20" Portrait' })],
      [],
      [],
      baseSettings,
      { ownerRules: { auctionRepId: ALLISON } },
    );
    const { rows, supersededManualIds } = toAttributionRows(matches, [], new Map(), { auctionRepId: ALLISON });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rep_id).toBe(ALLISON);
    expect(rows[0]!.method).toBe(OWNER_RULE_AUCTION_METHOD);
    expect(rows[0]!.reason_code).toBe(OWNER_RULE_AUCTION_REASON);
    expect(rows[0]!.note).toBe(OWNER_RULE_AUCTION_NOTE);
    expect(rows[0]!.manual_override).toBe(false);
    expect(supersededManualIds).toHaveLength(0);
  });

  test("different-rep manual override is SUPERSEDED by the rule", () => {
    const manual: AttributionRow = {
      id: "attr:a7",
      appointment_id: "a7",
      call_id: null,
      rep_id: OTHER,
      method: "manual",
      confidence: 1,
      manual_override: true,
    };
    const matches = matchAppointmentsToCalls(
      [appt({ id: "a7", appointment_type: 'Auction Portrait Session + 20" Portrait' })],
      [],
      [],
      baseSettings,
      { ownerRules: { auctionRepId: ALLISON } },
    );
    const { rows, supersededManualIds } = toAttributionRows(matches, [manual], new Map(), { auctionRepId: ALLISON });
    expect(rows[0]!.rep_id).toBe(ALLISON);
    expect(rows[0]!.method).toBe(OWNER_RULE_AUCTION_METHOD);
    expect(rows[0]!.manual_override).toBe(false);
    expect(supersededManualIds).toEqual(["a7"]);
  });

  test("Allison manual override is carried VERBATIM (no churn)", () => {
    const manual: AttributionRow = {
      id: "attr:a8",
      appointment_id: "a8",
      call_id: null,
      rep_id: ALLISON,
      method: "manual",
      confidence: 1,
      manual_override: true,
    };
    const matches = matchAppointmentsToCalls(
      [appt({ id: "a8", appointment_type: 'Auction Portrait Session + 20" Portrait' })],
      [],
      [],
      baseSettings,
      { ownerRules: { auctionRepId: ALLISON } },
    );
    const { rows, supersededManualIds } = toAttributionRows(matches, [manual], new Map(), { auctionRepId: ALLISON });
    expect(rows[0]).toEqual(manual);
    expect(supersededManualIds).toHaveLength(0);
  });
});

describe("computeAndPersistAttributions — end-to-end through the store (memory)", () => {
  const ACUITY_AUCTION = "acx-auction";
  const ACUITY_FAMILY = "acx-family";
  const ACUITY_MANUAL = "acx-manual";

  async function seedStore(
    withManualOther: boolean,
  ): Promise<{ store: MemoryStore; allisonId: string; otherId: string }> {
    const store = new MemoryStore();
    await store.upsertUsers([
      { id: ALLISON, provider: "highlevel", external_id: "hl-allison", name: "Allison Wittner", email: null, is_active: true } as never,
      { id: OTHER, provider: "highlevel", external_id: "hl-other", name: "Other Rep", email: null, is_active: true } as never,
    ]);
    // The store assigns its own canonical ids on upsert (keyed by provider +
    // external_id) — resolve them by name instead of assuming the seed ids.
    const users = await store.getAllUsers();
    const allisonId = users.find((u) => u.name === "Allison Wittner")!.id;
    const otherId = users.find((u) => u.name === "Other Rep")!.id;
    await store.upsertContacts([
      { id: "contact-1", phone: "5551234567", email: "client@example.com", external_id: "hl-contact-1", assigned_rep_id: OTHER } as never,
    ]);
    await store.upsertAppointments([
      {
        acuity_appointment_id: ACUITY_AUCTION,
        contact_id: "contact-1",
        appointment_type: 'Auction Portrait Session + 20" Portrait',
        appointment_datetime: "2026-10-17T18:30:00Z",
        created_at: "2026-10-17T14:00:00Z",
        created_business_date: "2026-10-17",
        client_name: "Auction Client",
        client_phone: "5551234567",
        client_email: "client@example.com",
        status: "scheduled",
        cancelled: false,
      },
      {
        acuity_appointment_id: ACUITY_FAMILY,
        contact_id: "contact-1",
        appointment_type: 'Portrait Session + 20" Portrait',
        appointment_datetime: "2026-10-17T18:30:00Z",
        created_at: "2026-10-17T14:00:00Z",
        created_business_date: "2026-10-17",
        client_name: "Family Client",
        client_phone: "5551234567",
        client_email: "client@example.com",
        status: "scheduled",
        cancelled: false,
      },
      ...(withManualOther
        ? [{
            acuity_appointment_id: ACUITY_MANUAL,
            contact_id: "contact-1",
            appointment_type: 'Auction Portrait Session + 20" Portrait + Hotel',
            appointment_datetime: "2026-10-17T19:30:00Z",
            created_at: "2026-10-17T14:30:00Z",
            created_business_date: "2026-10-17",
            client_name: "Manual Client",
            client_phone: "5551234567",
            client_email: "client@example.com",
            status: "scheduled",
            cancelled: false,
          }]
        : []),
    ] as never);
    if (withManualOther) {
      const appts = await store.getAllAppointmentsSince("1970-01-01T00:00:00Z");
      const manualAppt = appts.find((a) => a.appointment_type?.includes("Hotel"));
      await store.setManualAttribution({
        id: `attr:${manualAppt!.id}`,
        appointment_id: manualAppt!.id,
        call_id: null,
        rep_id: otherId,
        method: "manual",
        confidence: 1,
        manual_override: true,
      });
    }
    return { store, allisonId, otherId };
  }

  function internalIdByAcuity(appts: { id: string; acuity_appointment_id?: string | null }[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of appts) if (a.acuity_appointment_id) out[a.acuity_appointment_id] = a.id;
    return out;
  }

  test("auction appointment with NO evidence ends attributed to Allison in the store; non-auction does not", async () => {
    const { store, allisonId } = await seedStore(false);
    const now = new Date("2026-10-19T15:00:00Z");
    const res = await computeAndPersistAttributions(store, baseSettings, { now: () => now, force: true });
    expect(res.outcome).toBe("synced");
    expect(res.ownerRuleApplied).toBe(1);

    const rows = await store.getAttributions();
    const appts = await store.getAllAppointmentsSince("1970-01-01T00:00:00Z");
    const ids = internalIdByAcuity(appts as never);
    const auctionRow = rows.find((r) => r.appointment_id === ids[ACUITY_AUCTION]);
    const familyRow = rows.find((r) => r.appointment_id === ids[ACUITY_FAMILY]);
    expect(auctionRow!.rep_id).toBe(allisonId);
    expect(auctionRow!.method).toBe(OWNER_RULE_AUCTION_METHOD);
    expect(auctionRow!.reason_code).toBe(OWNER_RULE_AUCTION_REASON);
    expect(auctionRow!.note).toBe(OWNER_RULE_AUCTION_NOTE);
    expect(familyRow!.rep_id).toBeNull();
    expect(familyRow!.method).toBe("none");
  });

  test("a different-rep manual override on an auction appointment is superseded + audited", async () => {
    const { store, allisonId } = await seedStore(true);
    const now = new Date("2026-10-19T15:00:00Z");
    const res = await computeAndPersistAttributions(store, baseSettings, { now: () => now, force: true });
    expect(res.ownerRuleSupersededManual).toBe(1);

    const rows = await store.getAttributions();
    const appts = await store.getAllAppointmentsSince("1970-01-01T00:00:00Z");
    const ids = internalIdByAcuity(appts as never);
    const row = rows.find((r) => r.appointment_id === ids[ACUITY_MANUAL]);
    expect(row!.rep_id).toBe(allisonId);
    expect(row!.method).toBe(OWNER_RULE_AUCTION_METHOD);
    expect(row!.manual_override).toBe(false);
    const audits = await store.getManualOverrides(50);
    const flip = audits.find((o) => o.entity_id === ids[ACUITY_MANUAL] && o.field === "rep" && o.changed_by === "owner-rule-auction");
    expect(flip).toBeDefined();
    expect(flip!.previous_value).toBe("Other Rep");
    expect(flip!.new_value).toBe("Allison Wittner");
  });
});
