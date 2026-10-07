/**
 * AVAILABILITY REBUILD PR-3 §2 — COPY AVAILABILITY byte-identity tests (owner
 * spec §10). The exact clipboard bytes ARE the contract (the CC Report
 * copy-test precedent): header "AVAILABILITY TO PUSH" + per-day line
 * "Wed Oct 7 — 2 Open | 1 Hole | 80% Full". The EXISTING single-day copy
 * sentence (availabilityCopyText) is asserted here too — it must stay intact.
 */
import { describe, expect, test } from "bun:test";
import {
  AVAILABILITY_COPY_HEADER,
  availabilityCopyDayLine,
  availabilityPushCopy,
  copyDayLabel,
  type AvailabilityCopyDay,
} from "../availability-copy";
import { availabilityCopyText } from "../availability-views";

const d = (over: Partial<AvailabilityCopyDay> & { date: string }): AvailabilityCopyDay => ({
  openCount: 2,
  holes: 1,
  capacity: 10,
  booked: 7,
  utilization: 0.8,
  ...over,
});

describe("availability copy — frozen byte formats", () => {
  test("header token is exact", () => {
    expect(AVAILABILITY_COPY_HEADER).toBe("AVAILABILITY TO PUSH");
  });

  test("per-day line matches the owner's example byte-for-byte", () => {
    expect(copyDayLabel("2026-10-07")).toBe("Wed Oct 7");
    expect(availabilityCopyDayLine(d({ date: "2026-10-07" }))).toBe("Wed Oct 7 — 2 Open | 1 Hole | 80% Full");
  });

  test("pluralization: Open never pluralizes, Hole pluralizes; percents round to whole", () => {
    expect(availabilityCopyDayLine(d({ date: "2026-10-08", openCount: 5, holes: 3, utilization: 0.5 }))).toBe(
      "Thu Oct 8 — 5 Open | 3 Holes | 50% Full",
    );
    expect(availabilityCopyDayLine(d({ date: "2026-10-12", openCount: 1, holes: 1, utilization: 0.9 }))).toBe(
      "Mon Oct 12 — 1 Open | 1 Hole | 90% Full",
    );
    // 0.796 → 80 (whole-percent rounding, not truncation)
    expect(availabilityCopyDayLine(d({ date: "2026-10-13", openCount: 4, holes: 4, utilization: 0.796 }))).toBe(
      "Tue Oct 13 — 4 Open | 4 Holes | 80% Full",
    );
  });

  test("an unknown open count renders the honest 'Open —' (never a fabricated 0)", () => {
    expect(availabilityCopyDayLine(d({ date: "2026-10-14", openCount: null }))).toBe(
      "Wed Oct 14 — Open — | 1 Hole | 80% Full",
    );
  });

  test("the multi-day block: header + one line per day, \\n-joined", () => {
    const block = availabilityPushCopy([
      d({ date: "2026-10-07" }),
      d({ date: "2026-10-08", openCount: 5, holes: 3, utilization: 0.5 }),
    ]);
    expect(block).toBe("AVAILABILITY TO PUSH\nWed Oct 7 — 2 Open | 1 Hole | 80% Full\nThu Oct 8 — 5 Open | 3 Holes | 50% Full");
  });

  test("closed days (capacity 0) are dropped from the block — nothing to push", () => {
    const block = availabilityPushCopy([
      d({ date: "2026-10-07" }),
      d({ date: "2026-10-14", capacity: 0, booked: 0, openCount: 0, holes: 0, utilization: null }),
    ]);
    expect(block).toBe("AVAILABILITY TO PUSH\nWed Oct 7 — 2 Open | 1 Hole | 80% Full");
  });

  test("empty selection: the header always stands, with the honest nothing-to-push line", () => {
    expect(availabilityPushCopy([])).toBe("AVAILABILITY TO PUSH\nNothing to push — every day is fully booked or closed.");
    expect(availabilityPushCopy([d({ date: "2026-10-13", capacity: 0, openCount: 0, holes: 0, utilization: null })])).toBe(
      "AVAILABILITY TO PUSH\nNothing to push — every day is fully booked or closed.",
    );
  });

  test("the EXISTING single-day copy sentence stays byte-identical (untouched behavior)", () => {
    // availabilityCopyText reads the legacy day shape (openSlotTimes labels)
    expect(
      availabilityCopyText({
        date: "2026-10-10",
        totalCapacity: 10,
        booked: 5,
        openSlotTimes: ["10:00 AM", "11:30 AM", "1:30 PM", "2:30 PM", "3:30 PM"],
        utilization: 0.5,
        blockedCount: 0,
      } as Parameters<typeof availabilityCopyText>[0]),
    ).toBe("Saturday Availability — 5 appointments remaining: 10:00 AM / 11:30 AM / 1:30 PM / 2:30 PM / 3:30 PM");
    expect(availabilityCopyText({ date: "2026-10-11", totalCapacity: 0, booked: 0, openSlotTimes: [], utilization: null, blockedCount: 0 } as Parameters<typeof availabilityCopyText>[0])).toBe(
      "Sunday Availability — studio closed (no bookable slots configured)",
    );
  });
});
