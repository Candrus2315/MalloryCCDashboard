/**
 * PENDING PAYMENT DISMISSAL (owner request 2026-09-30: "for the pending
 * payments on todays tab i want to be able to exit out of them, can you put a
 * x exit to them to delete from that list as i see fit").
 *
 * Semantics under test:
 *  1. ✕ dismiss removes the item from the pending list IMMEDIATELY and
 *     PERMANENTLY — pending_dismissed_at is owner-controlled state that the
 *     Acuity sync's upsertAppointments NEVER touches or clears (9/29 lesson:
 *     MemoryStore-only tests shipped a broken PgStore, so the pg-backed block
 *     mirrors the same assertions against a real Postgres when
 *     TEST_DATABASE_URL is set).
 *  2. The appointment ROW itself is never deleted (Acuity is the source of
 *     truth; the sync would re-create it).
 *  3. Dismissal affects ONLY the pending list: if the appointment later
 *     becomes PAID it still counts as a Booking Win everywhere.
 *  4. An already-paid win can never be dismissed (the server rejects).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { PgStore } from "../store/pg";
import { appointmentPaymentStateOf, isBookingWin } from "../metrics/compute";
import { dismissPendingPaymentCore } from "../queries";
import { addDays, etDayStartUtc, etToday } from "../date-logic";
import type { AppointmentRow } from "../metrics/compute";

/**
 * DATE-ROT SAFETY (owner 11/2: the Sep-1 fixture slid past the 30-day pending
 * window as real time reached November → "Appointment not found in the pending
 * payments window"). The dismissal core windows on the REAL clock
 * (etToday() − 30 days), so the fixture dates itself RELATIVE to real now:
 * TODAY = the real ET today, and every fetch floor is the SAME 30-day window
 * the core reads. The suite is green any day without weakening a single
 * assertion (counts, ids, state transitions are unchanged).
 */
const TODAY = etToday(); // real ET today — inside the pending window by construction
/** The Today page's pending window — the EXACT floor dismissPendingPaymentCore computes. */
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
/** A pending (unpaid) booking created today — the pending-list shape. */
function pendingAppt(overrides: Partial<AppointmentRow> = {}): AppointmentRow {
  seq += 1;
  return {
    id: `appt-dismiss-${seq}`,
    contact_id: null,
    calendar_id: "cal-mallory",
    appointment_type: "Portrait Session + Include a pet, cleaning deposit",
    appointment_datetime: `${addDays(TODAY, 1)}T14:00:00.000Z`,
    created_at: `${TODAY}T14:00:00.000Z`,
    created_business_date: TODAY,
    created_time_precision: "full",
    raw: raw("no", "300.00") as unknown as Record<string, unknown>,
    status: "scheduled",
    cancelled: false,
    ...overrides,
  };
}

async function seedPending(store: MemoryStore, acuityId: string): Promise<AppointmentRow> {
  const row = pendingAppt({ acuity_appointment_id: acuityId } as Partial<AppointmentRow>);
  await store.upsertAppointments([
    {
      ...row,
      acuity_appointment_id: acuityId,
      payment_state: "pending_payment",
      client_name: "Test Pending Client",
    } as AppointmentRow & { acuity_appointment_id: string },
  ]);
  return row;
}

