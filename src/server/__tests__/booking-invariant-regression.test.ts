/**
 * BOOKING-INVARIANT REGRESSION (2026-09-28 night hotfix).
 *
 * Post-PR-#9 the first scheduler tick aborted the acuity sync with
 *   "Booking invariant violated: engine verdicts attributed(139) +
 *    unattributed(276) must equal total(411)"
 * 139+276=415 ≠ 411: the engine verdict census covered ALL in-scope,
 * non-cancelled appointments (paid AND pending), while PR #9 redefined the
 * coverage split's `total` to PAID (Booking Win) bookings only. The four
 * pending rows in the live window — Jenna Van Deventer, Marybeth O'Keefe,
 * Stefanie Korobkin (all created 9/28) and Brian Pacheco (9/2) — made the
 * census exceed cov.total by exactly the pending count, and the sync refused
 * to persist (attribution + availability skipped).
 *
 * These tests pin tonight's EXACT data shape at small scale:
 *   - paid attributed bookings (window-interaction + contact evidence);
 *   - MANUAL-OVERRIDE rows with no window interaction (the owner's Jordyn /
 *     Angela rulings) — carried verbatim by the recompute, counted once;
 *   - a paid AMBIGUOUS row (identity conflict — its own bucket);
 *   - a paid UNATTRIBUTED online booking (the Mark Nadeau shape — counts in
 *     team totals, never rep metrics);
 *   - PENDING unpaid bookings (the Jenna / Marybeth shape — engine verdicts
 *     exist, coverage excludes them);
 * and asserts the invariant PASSES (no throw) while still catching a verdict
 * that actually vanishes.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { attributionTick, resetAttributionThrottle } from "../sync/attribution-tick";
import {
  assertBookingInvariant,
  attributionStateOf,
  bookingAttributionSplit,
  isBookingWin,
} from "../metrics/compute";
import { appointmentInScope } from "../metrics/availability";
import type { AppSettings, AttributionRow } from "../store/types";

const NOW = new Date("2026-09-28T15:00:00Z"); // Mon ET mid-day, the incident night
const now = () => NOW;
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const H = 3_600_000;

const PAID = { paid: "yes", price: "300.00", amountPaid: "300.00" };
const PENDING = { paid: "no", price: "300.00", amountPaid: "0.00" };

/** Roster rep (the "Allison" analogue). */
async function seedRep(store: MemoryStore): Promise<string> {
  await store.upsertUsers([
    { id: "", provider: "highlevel", external_id: "usr_allison", name: "Allison analogue", email: "a@mallory.test", is_active: true, call_start_date: null },
  ]);
  return (await store.getAllUsers()).find((u) => u.external_id === "usr_allison")!.id;
}

async function seedContact(
  store: MemoryStore,
  ext: string,
  phone: string,
  email: string,
  repId: string | null,
): Promise<string> {
  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: ext, name: ext, phone, email, assigned_rep_id: repId },
  ]);
  return (await store.getContacts()).find((c) => c.external_id === ext)!.id;
}

/** One qualifying call 27h before NOW (creation ET date − 1: inside the window). */
async function seedCall(store: MemoryStore, ext: string, repId: string, contactId: string): Promise<void> {
  await store.upsertCalls([
    {
      provider: "highlevel",
      external_call_id: ext,
      rep_id: repId,
      provider_rep_external_id: "usr_allison",
      contact_id: contactId,
      started_at: iso(27 * H),
      duration_seconds: 300,
      over_two_minutes: true,
      direction: "outbound",
      call_status: "completed",
    },
  ]);
}

/**
 * One in-scope booking created 3h ago. `raw` decides paid vs pending
 * (derivePaymentState — Acuity paid:"yes"/"no" evidence).
 */
async function seedBooking(
  store: MemoryStore,
  opts: {
    acuityId: string;
    contactId: string | null; // null → stored contact id that resolves to nothing
    clientEmail: string;
    clientPhone: string;
    raw: Record<string, unknown>;
  },
): Promise<string> {
  await store.upsertAppointments([
    {
      id: "",
      contact_id: opts.contactId,
      calendar_id: "1335091",
      calendar_name: "MALLORY PORTRAITS",
      appointment_type: "Consult",
      appointment_datetime: iso(1 * H),
      created_at: iso(3 * H),
      duration_minutes: 60,
      status: "scheduled",
      cancelled: false,
      acuity_appointment_id: opts.acuityId,
      client_name: opts.acuityId,
      client_phone: opts.clientPhone,
      client_email: opts.clientEmail,
      raw: opts.raw,
    },
  ]);
  return (await store.getAppointmentsWithClientsSince("2000-01-01")).find((a) => a.acuity_appointment_id === opts.acuityId)!.id;
}

