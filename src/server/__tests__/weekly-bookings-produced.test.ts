/**
 * WEEKLY BOOKINGS PRODUCED (Mon–Sun) — owner directive 2026-10-28 (the
 * 79-vs-84 formal audit, audit-79v84; owner-confirmed definition).
 *
 * Covers:
 *  1. The dedupe rule (audit-exact): a CANCELLED paid row is dropped only when
 *     the week holds an ACTIVE paid sibling sharing a phone10/email identity
 *     (cancel-and-rebook counts ONCE); a cancelled-only group still counts as
 *     produced; two distinct active bookings never merge; phone10 normalization
 *     (leading country code) and email case/whitespace normalization.
 *  2. The audit pin: Oct 19–25 = EXACTLY 84, id-set equality against the
 *     formal audit's candidate-84-records.csv (fixture copied into
 *     __tests__/fixtures/ with the client column stripped), Vallee Bordinaro's
 *     cancelled row deduped against her active rebook.
 *  3. The separate-count guard: the SAME input through the UNTOUCHED existing
 *     chain (filterApptsInWinBucketRange + isBookingWin) still yields 79 —
 *     the new builder must never move the win/funnel/cohort numbers.
 *  4. The report line: figure + one-line footnote, and byte-identity of the
 *     template when the input is absent.
 *  5. The page payload (MemoryStore seam): bookings.total counts only paid-AND-
 *     active wins while bookings.producedMonSun includes the cancelled paid
 *     row minus the dedupe — and the copied report carries the SAME digit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeWeeklyBookingsProduced, type ApptWithClientIdentity } from "../metrics/source-attribution";
import { filterApptsInWinBucketRange, isBookingWin, type AppointmentRow } from "../metrics/compute";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import { weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";

// ---------- fixtures ----------

const WEEK_MON = "2026-10-19";
const WEEK_SUN = "2026-10-25";
const VALLEE_ACTIVE_ID = "3429e971-a9b4-4db8-95d4-b36aeb774564";
const VALLEE_CANCELLED_ID = "a9aa1b08-22cf-43b1-a90a-7e2f954e8666";
const VALLEE_PHONE = "5082844874"; // the audit's documented shared identity

/** Minimal paid-created-in-week row (builder only needs these fields). */
function appt(
  id: string,
  createdDay: string,
  opts: {
    paid?: boolean;
    cancelled?: boolean;
    phone?: string | null;
    email?: string | null;
    winDate?: string | null;
  } = {},
): ApptWithClientIdentity {
  const paid = opts.paid ?? true;
  return {
    id,
    contact_id: null,
    calendar_id: "cal-1",
    appointment_type: "Portrait Session",
    appointment_datetime: `${createdDay}T18:00:00.000Z`,
    created_at: `${createdDay}T15:00:00.000Z`,
    created_business_date: createdDay,
    booking_win_business_date: opts.winDate !== undefined ? opts.winDate : createdDay,
    payment_state: paid ? "paid" : "pending_payment",
    raw: paid ? { paid: "yes", amountPaid: "200.00" } : { paid: "no" },
    status: opts.cancelled ? "cancelled" : "scheduled",
    cancelled: opts.cancelled ?? false,
    client_phone: opts.phone ?? null,
    client_email: opts.email ?? null,
  };
}

// ---------- 1. dedupe rule (unit) ----------

