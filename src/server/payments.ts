/**
 * BOOKING WIN PAYMENT-STATE MODEL (owner directive, business-plan rev 12
 * "Booking Win definition"). THE one derivation of an appointment's payment
 * state from the retained raw Acuity payload (appointments.raw, S7c).
 *
 * Three states, mutually exclusive:
 *   - "paid"            → Paid Booking / BOOKING WIN — counts everywhere a
 *                         "Booking" is displayed. Evidence: raw paid:"yes".
 *                         amountPaid is INFORMATIONAL ONLY — a real case
 *                         (Angela Chiccarelli, 2026-09-28) has paid:"yes" with
 *                         amountPaid:"0.00" and still counts as paid. Never
 *                         read price/priceSold/certificate for the verdict.
 *   - "pending_payment" → invoice sent but UNPAID — visible in the Pending
 *                         Payments drill-down, NEVER counts toward performance.
 *                         Evidence: raw paid:"no" with a positive price.
 *   - "scheduled"       → plain appointment (no payment yet); holds
 *                         availability, counts nowhere.
 *
 * A row with NEITHER raw NOR a persisted payment_state carries no payment
 * evidence at all (pre-S7c legacy rows, demo seeds): its paid-ness is UNKNOWN
 * and the metrics layer keeps legacy behavior for it (see appointmentIsPaid in
 * metrics/compute.ts) — the Acuity sync writes raw + derived state on every
 * pass, so live rows always carry explicit evidence.
 *
 * booking_win_business_date (ET): the business date the deposit was received —
 * the Acuity payment timestamp when the raw carries one, else the FIRST-SEEN
 * evidence (date proxied by the creation ET date, precision-marked) so a win
 * date never moves after the fact and an appointment never counts twice.
 */

export type BookingPaymentState = "paid" | "pending_payment" | "scheduled" | "unknown";

/** Where a win's business date came from — shown for traceability. */
export type WinDateSource = "acuity-payment" | "first-seen" | null;

export interface PaymentDerivation {
  state: BookingPaymentState;
  /** true/false only when the raw carries explicit paid evidence; else null. */
  paid: boolean | null;
  /** Informational amounts (never the verdict). */
  price: number | null;
  priceSold: number | null;
  amountPaid: number | null;
  /** Payment timestamp when the raw carries one (rare: Acuity v1 appointment payloads usually do not). */
  paymentTimestamp: string | null;
}

const TRUE_VALUES = new Set(["yes", "true", "1", "y"]);
const FALSE_VALUES = new Set(["no", "false", "0", "n"]);

