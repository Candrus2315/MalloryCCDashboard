/**
 * RESCHEDULE LINEAGE — owner directive 10/28 ("a session moved from Sat 10/24
 * to Wed 10/28 must still count in the 10/19–25 week's Gross; production
 * credit is tied to the original booking-creation event, never the current
 * session date") PINNED against the 10/28 lineage audit.
 *
 * THE AUDIT (provider-doc + record grounded; artifacts:
 * /home/team/shared/reschedule-lineage-audit/):
 *   1. A normal Acuity reschedule RETAINS the appointment ID. The only
 *      reschedule mechanism is PUT /appointments/{id}/reschedule — "Reschedule
 *      an appointment to a different date or calendar" — an in-place mutation
 *      of THAT appointment object (client-initiated by default, admin via
 *      `admin=true`), and our sync upserts by acuity_appointment_id (store ON
 *      CONFLICT (acuity_appointment_id) DO UPDATE), so a reschedule updates
 *      the stored row in place while created_at / created_business_date keep
 *      re-deriving from the UNCHANGED datetimeCreated. Payload census over all
 *      825 stored raw Acuity objects: ZERO reschedule/origin/lineage metadata
 *      fields — only `canClientReschedule`, a permission flag.
 *   2. Acuity CANNOT represent a reschedule as a cancelled appointment + a new
 *      appointment: the same endpoint answers `reschedule_canceled` —
 *      "Canceled appointments may not be rescheduled" — a cancelled
 *      appointment is terminal, and booking again is a NEW booking event (new
 *      ID). Stored evidence agrees: the only cancel+new same-type pairs in the
 *      whole paid history are 3 cross-week pairs 18/32/75 days apart
 *      (Collins/Lord/O'Brien) — genuine cancellation + genuine later booking —
 *      and ONE same-week near-simultaneous pair (Vallee Bordinaro, Acuity
 *      1792280090 → 1792286335, 9m47s apart, SAME slot 10/29 16:00 ET), a
 *      cancel-and-rebook counted ONCE by the owner-confirmed identity rule
 *      (the audit's 84) — never relabeled a reschedule.
 *   3. VERDICT: production credit is tied to the original booking-creation
 *      event BY CONSTRUCTION (created_at derives from datetimeCreated; the
 *      session date is display-only). No lineage heuristics are needed or
 *      permitted (owner decision gate: do NOT guess lineage) — these tests pin
 *      the required behaviors instead.
 *
 * Covers: (a) same-ID reschedule at the parse layer — creation date survives
 * the moved session; (b) THE OWNER'S SCENARIO — booking created Sat 10/24,
 * session rescheduled Wed 10/28 (and again): gross stays in 10/19–25, the next
 * week gets no gross and no cancellation; (c) same-week cancel-and-rebook
 * (Vallee shape) counts once, zero cancellations; (d) true cancellation:
 * original week keeps Gross, cancellations increments, net decreases;
 * (e) true later rebooking after a genuine cancellation (Collins shape):
 * original week keeps Gross + Cancellation, rebook week gets its own Gross;
 * (f) two genuinely separate bookings by the same client — both count.
 */
import { describe, expect, test } from "bun:test";
import { parseAcuityAppointment } from "../sync/acuity-live";
import {
  computeWeeklyProduction,
  type ApptWithClientIdentity,
} from "../metrics/source-attribution";

// ---------- weeks (the audited Mon–Sun basis) ----------
const W1_MON = "2026-10-19", W1_SUN = "2026-10-25"; // the audited week
const W2_MON = "2026-10-26", W2_SUN = "2026-11-01"; // the week after
const W0_MON = "2026-09-28", W0_SUN = "2026-10-04"; // three weeks before

