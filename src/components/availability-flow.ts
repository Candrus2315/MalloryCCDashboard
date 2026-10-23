/**
 * AVAILABILITY FLOW — the client-side args contract for the availability tab
 * (2026-10-10 interactivity fix; root cause: scratch/availability-root-cause.md).
 *
 * On every in-tab interaction the route navigates by URL search params and the
 * loader re-runs — but a LOADER-issued serverfn call drops its payload in
 * transit (TanStack Start 1.158, live-instrumented 2026-10-07). The handler
 * then falls back to the route default (month of today, no filters), so the
 * URL advances while the view does not, and the owner "fixes" it with a manual
 * refresh (a full SSR page load, whose page-URL fallback DOES carry the args).
 *
 * The fix routes interactions through the transport proven to deliver
 * payloads: a DIRECT component-issued serverfn call (the pattern
 * `refreshAvailabilityFeed` already uses from a click handler). This module
 * carries the pure pieces of that flow, shared by the route's validateSearch
 * and the component:
 *
 *  - normalizeAvailabilitySearch — the ONE search normalization (the route's
 *    validateSearch delegates to it), so the payload the component explicitly
 *    POSTs is always exactly what the URL implies.
 *  - sameAvailabilitySearch — the render-source key: explicit-fetch data
 *    renders only while it matches the URL's current search (back/forward,
 *    cross-page links and SSR loads fall through to the loader payload).
 *  - AVAILABILITY_ARGS_LOST_WARNING — the honesty-banner marker (page-data
 *    pushes it into payload warnings when even the URL fallback fails; the
 *    component reads its presence to distrust a loader payload and self-heal
 *    through the same explicit transport).
 *
 * Client-safe by construction: the ONLY page-data import is type-only (erased
 * at compile), so no server module enters the client bundle — same pattern as
 * availability-views.tsx / availability-copy.ts.
 */
import type { AvailabilityViewRawSearch } from "~/server/page-data";

/**
 * The route's search normalization. validateSearch delegates here byte-for-byte,
 * and `go()` runs the same function over the patched search BEFORE the explicit
 * fetch — one shape everywhere: URL, loader payload, and explicit payload.
 */
export function normalizeAvailabilitySearch(
  search: Partial<AvailabilityViewRawSearch> | Record<string, unknown>,
): AvailabilityViewRawSearch {
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  return {
    view: s(search.view) ?? "month", // month is the DEFAULT view (owner §2 directive)
    month: s(search.month),
    from: s(search.from),
    date: s(search.date),
    cal: s(search.cal),
    type: s(search.type),
    st: s(search.st),
  };
}

/** Field-by-field equality over the normalized search (the render-source key). */
export function sameAvailabilitySearch(a: AvailabilityViewRawSearch, b: AvailabilityViewRawSearch): boolean {
  return (
    a.view === b.view &&
    a.month === b.month &&
    a.from === b.from &&
    a.date === b.date &&
    a.cal === b.cal &&
    a.type === b.type &&
    a.st === b.st
  );
}

/**
 * The args-lost honesty marker — byte-identical to the warning availabilityPageData
 * pushes into `warnings` when the payload fell back to the route default
 * (page-data.ts imports THIS constant, so the two can never drift). The
 * availability route renders it in the amber status banner; the component also
 * uses its PRESENCE as the "this loader payload lost its args" signal for the
 * self-heal fetch.
 */
export const AVAILABILITY_ARGS_LOST_WARNING =
  "Availability view args were lost in transit — the default month view (today) is shown.";
