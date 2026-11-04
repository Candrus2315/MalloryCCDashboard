/**
 * ONLINE-BOOKING DESIGNATION CONTROL (owner directive 2026-11-04, the
 * approved follow-up to the creator-rule engine PR #151).
 *
 * Under test — the two POST endpoints (cores; the TanStack wrappers are thin):
 *
 *   designateOnlineBookingCore — writes the EXACT STICKY ROW SHAPE the
 *   creation-source engine feeds back in (booking_attributions: rep NULL,
 *   call NULL, method "owner-designation", reason_code "online-booking",
 *   manual_override TRUE, confidence 1, note). Stickiness is two-layered and
 *   PINNED here: deriveCreationSourceEvidence reads the reason_code back in
 *   as proven client-created, and manual_override=true pins the row through
 *   the tick's manual-wins path.
 *
 *   undoOnlineBookingDesignationCore — restores the NEUTRAL row (reason_code
 *   NULL, method "none", rep NULL, call NULL, manual_override false) so the
 *   next attribution tick re-derives the appointment from evidence.
 *
 * Guards on both: appointment exists (30-day window), is a paid
 * non-cancelled win, and designate REFUSES any row carrying a rep credit
 * (rep_id set or manual_override set) — those are owner rulings.
 *
 * No production DB: the MemoryStore block runs on the in-memory store; the
 * PgStore mirror runs only when TEST_DATABASE_URL is set.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { PgStore } from "../store/pg";
import { isBookingWin, type AppointmentRow } from "../metrics/compute";
import { ONLINE_BOOKING_REASON, OWNER_DESIGNATION_METHOD, OWNER_RULE_AUCTION_METHOD, supersedePreviousValue, parseSupersedePreviousValue } from "../metrics/attribution";
import { buildEvidenceCreditedQueue, designateOnlineBookingCore, undoOnlineBookingDesignationCore } from "../queries";
import { deriveCreationSourceEvidence } from "../sync/attribution-tick";
import { addDays, etDayStartUtc, etToday } from "../date-logic";

/**
 * DATE-ROT SAFETY (same lesson as pending-payment-dismiss.test.ts): the
 * designation cores window on the REAL clock (etToday() − 30 days), so the
 * fixture dates itself RELATIVE to real now — green any day, no weakened
 * assertions.
 */
const TODAY = etToday();
/** The EXACT floor the designation cores compute. */
const WINDOW_START = etDayStartUtc(addDays(TODAY, -30));

const raw = (paid: "yes" | "no", price: string) => ({
  paid,
  price,
  priceSold: price,
  amountPaid: "0.00",
  certificate: null,
  canceled: false,
});

let seq = 0;
/** A PAID, non-cancelled booking created today — the designatable shape. */
function winAppt(overrides: Partial<AppointmentRow> = {}): AppointmentRow {
  seq += 1;
  return {
    id: `appt-desig-${seq}`,
    contact_id: null,
    calendar_id: "cal-mallory",
    appointment_type: "Portrait Session + Include a pet, cleaning deposit",
    appointment_datetime: `${addDays(TODAY, 1)}T14:00:00.000Z`,
    created_at: `${TODAY}T14:00:00.000Z`,
    created_business_date: TODAY,
    created_time_precision: "full",
    raw: raw("yes", "300.00") as unknown as Record<string, unknown>,
    payment_state: "paid",
    booking_win_business_date: TODAY,
    status: "scheduled",
    cancelled: false,
    client_name: "Designation Test Client",
    ...overrides,
  };
}

/** Seed one appointment; returns its store-canonical internal id. */
async function seed(store: MemoryStore, acuityId: string, overrides: Partial<AppointmentRow> = {}): Promise<string> {
  await store.upsertAppointments([
    {
      ...winAppt(overrides),
      acuity_appointment_id: acuityId,
    } as AppointmentRow & { acuity_appointment_id: string },
  ]);
  const rows = await store.getAppointmentsWithClientsSince(WINDOW_START);
  const mine = rows.find((r) => r.acuity_appointment_id === acuityId);
  expect(mine).toBeDefined();
  return mine!.id;
}