describe("pending payment dismissal — store semantics (MemoryStore)", () => {
  test("dismissPendingPayment sets pending_dismissed_at (keep-first, idempotent); the row is never deleted", async () => {
    const store = new MemoryStore();
    await seedPending(store, "dp-1");
    const before = await store.getAppointmentsWithClientsSince(WINDOW_START);
    expect(before.length).toBe(1);

    await store.dismissPendingPayment(before[0].id);
    const after1 = await store.getAppointmentsWithClientsSince(WINDOW_START);
    expect(after1.length).toBe(1); // row kept, never deleted
    const stamp1 = after1[0].pending_dismissed_at;
    expect(stamp1).not.toBeNull();

    // idempotent: a re-dismiss never moves the original timestamp
    await new Promise((r) => setTimeout(r, 5));
    await store.dismissPendingPayment(before[0].id);
    const after2 = await store.getAppointmentsWithClientsSince(WINDOW_START);
    expect(after2[0].pending_dismissed_at).toBe(stamp1);
  });

  test("upsertAppointments (re-sync) does NOT clear pending_dismissed_at", async () => {
    const store = new MemoryStore();
    await seedPending(store, "dp-2");
    const rows = await store.getAppointmentsWithClientsSince(WINDOW_START);
    const apptId = rows[0].id;
    await store.dismissPendingPayment(apptId);

    // The Acuity sync re-upserts the same appointment (paid stays unpaid; only
    // sync fields refresh) — the dismissal must survive untouched.
    await store.upsertAppointments([
      {
        ...pendingAppt({ id: "ignored-on-resync" }),
        acuity_appointment_id: "dp-2",
        payment_state: "pending_payment",
        client_name: "Test Pending Client",
        created_at: `${TODAY}T15:00:00.000Z`,
      } as AppointmentRow & { acuity_appointment_id: string },
    ]);
    const after = await store.getAppointmentsWithClientsSince(WINDOW_START);
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(apptId); // internal id stable across re-syncs
    expect(after[0].pending_dismissed_at).not.toBeNull();
  });

  test("excludePendingDismissed drops dismissed rows from the pending window; default keeps them", async () => {
    const store = new MemoryStore();
    await seedPending(store, "dp-3");
    await seedPending(store, "dp-4");
    const rows = await store.getAppointmentsWithClientsSince(WINDOW_START);
    expect(rows.length).toBe(2);
    await store.dismissPendingPayment(rows[0].id);

    // The Today page's pending list reads WITH the exclusion...
    const pendingWindow = await store.getAppointmentsWithClientsSince(WINDOW_START, { excludePendingDismissed: true });
    expect(pendingWindow.length).toBe(1);
    expect(pendingWindow[0].pending_dismissed_at).toBeNull();

    // ...the attribution tick / unattributed queue / dismiss endpoint read the DEFAULT.
    const everything = await store.getAppointmentsWithClientsSince(WINDOW_START);
    expect(everything.length).toBe(2);
  });
});

describe("pending payment dismissal — server semantics (dismissPendingPaymentCore)", () => {
  test("dismiss → pending list excludes it → appointment later PAID → still counted as a Booking Win", async () => {
    const store = new MemoryStore();
    await seedPending(store, "dp-5");
    const rows = await store.getAppointmentsWithClientsSince(WINDOW_START);
    const apptId = rows[0].id;

    // core server fn: dismiss + audit row
    await dismissPendingPaymentCore(store, { appointmentId: apptId });
    const audit = await store.getManualOverrides(10);
    expect(audit.some((a) => a.entity_type === "appointment" && a.entity_id === apptId && a.new_value === "pending payment dismissed by owner")).toBe(true);

    // pending list (query layer + page filter) excludes the dismissed row
    const pendingWindow = await store.getAppointmentsWithClientsSince(WINDOW_START, { excludePendingDismissed: true });
    const pendingList = pendingWindow.filter(
      (a) => !a.cancelled && a.status !== "cancelled" && appointmentPaymentStateOf(a) === "pending_payment",
    );
    expect(pendingList.length).toBe(0);

    // the deposit arrives later — the appointment becomes a PAID Booking Win
    await store.upsertAppointments([
      {
        ...pendingAppt(),
        acuity_appointment_id: "dp-5",
        payment_state: "paid",
        raw: raw("yes", "300.00") as unknown as Record<string, unknown>,
        booking_win_business_date: TODAY,
        payment_business_date_source: "first-seen",
        first_seen_paid_at: `${TODAY}T16:00:00.000Z`,
      } as AppointmentRow & { acuity_appointment_id: string },
    ]);
    const wins = await store.getAppointmentsByWinBusinessDateBetween(TODAY, TODAY);
    expect(wins.length).toBe(1); // dismissal NEVER affects a win
    expect(isBookingWin(wins[0])).toBe(true);
  });

  test("an already-PAID win can never be dismissed (server rejects)", async () => {
    const store = new MemoryStore();
    const row = pendingAppt({ payment_state: "paid" } as Partial<AppointmentRow>);
    await store.upsertAppointments([
      {
        ...row,
        acuity_appointment_id: "dp-6",
        raw: raw("yes", "300.00") as unknown as Record<string, unknown>,
        booking_win_business_date: TODAY,
      } as AppointmentRow & { acuity_appointment_id: string },
    ]);
    const rows = await store.getAppointmentsWithClientsSince(WINDOW_START);
    await expect(dismissPendingPaymentCore(store, { appointmentId: rows[0].id })).rejects.toThrow(/Only pending payments can be dismissed/);
    const after = await store.getAppointmentsWithClientsSince(WINDOW_START);
    expect(after[0].pending_dismissed_at ?? null).toBeNull();
  });
});

