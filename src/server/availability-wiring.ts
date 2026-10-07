/**
 * Availability route → serverfn → builder WIRING (2026-10-07 outage fix).
 *
 * The rebuilt route's loader calls getAvailabilityData({ data: search }). Two
 * transports deliver that search to the serverfn handler:
 *  - HTTP RPC (client navigation): the seroval payload carries {"data":search}
 *    and the handler receives the search directly — this path always worked.
 *  - SSR in-process: the start SSR fetch drops the GET payload query, so the
 *    handler received `data = {}` for a /availability?view=month load (probe
 *    evidence 2026-10-07: the same endpoint over real HTTP delivers the search
 *    fine, the in-process SSR chain does not). The only reliable server-side
 *    source is then the PAGE request itself — its URL query is exactly the raw
 *    search validateSearch saw.
 *
 * availabilityViewArgsFrom is the ONE translation the loader chain performs —
 * PURE in (data, pageUrl), no globals — so the wiring test can call the same
 * logic the handler does. It returns undefined only when NEITHER source names
 * a view → the legacy 7-day payload contract keeps running unchanged (its
 * tests are pinned).
 */
import type { AvailabilityViewRawSearch } from "./page-data";

/** Raw-search field names the availability route may hand the serverfn. */
const AVAIL_RAW_SEARCH_KEYS = ["view", "month", "from", "to", "date", "cal", "type", "st"] as const;

export function availabilityViewArgsFrom(
  data: AvailabilityViewRawSearch | undefined,
  pageUrl: string | null,
): AvailabilityViewRawSearch | undefined {
  if (data && AVAIL_RAW_SEARCH_KEYS.some((k) => data[k] != null)) return data;
  if (!pageUrl) return undefined;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, "");
  const onAvailabilityPage = path === "/availability" || path.endsWith("/availability");
  const parsed: AvailabilityViewRawSearch = {
    view: url.searchParams.get("view") ?? undefined,
    month: url.searchParams.get("month") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    date: url.searchParams.get("date") ?? undefined,
    cal: url.searchParams.get("cal") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    st: url.searchParams.get("st") ?? undefined,
  };
  if (onAvailabilityPage) {
    // validateSearch defaults the view to "month" — a bare /availability load
    // carries NO params in the URL, so the SSR fallback mirrors that default.
    return { ...parsed, view: parsed.view ?? "month" };
  }
  // RPC/other-page request: no recognized params → no view (legacy path).
  return AVAIL_RAW_SEARCH_KEYS.some((k) => parsed[k] != null) ? parsed : undefined;
}
