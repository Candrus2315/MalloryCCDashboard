/**
 * Guards for the Availability-page presentation rules (availability-spec.md +
 * merged-build playbook Phase 1): the capacity-status ladder boundaries, the
 * rule-based dates-to-push ranking (Full/closed excluded, ties chronological),
 * the spec's exact copy shapes, and the honest connection states. Pure
 * compositions only — lives outside src/server so `bun test src/server`
 * counts stay stable.
 */
import { describe, expect, test } from "bun:test";
import {
  availabilityCopyText,
  availabilityKpis,
  bestDatesToPushLine,
  capacityStatus,
  connectionView,
  datesToPush,
  dayPrefix,
  lastSyncLabel,
  pushDayLabel,
  slackAvailabilitySummary,
  weekdayLong,
} from "~/components/availability-views";
import type { AvailabilityDay } from "~/server/page-data";

const day = (date: string, over: Partial<AvailabilityDay> = {}): AvailabilityDay => ({
  date,
  totalCapacity: 24,
  booked: 12,
  openSlotTimes: [],
  utilization: 0.5,
  blockedCount: 0,
  ...over,
});

describe("capacityStatus — spec ladder boundaries (utilization is the payload's 0..1 fraction)", () => {
  test("100% → Full", () => {
    expect(capacityStatus(1).label).toBe("Full");
    expect(capacityStatus(1).status).toBe("full");
  });
  test("85% → Nearly full (at the boundary is in)", () => {
    expect(capacityStatus(0.85).label).toBe("Nearly full");
    expect(capacityStatus(0.85).status).toBe("nearly-full");
  });
  test("84.9% → Healthy", () => {
    expect(capacityStatus(0.849).label).toBe("Healthy");
  });
  test("60% → Healthy (at the boundary is in)", () => {
    expect(capacityStatus(0.6).label).toBe("Healthy");
  });
  test("59.9% → Needs bookings", () => {
    expect(capacityStatus(0.599).label).toBe("Needs bookings");
    expect(capacityStatus(0.599).status).toBe("needs-bookings");
  });
  test("null → — (never a fabricated state)", () => {
    expect(capacityStatus(null).label).toBe("—");
    expect(capacityStatus(null).status).toBe("no-data");
  });
  test("thresholds are configurable", () => {
    const t = { full: 1, nearlyFull: 0.9, healthy: 0.75 };
    expect(capacityStatus(0.7, t).label).toBe("Needs bookings");
    expect(capacityStatus(0.8, t).label).toBe("Healthy");
    expect(capacityStatus(0.9, t).label).toBe("Nearly full");
    expect(capacityStatus(1, t).label).toBe("Full");
  });
});

describe("availabilityKpis — presentation sums over the 7-day payload", () => {
  const days = [
    day("2026-09-26", { openSlotTimes: ["10:00 AM", "11:30 AM"], booked: 22, utilization: 22 / 24 }),
    day("2026-09-27", { openSlotTimes: ["9:00 AM"], booked: 24, utilization: 1 }),
    day("2026-09-28", { totalCapacity: 0, booked: 0, openSlotTimes: [], utilization: null }), // closed
  ];
  test("openToday/openTomorrow read days[0]/days[1]", () => {
    const k = availabilityKpis(days);
    expect(k.openToday).toBe(2);
    expect(k.openTomorrow).toBe(1);
  });
  test("7-day totals sum every day; utilization aggregates booked ÷ capacity", () => {
    const k = availabilityKpis(days);
    expect(k.openNext7).toBe(3);
    expect(k.totalCapacity).toBe(48);
    expect(k.bookedSlots).toBe(46);
    expect(k.utilization).toBeCloseTo(46 / 48, 10);
  });
  test("zero configured capacity → utilization null, never a fake 0%", () => {
    const k = availabilityKpis([day("2026-09-26", { totalCapacity: 0, booked: 0, utilization: null })]);
    expect(k.utilization).toBeNull();
  });
});

describe("datesToPush — rule-based ranking from actual numbers", () => {
  const days = [
    day("2026-09-26", { openSlotTimes: ["10:00 AM"], booked: 23, utilization: 23 / 24 }), // 1 open
    day("2026-09-27", { openSlotTimes: ["9:00 AM", "10:00 AM", "11:00 AM", "1:00 PM"], booked: 20, utilization: 20 / 24 }), // 4 open
    day("2026-09-28", { totalCapacity: 0, booked: 0, openSlotTimes: [], utilization: null }), // closed — excluded
    day("2026-09-29", { openSlotTimes: [], booked: 24, utilization: 1 }), // Full — excluded
    day("2026-09-30", { openSlotTimes: ["9:00 AM", "10:00 AM", "11:00 AM"], booked: 21, utilization: 21 / 24 }), // 3 open
    day("2026-10-01", { openSlotTimes: ["9:00 AM", "10:00 AM", "11:00 AM"], booked: 21, utilization: 21 / 24 }), // tie with Sep 30
  ];
  test("most open slots first; Full and closed days excluded", () => {
    const push = datesToPush(days);
    expect(push.map((p) => p.date)).toEqual(["2026-09-27", "2026-09-30", "2026-10-01"]);
  });
  test("ties break by date ascending", () => {
    const push = datesToPush(days);
    expect(push[1].date < push[2].date).toBe(true);
  });
  test("limit caps the list; items carry the actual open count", () => {
    const push = datesToPush(days, 2);
    expect(push).toHaveLength(2);
    expect(push[0].open).toBe(4);
    expect(push[0].label).toBe("Sun Sep 27");
  });
  test("every day full/closed → empty (the UI says so honestly)", () => {
    expect(datesToPush([day("2026-09-26", { openSlotTimes: [], booked: 24, utilization: 1 })])).toEqual([]);
  });
});

