/**
 * UNATTRIBUTED QUEUE DECLUTTER (owner request 2026-10-21: "can i get a clear
 * all button for the Unattributed Bookings in settings or collapse all the
 * olds so all i see is the new one that come in? Most of those are way before
 * i started to work here.").
 *
 * Contract under test:
 *  1. The "Clear old entries" action persists the marker
 *     app_settings → unattributedQueue.dismissedBefore (ISO instant); the
 *     banner's Undo clears it back to null. Both directions are AUDITED — one
 *     manual_override row each, recording the marker value set/cleared.
 *  2. DISPLAY-LAYER ONLY: after the action, appointments, booking_attributions
 *     and the queue the loader composes (buildUnattributedQueue) are
 *     BYTE-IDENTICAL — the split is applied at render time by
 *     splitRowsByMarker (settings-views), the payload always stays full, and
 *     queueReasonBreakdown keeps counting ALL rows (truthful backlog).
 *  3. Fail-honest normalization: a garbage/absent stored marker reads as NO
     marker (normalizeUnattributedQueueSettings) — a corrupted key can never
 *     hide the whole queue.
 *  4. Route wiring pins: the settings route consumes the marker + the audited
 *     action and never bypasses the split helper.
 *
 * Store-backed tests use MemoryStore directly — NEVER getStore(), which would
 * touch the live Postgres from tests (pg-backed semantics for the marker are
 * covered by the shared app_settings round-trip in settings.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MemoryStore } from "../store/memory";
import { normalizeUnattributedQueueSettings, normalizeAppSettings } from "../store/types";
import { setUnattributedQueueDismissalCore } from "../queries";
import { buildUnattributedQueue } from "../metrics/compute";
import { queueReasonBreakdown, splitRowsByMarker } from "../../components/settings-views";
import type { AppointmentRow } from "../metrics/compute";

const paidRaw = (price: string) => ({
  paid: "yes",
  price,
  priceSold: price,
  amountPaid: "0.00",
  certificate: null,
  canceled: false,
});

let seq = 0;
/** A paid (booking-win) appointment created at a known instant. */
function paidAppt(createdAt: string, overrides: Partial<AppointmentRow> = {}): AppointmentRow {
  seq += 1;
  return {
    id: `appt-decl-${seq}`,
    contact_id: null,
    calendar_id: "cal-mallory",
    appointment_type: "Family Mini Session",
    appointment_datetime: createdAt,
    created_at: createdAt,
    raw: paidRaw("300.00") as unknown as Record<string, unknown>,
    status: "scheduled",
    cancelled: false,
    ...overrides,
  } as AppointmentRow;
}

describe("unattributed queue declutter — marker normalization (fail-honest)", () => {
  test("absent/garbage/non-ISO values read as NO marker; only a parsable ISO instant survives", () => {
    expect(normalizeUnattributedQueueSettings(undefined)).toEqual({ dismissedBefore: null });
    expect(normalizeUnattributedQueueSettings(null)).toEqual({ dismissedBefore: null });
    expect(normalizeUnattributedQueueSettings({})).toEqual({ dismissedBefore: null });
    expect(normalizeUnattributedQueueSettings({ dismissedBefore: "not-a-date" })).toEqual({ dismissedBefore: null });
    expect(normalizeUnattributedQueueSettings({ dismissedBefore: 42 })).toEqual({ dismissedBefore: null });
    expect(normalizeUnattributedQueueSettings({ dismissedBefore: "2026-10-21T16:00:00.000Z" })).toEqual({
      dismissedBefore: "2026-10-21T16:00:00.000Z",
    });
  });

  test("normalizeAppSettings carries the field on a legacy stored payload (pre-feature row)", () => {
    const merged = normalizeAppSettings({ meaningful_call_threshold_seconds: 120 });
    expect(merged.unattributedQueue).toEqual({ dismissedBefore: null });
  });
});

