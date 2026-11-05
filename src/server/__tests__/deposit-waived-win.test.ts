/**
 * DEPOSIT-WAIVED BOOKING WINS (owner directive 2026-11-05, the Sunalie Morton
 * case — Acuity 1801740669, Animalia Session, session 2026-11-05 17:00 UTC).
 *
 * The owner WAIVED the deposit: no payment evidence will ever exist. The row
 * was restored with a direct DB fix — booking_win_business_date '2026-11-05'
 * PERSISTED (write-once evidence the owner set deliberately, audited in
 * manual_overrides) while payment_state stays 'pending_payment' (honest — no
 * payment occurred).
 *
 * Pinned here:
 *  1. THE GATE: isBookingWin treats a PERSISTED booking_win_business_date as
 *     a win even when unpaid — the waived booking counts everywhere a
 *     Booking counts (Today / Daily Report / Weekly / Performance /
 *     commissions all share the ONE isBookingWin + bookingWinBusinessDateOf
 *     chain, so this single gate change carries every surface).
 *  2. THE BUCKET: bookingWinBusinessDateOf returns the persisted date even
 *     when not paid (it IS the win-bucket key); paid rows keep the existing
 *     derivation order (persisted → raw paymentTimestamp → created date).
 *  3. NO UN-WINNING: a genuinely pending row (unpaid, NO win date) counts
 *     nowhere — unchanged; a cancelled appointment is never resurrected by a
 *     persisted date; plain paid rows are untouched.
 *  4. WRITER SAFETY: deriveBookingPaymentFields' not-paid branch KEEPS the
 *     persisted win date and NEVER invents payment evidence (payment_state
 *     stays 'pending_payment'; first_seen_paid_at stays null — write-once
 *     keeps the existing null).
 *  5. THE PENDING LIST: a dismissed waived row (the Sunalie shape) stays out
 *     of the Pending Payments drill-down (pending_dismissed_at is
 *     owner-controlled; the query-layer exclusion is unchanged) while STILL
 *     counting as a win through the win-bucket fetch — and a re-sync
 *     (unpaid raw again) preserves every fact (win date write-once,
 *     dismissal survives).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { deriveBookingPaymentFields } from "../payments";
import {
  appointmentIsPaid,
  bookingWinBusinessDateOf,
  countBookingsCreatedBetween,
  filterApptsInWinBucketRange,
  isBookingWin,
} from "../metrics/compute";
import { etDayStartUtc } from "../date-logic";
import type { AppointmentRow } from "../metrics/compute";

const WIN_DATE = "2026-11-05"; // the owner-set deposit-waived win date (ET)
const CREATED = "2026-11-03T15:00:00.000Z";
const SESSION = "2026-11-05T17:00:00.000Z";

/** Raw Acuity payload: unpaid (the waived deposit never arrives). */
const unpaidRaw = () =>
  ({ paid: "no", price: "300.00", priceSold: "300.00", amountPaid: "0.00", certificate: null, canceled: false }) as Record<
    string,
    unknown
  >;
const paidRaw = () =>
  ({ paid: "yes", price: "300.00", priceSold: "300.00", amountPaid: "300.00", certificate: null, canceled: false }) as Record<
    string,
    unknown
  >;

let seq = 0;
function appt(opts: {
  paid: "yes" | "no";
  winDate?: string | null;
  cancelled?: boolean;
  created?: string;
  session?: string;
}): AppointmentRow {
  seq += 1;
  const created = opts.created ?? CREATED;
  const base: AppointmentRow = {
    id: `appt-waived-${seq}`,
    contact_id: null,
    calendar_id: "cal-animalia",
    acuity_appointment_id: `18017406${seq}`,
    client_name: "Client",
    appointment_type: "Animalia Session",
    appointment_datetime: opts.session ?? SESSION,
    created_at: created,
    created_business_date: created.slice(0, 10),
    created_time_precision: "full",
    raw: opts.paid === "yes" ? paidRaw() : unpaidRaw(),
    payment_state: opts.paid === "yes" ? "paid" : "pending_payment",
    booking_win_business_date: opts.winDate ?? null,
    status: opts.cancelled ? "cancelled" : "scheduled",
    cancelled: opts.cancelled ?? false,
  };
  return base;
}

/** The exact owner-restored Sunalie Morton row. */
const sunalie = () =>
  appt({ paid: "no", winDate: WIN_DATE }) as AppointmentRow & {
    acuity_appointment_id: string;
    client_name: string;
  };

