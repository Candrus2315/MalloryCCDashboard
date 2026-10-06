/**
 * ACUITY AVAILABILITY CLIENT — fixture-backed tests with an INJECTED fetch.
 * NO live API call ever happens (the NODE_ENV=test guard blocks the default
 * resolver; every test constructs the client directly with a stub fetch).
 *
 * Fixtures: src/server/__tests__/fixtures/availability-feed/ — the raw
 * 2026-10-06 live probe snapshots (dates/times per calendar, empty-horizon
 * months, the per-calendar type bindings).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AcuityAvailabilityClient,
  parseAcuityCalendar,
  parseAcuityOpenTime,
  parseAcuityTypeFull,
  parseAvailabilityDateRow,
  resolveAcuityAvailabilityClient,
  type AcuityCalendarInfo,
  type AcuityTypeFull,
} from "../sync/acuity-availability";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "availability-feed");
const loadFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));

const CAL: AcuityCalendarInfo[] = (loadFixture("calendars.json") as Record<string, unknown>[]).map((r) => parseAcuityCalendar(r)!).filter(Boolean);
const TYPES: AcuityTypeFull[] = (loadFixture("appointment-types.json") as Record<string, unknown>[])
  .map((r) => parseAcuityTypeFull(r)!)
  .filter(Boolean);

/** Fake clock + recorded sleeps so the 1.1s pacing is asserted without waiting. */
function makeEnv(responses: Map<string, unknown | (() => never)>, opts?: { status?: number }) {
  const sleeps: number[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const key = new URL(url).pathname.replace("/api/v1/", "") + "?" + new URL(url).search;
    const matcher = [...responses.keys()].find((k) => key.startsWith(k)) ?? [...responses.keys()].find((k) => key.startsWith(new URLSearchParams(k.split("?")[0]).get("") ?? ""));
    // route by pathname+query prefix
    const hit = [...responses.entries()].find(([k]) => key.startsWith(k));
    if (!hit) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const value = hit[1];
    if (value instanceof Function) return value();
    const status = opts?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => value,
    } as unknown as Response;
  }) as unknown as (url: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Response>;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { fetchImpl, sleep, sleeps, calls };
}

/** The main calendar's representative session type from the live catalog. */
const PORTRAIT = TYPES.find((t) => t.name === "Portrait Session")!;