describe("computeWeeklyBookingsProduced — dedupe rule (audit-exact)", () => {
  test("cancel-and-rebook counts ONCE — the active sibling wins, the cancelled duplicate drops", () => {
    const rows = [
      appt("active", WEEK_MON, { phone: VALLEE_PHONE }),
      appt("cancelled-dup", WEEK_MON, { phone: VALLEE_PHONE, cancelled: true }),
    ];
    const out = computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN);
    expect(out.count).toBe(1);
    expect(out.rows.map((r) => r.id)).toEqual(["active"]);
  });

  test("cancelled-only group still counts as produced (paid deposit landed)", () => {
    const rows = [appt("cancelled-only", WEEK_MON, { phone: "5550001111", cancelled: true })];
    const out = computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN);
    expect(out.count).toBe(1);
    expect(out.rows[0]!.id).toBe("cancelled-only");
  });

  test("two distinct clients (different phones) never merge — no false dedupe", () => {
    const rows = [
      appt("a", WEEK_MON, { phone: "5550001111" }),
      appt("b", WEEK_MON, { phone: "5550002222" }),
      appt("c-dup-of-a", WEEK_MON, { phone: "5550001111", cancelled: true }),
    ];
    const out = computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN);
    expect(out.count).toBe(2); // a + b; c drops as a's duplicate
    expect(out.rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("email identity dedupes too (case/whitespace normalized) — and phone normalization (leading 1)", () => {
    const rows = [
      appt("active-email", WEEK_MON, { email: " Client@Example.COM " }),
      appt("cancelled-email-dup", WEEK_MON, { email: "client@example.com", cancelled: true }),
      appt("active-phone", "2026-10-21", { phone: "15085551234" }),
      appt("cancelled-phone-dup", "2026-10-22", { phone: "5085551234", cancelled: true }),
    ];
    const out = computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN);
    expect(out.count).toBe(2);
    expect(out.rows.map((r) => r.id).sort()).toEqual(["active-email", "active-phone"]);
  });

  test("status 'cancelled' alone (without the boolean flag) is still a cancelled row", () => {
    const rows = [
      appt("active", WEEK_MON, { phone: "5550001111" }),
      { ...appt("cancelled-status", WEEK_MON, { phone: "5550001111" }), cancelled: false, status: "cancelled" },
    ];
    const out = computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN);
    expect(out.count).toBe(1);
    expect(out.rows[0]!.id).toBe("active");
  });

  test("two ACTIVE paid rows sharing an identity both count — the audit rule only drops cancelled duplicates", () => {
    const rows = [
      appt("first", WEEK_MON, { phone: "5550001111" }),
      appt("second", "2026-10-22", { phone: "5550001111" }),
    ];
    expect(computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN).count).toBe(2);
  });

  test("unpaid rows never count; out-of-week created rows never count", () => {
    const rows = [
      appt("pending", WEEK_MON, { paid: false }),
      appt("before", "2026-10-18", { phone: "5550001111" }), // Sunday before
      appt("after", "2026-10-26", { phone: "5550002222" }), // Monday after
      appt("in-week", WEEK_MON, { phone: "5550003333" }),
    ];
    const out = computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN);
    expect(out.count).toBe(1);
    expect(out.rows[0]!.id).toBe("in-week");
  });

  test("a row with NO identity tokens can never be deduped away", () => {
    const rows = [
      appt("active-no-id", WEEK_MON),
      appt("cancelled-no-id", WEEK_MON, { cancelled: true }),
    ];
    expect(computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN).count).toBe(2);
  });

  test("scope filter applies when provided (same appointmentInScope rule)", () => {
    const rows = [
      appt("in-cal", WEEK_MON, { phone: "5550001111" }),
      { ...appt("out-cal", WEEK_MON, { phone: "5550002222" }), calendar_name: "Annex", calendar_id: "annex" },
    ];
    const scope = { calendars_included: ["cal-1"], types_included: [] };
    expect(computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN, scope).count).toBe(1);
    expect(computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN, undefined).count).toBe(2);
  });

  test("deterministic: same input → same output, input never mutated", () => {
    const rows = [
      appt("active", WEEK_MON, { phone: VALLEE_PHONE }),
      appt("cancelled-dup", WEEK_MON, { phone: VALLEE_PHONE, cancelled: true }),
    ];
    const snapshot = JSON.stringify(rows);
    const a = computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN);
    const b = computeWeeklyBookingsProduced(rows, WEEK_MON, WEEK_SUN);
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(a).toEqual(b);
  });
});

// ---------- 2. the audit pin — Oct 19–25 = 84, id-set equality ----------

/** The formal audit's candidate-84 basis (client column stripped for the repo fixture). */
const FIXTURE_CSV = readFileSync(join(import.meta.dir, "fixtures", "candidate-84-records.csv"), "utf8");
const CANDIDATE_ROWS = FIXTURE_CSV.trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [id, genre, createdDay, createdAt, paymentState, status, winBucketDate, basis84] = line.split(",");
    return { id, genre, createdDay, createdAt, paymentState, status, winBucketDate, basis84 };
  });

/** The candidate-84 rows as appointment rows; ONLY the Vallee pair carries identity (the audit's one duplicate group). */
function candidateAppts(): ApptWithClientIdentity[] {
  return CANDIDATE_ROWS.map((r) =>
    appt(r.id, r.createdDay, {
      paid: r.paymentState === "paid",
      cancelled: r.status === "cancelled",
      phone: r.id === VALLEE_ACTIVE_ID ? VALLEE_PHONE : null,
      winDate: r.winBucketDate || null,
    }),
  );
}

