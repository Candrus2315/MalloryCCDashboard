/**
 * STORE-INTERFACE COMPLETENESS (closes the known debt behind PR #18/#19).
 *
 * The 9/29 sync outage shipped because MemoryStore-only tests hid a missing
 * PgStore method: the Store interface grew, MemoryStore implemented it, and
 * PgStore did not — `vite build` does NOT type-check, so nothing failed until
 * production hit `store.X is not a function`. Both classes already declare
 * `implements Store`, but that only errors under tsc with code TS2420/TS2720,
 * which the typecheck tripwire (dangling-reference codes) does not fail on.
 *
 * This module makes completeness STRUCTURAL and enforced in three layers:
 *
 * 1. COMPILE-TIME assignability — the two `extends Store` conditional-type
 *    consts below resolve to `never` when either class is missing/renaming a
 *    Store member; the assignment then fails (TS2322) inside THIS file.
 * 2. COMPILE-TIME member list — STORE_METHOD_FLAGS is `satisfies
 *    Record<keyof Store, number>`: the literal must list EXACTLY the Store
 *    members (a missing member after the interface grows = compile error;
 *    a stale extra member = compile error too). The list doubles as the
 *    runtime source of truth because the compiler keeps it honest.
 * 3. RUNTIME walk — src/server/__tests__/store-satisfies.test.ts walks
 *    STORE_INTERFACE_MEMBERS against BOTH store instances (and a real
 *    PgStore when TEST_DATABASE_URL is set) asserting each is callable, and
 *    the typecheck tripwire fails on ANY diagnostic inside this file, so the
 *    compile-time layers are build-enforced (bun test src/server), not just
 *    IDE noise.
 *
 * When you add a Store method: implement it on BOTH stores, then add its name
 * here — tsc and the runtime test both refuse to pass otherwise.
 */
import type { Store } from "./types";
import type { MemoryStore } from "./memory";
import type { PgStore } from "./pg";

// -- 1. compile-time assignability asserts (resolve to never on drift) --
export type AssertMemoryStoreSatisfiesStore = MemoryStore extends Store ? true : never;
export type AssertPgStoreSatisfiesStore = PgStore extends Store ? true : never;
const _memoryStoreSatisfiesStore: AssertMemoryStoreSatisfiesStore = true;
const _pgStoreSatisfiesStore: AssertPgStoreSatisfiesStore = true;
void _memoryStoreSatisfiesStore;
void _pgStoreSatisfiesStore;

// -- 2/3. the compiler-checked member list (runtime-walkable) --
const STORE_METHOD_FLAGS = {
  mode: 1,
  ensureSchema: 1,
  // settings
  getSettings: 1,
  saveSettings: 1,
  // goals
  upsertTeamGoal: 1,
  getTeamGoal: 1,
  getTeamGoals: 1,
  upsertRepGoals: 1,
  getRepGoals: 1,
  deleteRepGoal: 1,
  upsertMonthlyGoal: 1,
  getMonthlyGoal: 1,
  deleteMonthlyGoal: 1,
  getWeeklyReportNotes: 1,
  upsertWeeklyReportNotes: 1,
  // core entities
  upsertUsers: 1,
  setUserCallStartDate: 1,
  getUsers: 1,
  getAllUsers: 1,
  upsertContacts: 1,
  getContacts: 1,
  countContacts: 1,
  getContactExternalIds: 1,
  getContactIdentityRows: 1,
  upsertCalls: 1,
  getCallsBetween: 1,
  getAllCallsSince: 1,
  getAuditCalls: 1,
  upsertOpportunities: 1,
  getOpportunities: 1,
  getOpportunitiesByPipelines: 1,
  deleteDemoHighLevelRows: 1,
  deleteDemoAcuityRows: 1,
  upsertAppointments: 1,
  getAppointmentsCreatedBusinessDateBetween: 1,
  getAppointmentsByWinBusinessDateBetween: 1,
  getAppointmentsOverlapping: 1,
  getAllAppointmentsSince: 1,
  getAppointmentsWithClientsSince: 1,
  dismissPendingPayment: 1,
  // attributions
  upsertAttributions: 1,
  getAttributions: 1,
  setManualAttribution: 1,
  deleteAttribution: 1,
  // leads
  upsertLeads: 1,
  deleteLeadsForSheet: 1,
  getLeadsByProvider: 1,
  deleteLeadsBySourceIds: 1,
  getLeadsByWorkDates: 1,
  getLeadsBySourceDates: 1,
  countLeads: 1,
  updateLeadWorkDate: 1,
  // lead count adjustments
  upsertLeadCountAdjustment: 1,
  getLeadCountAdjustments: 1,
  // availability
  upsertAvailabilityRules: 1,
  getAvailabilityRules: 1,
  upsertBlockedTimes: 1,
  getBlockedTimesBetween: 1,
  insertBlockedTime: 1,
  deleteBlockedTime: 1,
  // daily priorities
  upsertDailyPriorities: 1,
  getDailyPriorities: 1,
  // integrations + sync
  upsertConnection: 1,
  getConnections: 1,
  insertSyncRun: 1,
  finishSyncRun: 1,
  getSyncRuns: 1,
  getRunningSyncRuns: 1,
  getRunningSyncRun: 1,
  getSyncWatermark: 1,
  setSyncWatermark: 1,
  getSyncCheckpoint: 1,
  setSyncCheckpoint: 1,
  // call harvest
  getHarvestProgress: 1,
  saveHarvestProgress: 1,
  upsertHarvestConversations: 1,
  getHarvestConversationsByIds: 1,
  upsertHarvestCalls: 1,
  getHarvestCallsByMessageIds: 1,
  getHarvestCallsSince: 1,
  applyCallContactBackfill: 1,
  getUnvisitedInWindow: 1,
  markHarvestVisited: 1,
  getHarvestCoverageSummary: 1,
  // manual overrides
  insertManualOverride: 1,
  getManualOverrides: 1,
  // performance management (PIP module)
  createPip: 1,
  updatePipDraft: 1,
  getPip: 1,
  listPips: 1,
  issuePip: 1,
  completePip: 1,
  cancelPip: 1,
  recordPipAck: 1,
  addPipCheckin: 1,
  getPipCheckins: 1,
  getPipEvidenceSnapshots: 1,
  createPipTemplate: 1,
  updatePipTemplate: 1,
  deletePipTemplate: 1,
  getPipTemplate: 1,
  listPipTemplates: 1,
  getPipTemplateUsage: 1,
  insertPipEvent: 1,
  getPipEvents: 1,
  // commission tracker (owner directive 2026-10-01, Phase A)
  setUserCommissionProfile: 1,
  upsertCommissionWeeklyRecord: 1,
  applyCommissionWeeklyCorrection: 1,
  setCommissionRecordAssignment: 1,
  getCommissionWeeklyRecords: 1,
  upsertCommissionCycle: 1,
  getCommissionCycle: 1,
  getCommissionCycles: 1,
  insertCommissionAdjustment: 1,
  getCommissionAdjustments: 1,
} satisfies Record<keyof Store, number>;

/** Every Store member name — compiler-verified complete (see module doc). */
export const STORE_INTERFACE_MEMBERS: string[] = Object.keys(STORE_METHOD_FLAGS);

/** Members that are values rather than methods (the runtime walk skips these). */
export const STORE_VALUE_MEMBERS: string[] = ["mode"];
