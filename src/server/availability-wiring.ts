/**
 * Availability route → serverfn → builder WIRING (2026-10-07 outage fix).
 *
 * The rebuilt route's loader calls getAvailabilityData({ data: search }). The
 * serverfn is now a POST (2026-10-07 triage): live instrumentation proved
 * TanStack Start 1.158 drops a GET serverfn's payload in BOTH transports —
 * the SSR in-process chain AND the client-navigation RPC — so the handler
 * received `data = {}` on every path except a bare hand-built HTTP call.
 *
 * availabilityViewArgsFrom is the ONE translation the loader chain performs —
 * PURE in (data, pageUrl), no globals — so the wiring test can call the same
 * logic the handler does. It returns undefined only when NEITHER source names
 * a view → the legacy 7-day payload contract keeps running unchanged (its
 * tests are pinned). With the POST switch the payload arrives on every real
 * transport; the page-URL fallback remains for SSR page loads (whose URL query
 * is exactly the raw search validateSearch saw) as belt-and-suspenders.
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

/**
 * The handler-level resolution (2026-10-07 triage): live instrumentation proved
 * TanStack Start 1.158 drops a loader's serverfn payload in EVERY in-app
 * transport — GET and POST, the SSR in-process chain AND the client-navigation
 * RPC (the handler then sees data={} while getRequest() holds the page request
 * during SSR but the _serverFn endpoint request during client nav). The URL
 * fallback rescues SSR page loads; client navigation has NO recoverable source.
 *
 * The availability serverfn has exactly ONE production caller — the
 * availability route — whose validateSearch DEFAULTS view="month". When
 * neither the payload nor the page URL names a view, the route default is the
 * honest answer: the SAME payload a bare /availability load renders, built
 * from real cached data (never invented calendar content). argsLost lets the
 * payload say so in its warnings — the owner is never shown a silently wrong
 * view, and the fail-closed panel stays reserved for genuine builder failure.
 */
export function resolveAvailabilityViewArgs(
  data: AvailabilityViewRawSearch | undefined,
  pageUrl: string | null,
): { args: AvailabilityViewRawSearch; argsLost: boolean } {
  const resolved = availabilityViewArgsFrom(data, pageUrl);
  if (resolved) return { args: resolved, argsLost: false };
  return { args: { view: "month" }, argsLost: true };
}