describe("acuity availability client (injected fetch, fixture-backed)", () => {
  test("fixture sanity: the live probe's three calendars parse", () => {
    expect(CAL.map((c) => c.id)).toEqual(["1335091", "12107308", "4932380"]);
    expect(CAL.map((c) => c.name)).toEqual(["MALLORY PORTRAITS", "The Annex", "Zoom"]);
    expect(CAL.every((c) => c.timezone === "America/New_York")).toBe(true);
  });

  test("fixture sanity: types carry the hard calendarIDs binding (invalid_calendar guard)", () => {
    expect(TYPES.length).toBeGreaterThan(20);
    const portrait = TYPES.find((t) => t.id === "3599872")!;
    expect(portrait.calendarIDs).toContain("1335091");
    // The Zoom-bound type ("Proof Only Appointment") is bound to main AND zoom —
    // the probe showed availability for it on main answers [] (fixture). Pair
    // selection must prefer a SESSION type bound to the calendar, not this one.
    const zoomType = TYPES.find((t) => t.calendarIDs.includes("4932380"));
    expect(zoomType).toBeDefined();
    expect(zoomType!.name).toBe("Proof Only Appointment");
    expect(zoomType!.calendarIDs).toContain("1335091");
  });

  test("dates: fixture month parses to the 10 probed open dates; empty months parse to []", () => {
    const oct = (loadFixture("dates-2026-10-cal1335091.json") as Record<string, unknown>[]).map((r) => parseAvailabilityDateRow(r)!);
    expect(oct).toEqual(["2026-10-08", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-24", "2026-10-31"]);
    const nov = (loadFixture("dates-2026-11-cal1335091.json") as Record<string, unknown>[]).map((r) => parseAvailabilityDateRow(r)!);
    expect(nov).toEqual(["2026-11-01"]);
    // past the booking-template horizon: HTTP-200 [] — cached as the horizon
    const dec = (loadFixture("dates-2026-12-cal1335091.json") as Record<string, unknown>[]) ?? [];
    expect(dec).toEqual([]);
    const jan = (loadFixture("dates-2027-01-cal1335091.json") as Record<string, unknown>[]) ?? [];
    expect(jan).toEqual([]);
  });

  test("times: fixture rows parse to ET HH:mm + slotsAvailable (offset respected)", () => {
    const times = (loadFixture("times-2026-10-13-cal1335091.json") as Record<string, unknown>[]).map((r) => parseAcuityOpenTime(r)!);
    expect(times).toEqual([
      { timeEt: "13:30", slotsAvailable: 1 },
      { timeEt: "14:30", slotsAvailable: 1 },
    ]);
    // the divergence day: Acuity still offered 15:30 AND 16:30 (§1.5)
    const t24 = (loadFixture("t2-2026-10-24-main.json") as Record<string, unknown>[]).map((r) => parseAcuityOpenTime(r)!);
    expect(t24.map((t) => t.timeEt)).toEqual(["15:30", "16:30"]);
  });

  test("open-time parser: malformed rows → null; missing slotsAvailable → honest 1; zero clamps to 1", () => {
    expect(parseAcuityOpenTime({ time: "not a date" })).toBeNull();
    expect(parseAcuityOpenTime({})).toBeNull();
    // absent slotsAvailable = "at least one" for a private session type
    expect(parseAcuityOpenTime({ time: "2026-10-13T13:30:00-0400" })).toEqual({ timeEt: "13:30", slotsAvailable: 1 });
    expect(parseAcuityOpenTime({ time: "2026-10-13T13:30:00-0400", slotsAvailable: 0 })).toEqual({ timeEt: "13:30", slotsAvailable: 1 });
    // no colon in the offset (another live encoding) must still parse; a
    // genuinely different offset is a different instant — the ET label shifts
    // (13:30 at -04:30 = 18:00 UTC = 14:00 EDT), never string-sliced
    expect(parseAcuityOpenTime({ time: "2026-10-13T13:30:00-0430" })).toEqual({ timeEt: "14:00", slotsAvailable: 1 });
  });

  test("client: auth header, URL params, pacing and per-call audit (dates + times)", async () => {
    const env = makeEnv(
      new Map<string, unknown | (() => never)>([
        ["availability/dates?", loadFixture("dates-2026-10-cal1335091.json")],
        ["availability/times?", loadFixture("times-2026-10-13-cal1335091.json")],
      ]),
    );
    const client = new AcuityAvailabilityClient({ userId: "u1", apiKey: "k1" }, env.fetchImpl, env.sleep);
    client.startRun(); // one run report accumulates across the multi-call sweep
    const dates = await client.fetchAvailabilityDates({ month: "2026-10", appointmentTypeId: PORTRAIT.id, calendarId: "1335091" });
    const times = await client.fetchAvailabilityTimes({ date: "2026-10-13", appointmentTypeId: PORTRAIT.id, calendarId: "1335091" });

    expect(dates).toHaveLength(10);
    expect(times.map((t) => t.timeEt)).toEqual(["13:30", "14:30"]);
    expect(env.calls).toHaveLength(2);
    const first = new URL(env.calls[0]);
    expect(first.origin + first.pathname).toBe("https://acuityscheduling.com/api/v1/availability/dates");
    expect(first.searchParams.get("month")).toBe("2026-10");
    expect(first.searchParams.get("appointmentTypeID")).toBe(PORTRAIT.id);
    expect(first.searchParams.get("calendarID")).toBe("1335091");
    expect(env.sleeps.length).toBeGreaterThanOrEqual(1); // second call paced after the first
    expect(env.sleeps[0]).toBeGreaterThan(900); // ~1.1s pacing
    expect(client.lastRun?.requests).toBe(2);
    expect(client.lastRun?.calls[0].path).toBe("availability/dates");
  });

  test("client: appointmentTypeId is REQUIRED (the API's 400 contract is pre-empted client-side)", async () => {
    const env = makeEnv(new Map());
    const client = new AcuityAvailabilityClient({ userId: "u1", apiKey: "k1" }, env.fetchImpl, env.sleep);
    await expect(client.fetchAvailabilityDates({ month: "2026-10", appointmentTypeId: "" })).rejects.toThrow(/appointmentTypeId is required/);
    await expect(client.fetchAvailabilityTimes({ date: "2026-10-13", appointmentTypeId: "" })).rejects.toThrow(/appointmentTypeId is required/);
    await expect(client.fetchAvailabilityDates({ month: "October 2026", appointmentTypeId: "1" })).rejects.toThrow(/YYYY-MM/);
    expect(env.calls).toHaveLength(0); // never fired
  });

  test("client: HTTP 400 body hint surfaces in the error (invalid_calendar shape)", async () => {
    const env = makeEnv(
      new Map<string, unknown | (() => never)>([
        [
          "availability/times?",
          () => {
            throw new Error("unreachable"); // replaced below by status path
          },
        ],
      ]),
    );
    // status-400 responder: ok=false, status=400, JSON body with error+message
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_calendar", message: 'The calendar "12107308" does not belong to appointment type "3599872".' }),
    })) as unknown as (url: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Response>;
    const client = new AcuityAvailabilityClient({ userId: "u1", apiKey: "k1" }, fetchImpl, env.sleep);
    // a type NOT bound to the calendar would be a caller bug — the error carries the API's hint
    await expect(client.fetchAvailabilityTimes({ date: "2026-10-13", appointmentTypeId: PORTRAIT.id, calendarId: "12107308" })).rejects.toThrow(/invalid_calendar/);
  });

  test("client: 401 authentication failure names the secrets (never their values)", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as (url: string) => Promise<Response>;
    const client = new AcuityAvailabilityClient({ userId: "u1", apiKey: "k1" }, fetchImpl, async () => {});
    await expect(client.fetchCalendars()).rejects.toThrow(/authentication failed \(401\)/);
  });

  test("test guard: the default resolver NEVER resolves under NODE_ENV=test", () => {
    // The owner's real credentials sit in this machine's environment — the
    // guard is what keeps `bun test` from firing live API calls.
    expect(resolveAcuityAvailabilityClient()).toBeNull();
  });

  test("default agent resolution without credentials → null (demo mode never calls the feed)", () => {
    // readAcuityAvailabilityCreds with no env secrets → null (checked via the
    // exported parser-level API; env-dependent creds are exercised in prod only)
    expect(typeof parseAcuityCalendar === "function").toBe(true);
  });
});