describe("online-booking designation — designate (happy path + sticky contract)", () => {
  test("writes the EXACT sticky row shape (rep/call NULL, owner-designation, online-booking, manual_override, confidence 1) + audit row", async () => {
    const store = new MemoryStore();
    const id = await seed(store, "desig-1");

    await designateOnlineBookingCore(store, { appointmentId: id });

    const row = (await store.getAttributions()).find((a) => a.appointment_id === id);
    expect(row).toBeDefined();
    // THE STICKY CONTRACT (pinned field by field):
    expect(row!.rep_id).toBeNull(); // team-only — never rep-attributed
    expect(row!.call_id).toBeNull();
    expect(row!.method).toBe(OWNER_DESIGNATION_METHOD);
    expect(row!.reason_code).toBe(ONLINE_BOOKING_REASON);
    expect(row!.manual_override).toBe(true); // the manual-wins pin
    expect(row!.confidence).toBe(1);
    expect(row!.note).toContain("Owner designation");

    // The engine feeds it back in: the tick's proven-client-created set.
    const evidence = deriveCreationSourceEvidence(await store.getAttributions());
    expect(evidence.provenClientCreated.has(id)).toBe(true);

    // Audited like every manual action.
    const audit = await store.getManualOverrides(10);
    expect(
      audit.some((a) => a.entity_type === "booking_attribution" && a.entity_id === id && a.field === "online_booking_designation" && a.new_value === "designated online booking (team-only)"),
    ).toBe(true);
  });

  test("the sticky feed is driven by reason_code + manual_override — strip either and the row leaves the set", async () => {
    const store = new MemoryStore();
    const id = await seed(store, "desig-sticky");
    await designateOnlineBookingCore(store, { appointmentId: id });

    // reason_code intact but manual_override stripped → still feeds back in
    // via reason_code (the engine's PRIMARY stickiness read)…
    const strippedManual = (await store.getAttributions()).map((r) =>
      r.appointment_id === id ? { ...r, manual_override: false } : r,
    );
    expect(deriveCreationSourceEvidence(strippedManual).provenClientCreated.has(id)).toBe(true);

    // …but with the reason_code gone the designation proof is gone.
    const strippedReason = (await store.getAttributions()).map((r) =>
      r.appointment_id === id ? { ...r, reason_code: null } : r,
    );
    expect(deriveCreationSourceEvidence(strippedReason).provenClientCreated.has(id)).toBe(false);
  });

  test("re-designating an already-designated row is an idempotent no-op", async () => {
    const store = new MemoryStore();
    const id = await seed(store, "desig-2");
    await designateOnlineBookingCore(store, { appointmentId: id });
    const before = (await store.getAttributions()).find((a) => a.appointment_id === id);

    await designateOnlineBookingCore(store, { appointmentId: id }); // no throw
    const after = (await store.getAttributions()).find((a) => a.appointment_id === id);
    expect(after).toEqual(before); // byte-identical row — no note churn
  });
});

