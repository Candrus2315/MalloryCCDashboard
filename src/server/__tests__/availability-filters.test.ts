/**
 * AVAILABILITY REBUILD PR-3 §3 — page-level FILTERS tests (owner spec §11).
 *
 * Options enumerate from the CACHED /calendars + /appointment-types catalog
 * (the committed 2026-10-06 probe fixtures — the real catalog: 3 calendars,
 * 37 types, hard calendarIDs bindings). The binding comes from the API's
 * calendarIDs — never guessed (a mismatched type×calendar pair answers 400
 * invalid_calendar). The scope merge proves the page can only NARROW what
 * Settings includes; unknown status tokens are dropped.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  AVAILABILITY_STATUS_TOKENS,
  normalizeAvailabilityView,
  type AvailabilitySlotView,
} from "../page-data";
import {
  availabilityFilterOptions,
  filterDaySlotsByStatuses,
  mergeAvailabilityPageScope,
} from "../availability-view";
import calendarsFixture from "./fixtures/availability-feed/calendars.json";
import typesFixture from "./fixtures/availability-feed/appointment-types.json";

const TODAY = "2026-10-06";
const FETCHED_AT = "2026-10-06T21:00:00.000Z";

function catalogRows() {
  return {
    calendars: (calendarsFixture as Array<{ id: number; name: string }>).map((c) => ({
      calendar_id: String(c.id),
      name: c.name,
      fetched_at: FETCHED_AT,
      run_id: "run-pr3",
    })),
    types: (typesFixture as Array<{ id: number; name: string; calendarIDs: number[]; duration: number | null }>).map(
      (t) => ({
        appointment_type_id: String(t.id),
        name: t.name,
        calendar_ids: t.calendarIDs.map(String),
        duration_minutes: t.duration,
        fetched_at: FETCHED_AT,
        run_id: "run-pr3",
      }),
    ),
  };
}

describe("filter option enumeration — from the cached catalog, never guessed", () => {
  const options = availabilityFilterOptions(catalogRows());

  test("all three calendars enumerate (Annex/Zoom included despite zero appointments)", () => {
    expect(options.calendars).toEqual([
      { id: "1335091", name: "MALLORY PORTRAITS" },
      { id: "12107308", name: "The Annex" },
      { id: "4932380", name: "Zoom" },
    ]);
    expect(options.fetchedAt).toBe(FETCHED_AT);
  });

  test("the full 37-type catalog enumerates with its REAL bindings", () => {
    expect(options.types).toHaveLength(37);
    const portrait = options.types.find((t) => t.name === "Portrait Session");
    expect(portrait?.calendarIds).toEqual(["1335091"]);
  });

  test("valid pairs exist ONLY where the API binds them (27 main / 1 Annex / 1 Zoom)", () => {
    const byCalendar = new Map<string, number>();
    for (const p of options.validPairs) byCalendar.set(p.calendarId, (byCalendar.get(p.calendarId) ?? 0) + 1);
    expect(byCalendar.get("1335091")).toBe(27);
    expect(byCalendar.get("12107308")).toBe(1);
    expect(byCalendar.get("4932380")).toBe(1);
    // every pair is backed by the type's own calendarIDs (the §1.2 contract)
    const byId = new Map(options.types.map((t) => [t.id, t]));
    for (const p of options.validPairs) {
      expect(byId.get(p.typeId)?.calendarIds).toContain(p.calendarId);
    }
    // the Annex's single type and Zoom's single type are the real names
    const annexPair = options.validPairs.find((p) => p.calendarId === "12107308");
    expect(options.types.find((t) => t.id === annexPair?.typeId)?.name).toBe("Session Fee, Portrait Session Only");
    const zoomPair = options.validPairs.find((p) => p.calendarId === "4932380");
    expect(options.types.find((t) => t.id === zoomPair?.typeId)?.name).toBe("Proof Only Appointment");
  });

  test("an empty catalog (feed never ran) enumerates honestly empty", () => {
    const empty = availabilityFilterOptions({ calendars: [], types: [] });
    expect(empty).toEqual({ calendars: [], types: [], validPairs: [], fetchedAt: null });
  });

  test("store round-trip: the feed run's catalog write is what the page reads", async () => {
    const store = new MemoryStore();
    await store.putAvailabilityCatalog(catalogRows(), "run-pr3", FETCHED_AT);
    const read = await store.getAvailabilityCatalog();
    expect(read.calendars).toHaveLength(3);
    expect(read.types).toHaveLength(37);
    // REPLACE-all: a second write with a smaller catalog fully replaces
    await store.putAvailabilityCatalog(
      { calendars: [{ calendar_id: "1335091", name: "MALLORY PORTRAITS" }], types: [] },
      "run-pr3b",
      "2026-10-07T10:00:00.000Z",
    );
    const replaced = await store.getAvailabilityCatalog();
    expect(replaced.calendars).toHaveLength(1);
    expect(replaced.types).toHaveLength(0);
    expect(replaced.calendars[0].fetched_at).toBe("2026-10-07T10:00:00.000Z");
  });
});

describe("page scope merge — the page narrows what Settings includes", () => {
  test("empty page filter = the Settings scope alone", () => {
    const scope = { calendars_included: ["1335091"], types_included: ["Portrait Session"] };
    expect(mergeAvailabilityPageScope(scope, { calendars: [], types: [], statuses: [] })).toEqual(scope);
  });

  test("page filter over an all-inclusive Settings becomes the page filter", () => {
    expect(
      mergeAvailabilityPageScope({ calendars_included: [], types_included: [] }, { calendars: ["4932380"], types: [], statuses: [] }),
    ).toEqual({ calendars_included: ["4932380"], types_included: [] });
  });

  test("both non-empty = intersection (never wider than Settings)", () => {
    expect(
      mergeAvailabilityPageScope(
        { calendars_included: ["1335091", "12107308"], types_included: [] },
        { calendars: ["1335091", "4932380"], types: [], statuses: [] },
      ).calendars_included,
    ).toEqual(["1335091"]);
  });
});

describe("filter search parsing — normalizeAvailabilityView", () => {
  test("comma lists parse; unknown status tokens drop (a typo must not empty the list)", () => {
    const req = normalizeAvailabilityView({ view: "month", cal: "1335091, 4932380", type: "Portrait Session", st: "booked,bogus,holes" }, TODAY);
    expect(req?.filters).toEqual({ calendars: ["1335091", "4932380"], types: ["Portrait Session"], statuses: ["booked", "holes"] });
    expect(req?.kind).toBe("month");
  });

  test("a bare filter (no view param) still yields the month default", () => {
    const req = normalizeAvailabilityView({ cal: "1335091" }, TODAY);
    expect(req?.kind).toBe("month");
    expect(req?.month).toBe("2026-10");
  });

  test("the status token set is the spec's five toggles", () => {
    expect([...AVAILABILITY_STATUS_TOKENS]).toEqual(["booked", "open", "holes", "cancelled", "blocked"]);
  });
});

describe("status toggles — Day-view slot-list filter (counts untouched)", () => {
  const slots = [
    { status: "booked", isHole: false, cancelledAppointments: [], blocked: false, time: "09:00" },
    { status: "booked-pending", isHole: false, cancelledAppointments: [], blocked: false, time: "10:00" },
    { status: "open", isHole: false, cancelledAppointments: [], blocked: false, time: "11:00" },
    { status: "open", isHole: true, cancelledAppointments: [], blocked: false, time: "12:00" },
    { status: "blocked", isHole: false, cancelledAppointments: [], blocked: true, time: "13:30" },
    { status: "open", isHole: false, cancelledAppointments: [{ id: "x" }], blocked: false, time: "14:30" },
  ] as unknown as AvailabilitySlotView[];

  test("empty = everything", () => {
    expect(filterDaySlotsByStatuses(slots, [])).toHaveLength(6);
  });

  test("each token selects its rows", () => {
    expect(filterDaySlotsByStatuses(slots, ["booked"]).map((s) => s.time)).toEqual(["09:00", "10:00"]); // pending counts as booked
    expect(filterDaySlotsByStatuses(slots, ["open"]).map((s) => s.time)).toEqual(["11:00", "12:00", "14:30"]);
    expect(filterDaySlotsByStatuses(slots, ["holes"]).map((s) => s.time)).toEqual(["12:00"]);
    expect(filterDaySlotsByStatuses(slots, ["cancelled"]).map((s) => s.time)).toEqual(["14:30"]);
    expect(filterDaySlotsByStatuses(slots, ["blocked"]).map((s) => s.time)).toEqual(["13:30"]);
    expect(filterDaySlotsByStatuses(slots, ["booked", "holes"]).map((s) => s.time)).toEqual(["09:00", "10:00", "12:00"]);
  });
});