describe("audit pin — Oct 19–25 Weekly Bookings Produced = 84 (audit-79v84)", () => {
  test("fixture matches the audit package: 84 rows — 79 win79 + 5 cancelled_paid_net", () => {
    expect(CANDIDATE_ROWS.length).toBe(84);
    expect(CANDIDATE_ROWS.filter((r) => r.basis84 === "win79").length).toBe(79);
    expect(CANDIDATE_ROWS.filter((r) => r.basis84 === "cancelled_paid_net").length).toBe(5);
    expect(new Set(CANDIDATE_ROWS.map((r) => r.id)).size).toBe(84);
    expect(CANDIDATE_ROWS.every((r) => r.paymentState === "paid")).toBe(true);
    expect(CANDIDATE_ROWS.every((r) => r.createdDay >= WEEK_MON && r.createdDay <= WEEK_SUN)).toBe(true);
  });

  test("builder count = 84 EXACTLY and id-set equality with candidate-84-records.csv", () => {
    // The fetch superset: the 84 candidates + Vallee's cancelled duplicate +
    // the week's unpaid rows + a paid row created outside the week.
    const input = [
      ...candidateAppts(),
      appt(VALLEE_CANCELLED_ID, "2026-10-20", { phone: VALLEE_PHONE, cancelled: true, winDate: "2026-10-20" }),
      appt("unpaid-1", "2026-10-21", { paid: false }),
      appt("unpaid-cancelled-1", "2026-10-23", { paid: false, cancelled: true }),
      appt("paid-next-week", "2026-10-26", { phone: "5550009999" }),
    ];
    const out = computeWeeklyBookingsProduced(input, WEEK_MON, WEEK_SUN);
    expect(out.count).toBe(84);
    const producedIds = new Set(out.rows.map((r) => r.id));
    expect(producedIds.size).toBe(84);
    for (const r of CANDIDATE_ROWS) expect(producedIds.has(r.id)).toBe(true);
    expect(producedIds.has(VALLEE_CANCELLED_ID)).toBe(false); // deduped duplicate
    expect(producedIds.has("unpaid-1")).toBe(false);
    expect(producedIds.has("paid-next-week")).toBe(false);
    // the five net cancelled-after-payment records ARE included (cancellations included)
    for (const r of CANDIDATE_ROWS.filter((c) => c.basis84 === "cancelled_paid_net")) {
      expect(producedIds.has(r.id)).toBe(true);
    }
  });

  test("SEPARATE-COUNT GUARD: the untouched existing chain still yields 79 on the same input", () => {
    const input: AppointmentRow[] = [
      ...candidateAppts(),
      appt(VALLEE_CANCELLED_ID, "2026-10-20", { phone: VALLEE_PHONE, cancelled: true, winDate: "2026-10-20" }),
      appt("unpaid-1", "2026-10-21", { paid: false }),
      appt("paid-next-week", "2026-10-26", { phone: "5550009999" }),
    ];
    const wins79 = filterApptsInWinBucketRange(input, WEEK_MON, WEEK_SUN).filter((a) => isBookingWin(a));
    expect(wins79.length).toBe(79); // the system's win count — byte-unchanged
    expect(computeWeeklyBookingsProduced(input, WEEK_MON, WEEK_SUN).count).toBe(84); // the new, separate count
  });
});

// ---------- 4. report line ----------

const REPORT_BASE: WeeklyCcReportInput = {
  week: { start: WEEK_MON, end: WEEK_SUN },
  monthKey: "2026-10",
  bookingsWeek: { total: 79, goal: 79 },
  bookingsMonth: { total: 162, goal: 316 },
  channels: { alliance: 3, auction: 2, website: null },
  channelLeads: { alliance: 9, auction: 4, website: null },
  leads: {
    family: 273, animalia: 562, fairyland: 66,
    auction_register_certificate: 9, google_ads_leads: 39,
    alliance_activate_certificate: 1, website_applications: 0,
    total: 950,
  },
  conversion: { overall: 0.25, family: 0.3, animalia: 0.2, fairyland: null },
  funnel: { wins: 79, leads: 957, pct: 0.0825, produced: 79 },
  calendar: {
    thisWeek: { appointments: 10, slotsOccupied: 10, capacity: 60 },
    nextWeek: { appointments: 8, slotsOccupied: 8, capacity: 60 },
    beyond: 3,
    firstFullyOpenDay: null,
  },
  holes: 12,
  notes: {},
  celebrateDefault: null,
};