describe("online-booking designation — guards", () => {
  test("refuses an UNPAID booking (no deposit → not a win)", async () => {
    const store = new MemoryStore();
    const id = await seed(store, "desig-unpaid", {
      raw: raw("no", "300.00") as unknown as Record<string, unknown>,
      payment_state: "pending_payment",
      booking_win_business_date: null,
    });
    expect(isBookingWin((await store.getAppointmentsWithClientsSince(WINDOW_START)).find((a) => a.id === id)!)).toBe(false);
    await expect(designateOnlineBookingCore(store, { appointmentId: id })).rejects.toThrow(/Only paid booking wins can be designated/);
    expect((await store.getAttributions()).some((a) => a.appointment_id === id)).toBe(false);
  });

  test("refuses a CANCELLED booking", async () => {
    const store = new MemoryStore();
    const id = await seed(store, "desig-cancelled", { status: "cancelled", cancelled: true });
    await expect(designateOnlineBookingCore(store, { appointmentId: id })).rejects.toThrow(/Cancelled bookings cannot be designated/);
    expect((await store.getAttributions()).some((a) => a.appointment_id === id)).toBe(false);
  });

  test("refuses a MANUAL rep credit (owner ruling): setManualAttribution rows keep their refusal", async () => {
    const store = new MemoryStore();
    const manualId = await seed(store, "desig-rep-manual");
    await store.setManualAttribution({
      id: "",
      appointment_id: manualId,
      call_id: null,
      rep_id: "rep-2",
      method: "manual",
      confidence: 1,
      manual_override: true,
    });
    await expect(designateOnlineBookingCore(store, { appointmentId: manualId })).rejects.toThrow(/owner ruling/);
    const manualRow = (await store.getAttributions()).find((a) => a.appointment_id === manualId);
    expect(manualRow!.rep_id).toBe("rep-2");
    expect(manualRow!.manual_override).toBe(true);
  });

  test("refuses an appointment outside the 30-day window (not found)", async () => {
    const store = new MemoryStore();
    await expect(designateOnlineBookingCore(store, { appointmentId: "appt-never-seeded" })).rejects.toThrow(/not found/i);
  });
});

/**
 * SUPERSEDE PATH (owner directive 2026-11-04, the Laurie Hendricks case —
 * appointment 37b8b62d, Acuity 1800865768): an ENGINE evidence-tier rep credit
 * (window_interaction, manual_override false, confidence 0.6) CAN be superseded
 * by a designation. The creator rule outranks interaction evidence, and undo
 * fully restores the credit (neutral row → the tick re-derives it).
 */