function appt(
  id: string,
  opts: {
    createdDay: string;
    sessionDay?: string; // defaults to the created day (booked for same week)
    cancelled?: boolean;
    phone?: string | null;
    email?: string | null;
  },
): ApptWithClientIdentity {
  const cancelled = opts.cancelled ?? false;
  return {
    id,
    contact_id: null,
    calendar_id: "cal-1",
    appointment_type: "Portrait Session",
    appointment_datetime: `${opts.sessionDay ?? opts.createdDay}T18:00:00.000Z`,
    created_at: `${opts.createdDay}T15:00:00.000Z`,
    created_business_date: opts.createdDay,
    booking_win_business_date: opts.createdDay,
    payment_state: "paid",
    raw: { paid: "yes", amountPaid: "300.00" },
    status: cancelled ? "cancelled" : "scheduled",
    cancelled,
    client_phone: opts.phone ?? null,
    client_email: opts.email ?? null,
  };
}

// ---------- (a) same-ID reschedule at the parse layer ----------

/** Acuity-shaped payload: booked Wed 10/21 for a Sat 10/24 session. */
const RESCHED_ROW = (sessionDatetime: string): Record<string, unknown> => ({
  id: "1799000001",
  datetime: sessionDatetime,
  datetimeCreated: "2026-10-21T09:00:00-0500", // creation — a reschedule NEVER changes it
  dateCreated: "October 21, 2026",
  calendarID: "1335091",
  calendar: "MALLORY PORTRAITS",
  type: "Portrait Session",
  duration: 60,
  canceled: false,
  firstName: "Jane",
  lastName: "Doe",
  phone: "+19175550142",
  email: "jane@example.com",
});

describe("same-ID reschedule — the parse layer keeps the creation event fixed", () => {
  test("rescheduled payload: SAME acuity_appointment_id + SAME createdAt/createdBusinessDate; only the session datetime moves", () => {
    const original = parseAcuityAppointment(RESCHED_ROW("2026-10-24T10:00:00-0500"));
    const rescheduled = parseAcuityAppointment(RESCHED_ROW("2026-10-28T10:00:00-0500"));
    expect(original).not.toBeNull();
    expect(rescheduled).not.toBeNull();
    // Same provider object — the reschedule never mints a second appointment.
    expect(rescheduled!.acuity_appointment_id).toBe(original!.acuity_appointment_id);
    // The creation event is untouched: created_at re-derives from
    // datetimeCreated, NOT from the moved session datetime.
    expect(rescheduled!.createdAt).toBe(original!.createdAt);
    expect(rescheduled!.createdAt).toBe("2026-10-21T14:00:00.000Z"); // 09:00 -0500
    expect(rescheduled!.createdAtBusinessDate).toBe(original!.createdAtBusinessDate);
    expect(rescheduled!.createdAtBusinessDate).toBe("2026-10-21");
    // Only the session moved.
    expect(rescheduled!.appointmentDatetime).not.toBe(original!.appointmentDatetime);
  });
});

// ---------- (b) THE OWNER'S SCENARIO, in the production block ----------

describe("same-ID reschedule — credit never leaves the original creation week", () => {
  const booking = appt("owner-scenario", {
    createdDay: "2026-10-24", // Sat — created INSIDE the audited week
    sessionDay: "2026-10-24",
    phone: "9175550142",
  });

  test("session rescheduled Sat 10/24 → Wed 10/28: gross stays in 10/19–25; next week gets NOTHING", () => {
    // The sync updated the row in place: same created day, session now 10/28.
    const rescheduled: ApptWithClientIdentity = {
      ...booking,
      appointment_datetime: "2026-10-28T15:00:00.000Z",
    };
    const w1 = computeWeeklyProduction([rescheduled], W1_MON, W1_SUN);
    expect(w1.gross).toBe(1);
    expect(w1.cancellations).toBe(0); // a reschedule is never a cancellation
    expect(w1.net).toBe(1);
    const w2 = computeWeeklyProduction([rescheduled], W2_MON, W2_SUN);
    expect(w2.gross).toBe(0); // no new gross merely because the session moved
    expect(w2.cancellations).toBe(0);
    expect(w2.net).toBe(0);
  });

  test("rescheduled AGAIN and again — still one gross in the original week, nothing in any other week", () => {
    const twice: ApptWithClientIdentity = {
      ...booking,
      appointment_datetime: "2026-10-30T20:00:00.000Z", // second move
    };
    expect(computeWeeklyProduction([twice], W1_MON, W1_SUN).gross).toBe(1);
    expect(computeWeeklyProduction([twice], W2_MON, W2_SUN).gross).toBe(0);
    expect(computeWeeklyProduction([twice], W2_MON, W2_SUN).cancellations).toBe(0);
    // Session pushed far out — credit still rides the 10/24 creation.
    const far: ApptWithClientIdentity = { ...booking, appointment_datetime: "2027-03-15T20:00:00.000Z" };
    expect(computeWeeklyProduction([far], W1_MON, W1_SUN).gross).toBe(1);
    expect(computeWeeklyProduction([far], "2027-03-08", "2027-03-14").gross).toBe(0);
  });
});

