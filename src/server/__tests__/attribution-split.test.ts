/**
 * THREE-WAY BOOKING ATTRIBUTION SPLIT (owner directive 2026-09-27, S5b).
 *
 * The attribution categories are MUTUALLY EXCLUSIVE everywhere they are
 * computed and displayed:
 *
 *   Total Bookings = Attributed + Ambiguous + Unattributed
 *
 * Ambiguous is its OWN state — never folded into Unattributed. These tests
 * pin: (a) the stored-row classifier's truth table; (b) the split's
 * disjointness and invariant on synthetic data; (c) the shape guard that the
 * production writer (toAttributionRows) emits rows whose stored shape
 * round-trips to the engine's verdict — the stale-writer lesson: no build may
 * be able to misread a row's state destructively; (d) the invariant on the
 * CURRENT LIVE data (Postgres-gated — skipped in demo/memory mode).
 *
 * Engine semantics are FROZEN here (the rep-ownership rule stays untouched
 * until the owner reviews the S5 decision matrix) — only the classification
 * and display of the stored verdicts is three-way.
 */
import { describe, expect, test } from "bun:test";
import {
  AMBIGUOUS_NOTE_PREFIX,
  assertBookingInvariant,
  attributionStateOf,
  bookingAttributionSplit,
  bookingCoverage,
  type AppointmentRow,
  type AttributionRow,
} from "../metrics/compute";
import { matchAppointmentsToCalls } from "../metrics/attribution";
import { toAttributionRows } from "../sync/attribution-tick";

const appt = (id: string, createdAt = "2026-09-28T14:00:00.000Z"): AppointmentRow => ({
  id,
  contact_id: null,
  calendar_id: "cal-1",
  appointment_type: "Family Portrait Session",
  appointment_datetime: "2026-10-01T14:00:00.000Z",
  created_at: createdAt,
  status: "scheduled",
  cancelled: false,
});

const row = (over: Partial<AttributionRow>): AttributionRow => ({
  id: `attr:${over.appointment_id}`,
  appointment_id: over.appointment_id ?? "a?",
  call_id: null,
  rep_id: null,
  method: "none",
  confidence: 0,
  manual_override: false,
  note: null,
  ...over,
});

describe("attributionStateOf — the ONE stored-row classifier", () => {
  test("rep on the row (manual included) is attributed — never downgraded by the note", () => {
    expect(attributionStateOf(row({ appointment_id: "a1", rep_id: "r1", method: "contact_id", note: "date_granularity_window call-dates 2026-09-27..2026-09-28 ET" }))).toBe("attributed");
    expect(attributionStateOf(row({ appointment_id: "a2", rep_id: "r2", manual_override: true, method: "manual" }))).toBe("attributed");
  });
  test("ambiguous note prefix → ambiguous (its OWN state)", () => {
    expect(
      attributionStateOf(row({ appointment_id: "a3", note: "ambiguous — email resolves a different contact than the stored contact id; date_granularity_window call-dates 2026-09-27..2026-09-28 ET" })),
    ).toBe("ambiguous");
    expect(attributionStateOf(row({ appointment_id: "a4", note: "ambiguous" }))).toBe("ambiguous");
  });
  test("no rep + no ambiguous prefix → unattributed (never guessed)", () => {
    expect(attributionStateOf(row({ appointment_id: "a5", note: "no-qualifying-call; date_granularity_window call-dates 2026-09-27..2026-09-28 ET" }))).toBe("unattributed");
    expect(attributionStateOf(row({ appointment_id: "a6", note: "no-contact-identity" }))).toBe("unattributed");
    expect(attributionStateOf(row({ appointment_id: "a7", note: null }))).toBe("unattributed");
  });
  test("the prefix constant matches the engine's reason token", () => {
    expect(AMBIGUOUS_NOTE_PREFIX).toBe("ambiguous");
  });
});