describe("online-booking designation — supersede of an evidence-tier rep credit", () => {
  /** Seed the named rep; returns the STORE-CANONICAL id (MemoryStore reassigns ids on upsert — never assume the seed id). */
  async function seedRep(store: MemoryStore, externalKey: string, name: string): Promise<string> {
    await store.upsertUsers([
      {
        id: externalKey,
        provider: "highlevel",
        external_id: `hl-${externalKey}`,
        name,
        email: `${externalKey}@example.com`,
        is_active: true,
        call_start_date: null,
      },
    ]);
    const user = (await store.getAllUsers()).find((u) => u.name === name);
    expect(user).toBeDefined();
    return user!.id;
  }

  test("writes the SAME sticky row + an audit whose previous_value carries the superseded rep", async () => {
    const store = new MemoryStore();
    const repId = await seedRep(store, "carmine", "Carmine Morgano");
    const id = await seed(store, "desig-supersede");
    await store.upsertAttributions([
      {
        id: `attr:${id}`,
        appointment_id: id,
        call_id: null,
        rep_id: repId,
        method: "window_interaction",
        confidence: 0.6,
        manual_override: false,
        reason_code: null,
      },
    ]);

    await designateOnlineBookingCore(store, { appointmentId: id });

    // The SAME sticky contract as a plain designation.
    const row = (await store.getAttributions()).find((a) => a.appointment_id === id);
    expect(row!.rep_id).toBeNull(); // the rep credit is gone — team-only
    expect(row!.call_id).toBeNull();
    expect(row!.method).toBe(OWNER_DESIGNATION_METHOD);
    expect(row!.reason_code).toBe(ONLINE_BOOKING_REASON);
    expect(row!.manual_override).toBe(true);
    expect(row!.confidence).toBe(1);
    expect(deriveCreationSourceEvidence(await store.getAttributions()).provenClientCreated.has(id)).toBe(true);

    // The audit trail records WHAT was replaced: method + rep name + rep id.
    const audit = (await store.getManualOverrides(10)).find(
      (a) => a.entity_type === "booking_attribution" && a.entity_id === id && a.field === "online_booking_designation",
    );
    expect(audit).toBeDefined();
    expect(audit!.previous_value).toBe(`window_interaction: rep Carmine Morgano (${repId})`);
    expect(audit!.new_value).toBe("designated online booking (team-only)");
  });

  test("audit format round-trips: supersedePreviousValue ↔ parseSupersedePreviousValue (name missing → id fills both)", async () => {
    expect(supersedePreviousValue("window_interaction", "da05649f", "Carmine Morgano")).toBe(
      "window_interaction: rep Carmine Morgano (da05649f)",
    );
    expect(parseSupersedePreviousValue("window_interaction: rep Carmine Morgano (da05649f)")).toEqual({
      method: "window_interaction",
      repId: "da05649f",
      repName: "Carmine Morgano",
    });
    // Name lookup misses: the id fills both slots — the string still parses.
    expect(supersedePreviousValue("phone", "rep-9", null)).toBe("phone: rep rep-9 (rep-9)");
    expect(parseSupersedePreviousValue("phone: rep rep-9 (rep-9)")).toEqual({
      method: "phone",
      repId: "rep-9",
      repName: "rep-9",
    });
    // Plain designation previous values do NOT parse as a supersede.
    expect(parseSupersedePreviousValue("no-window-interaction")).toBeNull();
    expect(parseSupersedePreviousValue("unattributed")).toBeNull();
    expect(parseSupersedePreviousValue(null)).toBeNull();
  });

  test("undo after a supersede → neutral row; the tick re-derivation returns the rep's evidence credit", async () => {
    const store = new MemoryStore();
    const repId = await seedRep(store, "carmine-undo", "Carmine Morgano");
    const id = await seed(store, "desig-supersede-undo");
    await store.upsertAttributions([
      {
        id: `attr:${id}`,
        appointment_id: id,
        call_id: null,
        rep_id: repId,
        method: "window_interaction",
        confidence: 0.6,
        manual_override: false,
        reason_code: null,
      },
    ]);
    await designateOnlineBookingCore(store, { appointmentId: id });
    expect((await store.getAttributions()).find((a) => a.appointment_id === id)!.method).toBe(OWNER_DESIGNATION_METHOD);

    await undoOnlineBookingDesignationCore(store, { appointmentId: id });

    // The NEUTRAL row (same contract as any undo) — the engine's control.
    const undone = (await store.getAttributions()).find((a) => a.appointment_id === id);
    expect(undone!.method).toBe("none");
    expect(undone!.rep_id).toBeNull();
    expect(undone!.manual_override).toBe(false);
    expect(undone!.reason_code).toBeNull();
    expect(deriveCreationSourceEvidence(await store.getAttributions()).provenClientCreated.has(id)).toBe(false);

    // The next attribution tick re-derives the SAME evidence credit (the
    // underlying call/conversation evidence was never touched) — the store's
    // upsertAttributions is the exact write path the tick uses.
    await store.upsertAttributions([
      {
        id: `attr:${id}`,
        appointment_id: id,
        call_id: null,
        rep_id: repId,
        method: "window_interaction",
        confidence: 0.6,
        manual_override: false,
        reason_code: null,
      },
    ]);
    const rederived = (await store.getAttributions()).find((a) => a.appointment_id === id);
    expect(rederived!.rep_id).toBe(repId); // the credit is BACK
    expect(rederived!.method).toBe("window_interaction");
    expect(rederived!.manual_override).toBe(false);
  });

  test("refusal matrix — non-evidence rep credits are never superseded", async () => {
    const store = new MemoryStore();
    // (a) owner-rule-auction: the standing owner rule, needs its own handling.
    const auctionId = await seed(store, "desig-sup-auction");
    await store.upsertAttributions([
      {
        id: `attr:${auctionId}`,
        appointment_id: auctionId,
        call_id: null,
        rep_id: "rep-allison",
        method: OWNER_RULE_AUCTION_METHOD,
        confidence: 1,
        manual_override: false,
        reason_code: OWNER_RULE_AUCTION_METHOD,
      },
    ]);
    await expect(designateOnlineBookingCore(store, { appointmentId: auctionId })).rejects.toThrow(/not evidence-tier/);
    expect((await store.getAttributions()).find((a) => a.appointment_id === auctionId)!.rep_id).toBe("rep-allison");

    // (b) evidence METHOD but confidence 1 (owner-grade verdict, not evidence).
    const confId = await seed(store, "desig-sup-conf");
    await store.upsertAttributions([
      {
        id: `attr:${confId}`,
        appointment_id: confId,
        call_id: null,
        rep_id: "rep-x",
        method: "window_interaction",
        confidence: 1,
        manual_override: false,
        reason_code: null,
      },
    ]);
    await expect(designateOnlineBookingCore(store, { appointmentId: confId })).rejects.toThrow(/not evidence-tier/);

    // (c) a manual_override row of ANY kind (even with a rep).
    const manualId = await seed(store, "desig-sup-manual");
    await store.upsertAttributions([
      {
        id: `attr:${manualId}`,
        appointment_id: manualId,
        call_id: null,
        rep_id: "rep-y",
        method: "manual",
        confidence: 1,
        manual_override: true,
        reason_code: null,
      },
    ]);
    await expect(designateOnlineBookingCore(store, { appointmentId: manualId })).rejects.toThrow(/owner ruling/);

    // (d) unpaid and cancelled stay refused (the supersede path inherits the guards).
    const unpaidId = await seed(store, "desig-sup-unpaid", {
      raw: raw("no", "300.00") as unknown as Record<string, unknown>,
      payment_state: "pending_payment",
      booking_win_business_date: null,
    });
    await expect(designateOnlineBookingCore(store, { appointmentId: unpaidId })).rejects.toThrow(/Only paid booking wins/);
    const cancelledId = await seed(store, "desig-sup-cancelled", { status: "cancelled", cancelled: true });
    await expect(designateOnlineBookingCore(store, { appointmentId: cancelledId })).rejects.toThrow(/Cancelled bookings/);

    // (e) outside the 30-day window.
    await expect(designateOnlineBookingCore(store, { appointmentId: "appt-not-in-window" })).rejects.toThrow(/not found/i);

    // (f) an already-designated (proven online) row stays an idempotent no-op.
    const designatedId = await seed(store, "desig-sup-designated");
    await store.setOnlineBookingDesignation(designatedId, "pre-existing designation");
    const before = (await store.getAttributions()).find((a) => a.appointment_id === designatedId);
    await designateOnlineBookingCore(store, { appointmentId: designatedId }); // no throw
    expect((await store.getAttributions()).find((a) => a.appointment_id === designatedId)).toEqual(before);
  });
});

