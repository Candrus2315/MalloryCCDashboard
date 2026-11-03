/**
 * PAGE-DATA BUILDERS (server-only module).
 *
 * repsPageData / teamPageData live here — NOT in queries.ts — because a
 * createServerFn module must export only server-fn stubs for the TanStack
 * client transform: plain exports left in queries.ts pulled the postgres
 * chain into the vite client bundle (build error: "performance" is not
 * exported by __vite-browser-external). Routes import the createServerFn
 * wrappers from queries.ts; tests and scripts import these builders
 * directly (with the PageDeps seam: inject a MemoryStore + pinned clock —
 * never getStore() from tests, never the Start runtime).

/**
 * Decomposed per docs/DECOMPOSITION-PLAN.md step 3: this file holds the
 * pieces every page builder shares (the header rationale, loadPageMeta,
 * the PageDeps DI seam). Section builders live in the sibling modules
 * (reps-team · today · availability · weekly · commission); page-data.ts
 * is the re-export shim that keeps every import path unchanged.
 */

import type { Store } from "../store/types";

import { etToday } from "../date-logic";














// The args-lost honesty marker lives in the client-safe flow module (the
// availability route reads it from payload warnings to distrust a loader
// payload and self-heal) — imported here so the two can never drift.
import { AVAILABILITY_ARGS_LOST_WARNING } from "../../components/availability-flow";
// Re-exported: the wiring tests assert byte-identity with the client marker.
export { AVAILABILITY_ARGS_LOST_WARNING };
import { type PageMeta } from "../queries";
// PageDeps.view's type is declared in the availability section module — in the
// monolith it was a forward reference inside the same file (page-data.ts:1377).
import type { AvailabilityViewRawSearch } from "./availability";

export async function loadPageMeta(): Promise<PageMeta> {
  const seeded = await import("../sync/run").then((m) => m.ensureDemoData());
  const { getDbStatus } = await import("../store");
  const status = getDbStatus();
  return { mode: seeded.mode, dbReason: status.ok ? null : status.reason, today: etToday(), demoSeeded: seeded.seeded };
}

/**
 * DI seam for tests (pure-layer view compos): when `store` is injected the
 * builders never touch getStore()/loadPageMeta() (which could reach live
 * Postgres or seed demo data); `today` pins the clock so week-cadence
 * behavior (Fri → weekend → Mon 12AM ET → Tue) is deterministic. The
 * createServerFn loaders pass nothing and behave exactly as before.
 */
export interface PageDeps {
  store?: Store;
  today?: string;
  /** Injected ET wall-clock (minutes since midnight) for deterministic tests — dailyReportPageData's anchor rule uses it. */
  etNowMinutes?: number;
  /**
   * AVAILABILITY REBUILD PR-2: the range-view request (raw search strings;
   * normalized server-side). Absent → the legacy 7-day payload (its contract
   * tests); the route always passes one (default view = month of today).
   */
  view?: AvailabilityViewRawSearch;
  /**
   * 2026-10-07 triage: the handler recovered args lost in transit to the
   * route's own default (view=month). The payload names it in a warning —
   * the owner is never shown a silently substituted view.
   */
  viewArgsLost?: boolean;
}