function parseMoney(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parsePaidFlag(v: unknown): boolean | null {
  if (v === true) return true;
  if (v === false || v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  return null;
}

/**
 * Derive the payment state from ONE retained raw Acuity appointment payload.
 * Pure; null/undefined raw → unknown (no evidence, never invented).
 */
export function derivePaymentState(raw: unknown): PaymentDerivation {
  // The pg driver may hand jsonb back as an object OR (some builds/paths) a
  // JSON string — parse defensively so evidence is never misread as absent.
  // Rows written before the store stopped pre-stringifying raw can be wrapped
  // MORE than once (a JSON string whose content is again a JSON string), so
  // unwrap repeatedly until an object (or a non-JSON string) is reached.
  for (let i = 0; typeof raw === "string" && i < 5; i++) {
    try { raw = JSON.parse(raw); } catch { raw = null; break; }
  }
  if (raw == null || typeof raw !== "object") {
    return { state: "unknown", paid: null, price: null, priceSold: null, amountPaid: null, paymentTimestamp: null };
  }
  const paid = parsePaidFlag(raw.paid);
  const price = parseMoney(raw.price);
  const priceSold = parseMoney(raw.priceSold);
  const amountPaid = parseMoney(raw.amountPaid);
  let state: BookingPaymentState;
  if (paid === true) {
    state = "paid"; // paid:"yes" is THE authoritative evidence (amountPaid informational)
  } else if (paid === false) {
    // Unpaid: an amount due (price/priceSold > 0) is a pending payment; a zero
    // price is a plain scheduled appointment with nothing to collect.
    const due = priceSold ?? price ?? 0;
    state = due > 0 ? "pending_payment" : "scheduled";
  } else {
    state = "unknown";
  }
  const ts = typeof raw.paymentTimestamp === "string" && raw.paymentTimestamp.trim() !== "" ? raw.paymentTimestamp.trim() : null;
  return { state, paid, price, priceSold, amountPaid, paymentTimestamp: ts };
}

export interface DerivedBookingPaymentFields {
  payment_state: BookingPaymentState;
  /** ET business date (YYYY-MM-DD) the deposit was received — persisted for the win bucket. */
  booking_win_business_date: string | null;
  payment_business_date_source: WinDateSource;
  /** First time THIS system observed the paid evidence (write-once). */
  first_seen_paid_at: string | null;
}

/**
 * Persisted payment fields for ONE appointment row, derived from its raw.
 * Write-once semantics for the win evidence: an already-persisted win date /
 * first-seen stamp is KEPT (an appointment never counts twice, never moves);
 * only a payment state upgrade and a missing stamp are filled.
 *
 * `existing` = the currently stored row (may be undefined). `createdBusinessDate`
 * = the row's created_business_date (the first-seen fallback proxy for the
 * payment date — Acuity appointment payloads carry no payment timestamp today,
 * so the first-seen stamp is precision-marked "first-seen").
 */
export function deriveBookingPaymentFields(input: {
  /** jsonb as object OR JSON string (pg driver variance) — parsed defensively. */
  raw: unknown;
  existing?: {
    booking_win_business_date?: string | null;
    payment_business_date_source?: string | null;
    first_seen_paid_at?: string | null;
  } | null;
  createdBusinessDate?: string | null;
  nowIso: string;
}): DerivedBookingPaymentFields {
  const d = derivePaymentState(input.raw);
  const existing = input.existing ?? null;
  const wasPaid = existing?.first_seen_paid_at != null || existing?.booking_win_business_date != null;
  const firstSeen = existing?.first_seen_paid_at ?? (d.state === "paid" ? input.nowIso : null);
  if (d.state !== "paid") {
    // Not paid: keep any persisted win evidence (never silently un-win a
    // booked-and-paid appointment if the provider payload flips), else nulls.
    return {
      payment_state: d.state,
      booking_win_business_date: existing?.booking_win_business_date ?? null,
      payment_business_date_source: existing?.payment_business_date_source ?? null,
      first_seen_paid_at: firstSeen,
    };
  }
  let winDate: string | null;
  let source: WinDateSource;
  if (d.paymentTimestamp) {
    // Acuity payment timestamp present → its ET calendar date is the win date.
    const ms = Date.parse(d.paymentTimestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    winDate = Number.isFinite(ms) ? etDateStrFromMs(ms) : null;
    source = winDate ? "acuity-payment" : null;
  } else {
    winDate = null;
    source = null;
  }
  if (!winDate) {
    // First-seen precision: keep the persisted win date when one exists;
    // otherwise proxy the payment date with the creation ET date (marked).
    if (wasPaid && existing?.booking_win_business_date) {
      winDate = existing.booking_win_business_date;
      source = (existing.payment_business_date_source as WinDateSource) ?? "first-seen";
    } else if (input.createdBusinessDate) {
      winDate = input.createdBusinessDate;
      source = "first-seen";
    }
  }
  return {
    payment_state: "paid",
    booking_win_business_date: winDate,
    payment_business_date_source: source,
    first_seen_paid_at: firstSeen,
  };
}

/** Instant (ms) → America/New_York calendar date (YYYY-MM-DD). Local to this module to stay dependency-free. */
function etDateStrFromMs(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}