describe("bookingAttributionSplit / bookingCoverage — three mutually exclusive states", () => {
  const appts = [appt("a1"), appt("a2"), appt("a3"), appt("a4")];
  const attributions: AttributionRow[] = [
    row({ appointment_id: "a1", rep_id: "r1", call_id: "k1", method: "contact_id", confidence: 1 }),
    row({ appointment_id: "a2", note: "ambiguous — email resolves a different contact than the stored contact id; date_granularity_window call-dates 2026-09-27..2026-09-28 ET" }),
    row({ appointment_id: "a3", note: "no-qualifying-call; date_granularity_window call-dates 2026-09-27..2026-09-28 ET" }),
  ];
  // a4 intentionally has NO verdict row.

  test("split: the three states are disjoint and ambiguous is NOT inside unattributed", () => {
    const s = bookingAttributionSplit(appts, attributions);
    expect(s).toEqual({ total: 4, attributed: 1, ambiguous: 1, unattributed: 1, withoutVerdict: 1 });
  });
  test("invariant: Total = Attributed + Ambiguous + Unattributed (+ withoutVerdict surfaced separately)", () => {
    const s = bookingAttributionSplit(appts, attributions);
    expect(s.attributed + s.ambiguous + s.unattributed + s.withoutVerdict).toBe(s.total);
  });
  test("coverage folds withoutVerdict into unattributed ONLY under the sync invariant's full-coverage guarantee — with full rows the three states sum to total", () => {
    // Full verdict coverage (the state the tick always leaves the store in):
    const full = [...attributions, row({ appointment_id: "a4", note: "no-qualifying-call; date_granularity_window call-dates 2026-09-27..2026-09-28 ET" })];
    const cov = bookingCoverage(appts, full);
    expect(cov).toEqual({ total: 4, attributed: 1, ambiguous: 1, unattributed: 2 });
    expect(cov.attributed + cov.ambiguous + cov.unattributed).toBe(cov.total);
    // The ambiguous row is NOT what makes unattributed 2 — remove it and
    // unattributed stays 2 (the a4 row), ambiguous stays its own 1.
    const withoutAmbig = bookingCoverage(appts, [full[0], full[2], full[3]]);
    expect(withoutAmbig).toEqual({ total: 4, attributed: 1, ambiguous: 0, unattributed: 3 });
  });
  test("assertBookingInvariant enforces the three-way sum and exact-one-verdict", () => {
    const full = [...attributions, row({ appointment_id: "a4", note: "no-qualifying-call" })];
    expect(() => assertBookingInvariant(appts, full)).not.toThrow();
    // losing a verdict row throws (never silent)
    expect(() => assertBookingInvariant(appts, full.slice(0, 3))).toThrow(/invariant/i);
  });
  test("cancelled bookings never enter the split", () => {
    const cancelled = { ...appt("a9"), cancelled: true, status: "cancelled" } as AppointmentRow;
    const s = bookingAttributionSplit([cancelled], [row({ appointment_id: "a9", rep_id: "r1" })]);
    expect(s).toEqual({ total: 0, attributed: 0, ambiguous: 0, unattributed: 0, withoutVerdict: 0 });
  });
});

