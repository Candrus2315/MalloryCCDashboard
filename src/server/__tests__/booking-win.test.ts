/**
 * BOOKING WIN ACCEPTANCE TEST (owner directive, business-plan rev 12 — the
 * gate). Mirrors 2026-09-28's thirteen appointments exactly as cross-checked
 * against Acuity's own Users Report (Allison 7 / $1,800 · Carmine 2 / $600 ·
 * Client 1 / $300):
 *
 *   9 attributed Booking Wins = Allison Wittner 7 (Nom Darling $200, Emily
 *   Leighton $200, Korin White $200, Jeanine Armitstead $300, Maya Hayes $300,
 *   Jordyn Coreau $300 [owner-ruled manual override — no window interaction],
 *   Angela Chiccarelli $300 [paid:"yes" with amountPaid:"0.00" — paid flag is
 *   authoritative; booked under Allison's own Acuity login → resolved to
 *   Allison]) + Carmine Morgano 2 (Jas Jackson $300, Stephanie Killian $300).
 *
 *   Mark Nadeau $300: PAID, online booking → counts as a win but shows
 *   UNATTRIBUTED — never credited to a rep.
 *
 *   Pending (unpaid — visible, NEVER counted): Jenna Van Deventer $300 +
 *   Marybeth O'Keefe $200 (both Allison), Stefanie Korobkin $300
 *   (unattributed).
 *
 * Every win traceable: appointment → payment evidence (raw paid) →
 * booking_win_business_date → rep attribution → displayed number.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { deriveBookingPaymentFields, derivePaymentState } from "../payments";
import {
  appointmentIsPaid,
  appointmentPaymentStateOf,
  bookingsByRep,
  bookingAttributionSplit,
  bookingWinBusinessDateOf,
  buildTodayMetrics,
  countBookingsCreatedBetween,
  isBookingWin,
} from "../metrics/compute";
import type { AppointmentRow, AttributionRow } from "../metrics/compute";

const TODAY = "2026-09-28"; // Monday, ET
const YESTERDAY = "2026-09-27";

/** Raw Acuity payload fragment with the payment fields exactly as observed live. */
const raw = (paid: "yes" | "no", price: string, amountPaid: string) => ({
  paid,
  price,
  priceSold: price,
  amountPaid,
  certificate: null,
  canceled: false,
});

let seq = 0;
function appt(
  client: string,
  opts: { paid: "yes" | "no"; price: string; amountPaid?: string; type?: string; created?: string },
): AppointmentRow {
  seq += 1;
  const created = opts.created ?? `${TODAY}T14:00:00.000Z`;
  return {
    id: `appt-${client.toLowerCase().replace(/[^a-z]+/g, "-")}`,
    contact_id: `contact-${seq}`,
    calendar_id: "cal-mallory",
    appointment_type: opts.type ?? "Animalia Session",
    appointment_datetime: "2026-10-01T14:00:00.000Z",
    created_at: created,
    created_business_date: created.slice(0, 10),
    created_time_source: `${created.slice(0, 10)}T09:00:00-0500`,
    created_time_precision: "full",
    raw: raw(opts.paid, opts.price, opts.amountPaid ?? "0.00"),
    status: "scheduled",
    cancelled: false,
  };
}