/**
 * EVIDENCE-CREDITED QUEUE SECTION (Settings page payload): lists ONLY the
 * supersede-eligible rows and excludes manual/auction/owner rulings.
 */
describe("buildEvidenceCreditedQueue — the Settings supersede section's rows", () => {
  const users = [
    { id: "rep-sup", name: "Carmine Morgano" },
    { id: "rep-allison", name: "Allison Wittner" },
  ];

  test("includes evidence-tier credited wins (rep + method + confidence); excludes manual, auction, unpaid, cancelled, rep-less", async () => {
    const mk = (id: string, over: Partial<AppointmentRow> = {}): AppointmentRow => winAppt({ id, ...over });
    const supersede = mk("a-sup");
    const manual = mk("a-manual");
    const auction = mk("a-auction");
    const unpaid = mk("a-unpaid", {
      raw: raw("no", "300.00") as unknown as Record<string, unknown>,
      payment_state: "pending_payment",
      booking_win_business_date: null,
    });
    const cancelled = mk("a-cancelled", { status: "cancelled", cancelled: true });
    const repLess = mk("a-repless");
    const attributions = [
      { id: "attr:1", appointment_id: "a-sup", call_id: null, rep_id: "rep-sup", method: "window_interaction", confidence: 0.6, manual_override: false, reason_code: null },
      { id: "attr:2", appointment_id: "a-manual", call_id: null, rep_id: "rep-sup", method: "manual", confidence: 1, manual_override: true, reason_code: null },
      { id: "attr:3", appointment_id: "a-auction", call_id: null, rep_id: "rep-allison", method: "owner-rule-auction", confidence: 1, manual_override: false, reason_code: "owner-rule-auction" },
      { id: "attr:4", appointment_id: "a-repless", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false, reason_code: "no-window-interaction" },
    ];
    const rows = buildEvidenceCreditedQueue({
      appointments: [supersede, manual, auction, unpaid, cancelled, repLess],
      attributions,
      users,
    });
    expect(rows.map((r) => r.appointment_id)).toEqual(["a-sup"]); // ONLY the supersede-eligible row
    expect(rows[0]!.credited_rep_name).toBe("Carmine Morgano");
    expect(rows[0]!.method).toBe("window_interaction");
    expect(rows[0]!.confidence).toBe(0.6);
    // Unpaid/cancelled never appear even WITH an evidence-tier attribution row.
    const rows2 = buildEvidenceCreditedQueue({
      appointments: [unpaid, cancelled],
      attributions: [
        { id: "attr:5", appointment_id: "a-unpaid", call_id: null, rep_id: "rep-sup", method: "window_interaction", confidence: 0.6, manual_override: false, reason_code: null },
        { id: "attr:6", appointment_id: "a-cancelled", call_id: null, rep_id: "rep-sup", method: "window_interaction", confidence: 0.6, manual_override: false, reason_code: null },
      ],
      users,
    });
    expect(rows2).toEqual([]);
  });

  test("newest-first ordering; name resolution misses render the null name (never a guess)", async () => {
    const newer = winAppt({ id: "a-newer", created_at: `${TODAY}T18:00:00.000Z` });
    const older = winAppt({ id: "a-older", created_at: `${TODAY}T10:00:00.000Z` });
    const rows = buildEvidenceCreditedQueue({
      appointments: [older, newer],
      attributions: [
        { id: "attr:1", appointment_id: "a-newer", call_id: null, rep_id: "rep-unknown", method: "sms", confidence: 0.5, manual_override: false, reason_code: null },
        { id: "attr:2", appointment_id: "a-older", call_id: null, rep_id: "rep-sup", method: "email", confidence: 0.9, manual_override: false, reason_code: null },
      ],
      users: [{ id: "rep-sup", name: "Carmine Morgano" }],
    });
    expect(rows.map((r) => r.appointment_id)).toEqual(["a-newer", "a-older"]);
    expect(rows[0]!.credited_rep_name).toBeNull(); // unknown rep — honest null
    expect(rows[1]!.credited_rep_name).toBe("Carmine Morgano");
  });
});