describe("unattributed queue declutter — the audited action (MemoryStore)", () => {
  test("Clear old entries persists the marker and writes the audit row (previous (none) → new instant)", async () => {
    const store = new MemoryStore();
    const res = await setUnattributedQueueDismissalCore(store, { dismissed: true });
    expect(typeof res.dismissedBefore).toBe("string");
    expect(Number.isFinite(Date.parse(res.dismissedBefore as string))).toBe(true);
    const settings = await store.getSettings();
    expect(settings.unattributedQueue?.dismissedBefore).toBe(res.dismissedBefore);
    const overrides = await store.getManualOverrides(40);
    const audit = overrides.find((o) => o.entity_type === "app_settings" && o.entity_id === "unattributed_queue");
    expect(audit).toBeDefined();
    expect(audit?.field).toBe("dismissed_before");
    expect(audit?.previous_value).toBe("(none)");
    expect(audit?.new_value).toBe(res.dismissedBefore);
    expect(audit?.changed_by).toBe("christopher");
  });

  test("Undo resets the marker to null and audits the cleared value with the previous marker recorded", async () => {
    const store = new MemoryStore();
    const set1 = await setUnattributedQueueDismissalCore(store, { dismissed: true });
    const marker = set1.dismissedBefore as string;
    const res = await setUnattributedQueueDismissalCore(store, { dismissed: false });
    expect(res.dismissedBefore).toBeNull();
    const settings = await store.getSettings();
    expect(settings.unattributedQueue?.dismissedBefore).toBeNull();
    const overrides = await store.getManualOverrides(40);
    const audit = overrides.find((o) => o.entity_type === "app_settings" && o.field === "dismissed_before" && o.new_value === "(cleared)");
    expect(audit).toBeDefined();
    expect(audit?.previous_value).toBe(marker);
  });

  test("re-clearing overwrites the marker with a fresh NOW (idempotent operation, every write audited)", async () => {
    const store = new MemoryStore();
    const first = await setUnattributedQueueDismissalCore(store, { dismissed: true });
    // toISOString is ms-precision; guarantee the two instants differ.
    await new Promise((r) => setTimeout(r, 3));
    const second = await setUnattributedQueueDismissalCore(store, { dismissed: true });
    expect(Number.isFinite(Date.parse(second.dismissedBefore as string))).toBe(true);
    expect(second.dismissedBefore).not.toBe(first.dismissedBefore);
    const overrides = await store.getManualOverrides(40);
    const audits = overrides.filter((o) => o.entity_type === "app_settings" && o.entity_id === "unattributed_queue");
    expect(audits).toHaveLength(2);
    // The second audit's previous_value records the FIRST marker (honest chain).
    const secondAudit = audits.find((a) => a.new_value === second.dismissedBefore);
    expect(secondAudit).toBeDefined();
    expect(secondAudit?.previous_value).toBe(first.dismissedBefore);
  });
});