// The thirteen 2026-09-28 appointments (live-verified order irrelevant).
const allison = "rep-allison";
const carmine = "rep-carmine";
const appts: AppointmentRow[] = [
  appt("Nom Darling", { paid: "yes", price: "200.00", amountPaid: "200.00", type: "Celebrating Me Session" }),
  appt("Emily Leighton", { paid: "yes", price: "200.00", amountPaid: "200.00" }),
  appt("Korin White", { paid: "yes", price: "200.00", amountPaid: "200.00", type: "Celebrating Me Session" }),
  appt("Jeanine Armitstead", { paid: "yes", price: "300.00", amountPaid: "300.00", type: "Auction Portrait Session + 20\" Portrait + Hotel" }),
  appt("Maya Hayes", { paid: "yes", price: "300.00", amountPaid: "300.00" }),
  appt("Jordyn Coreau", { paid: "yes", price: "300.00", amountPaid: "300.00" }), // owner-ruled → Allison (manual override)
  appt("Angela Chiccarelli", { paid: "yes", price: "300.00", amountPaid: "0.00", type: "Portrait Session + Include a pet, cleaning deposit" }), // paid flag authoritative
  appt("Jas Jackson", { paid: "yes", price: "300.00", amountPaid: "300.00" }), // Carmine
  appt("Stephanie Killian", { paid: "yes", price: "300.00", amountPaid: "300.00" }), // Carmine
  appt("Mark Nadeau", { paid: "yes", price: "300.00", amountPaid: "300.00" }), // PAID, online, unattributed
  appt("Jenna Van Deventer", { paid: "no", price: "300.00", type: "Portrait Session + Include a pet, cleaning deposit" }), // pending
  appt("Marybeth O'Keefe", { paid: "no", price: "200.00", type: "Celebrating Me Session" }), // pending
  appt("Stefanie Korobkin", { paid: "no", price: "300.00" }), // pending, unattributed
];
const idOf = (client: string) => `appt-${client.toLowerCase().replace(/[^a-z]+/g, "-")}`;

// Stored attribution verdicts (engine rows + the two owner-ruled manual overrides).
const attrs: AttributionRow[] = [
  { id: "v1", appointment_id: idOf("Nom Darling"), call_id: null, rep_id: allison, method: "contact_id", confidence: 1, manual_override: false },
  { id: "v2", appointment_id: idOf("Emily Leighton"), call_id: null, rep_id: allison, method: "contact_id", confidence: 1, manual_override: false },
  { id: "v3", appointment_id: idOf("Korin White"), call_id: "c1", rep_id: allison, method: "window_interaction", confidence: 1, manual_override: false },
  { id: "v4", appointment_id: idOf("Jeanine Armitstead"), call_id: "c2", rep_id: allison, method: "window_interaction", confidence: 1, manual_override: false },
  { id: "v5", appointment_id: idOf("Maya Hayes"), call_id: null, rep_id: allison, method: "contact_id", confidence: 1, manual_override: false },
  // OWNER RULING recorded as durable manual overrides (survive reprocessing).
  { id: "v6", appointment_id: idOf("Jordyn Coreau"), call_id: null, rep_id: allison, method: "manual", confidence: 1, manual_override: true, note: "owner ruling 2026-09-28 — no window interaction existed" },
  { id: "v7", appointment_id: idOf("Angela Chiccarelli"), call_id: null, rep_id: allison, method: "manual", confidence: 1, manual_override: true, note: "owner ruling 2026-09-28 — attribution row's contact id 527185b8 IS Allison's contact" },
  { id: "v8", appointment_id: idOf("Jas Jackson"), call_id: "c3", rep_id: carmine, method: "window_interaction", confidence: 1, manual_override: false },
  { id: "v9", appointment_id: idOf("Stephanie Killian"), call_id: "c4", rep_id: carmine, method: "window_interaction", confidence: 1, manual_override: false },
  { id: "v10", appointment_id: idOf("Mark Nadeau"), call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false, reason_code: "no-window-interaction" },
  { id: "v11", appointment_id: idOf("Jenna Van Deventer"), call_id: null, rep_id: allison, method: "contact_id", confidence: 1, manual_override: false },
  { id: "v12", appointment_id: idOf("Marybeth O'Keefe"), call_id: "c5", rep_id: allison, method: "window_interaction", confidence: 1, manual_override: false },
];

