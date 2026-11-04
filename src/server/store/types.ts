/**
 * STORE TYPES (server-only module) — re-export shim.
 *
 * Decomposed per docs/DECOMPOSITION-PLAN.md step 4: the contents live in
 * ./types/ (rows-core · seeds · sync-meta · rows-modules · store-interface),
 * split at the file's own section seams. This shim keeps every existing
 * import path resolving unchanged ("./types" inside store/, "../store/types"
 * from server modules, "~/server/store/types" from routes, "./types" from
 * tests) and preserves the module's exact public surface — same exported
 * names, nothing added, nothing dropped.
 *
 * ONE disclosed addition (type-only, zero runtime change): the monolith
 * declared the metric row types locally via its compute.ts import, and
 * consumers already imported those names from THIS module (tolerated as
 * TS2459). The shim makes that de-facto surface real:
 */
// Metric row types the monolith carried locally — re-exported type-only.
export type {
  AppointmentRow,
  AttributionRow,
  AvailabilityRule,
  BlockedTimeRow,
  CallRow,
  LeadRow,
  RecurringBlock,
} from "../metrics/compute";
// core rows + settings
export {
  type UserRow,
  type ContactRow,
  type OpportunityRow,
  type ContactExternalIdRow,
  type ContactIdentityRow,
  type LeadJoinRow,
  type AuditCallRow,
  type TeamGoalRow,
  type RepGoalRowFull,
  type MonthlyGoalRow,
  type WeeklyReportNotesRow,
  type ConnectionRow,
  type SyncRunRow,
  type HarvestConvRow,
  type HarvestCallRow,
  type EvidenceMessageRow,
  type HlCallRecordRow,
  type CallContactResolutionMethod,
  type CallContactBackfillUpdate,
  type HarvestProgressRow,
  type LeadCountAdjustmentRow,
  type ManualOverrideRow,
  type DailyPrioritiesRow,
  type RosterEntry,
  normalizeRoster,
  normalizeHistoricalReps,
  type RepMapping,
  normalizeRepMappings,
  type AppSettings,
  type RetentionSettings,
  weekStartOfDateOrUndefined,
  normalizeRetentionSettings,
  mergeRetentionSettings,
  type SheetMappingMode,
  type SheetConfig,
  isSheetMappingModeValue,
  SETTINGS_OWNER_ACTOR,
  mergeSheetsSettings,
  normalizeUnattributedQueueSettings,
  normalizeAppSettings,
} from "./types/rows-core";

// seed constants
export {
  DEFAULT_CALL_START_DATES,
  type CommissionProfileSeed,
  DEFAULT_COMMISSION_PROFILES,
  DEFAULT_ACTIVE_ROSTER,
  DEFAULT_RETENTION_SETTINGS,
  FORMS_WORKBOOK_ID,
  DEFAULT_SHEET_IDS,
  DEFAULT_COLUMN_MAPPING,
  DEFAULT_COLUMN_MAPPING_DAY_COUNT,
  DEFAULT_SETTINGS,
  defaultSettings,
} from "./types/seeds";

// sync liveness constants
export {
  TICK_WATCHDOG_CAP_MS,
  STALE_RUN_REAP_MINUTES,
  HIGHLEVEL_RUN_BUDGET_MS,
  HIGHLEVEL_RUN_BUDGET_ENV,
  parseSyncStartedMs,
} from "./types/sync-meta";

// module rows (PIP · commission · availability · clients · retention)
export {
  type PipStatus,
  PIP_STATUSES,
  isPipStatus,
  type PipActionItem,
  normalizePipActionList,
  type PipRow,
  type PipCreateInput,
  type PipDraftPatch,
  type PipEvidenceSnapshotRow,
  type PipCheckinRow,
  type PipTemplateRow,
  type PipTemplateCreateInput,
  type PipTemplatePatch,
  type PipEventType,
  type PipEventRow,
  type CommissionWeeklyStatus,
  type CommissionUpsertResult,
  type CommissionAssignment,
  type CommissionCycleStatus,
  type CountedBookingSnapshot,
  type HoleAuditSnapshot,
  type CommissionWeeklyRow,
  type CommissionProfileInput,
  type CommissionCycleRow,
  type CommissionAdjustmentInput,
  type CommissionAdjustmentRow,
  type AvailabilitySlotRow,
  type AvailabilityDatesRow,
  type AvailabilitySyncRunRow,
  type AvailabilityDiscrepancyKind,
  type AvailabilityDiscrepancyRow,
  type AvailabilitySlotInput,
  type AvailabilityDatesInput,
  type AvailabilityDiscrepancyInput,
  type AvailabilityCalendarRow,
  type AvailabilityTypeRow,
  type AvailabilityCatalogInput,
  type InternalClientRow,
  type InternalClientSeedInput,
  type ClientMatchLinkRow,
  type ClientMatchLinkInput,
  type DataMatchExceptionRow,
  type DataMatchExceptionInput,
  type RetentionAttemptRow,
  type RetentionAttemptWrite,
  type RetentionOutcomeRow,
  type RetentionOutcomeWrite,
  type RetentionCancellationRow,
  type RetentionCancellationWrite,
  type RetentionNoShowRow,
  type RetentionNoShowWrite,
  type RetentionTransferRow,
  type RetentionTransferWrite,
  type RetentionScorecardRow,
  type RetentionScorecardWrite,
  type RetentionOwnerHistoryRow,
} from "./types/rows-modules";

// the Store interface
export { type Store } from "./types/store-interface";