describe("presentation invariant — the action never touches attribution data (display-layer only)", () => {
  test("appointments, attributions and the composed queue stay BYTE-IDENTICAL across a clear + undo", async () => {
    const store = new MemoryStore();
    // Two unattributed paid bookings (old + recent) and one attributed one that
    // never enters the queue — the exact mix the live page sees. created_at is
    // RELATIVE to the wall clock because the marker IS the clear instant: every
    // row seeded before the action predates it (that is the product semantics —
    // "clear old entries" hides what exists now; only later arrivals show).
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const windowStart = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await store.upsertAppointments([
      { ...paidAppt(daysAgo(30), { acuity_appointment_id: "decl-1" }), client_name: "Old Booking" },
      { ...paidAppt(daysAgo(1), { acuity_appointment_id: "decl-2" }), client_name: "Recent Booking" },
      { ...paidAppt(daysAgo(2), { acuity_appointment_id: "decl-3" }), client_name: "Attributed Booking" },
    ] as (AppointmentRow & { acuity_appointment_id: string })[]);
    const stored = await store.getAppointmentsWithClientsSince(windowStart);
    const attributedRow = stored.find((a) => a.acuity_appointment_id === "decl-3");
    expect(attributedRow).toBeDefined();
    await store.setManualAttribution({
      id: "",
      appointment_id: attributedRow!.id,
      call_id: null,
      rep_id: "rep-1",
      method: "manual",
      confidence: 1,
      manual_override: true,
    });

    const snapshot = async () => {
      const appts = await store.getAppointmentsWithClientsSince(windowStart);
      const attributions = await store.getAttributions();
      const settings = await store.getSettings();
      const queue = buildUnattributedQueue({
        appointments: appts,
        attributions,
        calls: [],
        contacts: [],
        thresholdSeconds: settings.meaningful_call_threshold_seconds,
        matches: [],
      });
      return { appts, attributions, queue, breakdown: queueReasonBreakdown(queue) };
    };

    const before = await snapshot();
    const overridesBefore = await store.getManualOverrides(40);

    // Clear → the only changed surfaces are app_settings + ONE audit row.
    await setUnattributedQueueDismissalCore(store, { dismissed: true });
    const afterClear = await snapshot();
    expect(afterClear.appts).toEqual(before.appts);
    expect(afterClear.attributions).toEqual(before.attributions);
    expect(afterClear.queue).toEqual(before.queue);
    expect(afterClear.breakdown).toEqual(before.breakdown);
    const overridesAfterClear = await store.getManualOverrides(40);
    expect(overridesAfterClear.filter((o) => o.entity_type !== "app_settings")).toEqual(
      overridesBefore.filter((o) => o.entity_type !== "app_settings"),
    );

    // The DISPLAY split with the marker live: every row seeded BEFORE the
    // clear predates the marker, so the default view collapses all of them
    // behind the banner (queue is newest-created-first) — while the payload
    // above stayed FULL and the top counts kept counting ALL rows.
    const marker = (await store.getSettings()).unattributedQueue?.dismissedBefore ?? null;
    const split = splitRowsByMarker(afterClear.queue, marker);
    expect(split.visible).toEqual([]);
    expect(split.hidden.map((r) => r.client_name)).toEqual(["Recent Booking", "Old Booking"]);
    expect(split.visible.length + split.hiddenCount).toBe(afterClear.queue.length);
    expect(queueReasonBreakdown(split.visible.concat(split.hidden))).toEqual(afterClear.breakdown);

    // A NEW ARRIVAL (created after the clear) always shows — the owner's ask.
    await new Promise((r) => setTimeout(r, 3)); // marker is ms-precision; guarantee the arrival postdates it
    await store.upsertAppointments([
      { ...paidAppt(new Date().toISOString(), { acuity_appointment_id: "decl-4" }), client_name: "Fresh Arrival" },
    ] as (AppointmentRow & { acuity_appointment_id: string })[]);
    const afterFresh = await snapshot();
    expect(afterFresh.appts).toHaveLength(4);
    expect(afterFresh.queue.map((r) => r.client_name)).toEqual(["Fresh Arrival", "Recent Booking", "Old Booking"]);
    const marker2 = (await store.getSettings()).unattributedQueue?.dismissedBefore ?? null;
    const split2 = splitRowsByMarker(afterFresh.queue, marker2);
    expect(split2.visible.map((r) => r.client_name)).toEqual(["Fresh Arrival"]);
    expect(split2.hidden.map((r) => r.client_name)).toEqual(["Recent Booking", "Old Booking"]);
    expect(queueReasonBreakdown(split2.visible.concat(split2.hidden))).toEqual(afterFresh.breakdown);

    // Undo → marker gone (display back to the full queue), still nothing else moved.
    await setUnattributedQueueDismissalCore(store, { dismissed: false });
    const afterUndo = await snapshot();
    expect(afterUndo.appts).toEqual(afterFresh.appts);
    expect(afterUndo.attributions).toEqual(afterFresh.attributions);
    expect(afterUndo.queue).toEqual(afterFresh.queue);
    const markerAfterUndo = (await store.getSettings()).unattributedQueue?.dismissedBefore ?? null;
    const split3 = splitRowsByMarker(afterUndo.queue, markerAfterUndo);
    expect(split3.collapsed).toBe(false);
    expect(split3.visible.map((r) => r.client_name)).toEqual(["Fresh Arrival", "Recent Booking", "Old Booking"]);
  });

  test("a booking created AFTER the marker always shows, even with a marker set", async () => {
    const store = new MemoryStore();
    await store.upsertAppointments([
      { ...paidAppt(new Date(Date.now() - 30 * 86_400_000).toISOString(), { acuity_appointment_id: "decl-old" }), client_name: "Old" },
    ] as (AppointmentRow & { acuity_appointment_id: string })[]);
    await setUnattributedQueueDismissalCore(store, { dismissed: true });
    // A NEW arrival lands after the clear (guard the ms-precision marker).
    await new Promise((r) => setTimeout(r, 3));
    await store.upsertAppointments([
      { ...paidAppt(new Date().toISOString(), { acuity_appointment_id: "decl-new" }), client_name: "Fresh" },
    ] as (AppointmentRow & { acuity_appointment_id: string })[]);
    const appts = await store.getAppointmentsWithClientsSince(new Date(Date.now() - 60 * 86_400_000).toISOString());
    const settings = await store.getSettings();
    const queue = buildUnattributedQueue({
      appointments: appts,
      attributions: await store.getAttributions(),
      calls: [],
      contacts: [],
      thresholdSeconds: settings.meaningful_call_threshold_seconds,
      matches: [],
    });
    const split = splitRowsByMarker(queue, settings.unattributedQueue?.dismissedBefore ?? null);
    expect(split.visible.map((r) => r.client_name)).toEqual(["Fresh"]);
    expect(split.hiddenCount).toBe(1);
  });
});