/**
 * PgStore-backed mirror of the same assertions (9/29 lesson: MemoryStore-only
 * tests shipped a broken PgStore). SKIPPED unless TEST_DATABASE_URL is set.
 * NOTE: the managed Timescale service allows no scratch databases (only
 * "tsdb") and docker is unavailable in this environment, so when the test
 * runs against the LIVE database its rows are dated INSIDE the 30-day pending
 * window but OUTSIDE the current Mon–Sun week (10 days back is always >6 days
 * before today, so no current-week surface can ever show them), and removed
 * in a finally block by unique acuity id. (Fixed past dates would slide out of
 * the dismissal core's rolling 30-day window — the same date-rot the
 * MemoryStore block hit in November 2026.)
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("pending payment dismissal — PgStore (real Postgres)", () => {
  test("upsert preserves pending_dismissed_at; exclusion + win semantics hold", async () => {
    // 90s: the remote managed Postgres costs multiple TLS round trips (schema
    // ensure + several queries) — the 5s default test timeout false-fails.
    const store = new PgStore(process.env.TEST_DATABASE_URL!);
    await store.ensureSchema();
    // Rows dated 10 days back (date-rot-safe AND window-safe — see NOTE), deleted in finally.
    const PAST_DAY = addDays(TODAY, -10);
    const acuityId = `test-dismiss-${Date.now()}`;
    const pastPending = pendingAppt({
      created_at: `${PAST_DAY}T14:00:00.000Z`,
      created_business_date: PAST_DAY,
    });
    try {
      await store.upsertAppointments([
        {
          ...pastPending,
          acuity_appointment_id: acuityId,
          payment_state: "pending_payment",
          client_name: "Pg Dismiss Test",
        } as AppointmentRow & { acuity_appointment_id: string },
      ]);
      let rows = await store.getAppointmentsWithClientsSince(WINDOW_START);
      const mine = rows.find((r) => r.acuity_appointment_id === acuityId)!;
      expect(mine.payment_state).toBe("pending_payment");
      await store.dismissPendingPayment(mine.id);

      // RE-SYNC: upsertAppointments must NOT touch pending_dismissed_at
      await store.upsertAppointments([
        {
          ...pastPending,
          acuity_appointment_id: acuityId,
          payment_state: "pending_payment",
          client_name: "Pg Dismiss Test",
        } as AppointmentRow & { acuity_appointment_id: string },
      ]);
      rows = await store.getAppointmentsWithClientsSince(WINDOW_START);
      const re = rows.find((r) => r.acuity_appointment_id === acuityId)!;
      expect(re.id).toBe(mine.id);
      expect(re.pending_dismissed_at).not.toBeNull(); // survived the sync

      // pending window excludes it; the default keeps it
      const pendingWindow = await store.getAppointmentsWithClientsSince(WINDOW_START, { excludePendingDismissed: true });
      expect(pendingWindow.some((r) => r.id === mine.id)).toBe(false);

      // the deposit arrives later — still a Booking Win, and NOT dismissible again
      await store.upsertAppointments([
        {
          ...pastPending,
          acuity_appointment_id: acuityId,
          payment_state: "paid",
          raw: raw("yes", "300.00") as unknown as Record<string, unknown>,
          booking_win_business_date: PAST_DAY,
        } as AppointmentRow & { acuity_appointment_id: string },
      ]);
      const wins = await store.getAppointmentsByWinBusinessDateBetween(PAST_DAY, PAST_DAY);
      const win = wins.find((r) => r.id === mine.id);
      expect(win).toBeDefined();
      expect(isBookingWin(win!)).toBe(true);

      await expect(dismissPendingPaymentCore(store, { appointmentId: mine.id })).rejects.toThrow(/Only pending payments can be dismissed/);
    } finally {
      // scratch-DB hygiene: only OUR test row is removed (by unique acuity id)
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