describe("CC Report — Bookings Produced line (tab ↔ report digit identity)", () => {
  test("one line: figure + definition footnote, right after Bookings (Week)", () => {
    const text = buildWeeklyCcReportText({ ...REPORT_BASE, bookingsProduced: 84 });
    const lines = text.split("\n");
    const i = lines.indexOf("Bookings (Week): 79/79 (±0)");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lines[i! + 1]).toBe(
      "Bookings Produced (Mon–Sun): 84 — paid deposits on bookings created in the Mon–Sun week · per client (cancel-and-rebook counted once) · cancellations included",
    );
  });

  test("absent input keeps the template byte-identical (no produced line anywhere)", () => {
    const without = buildWeeklyCcReportText(REPORT_BASE);
    expect(without.includes("Bookings Produced")).toBe(false);
    const withNull = buildWeeklyCcReportText({ ...REPORT_BASE, bookingsProduced: null });
    expect(withNull).toBe(without);
  });
});

// ---------- 5. page payload (MemoryStore seam) ----------

const PAGE_TODAY = "2026-10-28"; // Tue → report week Mon 10/19 .. Sun 10/25
const H = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString();

describe("weekly page payload — bookings.producedMonSun (separate count, additive)", () => {
  test("total counts paid-AND-active wins only; producedMonSun includes the cancelled paid row minus the dedupe; report carries the same digit", async () => {
    const store = new MemoryStore();
    await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
    await store.upsertAppointments([
      // cancel-and-rebook pair — one client, phone identity
      {
        id: "rebook-active", acuity_appointment_id: "rebook-active", contact_id: null, calendar_id: "cal-1",
        appointment_type: "Portrait Session", appointment_datetime: H("2026-10-20", "14:00"),
        created_at: H("2026-10-20", "12:00"), created_business_date: "2026-10-20",
        booking_win_business_date: "2026-10-20", payment_state: "paid",
        raw: { paid: "yes", amountPaid: "300.00" }, status: "scheduled", cancelled: false,
        client_phone: "5085554874", client_email: null,
      },
      {
        id: "rebook-cancelled", acuity_appointment_id: "rebook-cancelled", contact_id: null, calendar_id: "cal-1",
        appointment_type: "Animalia Session", appointment_datetime: H("2026-10-20", "15:00"),
        created_at: H("2026-10-20", "13:00"), created_business_date: "2026-10-20",
        booking_win_business_date: "2026-10-20", payment_state: "paid",
        raw: { paid: "yes", amountPaid: "300.00" }, status: "cancelled", cancelled: true,
        client_phone: "5085554874", client_email: null,
      },
      // cancelled-after-payment with NO active sibling — still produced
      {
        id: "cancelled-only", acuity_appointment_id: "cancelled-only", contact_id: null, calendar_id: "cal-1",
        appointment_type: "Portrait Session", appointment_datetime: H("2026-10-21", "14:00"),
        created_at: H("2026-10-21", "12:00"), created_business_date: "2026-10-21",
        booking_win_business_date: "2026-10-21", payment_state: "paid",
        raw: { paid: "yes", amountPaid: "200.00" }, status: "cancelled", cancelled: true,
        client_phone: "5550001111", client_email: null,
      },
      // pending payment — never counts anywhere
      {
        id: "pending", acuity_appointment_id: "pending", contact_id: null, calendar_id: "cal-1",
        appointment_type: "Portrait Session", appointment_datetime: H("2026-10-22", "14:00"),
        created_at: H("2026-10-22", "12:00"), created_business_date: "2026-10-22",
        booking_win_business_date: null, payment_state: "pending_payment",
        raw: { paid: "no" }, status: "scheduled", cancelled: false,
        client_phone: "5550002222", client_email: null,
      },
    ]);

    const data = await weeklyPageData({ store, today: PAGE_TODAY });
    expect(data.week.start).toBe(WEEK_MON);
    expect(data.week.end).toBe(WEEK_SUN);
    // UNTOUCHED count: only the active win (cancelled rows and pending never count)
    expect(data.bookings.total).toBe(1);
    // NEW separate count: 3 paid created in-week − 1 deduped cancel-and-rebook = 2
    expect(data.bookings.producedMonSun).toBe(2);
    // The copied report carries the SAME digit (tab ↔ report identity)
    expect(data.report.reportText).toContain("Bookings Produced (Mon–Sun): 2");
    expect(data.report.reportText).toContain("Bookings (Week): 1/");
  });
});