/** The owner-ruling shape: a manual row with NO window interaction at all. */
const manualRow = (appointmentId: string, repId: string): AttributionRow => ({
  id: `attr:${appointmentId}`,
  appointment_id: appointmentId,
  call_id: null,
  rep_id: repId,
  method: "manual",
  confidence: 1,
  manual_override: true,
  note: "owner-assigned manual override — no window interaction existed",
  reason_code: null,
});

async function seedTonightShape(store: MemoryStore): Promise<{ rep: string; settings: AppSettings }> {
  const rep = await seedRep(store);

  // Wittner analogue: contact + qualifying window call → engine-attributed, paid.
  const wittnerContact = await seedContact(store, "cnt_w", "+19175550001", "wittner@example.test", rep);
  await seedCall(store, "call_w", rep, wittnerContact);
  await seedBooking(store, { acuityId: "acuity_wittner", contactId: wittnerContact, clientEmail: "wittner@example.test", clientPhone: "19175550001", raw: PAID });

  // Jordyn + Angela analogues: paid, NO window interaction — owner manual overrides.
  const jordynContact = await seedContact(store, "cnt_j", "+19175550002", "jordyn@example.test", rep);
  await seedBooking(store, { acuityId: "acuity_jordyn", contactId: jordynContact, clientEmail: "jordyn@example.test", clientPhone: "19175550002", raw: PAID });
  const angelaContact = await seedContact(store, "cnt_a", "+19175550003", "angela@example.test", rep);
  await seedBooking(store, { acuityId: "acuity_angela", contactId: angelaContact, clientEmail: "angela@example.test", clientPhone: "19175550003", raw: PAID });

  // Ambiguous analogue: stored contact id resolves to nothing, client email
  // matches ANOTHER contact → engine verdict "ambiguous" (its own bucket), paid.
  await seedBooking(store, { acuityId: "acuity_amb", contactId: "ghost-c", clientEmail: "wittner@example.test", clientPhone: "19175550004", raw: PAID });

  // Mark analogue: paid online self-book — no stored contact resolution at all,
  // no calls → engine unattributed (counts in team totals, never rep metrics).
  await seedBooking(store, { acuityId: "acuity_mark", contactId: null, clientEmail: "mark@example.test", clientPhone: "19175550005", raw: PAID });

  // Jenna + Marybeth analogues: engine-ATTRIBUTED (window call) but UNPAID —
  // pending invoices; the exact rows that broke the old census comparison.
  const jennaContact = await seedContact(store, "cnt_jen", "+19175550006", "jenna@example.test", rep);
  await seedCall(store, "call_jen", rep, jennaContact);
  await seedBooking(store, { acuityId: "acuity_jenna", contactId: jennaContact, clientEmail: "jenna@example.test", clientPhone: "19175550006", raw: PENDING });
  const marybethContact = await seedContact(store, "cnt_mb", "+19175550007", "marybeth@example.test", rep);
  await seedCall(store, "call_mb", rep, marybethContact);
  await seedBooking(store, { acuityId: "acuity_marybeth", contactId: marybethContact, clientEmail: "marybeth@example.test", clientPhone: "19175550007", raw: PENDING });

  // Manual overrides pre-seed (Christopher's rulings land BEFORE the recompute
  // — the tick must carry them verbatim and still row every appointment once).
  const byAcuity = new Map((await store.getAppointmentsWithClientsSince("2000-01-01")).map((a) => [a.acuity_appointment_id, a.id]));
  await store.upsertAttributions([
    manualRow(byAcuity.get("acuity_jordyn")!, rep),
    manualRow(byAcuity.get("acuity_angela")!, rep),
  ]);

  return { rep, settings: await store.getSettings() };
}