describe("DEPOSIT-WAIVED win gate — isBookingWin + bookingWinBusinessDateOf", () => {
  test("the waived row IS a win: unpaid + persisted win date counts and buckets by its persisted date", () => {
    const a = sunalie();
    // The payment verdict stays honest — no payment evidence exists.
    expect(appointmentIsPaid(a)).toBe(false);
    // The GATE: persisted write-once win evidence decides.
    expect(isBookingWin(a)).toBe(true);
    // The BUCKET: the persisted date IS the win-bucket key (returned even unpaid).
    expect(bookingWinBusinessDateOf(a)).toBe(WIN_DATE);
    // Counting surfaces (the shared chain): the win counts in its window.
    expect(countBookingsCreatedBetween([a], WIN_DATE, WIN_DATE)).toBe(1);
    expect(filterApptsInWinBucketRange([a], WIN_DATE, WIN_DATE)).toHaveLength(1);
    // ...and nowhere else (no bucket by creation date, which is 11-03).
    expect(countBookingsCreatedBetween([a], "2026-11-03", "2026-11-03")).toBe(0);
  });

  test("a genuinely pending row (unpaid, NO win date) counts nowhere — unchanged", () => {
    const a = appt({ paid: "no" });
    expect(appointmentIsPaid(a)).toBe(false);
    expect(isBookingWin(a)).toBe(false);
    expect(bookingWinBusinessDateOf(a)).toBeNull();
    expect(countBookingsCreatedBetween([a], WIN_DATE, WIN_DATE)).toBe(0);
    expect(filterApptsInWinBucketRange([a], WIN_DATE, WIN_DATE)).toHaveLength(0);
  });

  test("a plain scheduled appointment (nothing to collect) counts nowhere — unchanged", () => {
    const a = appt({ paid: "no", created: "2026-11-03T15:00:00.000Z" });
    const scheduled = { ...a, payment_state: "scheduled", raw: { paid: "no", price: "0.00", priceSold: "0.00", amountPaid: "0.00", certificate: null, canceled: false } as Record<string, unknown> };
    expect(isBookingWin(scheduled)).toBe(false);
    expect(bookingWinBusinessDateOf(scheduled)).toBeNull();
  });

  test("a cancelled appointment is never resurrected by a persisted win date", () => {
    const a = appt({ paid: "no", winDate: WIN_DATE, cancelled: true });
    expect(isBookingWin(a)).toBe(false);
    expect(countBookingsCreatedBetween([a], WIN_DATE, WIN_DATE)).toBe(0);
    // the bucket key still reads the persisted date (the window superset may
    // carry the row; the isBooking gate keeps it out of every count).
    expect(bookingWinBusinessDateOf(a)).toBe(WIN_DATE);
  });

  test("paid rows are untouched: gate true; bucket order preserved (persisted → raw paymentTimestamp → created)", () => {
    // persisted beats the raw timestamp (order preserved for paid rows)
    const persisted = appt({ paid: "yes", winDate: "2026-11-04" });
    const withTs = {
      ...persisted,
      raw: { paid: "yes", price: "300.00", priceSold: "300.00", amountPaid: "300.00", certificate: null, canceled: false, paymentTimestamp: "2026-11-05T01:30:00-0500" } as Record<string, unknown>,
    };
    expect(isBookingWin(withTs)).toBe(true);
    expect(bookingWinBusinessDateOf(withTs)).toBe("2026-11-04");

    // no persisted date → the raw payment timestamp's ET date (as before):
    // 01:30-0500 = 06:30 UTC = 01:30 ET (EST) on 2026-11-05
    const noPersisted = {
      ...appt({ paid: "yes", winDate: null }),
      created_business_date: "2026-11-03",
      raw: { ...paidRaw(), paymentTimestamp: "2026-11-05T01:30:00-0500" } as Record<string, unknown>,
    };
    expect(bookingWinBusinessDateOf(noPersisted)).toBe("2026-11-05");
    // no persisted, no timestamp → the creation ET business date (first-seen proxy)
    const noTs = { ...noPersisted, raw: paidRaw() };
    expect(bookingWinBusinessDateOf(noTs)).toBe("2026-11-03");
  });
});