describe("online-booking designation — undo", () => {
  test("designate → undo restores the NEUTRAL row; the sticky feed drops it", async () => {
    const store = new MemoryStore();
    const id = await seed(store, "desig-3");
    await designateOnlineBookingCore(store, { appointmentId: id });
    expect(deriveCreationSourceEvidence(await store.getAttributions()).provenClientCreated.has(id)).toBe(true);

    await undoOnlineBookingDesignationCore(store, { appointmentId: id });

    const row = (await store.getAttributions()).find((a) => a.appointment_id === id);
    expect(row).toBeDefined(); // neutral row kept, not deleted
    expect(row!.reason_code).toBeNull();
    expect(row!.method).toBe("none");
    expect(row!.rep_id).toBeNull();
    expect(row!.call_id).toBeNull();
    expect(row!.manual_override).toBe(false);
    // the next attribution tick re-derives from evidence like any other row
    expect(deriveCreationSourceEvidence(await store.getAttributions()).provenClientCreated.has(id)).toBe(false);

    const audit = await store.getManualOverrides(10);
    expect(
      audit.some((a) => a.entity_type === "booking_attribution" && a.entity_id === id && a.new_value === "designation undone — returns to engine attribution"),
    ).toBe(true);
  });

  test("undo refuses a row that is NOT an owner-designation (engine verdict / no row)", async () => {
    const store = new MemoryStore();
    // an engine-style unattributed verdict row (rep NULL, not a designation)
    const engineId = await seed(store, "desig-undo-engine");
    await store.upsertAttributions([
      {
        id: `attr:${engineId}`,
        appointment_id: engineId,
        call_id: null,
        rep_id: null,
        method: "none",
        confidence: 0,
        manual_override: false,
        reason_code: "no-window-interaction",
      },
    ]);
    await expect(undoOnlineBookingDesignationCore(store, { appointmentId: engineId })).rejects.toThrow(/not an owner-designated Online Booking/);
    expect((await store.getAttributions()).find((a) => a.appointment_id === engineId)!.reason_code).toBe("no-window-interaction");

    // no attribution row at all
    const bareId = await seed(store, "desig-undo-bare");
    await expect(undoOnlineBookingDesignationCore(store, { appointmentId: bareId })).rejects.toThrow(/not an owner-designated Online Booking/);
  });

  test("undo re-checks the appointment: cancelled and unpaid are refused", async () => {
    const store = new MemoryStore();
    const cancelledId = await seed(store, "desig-undo-cancelled", { status: "cancelled", cancelled: true });
    await store.setOnlineBookingDesignation(cancelledId, "pre-existing designation");
    await expect(undoOnlineBookingDesignationCore(store, { appointmentId: cancelledId })).rejects.toThrow(/Cancelled bookings cannot be undesignated/);

    const unpaidId = await seed(store, "desig-undo-unpaid", {
      raw: raw("no", "300.00") as unknown as Record<string, unknown>,
      payment_state: "pending_payment",
      booking_win_business_date: null,
    });
    await store.setOnlineBookingDesignation(unpaidId, "pre-existing designation");
    await expect(undoOnlineBookingDesignationCore(store, { appointmentId: unpaidId })).rejects.toThrow(/Only paid booking wins can be undesignated/);
  });
});