describe("BOOKING WIN acceptance — 2026-09-28 (the gate)", () => {
  test("exactly 9 attributed wins today: Allison 7 + Carmine 2", () => {
    // 10 paid wins total (9 attributed + Mark Nadeau's unattributed online win)
    expect(countBookingsCreatedBetween(appts, TODAY, TODAY)).toBe(10);
    const byRep = bookingsByRep(appts, attrs);
    expect(byRep.size).toBe(2);
    expect(byRep.get(allison)).toBe(7);
    expect(byRep.get(carmine)).toBe(2);
  });

  test("per-win traceability: appointment → paid evidence → win date → attribution", () => {
    const byAppt = new Map(attrs.map((a) => [a.appointment_id, a]));
    const wins = appts.filter((a) => isBookingWin(a));
    expect(wins.length).toBe(10); // 9 attributed + Mark (paid, unattributed)
    for (const w of wins) {
      // payment evidence exists in the retained raw
      expect(w.raw && (w.raw as Record<string, unknown>).paid).toBe("yes");
      // the win bucket date is the ET deposit date (here: today)
      expect(bookingWinBusinessDateOf(w)).toBe(TODAY);
      // attribution row exists (rep or honest unattributed verdict)
      expect(byAppt.has(w.id)).toBe(true);
    }
    for (const name of ["Nom Darling", "Emily Leighton", "Korin White", "Jeanine Armitstead", "Maya Hayes", "Jordyn Coreau", "Angela Chiccarelli"]) {
      expect(byAppt.get(idOf(name))?.rep_id).toBe(allison);
    }
    for (const name of ["Jas Jackson", "Stephanie Killian"]) {
      expect(byAppt.get(idOf(name))?.rep_id).toBe(carmine);
    }
  });

  test("Angela Chiccarelli counts with paid:'yes' + amountPaid:'0.00' (amountPaid informational only)", () => {
    const angela = appts.find((a) => a.id === idOf("Angela Chiccarelli"))!;
    expect(angela.raw && (angela.raw as Record<string, unknown>).amountPaid).toBe("0.00");
    expect(appointmentIsPaid(angela)).toBe(true);
    expect(isBookingWin(angela)).toBe(true);
  });

  test("Mark Nadeau: paid win, never credited to a rep (unattributed state)", () => {
    const mark = appts.find((a) => a.id === idOf("Mark Nadeau"))!;
    expect(appointmentIsPaid(mark)).toBe(true);
    expect(isBookingWin(mark)).toBe(true);
    // no rep on his verdict row → bookingsByRep can never credit him
    expect(attrs.find((a) => a.appointment_id === mark.id)?.rep_id ?? null).toBeNull();
    const split = bookingAttributionSplit(appts, attrs);
    expect(split.total).toBe(10); // paid bookings only
    expect(split.attributed).toBe(9);
    expect(split.unattributed).toBe(1); // Mark
    expect(split.ambiguous).toBe(0);
  });

  test("pending (unpaid) bookings NEVER count — visible as pending_payment instead", () => {
    for (const name of ["Jenna Van Deventer", "Marybeth O'Keefe", "Stefanie Korobkin"]) {
      const a = appts.find((x) => x.id === idOf(name))!;
      expect(appointmentPaymentStateOf(a)).toBe("pending_payment");
      expect(isBookingWin(a)).toBe(false);
      expect(bookingWinBusinessDateOf(a)).toBeNull();
    }
    // removing the 3 pendings does not change any win number — they were never in it
    const winsOnly = appts.filter((a) => appointmentPaymentStateOf(a) !== "pending_payment");
    // 10 = 9 attributed + Mark — the pendings were never in the count
    expect(countBookingsCreatedBetween(winsOnly, TODAY, TODAY)).toBe(10);
  });

  test("win counts by booking_win_business_date, never twice (one appointment → exactly one bucket)", () => {
    // same 13 appointments partitioned across two ET days: every win lands in exactly one
    const inYesterday = countBookingsCreatedBetween(appts, YESTERDAY, YESTERDAY);
    const inToday = countBookingsCreatedBetween(appts, TODAY, TODAY);
    expect(inYesterday + inToday).toBe(10);
    expect(inToday).toBe(10); // all created + paid on 2026-09-28
  });

  test("a booking created Friday and paid Monday counts ON MONDAY (deposit date), not twice", () => {
    const latePay = appt("Late Payer", { paid: "yes", price: "300.00", amountPaid: "300.00", created: `${YESTERDAY}T20:00:00.000Z` });
    latePay.booking_win_business_date = TODAY; // persisted by the sync (first-seen 9/28)
    latePay.payment_business_date_source = "first-seen";
    const set = [...appts, latePay];
    expect(countBookingsCreatedBetween(set, YESTERDAY, YESTERDAY)).toBe(0);
    expect(countBookingsCreatedBetween(set, TODAY, TODAY)).toBe(11);
    expect(countBookingsCreatedBetween(set, YESTERDAY, TODAY)).toBe(11); // never counts twice
  });

  test("buildTodayMetrics shows 9 today / 9 WTD with the full fixture", () => {
    const m = buildTodayMetrics({
      reportDate: TODAY,
      calls: [],
      apptsCreatedToday: appts,
      apptsCreatedYesterday: [],
      apptsCreatedWtd: appts,
      callsWtd: [],
      allCallsForWeek: [],
      attributions: attrs,
      leadsAllRecent: [],
      teamBookingGoal: 0,
      weeklyLeadBudget: 0,
      thresholdSeconds: 120,
      openSlotsByDay: [],
      reps: [
        { id: allison, name: "Allison Wittner" },
        { id: carmine, name: "Carmine Morgano" },
      ],
      repGoals: [],
    });
    // Team-level "Bookings" = ALL paid bookings (10 = 9 attributed + Mark's
    // paid online booking, which stays unattributed); per-rep credit is the
    // 7/2 split asserted above via bookingsByRep.
    expect(m.bookings.today).toBe(10);
    expect(m.bookings.wtd).toBe(10);
    expect(m.bookings.yesterday).toBe(0);
  });
});