// ---------- (c) same-week cancel-and-rebook (the Vallee shape) ----------

describe("same-week cancel-and-rebook — counted ONCE (owner-confirmed 84), never a cancellation", () => {
  test("cancelled paid row + active paid rebook, same identity, same week → one gross, zero cancellations", () => {
    const rows = [
      appt("active-rebook", { createdDay: "2026-10-20", phone: "5082844874" }),
      appt("cancelled-original", { createdDay: "2026-10-20", phone: "5082844874", cancelled: true }),
    ];
    const block = computeWeeklyProduction(rows, W1_MON, W1_SUN);
    expect(block.gross).toBe(1); // the identity dedupe — the owner's 84 not 85
    expect(block.cancellations).toBe(0);
    expect(block.net).toBe(1);
  });
});

// ---------- (d) true cancellation ----------

describe("true cancellation — original week keeps Gross, cancellations increments, net decreases", () => {
  test("paid booking created in the week, later cancelled, never rebooked", () => {
    const rows = [appt("true-cxl", { createdDay: "2026-10-21", cancelled: true, phone: "9175550143" })];
    const w1 = computeWeeklyProduction(rows, W1_MON, W1_SUN);
    expect(w1.gross).toBe(1); // produced that week — the deposit landed
    expect(w1.cancellations).toBe(1);
    expect(w1.net).toBe(0);
    // No rebooking anywhere: the following week stays empty.
    const w2 = computeWeeklyProduction(rows, W2_MON, W2_SUN);
    expect(w2.gross).toBe(0);
    expect(w2.cancellations).toBe(0);
  });
});

// ---------- (e) true later rebooking after a genuine cancellation ----------

describe("later rebooking after a genuine cancellation — original week keeps Gross + Cancellation; rebook week gets its own Gross", () => {
  test("the Heather Collins shape: paid created 10/01 cancelled; paid rebook created 10/19", () => {
    const rows = [
      appt("cxl-w0", { createdDay: "2026-10-01", sessionDay: "2026-10-15", cancelled: true, phone: "6032620859" }),
      appt("rebook-w1", { createdDay: "2026-10-19", phone: "6032620859" }),
    ];
    const w0 = computeWeeklyProduction(rows, W0_MON, W0_SUN);
    expect(w0.gross).toBe(1); // week 1 keeps the Gross booking
    expect(w0.cancellations).toBe(1); // and owns its Cancellation
    expect(w0.net).toBe(0);
    const w1 = computeWeeklyProduction(rows, W1_MON, W1_SUN);
    expect(w1.gross).toBe(1); // the rebook is week 2's own production event
    expect(w1.cancellations).toBe(0);
    expect(w1.net).toBe(1);
  });
});

// ---------- (f) two genuinely separate bookings by the same client ----------

describe("two genuinely separate bookings by the same client — both count, never merged", () => {
  test("active paid bookings in two different weeks (no cancellation involved)", () => {
    const rows = [
      appt("first", { createdDay: "2026-10-01", phone: "9175550144" }),
      appt("second", { createdDay: "2026-10-19", phone: "9175550144" }),
    ];
    const w0 = computeWeeklyProduction(rows, W0_MON, W0_SUN);
    expect(w0.gross).toBe(1);
    expect(w0.cancellations).toBe(0);
    const w1 = computeWeeklyProduction(rows, W1_MON, W1_SUN);
    expect(w1.gross).toBe(1);
    expect(w1.cancellations).toBe(0);
  });
});