describe("booking-invariant regression (the 415-vs-411 night)", () => {
  test("tonight's exact shape: manual overrides + ambiguous + paid online + pending rows — the sync COMPLETES", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const { rep, settings } = await seedTonightShape(store);

    const res = await attributionTick({ store, settings, now, trigger: "manual" });
    // THE assertion: the old build threw the invariant here and skipped
    // attribution + availability for the night.
    expect(res.outcome).toBe("synced");
    expect(res.error).toBeUndefined();

    // Engine census = the FULL population (7), paid subset is only 5 —
    // the exact 415-vs-411 relationship (census = paid + pending).
    expect(res.appointments).toBe(7);
    expect((res.attributed ?? 0) + (res.unattributed ?? 0)).toBe(7);
    expect((res.attributed ?? 0)).toBe(3); // wittner + jenna + marybeth (engine verdicts)
    expect((res.unattributed ?? 0)).toBe(4); // jordyn + angela + ambiguous + mark
    expect(res.manuallyAssigned).toBe(2);

    // Every appointment rowed EXACTLY once; overrides survive the recompute.
    const rows = await store.getAttributions();
    const appts = (await store.getAppointmentsWithClientsSince("2000-01-01")).filter(
      (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
    );
    expect(appts).toHaveLength(7);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.appointment_id)).size).toBe(7);

    const byAcuity = new Map(appts.map((a) => [a.acuity_appointment_id, a.id]));
    const jordyn = rows.find((r) => r.appointment_id === byAcuity.get("acuity_jordyn"))!;
    expect(jordyn.manual_override).toBe(true);
    expect(jordyn.rep_id).toBe(rep);
    const angela = rows.find((r) => r.appointment_id === byAcuity.get("acuity_angela"))!;
    expect(angela.manual_override).toBe(true);
    expect(angela.rep_id).toBe(rep);

    // The paid (Booking Win) split: total 5 — attributed 3 (incl. both manual
    // overrides), ambiguous its OWN 1, unattributed 1 (the online booking).
    const split = bookingAttributionSplit(appts, rows);
    expect(split).toEqual({ total: 5, attributed: 3, ambiguous: 1, unattributed: 1, withoutVerdict: 0 });
    const ambAppt = appts.find((a) => a.acuity_appointment_id === "acuity_amb")!;
    expect(attributionStateOf(rows.find((r) => r.appointment_id === ambAppt.id)!)).toBe("ambiguous");
    // The pending rows are NOT Booking Wins and appear nowhere in the split.
    expect(appts.filter((a) => isBookingWin(a))).toHaveLength(5);

    // The sync-path invariant call with the REAL census passes — under the old
    // comparison (census vs cov.total = 5) this exact shape threw.
    expect(() =>
      assertBookingInvariant(appts, rows, {
        engineAttributed: res.attributed ?? 0,
        engineUnattributed: res.unattributed ?? 0,
      }),
    ).not.toThrow();
  });

  test("the census still catches a verdict that VANISHES (row dropped)", () => {
    const a = (id: string, paid: boolean) => ({
      id,
      contact_id: null,
      calendar_id: "1335091",
      appointment_type: "Consult",
      appointment_datetime: NOW.toISOString(),
      created_at: NOW.toISOString(),
      status: "scheduled",
      cancelled: false,
      raw: paid ? PAID : PENDING,
    }) as any;
    const appts = [a("p1", true), a("p2", true), a("pend1", false)];
    const rows = ["p1", "p2", "pend1"].map((id) => ({
      id: `attr:${id}`,
      appointment_id: id,
      call_id: null,
      rep_id: null,
      method: "none",
      confidence: 0,
      manual_override: false,
      note: "no-qualifying-call",
    }));
    // full population rowed + census = population (2 paid + 1 pending) → OK
    expect(() => assertBookingInvariant(appts, rows, { engineAttributed: 0, engineUnattributed: 3 })).not.toThrow();
    // a verdict vanishes → LOUD, never silently persisted
    expect(() => assertBookingInvariant(appts, rows.slice(1), { engineAttributed: 0, engineUnattributed: 2 })).toThrow(/invariant/i);
    // the engine DROPS an appointment (census short of the population) → LOUD
    expect(() => assertBookingInvariant(appts, rows, { engineAttributed: 0, engineUnattributed: 2 })).toThrow(/engine population/);
    // duplicate rows for one appointment → LOUD
    expect(() =>
      assertBookingInvariant(appts, [...rows, { ...rows[0], id: "attr:dup" }], { engineAttributed: 0, engineUnattributed: 3 }),
    ).toThrow(/exactly one each/);
  });
});