describe("payment-state derivation (payments.ts)", () => {
  test("paid:'yes' wins regardless of amountPaid; 'no' + price → pending; zero price → scheduled; no raw → unknown", () => {
    expect(derivePaymentState(raw("yes", "300.00", "0.00")).state).toBe("paid");
    expect(derivePaymentState(raw("no", "300.00")).state).toBe("pending_payment");
    expect(derivePaymentState(raw("no", "0.00")).state).toBe("scheduled");
    expect(derivePaymentState(null).state).toBe("unknown");
    expect(derivePaymentState(undefined).paid).toBeNull();
  });

  test("RAW AS JSON STRING (pg driver variance): evidence parsed, never misread as absent", () => {
    // The pg driver hands jsonb back as an object on most paths but as a JSON
    // string on others — the string form must derive the identical verdict.
    const obj = raw("yes", "300.00", "0.00");
    const asString = JSON.stringify(obj);
    const fromString = derivePaymentState(asString);
    expect(fromString).toEqual(derivePaymentState(obj));
    expect(fromString.state).toBe("paid");
    expect(fromString.paid).toBe(true);
    expect(fromString.amountPaid).toBe(0);
    // a non-JSON string is NOT evidence — unknown, never invented
    expect(derivePaymentState("not-json").state).toBe("unknown");
    // DOUBLE-wrapped (pre-fix store wrote stringified raw back as a string):
    // repeated unwraps must still reach the evidence (Jenna/Marybeth case)
    const double = JSON.stringify(JSON.stringify(obj));
    expect(derivePaymentState(double).state).toBe("paid");
    expect(derivePaymentState(double).amountPaid).toBe(0);
    // full derivation from a string raw: paid verdict + first-seen win date
    const d = deriveBookingPaymentFields({
      raw: JSON.stringify(raw("yes", "300.00", "300.00")),
      createdBusinessDate: "2026-09-28",
      nowIso: "2026-09-28T20:30:00.000Z",
    });
    expect(d.payment_state).toBe("paid");
    expect(d.booking_win_business_date).toBe("2026-09-28");
    expect(d.payment_business_date_source).toBe("first-seen");
    expect(d.first_seen_paid_at).toBe("2026-09-28T20:30:00.000Z");
  });

  test("first-seen stamp: created-date proxy, precision-marked, and idempotent (never moves)", () => {
    const first = deriveBookingPaymentFields({
      raw: raw("yes", "300.00", "300.00"),
      createdBusinessDate: "2026-09-20",
      nowIso: "2026-09-28T15:00:00.000Z",
    });
    expect(first.payment_state).toBe("paid");
    expect(first.booking_win_business_date).toBe("2026-09-20"); // first-seen proxy = creation ET date
    expect(first.payment_business_date_source).toBe("first-seen");
    expect(first.first_seen_paid_at).toBe("2026-09-28T15:00:00.000Z");
    // second pass (same raw) keeps the original evidence — never re-stamps, never moves
    const second = deriveBookingPaymentFields({
      raw: raw("yes", "300.00", "300.00"),
      existing: first,
      createdBusinessDate: "2026-09-20",
      nowIso: "2026-09-29T10:00:00.000Z",
    });
    expect(second.booking_win_business_date).toBe("2026-09-20");
    expect(second.first_seen_paid_at).toBe("2026-09-28T15:00:00.000Z");
  });

  test("acuity payment timestamp wins when present (ET calendar date)", () => {
    const d = deriveBookingPaymentFields({
      raw: { paid: "yes", price: "300.00", paymentTimestamp: "2026-10-01T01:30:00-0500" }, // 01:30 ET on 10/1 → ET date 10/1
      createdBusinessDate: "2026-09-30",
      nowIso: "2026-09-28T15:00:00.000Z",
    });
    expect(d.booking_win_business_date).toBe("2026-10-01");
    expect(d.payment_business_date_source).toBe("acuity-payment");
  });

  test("a paid row whose raw later flips to unpaid keeps its persisted win (never silently un-wins)", () => {
    const d = deriveBookingPaymentFields({
      raw: raw("no", "300.00"),
      existing: { booking_win_business_date: "2026-09-28", payment_business_date_source: "first-seen", first_seen_paid_at: "2026-09-28T15:00:00.000Z" },
      createdBusinessDate: "2026-09-28",
      nowIso: "2026-09-30T10:00:00.000Z",
    });
    expect(d.booking_win_business_date).toBe("2026-09-28");
    expect(d.first_seen_paid_at).toBe("2026-09-28T15:00:00.000Z");
  });
});