/**
 * PgStore-backed mirror (9/29 lesson: MemoryStore-only tests shipped a broken
 * PgStore). SKIPPED unless TEST_DATABASE_URL is set; scratch rows removed in
 * finally by unique acuity id.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("online-booking designation — PgStore (real Postgres)", () => {
  test("designate writes the sticky shape; undo restores neutral", async () => {
    const store = new PgStore(process.env.TEST_DATABASE_URL!);
    await store.ensureSchema();
    const PAST_DAY = addDays(TODAY, -10); // inside the 30-day window, outside the current week
    const acuityId = `test-desig-${Date.now()}`;
    try {
      await store.upsertAppointments([
        {
          ...winAppt({ created_at: `${PAST_DAY}T14:00:00.000Z`, created_business_date: PAST_DAY, booking_win_business_date: PAST_DAY }),
          acuity_appointment_id: acuityId,
        } as AppointmentRow & { acuity_appointment_id: string },
      ]);
      const mine = (await store.getAppointmentsWithClientsSince(WINDOW_START)).find((r) => r.acuity_appointment_id === acuityId)!;

      await designateOnlineBookingCore(store, { appointmentId: mine.id });
      const row = (await store.getAttributions()).find((a) => a.appointment_id === mine.id);
      expect(row!.method).toBe(OWNER_DESIGNATION_METHOD);
      expect(row!.reason_code).toBe(ONLINE_BOOKING_REASON);
      expect(row!.manual_override).toBe(true);
      expect(row!.rep_id).toBeNull();
      expect(row!.call_id).toBeNull();
      expect(row!.confidence).toBe(1);

      await undoOnlineBookingDesignationCore(store, { appointmentId: mine.id });
      const undone = (await store.getAttributions()).find((a) => a.appointment_id === mine.id);
      expect(undone!.method).toBe("none");
      expect(undone!.reason_code).toBeNull();
      expect(undone!.manual_override).toBe(false);
    } finally {
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, ...(process.env.TEST_DATABASE_URL!.includes("sslmode=") ? {} : { ssl: "require" }) });
      try {
        await sql`DELETE FROM appointments WHERE acuity_appointment_id = ${acuityId}`;
      } finally {
        await sql.end();
      }
    }
  }, 90_000);
});