describe("STALE-WRITER SHAPE GUARD — stored rows round-trip to the engine's verdict", () => {
  // Fixture mirrors the CURRENT live shape: 2 attributed (contact_id), 1
  // ambiguous (email resolves a different contact), 1 no-qualifying-call.
  const contacts = [
    { id: "c-1", phone: "+15088891019", email: "one@example.com" },
    { id: "c-2", phone: null, email: "two@example.com" },
  ];
  const calls = [
    { id: "k1", external_call_id: "hl-1", rep_id: "rep-1", contact_id: "c-1", started_at: "2026-09-28T13:00:00.000Z", duration_seconds: 600 },
    { id: "k2", external_call_id: "hl-2", rep_id: "rep-1", contact_id: "c-2", started_at: "2026-09-28T13:30:00.000Z", duration_seconds: 600 },
  ];
  const settings = { meeting_threshold_seconds: 120, attribution_window_hours: 24, rep_mappings: [] };

  test("every engine verdict's stored row classifies back to the SAME state (ambiguous keeps the note prefix; attributed never carries one)", () => {
    const apptsIn = [
      { id: "a1", contact_id: "c-1", client_phone: null, client_email: null, appointment_datetime: "2026-09-28T14:00:00.000Z", created_at: "2026-09-28T14:00:00.000Z" },
      { id: "a2", contact_id: "c-9", client_phone: null, client_email: "One@Example.com", appointment_datetime: "2026-09-28T14:00:00.000Z", created_at: "2026-09-28T14:00:00.000Z" },
      { id: "a3", contact_id: "c-1", client_phone: null, client_email: null, appointment_datetime: "2026-09-30T14:00:00.000Z", created_at: "2026-09-30T14:00:00.000Z" },
    ];
    const matches = matchAppointmentsToCalls(apptsIn, calls, contacts, settings, {
      today: "2026-09-30",
      users: [{ id: "rep-1", is_active: true }],
    });
    const byId = new Map(matches.map((m) => [m.appointmentId, m]));
    expect(byId.get("a1")?.status).toBe("attributed");
    expect(byId.get("a2")?.status).toBe("unattributed");
    expect(byId.get("a2")?.reason).toBe("ambiguous");
    expect(byId.get("a3")?.status).toBe("unattributed"); // no qualifying call on 9/30 window

    const { rows } = toAttributionRows(matches, [], new Map([["hl-1", "k1"], ["hl-2", "k2"]]));
    expect(rows).toHaveLength(3);
    for (const m of matches) {
      const stored = rows.find((r) => r.appointment_id === m.appointmentId)!;
      const expected = m.status === "attributed" ? "attributed" : m.reason === "ambiguous" ? "ambiguous" : "unattributed";
      expect(attributionStateOf(stored)).toBe(expected);
    }
    // The ambiguous row's stored shape: rep NULL, method none, note STARTS
    // with the ambiguous prefix — no build can misread it as cleanly
    // unattributed, and no rep is silently attached.
    const amb = rows.find((r) => r.appointment_id === "a2")!;
    expect(amb.rep_id).toBeNull();
    expect(amb.method).toBe("none");
    expect((amb.note ?? "").startsWith(AMBIGUOUS_NOTE_PREFIX)).toBe(true);
    // Attributed rows NEVER carry a note that could classify as ambiguous.
    for (const r of rows.filter((r) => r.rep_id !== null)) {
      expect(attributionStateOf(r)).toBe("attributed");
    }
  });
});

// ---------- LIVE-DATA INVARIANT (Postgres-gated; skipped in demo/memory mode) ----------
import { etToday, addDays, etDayStartUtc } from "../date-logic";
import { appointmentInScope } from "../metrics/availability";
import { getStore, getDbStatus } from "../store";

const liveAvailable: boolean = await (async () => {
  try {
    await getStore(); // probes Postgres once; falls back to the memory store
    const status = getDbStatus();
    return status.mode === "postgres" && status.ok;
  } catch {
    return false;
  }
})();
const liveTest = liveAvailable ? test : test.skip;

describe("S5b invariant on the CURRENT data (live Postgres)", () => {
  liveTest("Total = Attributed + Ambiguous + Unattributed (+ withoutVerdict); ambiguous rows are never counted inside unattributed", async () => {
    const store = await getStore();
    const settings = await store.getSettings();
    const today = etToday();
    const [apptsRaw, attributions] = await Promise.all([
      store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
      store.getAttributions(),
    ]);
    // the SAME in-scope, non-cancelled set the attribution tick evaluates
    const appts = apptsRaw.filter(
      (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
    );
    const split = bookingAttributionSplit(appts, attributions);

    // the invariant itself
    expect(split.attributed + split.ambiguous + split.unattributed + split.withoutVerdict).toBe(split.total);

    // ambiguous rows are never counted inside unattributed — the ambiguous
    // count EQUALS the stored ambiguous rows, and no ambiguous appointment id
    // appears in the unattributed classification.
    const qIds = new Set(appts.map((a) => a.id));
    const storedAmbiguousIds = new Set(
      attributions
        .filter((r) => qIds.has(r.appointment_id) && r.rep_id === null && (r.note ?? "").startsWith(AMBIGUOUS_NOTE_PREFIX))
        .map((r) => r.appointment_id),
    );
    expect(split.ambiguous).toBe(storedAmbiguousIds.size);
    const unattributedIds = new Set(
      attributions
        .filter((r) => qIds.has(r.appointment_id) && attributionStateOf(r) === "unattributed")
        .map((r) => r.appointment_id),
    );
    for (const id of storedAmbiguousIds) expect(unattributedIds.has(id)).toBe(false);

    // full verdict coverage inside the recompute window (the tick leaves no
    // qualifying booking unrowed): the three states alone must sum to total.
    if (split.withoutVerdict === 0) {
      expect(split.attributed + split.ambiguous + split.unattributed).toBe(split.total);
    }
  });
});