describe("DEPOSIT-WAIVED writer safety — deriveBookingPaymentFields", () => {
  test("the not-paid branch KEEPS the persisted win date and invents no payment evidence", () => {
    const d = deriveBookingPaymentFields({
      raw: unpaidRaw(),
      existing: {
        booking_win_business_date: WIN_DATE,
        payment_business_date_source: "first-seen",
        first_seen_paid_at: null,
      },
      createdBusinessDate: "2026-11-03",
      nowIso: "2026-11-05T18:00:00.000Z",
    });
    // payment_state stays honest — never invented 'paid'
    expect(d.payment_state).toBe("pending_payment");
    // the owner-set win date survives the re-derivation (write-once)
    expect(d.booking_win_business_date).toBe(WIN_DATE);
    expect(d.payment_business_date_source).toBe("first-seen");
    // first_seen_paid_at stays null for waived rows (write-once keeps existing null)
    expect(d.first_seen_paid_at).toBeNull();
  });

  test("the writer never derives a win date for an unpaid row without one", () => {
    const d = deriveBookingPaymentFields({
      raw: unpaidRaw(),
      existing: null,
      createdBusinessDate: "2026-11-03",
      nowIso: "2026-11-05T18:00:00.000Z",
    });
    expect(d.payment_state).toBe("pending_payment");
    expect(d.booking_win_business_date).toBeNull();
    expect(d.first_seen_paid_at).toBeNull();
  });
});

describe("DEPOSIT-WAIVED store round-trip — the Sunalie shape (MemoryStore)", () => {
  test("waived row: counts via the win-bucket fetch, stays OUT of the pending list once dismissed, survives a re-sync", async () => {
    const store = new MemoryStore();
    const windowStart = etDayStartUtc("2026-11-01");
    await store.upsertAppointments([{ ...sunalie() } as AppointmentRow & { acuity_appointment_id: string }]);
    let rows = await store.getAppointmentsWithClientsSince(windowStart);
    expect(rows).toHaveLength(1);
    const internalId = rows[0].id; // store-canonical id — read back, never assumed

    // The win-bucket fetch returns her by the persisted date; the gate counts her.
    const wins = await store.getAppointmentsByWinBusinessDateBetween(WIN_DATE, WIN_DATE);
    expect(wins.map((w) => w.id)).toContain(internalId);
    expect(isBookingWin(wins[0])).toBe(true);
    expect(bookingWinBusinessDateOf(wins[0])).toBe(WIN_DATE);

    // Pending list BEFORE dismissal: the filter is payment_state-only, so an
    // undismissed waived row would still appear (the owner decides when).
    let pendingWindow = await store.getAppointmentsWithClientsSince(windowStart, { excludePendingDismissed: true });
    expect(pendingWindow.some((a) => a.id === internalId)).toBe(true);

    // The owner dismisses her from the pending list (already done in prod).
    await store.dismissPendingPayment(internalId);

    // OUT of the pending list (query-layer exclusion — unchanged)...
    pendingWindow = await store.getAppointmentsWithClientsSince(windowStart, { excludePendingDismissed: true });
    expect(pendingWindow.some((a) => a.id === internalId)).toBe(false);
    const pendingList = pendingWindow.filter(
      (a) => !a.cancelled && a.status !== "cancelled" && (a.payment_state ?? "") === "pending_payment",
    );
    expect(pendingList).toHaveLength(0);
    // ...while STILL a win through the win-bucket fetch.
    const winsAfter = await store.getAppointmentsByWinBusinessDateBetween(WIN_DATE, WIN_DATE);
    expect(winsAfter.some((w) => w.id === internalId)).toBe(true);
    expect(isBookingWin(winsAfter[0])).toBe(true);

    // A re-sync (unpaid raw again — nothing will ever pay) preserves every fact.
    await store.upsertAppointments([{ ...sunalie(), created_at: "2026-11-03T16:00:00.000Z" } as AppointmentRow & { acuity_appointment_id: string }]);
    const after = await store.getAppointmentsWithClientsSince(windowStart);
    const row = after.find((a) => a.id === internalId);
    expect(row).toBeDefined();
    expect(row?.booking_win_business_date).toBe(WIN_DATE); // write-once win date survives
    expect(row?.payment_state).toBe("pending_payment"); // honest — no payment invented
    expect(row?.pending_dismissed_at).not.toBeNull(); // dismissal survives
    expect(isBookingWin(row as AppointmentRow)).toBe(true); // still a win
    const pendingAfter = await store.getAppointmentsWithClientsSince(windowStart, { excludePendingDismissed: true });
    expect(pendingAfter.some((a) => a.id === internalId)).toBe(false); // still out of the pending list
  });
});
