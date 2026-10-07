/**
 * AVAILABILITY WIRING — the regression test class that was missing all day
 * (2026-10-07 outage). The builder + pg store were proven good in isolation;
 * the defect lived ONLY in the loader→serverfn→builder translation:
 * the SSR in-process transport drops the GET payload query, so the handler
 * received `data = {}` and normalizeAvailabilityView({}) → null → the legacy
 * 7-day payload → the rebuilt route's fail-closed guard rendered
 * "Availability unavailable".
 *
 * These tests call the SAME translation the serverfn handler does
 * (availabilityViewArgsFrom from availability-wiring.ts — the handler is
 * `.handler(({data}) => availabilityPageData({view: availabilityViewArgsFrom(data, currentRequestUrl())}))`)
 * and then run the FULL builder on its output, asserting the payload HAS a
 * view (kind month/day) — i.e. the rebuilt route can never silently fall back
 * to the legacy shape again, in either transport.
 *
 * Shape note: the helper returns the RAW search (view/month/from/… — the same
 * shape the route hands the serverfn); `kind` appears only after
 * normalizeAvailabilityView, which runs INSIDE the builder — so the payload
 * assertions (payload.view.kind) are the real wiring contract here.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { availabilityPageData } from "../page-data";
import { availabilityViewArgsFrom } from "../availability-wiring";

const TODAY = "2026-10-06"; // Tuesday — the day the PR-1 probes ran

async function buildWithArgs(data: Parameters<typeof availabilityViewArgsFrom>[0], pageUrl: Parameters<typeof availabilityViewArgsFrom>[1]) {
  const view = availabilityViewArgsFrom(data, pageUrl);
  const store = new MemoryStore();
  return { view, payload: await availabilityPageData({ store, today: TODAY, view }) };
}

const RAW = { view: "month", month: "2026-10", from: undefined, to: undefined, date: undefined, cal: undefined, type: undefined, st: undefined };

describe("availability wiring — serverfn args → builder view request (loader-chain translation)", () => {
  test("client-navigation transport: data=search reaches the handler directly → month view payload", async () => {
    // The HTTP RPC path delivers the search under data (probe A: endpoint 200,
    // month payload). pageUrl=null — no fallback needed.
    const { view, payload } = await buildWithArgs({ view: "month", month: "2026-10" }, null);
    expect(view).toEqual(RAW);
    expect((payload.view as { kind: string }).kind).toBe("month");
  });

  test("THE OUTAGE CASE — SSR transport: data={} (payload query dropped) recovers the search from the page request URL → month view payload", async () => {
    // Exact observed defect: a /availability?view=month SSR load delivered
    // data={} to the handler (probe evidence 2026-10-07). The fallback reads
    // the PAGE request's own query.
    const { view, payload } = await buildWithArgs({}, "http://localhost:3000/availability?view=month&month=2026-10");
    expect(view).toEqual(RAW);
    expect((payload.view as { kind: string }).kind).toBe("month");
    expect(payload.view).not.toBeUndefined();
  });

  test("SSR fallback: view=day&date=… → Day view payload with that date", async () => {
    const { view, payload } = await buildWithArgs({}, "http://localhost:3000/availability?view=day&date=2026-10-13");
    expect(view!.view).toBe("day");
    expect(view!.date).toBe("2026-10-13");
    const v = payload.view as { kind: string; date?: string };
    expect(v.kind).toBe("day");
    expect(v.date).toBe("2026-10-13");
  });

  test("empty-search default: a BARE /availability SSR load (no params at all) still defaults to month — never legacy", async () => {
    // validateSearch defaults view to "month"; the SSR fallback mirrors it for
    // the availability page even when the URL carries zero params.
    const { view, payload } = await buildWithArgs({}, "http://localhost:3000/availability");
    expect(view!.view).toBe("month");
    expect((payload.view as { kind: string }).kind).toBe("month");
  });

  test("legacy path intact: no args AND no page URL → undefined → legacy 7-day payload (no view field)", async () => {
    // The legacy contract tests are pinned on this shape — the wiring must
    // keep returning undefined (not a view object) for non-availability calls.
    expect(availabilityViewArgsFrom(undefined, null)).toBeUndefined();
    const { view, payload } = await buildWithArgs(undefined, null);
    expect(view).toBeUndefined();
    expect(payload.view).toBeUndefined();
    expect(payload.days).toHaveLength(7); // the legacy 7-day strip payload
  });

  test("non-availability request with empty data and no recognized params → legacy (no accidental default)", () => {
    // An RPC request whose payload was lost AND whose URL is not the
    // availability page must not invent a view.
    expect(availabilityViewArgsFrom({}, "http://localhost:3000/_serverFn/xyz?payload=%7B%7D")).toBeUndefined();
    expect(availabilityViewArgsFrom({}, "http://localhost:3000/team")).toBeUndefined();
  });

  test("route search variations survive the fallback: month param / 14-day / filters", () => {
    const base = "http://localhost:3000/availability";
    // month key picked up from the URL
    expect(availabilityViewArgsFrom({}, `${base}?view=month&month=2026-11`)!.month).toBe("2026-11");
    // invalid month passes through the raw string — normalizeAvailabilityView
    // (inside the builder) applies its honest default (month of today)
    expect(availabilityViewArgsFrom({}, `${base}?view=month&month=garbage`)!.month).toBe("garbage");
    // 14-Day view from its from date
    const days = availabilityViewArgsFrom({}, `${base}?view=days&from=2026-10-13`);
    expect(days!.view).toBe("days");
    expect(days!.from).toBe("2026-10-13");
    // filters ride along as comma lists (normalizeAvailabilityView validates tokens)
    const filtered = availabilityViewArgsFrom({}, `${base}?view=month&cal=1335091&type=Family%20Session&st=booked,open,bogus`);
    expect(filtered!.cal).toBe("1335091");
    expect(filtered!.type).toBe("Family Session");
    expect(filtered!.st).toBe("booked,open,bogus");
  });

  test("direct data always wins over the URL fallback (client navigation with explicit filters)", () => {
    const data = { view: "month", month: "2026-12", cal: "12107308" };
    expect(availabilityViewArgsFrom(data, "http://localhost:3000/availability?view=month&month=2026-10")).toBe(data);
  });
});