describe("store write-once + win-bucket selector (memory mirror of pg semantics)", () => {
  test("upsert keeps the first win evidence; selector returns win-date ∪ created-date rows", async () => {
    const store = new MemoryStore();
    const base = {
      id: "x1",
      contact_id: null,
      calendar_id: "cal",
      appointment_type: "Animalia Session",
      appointment_datetime: "2026-10-01T14:00:00.000Z",
      status: "scheduled",
      cancelled: false,
    };
    await store.upsertAppointments([
      {
        ...base,
        acuity_appointment_id: "a-1",
        created_at: `${YESTERDAY}T20:00:00.000Z`,
        created_business_date: YESTERDAY,
        raw: raw("no", "300.00") as Record<string, unknown>,
        payment_state: "pending_payment",
      },
    ]);
    // paid arrives a day later (deposit received 9/28)
    await store.upsertAppointments([
      {
        ...base,
        acuity_appointment_id: "a-1",
        created_at: `${YESTERDAY}T20:00:00.000Z`,
        created_business_date: YESTERDAY,
        raw: raw("yes", "300.00", "300.00") as Record<string, unknown>,
        payment_state: "paid",
        booking_win_business_date: TODAY,
        payment_business_date_source: "first-seen",
        first_seen_paid_at: `${TODAY}T15:00:00.000Z`,
      },
    ]);
    const rows = await store.getAppointmentsByWinBusinessDateBetween(TODAY, TODAY);
    expect(rows.length).toBe(1); // win date 9/28 → today's bucket
    expect(rows[0].payment_state).toBe("paid");
    expect(rows[0].booking_win_business_date).toBe(TODAY);
    // re-sync with a DIFFERENT win date cannot move the evidence (write-once)
    await store.upsertAppointments([
      {
        ...base,
        acuity_appointment_id: "a-1",
        created_at: `${YESTERDAY}T20:00:00.000Z`,
        created_business_date: YESTERDAY,
        raw: raw("yes", "300.00", "300.00") as Record<string, unknown>,
        payment_state: "paid",
        booking_win_business_date: "2030-01-01",
        payment_business_date_source: "first-seen",
      },
    ]);
    const after = await store.getAppointmentsByWinBusinessDateBetween("2030-01-01", "2030-01-01");
    expect(after.length).toBe(0);
    const still = await store.getAppointmentsByWinBusinessDateBetween(TODAY, TODAY);
    expect(still.length).toBe(1);
    expect(still[0].booking_win_business_date).toBe(TODAY);
  });
});
