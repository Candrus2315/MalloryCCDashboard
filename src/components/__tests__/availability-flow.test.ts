/**
 * AVAILABILITY FLOW — unit tests for the client-side args contract introduced
 * by the 2026-10-10 interactivity fix (root cause:
 * scratch/availability-root-cause.md). The loader-issued serverfn call drops
 * its payload on client navigation (TanStack Start 1.158), so the route's
 * component now POSTs the normalized search itself (the proven
 * refreshAvailabilityFeed transport). These tests pin the pure pieces of that
 * flow:
 *
 *  - normalizeAvailabilitySearch is byte-for-byte the route's validateSearch
 *    contract (view default "month", empty strings dropped, fields
 *    pass-through) — so the explicitly-fetched payload always matches what
 *    the URL implies;
 *  - sameAvailabilitySearch is the render-source key (explicit-fetch data
 *    renders only while it matches the URL's current search);
 *  - AVAILABILITY_ARGS_LOST_WARNING stays byte-identical to the warning
 *    page-data pushes into payload warnings (the self-heal trigger) — the
 *    drift-guard the whole design rests on.
 *
 * Pure compositions only — lives outside src/server so `bun test src/server`
 * counts stay stable.
 */
import { describe, expect, test } from "bun:test";
import {
  AVAILABILITY_ARGS_LOST_WARNING,
  normalizeAvailabilitySearch,
  sameAvailabilitySearch,
} from "~/components/availability-flow";
// value import (not type-only) on purpose: this asserts byte-identity between
// the client marker and the one page-data actually pushes into payload warnings.
import { AVAILABILITY_ARGS_LOST_WARNING as PAGE_DATA_MARKER } from "~/server/page-data";

const BARE = {
  view: "month",
  month: undefined,
  from: undefined,
  date: undefined,
  cal: undefined,
  type: undefined,
  st: undefined,
};

describe("normalizeAvailabilitySearch — the ONE search normalization (validateSearch's contract)", () => {
  test("bare /availability load: view defaults to month, every other field undefined", () => {
    expect(normalizeAvailabilitySearch({})).toEqual(BARE);
    expect(normalizeAvailabilitySearch({ view: undefined, month: "" }).view).toBe("month");
  });

  test("empty strings drop to undefined (never leak into the payload)", () => {
    const n = normalizeAvailabilitySearch({ view: "month", month: "", cal: "", st: "" });
    expect(n).toEqual(BARE);
  });

  test("every field passes through as a raw string (the builder normalizes values)", () => {
    const n = normalizeAvailabilitySearch({
      view: "days",
      month: "2026-11",
      from: "2026-10-13",
      date: "2026-10-08",
      cal: "1335091",
      type: "Family Session",
      st: "booked,open",
    });
    expect(n).toEqual({
      view: "days",
      month: "2026-11",
      from: "2026-10-13",
      date: "2026-10-08",
      cal: "1335091",
      type: "Family Session",
      st: "booked,open",
    });
  });

  test("non-string junk (arrays/objects from URL parsing) drops, never throws", () => {
    const n = normalizeAvailabilitySearch({ month: ["2026-11"], cal: { a: 1 } } as unknown as Record<string, unknown>);
    expect(n).toEqual(BARE);
  });

  test("idempotent: normalizing a normalized search returns the same shape", () => {
    const once = normalizeAvailabilitySearch({ view: "day", date: "2026-10-08" });
    expect(normalizeAvailabilitySearch(once)).toEqual(once);
  });
});

describe("sameAvailabilitySearch — the render-source key (explicit data vs the URL's search)", () => {
  test("absent and undefined fields are equal", () => {
    expect(sameAvailabilitySearch(normalizeAvailabilitySearch({}), normalizeAvailabilitySearch({ view: "month" }))).toBe(true);
  });

  test("each owner interaction field is distinguished: view / month / from / date / cal / type / st", () => {
    const base = normalizeAvailabilitySearch({ view: "month", month: "2026-10" });
    const cases: Array<[Partial<typeof base>, boolean]> = [
      [{ month: "2026-11" }, false], // month nav (symptom 1)
      [{ view: "days" }, false], // view switch (symptom 3a)
      [{ cal: "1335091" }, false], // studio filter (symptom 3b)
      [{ type: "Family Session" }, false], // type filter (symptom 3b)
      [{ st: "booked" }, false], // status chips (symptom 3b)
      [{ view: "day", date: "2026-10-08" }, false], // date selection (symptom 3c)
      [{}, true], // identical
    ];
    for (const [patch, expected] of cases) {
      expect(sameAvailabilitySearch(base, normalizeAvailabilitySearch({ ...base, ...patch }))).toBe(expected);
    }
  });
});

describe("AVAILABILITY_ARGS_LOST_WARNING — the honesty marker cannot drift", () => {
  test("the client-safe constant is byte-identical to the warning page-data pushes", () => {
    expect(AVAILABILITY_ARGS_LOST_WARNING).toBe(PAGE_DATA_MARKER);
    expect(AVAILABILITY_ARGS_LOST_WARNING).toBe(
      "Availability view args were lost in transit — the default month view (today) is shown.",
    );
  });
});