describe("route wiring — the settings route consumes marker + audited action through the split helper", () => {
  const routeSrc = readFileSync(new URL("../../routes/settings.tsx", import.meta.url), "utf8");
  const queriesSrc = readFileSync(new URL("../queries.ts", import.meta.url), "utf8");

  test("loader exposes the marker; the action is the audited server fn", () => {
    expect(queriesSrc).toContain("unattributedQueueDismissedBefore:");
    expect(queriesSrc).toContain("setUnattributedQueueDismissalCore");
    expect(queriesSrc).toContain('entity_type: "app_settings"');
    expect(queriesSrc).toContain('field: "dismissed_before"');
  });

  test("the page splits display rows via splitRowsByMarker and renders the banner + client-local toggle", () => {
    expect(routeSrc).toContain("splitRowsByMarker");
    expect(routeSrc).toContain("unattributedHiddenBannerLabel");
    expect(routeSrc).toContain('data-testid="queue-clear-old"');
    expect(routeSrc).toContain('data-testid="queue-cleared-banner"');
    expect(routeSrc).toContain('data-testid="queue-show-all"');
    expect(routeSrc).toContain('data-testid="queue-undo-clear"');
    expect(routeSrc).toContain("setUnattributedQueueDismissal({ data: { dismissed: true } })");
    expect(routeSrc).toContain("setUnattributedQueueDismissal({ data: { dismissed: false } })");
  });

  test("the top counts still read the FULL queue and the row lists render only through the split", () => {
    // Truthful backlog: the breakdown is computed over every row.
    expect(routeSrc).toContain("queueReasonBreakdown(data.unattributed)");
    // The pre-feature direct slice is gone — both lists (desktop + mobile) go
    // through queueRows (the marker-split, show-all-aware list).
    expect(routeSrc).not.toContain("data.unattributed.slice(0, 12)");
    expect(routeSrc.match(/queueRows\.map\(/g)?.length).toBe(2);
  });
});
