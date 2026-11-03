/**
 * PAGE-DATA BUILDERS (server-only module) — re-export shim.
 *
 * Decomposed per docs/DECOMPOSITION-PLAN.md step 3: the builders live in
 * ./page-data/ (shared · reps-team · today · availability · weekly ·
 * commission), split along the section banners that already organized the
 * monolith. This shim keeps every existing import path resolving unchanged
 * ("./page-data" from server modules, "~/server/page-data" from routes and
 * client-safe components, "../page-data" from tests) and preserves the
 * module's exact public surface — same exported names, nothing added.
 *
 * The createServerFn rationale (why the builders are NOT in queries.ts) and
 * the PageDeps DI seam live in ./page-data/shared.ts.
 */
export { AVAILABILITY_ARGS_LOST_WARNING } from "./page-data/shared";
export type { PageDeps } from "./page-data/shared";
export { repsPageData, teamPageData } from "./page-data/reps-team";
export { todayPageData, dailyReportPageData } from "./page-data/today";
export {
  type AvailabilityDay,
  type DayHoleDetail,
  type AvailabilityConnection,
  ACUITY_STALE_AFTER_MS,
  availabilityPageData,
  type AvailabilityViewRawSearch,
  type AvailabilityViewKind,
  AVAILABILITY_DAYS_VIEW_WINDOW,
  type AvailabilityPageFilters,
  AVAILABILITY_STATUS_TOKENS,
  type AvailabilityViewRequest,
  normalizeAvailabilityView,
  availabilityViewDates,
  type AvailabilityAcuityState,
  type AvailabilityRangeDay,
  type AvailabilityRangeSummary,
  type AvailabilitySlotStatus,
  type AvailabilitySlotAppointment,
  type AvailabilitySlotView,
  type AvailabilityCoverageView,
  type AvailabilityViewPayload,
  type AvailabilityPageView,
} from "./page-data/availability";
export {
  type WeeklyCalendarBucket,
  type WeeklyPageData,
  type ReportSourcePerformance,
  FIRST_OPEN_DAY_HORIZON_DAYS,
  weeklyPageData,
} from "./page-data/weekly";
export {
  type CommissionEstimatedWeek,
  estimatedCommissionWeek,
  type CancelledWinFlag,
  buildCancelledWinFlags,
  type DriftedWinFlag,
  buildAttributionDriftFlags,
} from "./page-data/commission";