describe("copy texts — the spec's exact shapes", () => {
  const saturday = day("2026-09-26", {
    openSlotTimes: ["10:00 AM", "11:30 AM", "1:00 PM", "3:00 PM", "5:30 PM"],
    booked: 19,
    utilization: 19 / 24,
  });
  test("COPY AVAILABILITY: 'Saturday Availability — 5 appointments remaining: …' with every slot", () => {
    expect(weekdayLong("2026-09-26")).toBe("Saturday");
    expect(availabilityCopyText(saturday)).toBe(
      "Saturday Availability — 5 appointments remaining: 10:00 AM / 11:30 AM / 1:00 PM / 3:00 PM / 5:30 PM",
    );
  });
  test("fully booked vs studio closed are different honest sentences", () => {
    expect(availabilityCopyText(day("2026-09-26", { openSlotTimes: [], booked: 24, utilization: 1 }))).toBe(
      "Saturday Availability — fully booked (no appointments remaining)",
    );
    expect(availabilityCopyText(day("2026-09-27", { totalCapacity: 0, booked: 0, utilization: null }))).toBe(
      "Sunday Availability — studio closed (no bookable slots configured)",
    );
  });
  test("Slack summary: per-day lines + 'Best dates to push' from actual open capacity", () => {
    const days = [
      day("2026-09-26", { openSlotTimes: ["10:00 AM"], booked: 23, utilization: 23 / 24 }),
      day("2026-09-27", { openSlotTimes: ["9:00 AM", "10:00 AM", "11:00 AM", "1:00 PM"], booked: 20, utilization: 20 / 24 }),
      day("2026-09-28", { totalCapacity: 0, booked: 0, utilization: null }),
    ];
    const text = slackAvailabilitySummary(days, datesToPush(days));
    expect(text).toContain("Best dates to push");
    expect(text).toContain("Sun Sep 27 — 4 openings");
    expect(text).toContain("Sat Sep 26 — 1 opening");
    expect(text).toContain("• Sat, Sep 26: 1 open of 24 (95.8% full)");
    expect(text).toContain("• Mon, Sep 28: 0 open of 0 (— full)");
  });
  test("empty push list says none — never an invented suggestion", () => {
    expect(bestDatesToPushLine([])).toBe("Best dates to push: none — every day is fully booked or closed.");
  });
  test("pushDayLabel drops the comma: 'Sun Sep 27'", () => {
    expect(pushDayLabel("2026-09-27")).toBe("Sun Sep 27");
  });
});

describe("dayPrefix — Today/Tomorrow/weekday from the payload's ET today", () => {
  test("today, tomorrow, then short weekday", () => {
    expect(dayPrefix("2026-09-26", "2026-09-26")).toBe("Today");
    expect(dayPrefix("2026-09-27", "2026-09-26")).toBe("Tomorrow");
    expect(dayPrefix("2026-09-28", "2026-09-26")).toBe("Mon");
  });
});

describe("connection freshness — honest states only", () => {
  const now = Date.parse("2026-09-26T10:00:00.000Z");
  test("disconnected → 'Acuity connection required.' + unavailable (page suppresses numbers)", () => {
    const v = connectionView({ connected: false, mode: "disconnected", lastSyncAt: null, stale: false }, now);
    expect(v.label).toBe("Acuity connection required.");
    expect(v.unavailable).toBe(true);
    expect(v.lastSync).toBeNull();
  });
  test("demo → labeled Demo data, numbers usable", () => {
    const v = connectionView({ connected: true, mode: "demo", lastSyncAt: null, stale: false }, now);
    expect(v.label).toBe("Demo data");
    expect(v.unavailable).toBe(false);
  });
  test("live → Connected · Last synced Xm ago", () => {
    const v = connectionView(
      { connected: true, mode: "live", lastSyncAt: new Date(now - 12 * 60_000).toISOString(), stale: false },
      now,
    );
    expect(v.label).toBe("Connected");
    expect(v.lastSync).toBe("Last synced 12m ago");
    expect(v.unavailable).toBe(false);
  });
  test("live but stale → attention tone (exact sentence ships in the warnings banner)", () => {
    const v = connectionView(
      { connected: true, mode: "live", lastSyncAt: new Date(now - 45 * 60_000).toISOString(), stale: true },
      now,
    );
    expect(v.tone).toBe("attention");
    expect(v.label).toBe("Connected");
  });
  test("lastSyncLabel: just-now, hours, days, and unparseable → null", () => {
    expect(lastSyncLabel(new Date(now - 20_000).toISOString(), now)).toBe("Last synced just now");
    expect(lastSyncLabel(new Date(now - 90 * 60_000).toISOString(), now)).toBe("Last synced 1h 30m ago");
    expect(lastSyncLabel(new Date(now - 26 * 3600_000).toISOString(), now)).toBe("Last synced 1d ago");
    expect(lastSyncLabel("not-a-date", now)).toBeNull();
    expect(lastSyncLabel(null, now)).toBeNull();
    expect(lastSyncLabel(new Date(now - 60_000).toISOString(), null)).toBeNull(); // pre-mount
  });
});
