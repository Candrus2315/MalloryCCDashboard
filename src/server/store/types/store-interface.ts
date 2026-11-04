/**
 * THE STORE INTERFACE — moved verbatim from src/server/store/types.ts
 * (docs/DECOMPOSITION-PLAN.md step 4). One Store interface in one module
 * (plan rule 3/§6: never per-store variants); it references the row types
 * from ./rows-core and ./rows-modules and the metric types from
 * ../../metrics/compute — the single store boundary for both implementations.
 */

import type { AppSettings, AuditCallRow, CallContactBackfillUpdate, ConnectionRow, ContactExternalIdRow, ContactIdentityRow, ContactRow, DailyPrioritiesRow, EvidenceMessageRow, HarvestCallRow, HarvestConvRow, HarvestProgressRow, HlCallRecordRow, LeadCountAdjustmentRow, LeadJoinRow, ManualOverrideRow, MonthlyGoalRow, OpportunityRow, RepGoalRowFull, SyncRunRow, TeamGoalRow, UserRow, WeeklyReportNotesRow } from "./rows-core";
import type { AvailabilityCalendarRow, AvailabilityCatalogInput, AvailabilityDatesInput, AvailabilityDatesRow, AvailabilityDiscrepancyInput, AvailabilityDiscrepancyRow, AvailabilitySlotRow, AvailabilitySyncRunRow, AvailabilityTypeRow, ClientMatchLinkInput, ClientMatchLinkRow, CommissionAdjustmentInput, CommissionAdjustmentRow, CommissionAssignment, CommissionCycleRow, CommissionProfileInput, CommissionUpsertResult, CommissionWeeklyRow, DataMatchExceptionInput, DataMatchExceptionRow, InternalClientRow, InternalClientSeedInput, PipCheckinRow, PipCreateInput, PipDraftPatch, PipEventRow, PipEvidenceSnapshotRow, PipRow, PipStatus, PipTemplateCreateInput, PipTemplatePatch, PipTemplateRow, RetentionAttemptRow, RetentionAttemptWrite, RetentionCancellationRow, RetentionCancellationWrite, RetentionNoShowRow, RetentionNoShowWrite, RetentionOutcomeRow, RetentionOutcomeWrite, RetentionOwnerHistoryRow, RetentionScorecardRow, RetentionScorecardWrite, RetentionTransferRow, RetentionTransferWrite } from "./rows-modules";
import type { AppointmentRow, AttributionRow, AvailabilityRule, BlockedTimeRow, CallRow, LeadRow } from "../../metrics/compute";
import type { IngestOptions, RunDeadline } from "../ingest-batch";

/**
 * Data store abstraction: the app runs against Postgres (Tiger Cloud) when
 * DATABASE_URL works, and falls back to an in-memory demo dataset when it
 * doesn't — so the dashboard is always viewable and the Postgres path activates
 * automatically once the connection is fixed. Both stores implement the same
 * duplicate-safe upsert semantics (keyed by provider external IDs).
 */
export interface Store {
  mode: "postgres" | "memory";
  ensureSchema(): Promise<void>;

  // settings
  getSettings(): Promise<AppSettings>;
  /**
   * Merge-apply a settings patch. `actor` (default "system") labels this
   * write: a sheet-mapping `mode` in the patch is honored ONLY when the actor
   * is the owner label (SETTINGS_OWNER_ACTOR) — system/unlabeled and default-
   * application writes can never change a saved mode, and any mode change an
   * owner-labeled write makes is audited (manual_overrides, old → new, actor;
   * owner directive: mode changes are explicit + audited, never silent).
   */
  saveSettings(patch: Partial<AppSettings>, actor?: string): Promise<AppSettings>;

  // goals
  upsertTeamGoal(row: TeamGoalRow): Promise<void>;
  getTeamGoal(weekStart: string): Promise<TeamGoalRow | null>;
  /** All stored weekly goals ordered by week_start (Settings week-list editor). */
  getTeamGoals(): Promise<TeamGoalRow[]>;
  upsertRepGoals(rows: RepGoalRowFull[]): Promise<void>;
  getRepGoals(weekStart: string): Promise<RepGoalRowFull[]>;
  /** Remove a rep's goal override so the team-share fallback applies again. */
  deleteRepGoal(repId: string, weekStart: string): Promise<void>;
  /** Per-month booking goals (Monthly Booking Goal, owner-approved 2026-09-29) — months never inherit each other. */
  upsertMonthlyGoal(row: MonthlyGoalRow): Promise<void>;
  getMonthlyGoal(month: string): Promise<MonthlyGoalRow | null>;
  deleteMonthlyGoal(month: string): Promise<void>;
  /** Editable CC Report narrative per report week (week_start Monday key). */
  getWeeklyReportNotes(weekStart: string): Promise<WeeklyReportNotesRow | null>;
  upsertWeeklyReportNotes(row: WeeklyReportNotesRow): Promise<void>;

  // core entities
  upsertUsers(rows: UserRow[]): Promise<number>;
  /** Set/clear one rep's activation date (Settings editor; ET YYYY-MM-DD or null). */
  setUserCallStartDate(repId: string, date: string | null): Promise<void>;
  /** Active-roster users only (every page/rep surface reads this). */
  getUsers(): Promise<UserRow[]>;
  /**
   * ALL users including inactive ones (roster-excluded reps keep their rows).
   * Used by the sync for rep-ID linkage so excluded users' calls/contacts keep
   * their references — never by page surfaces.
   */
  getAllUsers(): Promise<UserRow[]>;
  upsertContacts(rows: ContactRow[]): Promise<number>;
  getContacts(): Promise<ContactRow[]>;
  /**
   * S4: cheap population count for ONE provider — the every-tick contacts
   * reconciliation tripwire (meta.total vs stored count) without any
   * materialization.
   */
  countContacts(provider: string): Promise<number>;
  /**
   * S4: light (id, external_id) pairs for ONE provider's contacts — the
   * per-tick replacement for the FULL getContacts() materialization (18
   * columns × ~116k rows every tick only ever fed the external-id→id linkage
   * map and the contacts walk's known-id set). `only` filters to specific
   * external ids (targeted linkage lookup for rows just upserted this tick).
   */
  getContactExternalIds(provider: string, only?: string[]): Promise<ContactExternalIdRow[]>;
  /** PERF: identity slice of every contact (see ContactIdentityRow) — page-path replacement for the full getContacts() read. */
  getContactIdentityRows(): Promise<ContactIdentityRow[]>;
  /**
   * Call upsert (keyed by provider + external_call_id — duplicates never
   * duplicate rows). provider_rep_external_id preserves the RAW HighLevel
   * userId even when it does not map to the active roster (rep_id NULL) — the
   * unattributed call is KEPT, never silently discarded. conversation_id links
   * the call message back to its HL conversation (audit endpoint).
   */
  upsertCalls(rows: (CallRow & { external_call_id: string; provider: string; provider_rep_external_id?: string | null; conversation_id?: string | null })[]): Promise<number>;
  getCallsBetween(startUtc: string, endUtc: string): Promise<CallRow[]>;
  getAllCallsSince(startUtc: string): Promise<CallRow[]>;
  /**
   * Raw records behind the call metrics (audit endpoint): rep/contact joined.
   * repSpec: null|"all" = every call, "non-roster" = calls whose rep resolves
   * to a KNOWN user that is not on the active roster, "unattributed" = calls
   * with rep NULL (no determinable owner). "unassigned" is kept as a legacy
   * alias for the UNION of both buckets (the exact complement of
   * keepRosterRepCalls' kept set, so counts reconcile with the roster math by
   * construction). A user id string filters to that user (roster or not —
   * read-only audit). thresholdSeconds drives over_threshold (live settings
   * value, metrics rule).
   */
  getAuditCalls(startUtc: string, endUtc: string, repSpec: string | null, thresholdSeconds: number): Promise<AuditCallRow[]>;
  upsertOpportunities(rows: OpportunityRow[]): Promise<number>;
  getOpportunities(): Promise<OpportunityRow[]>;
  /** Opportunities on specific GHL pipelines (Alliance/Auction lead counts). */
  getOpportunitiesByPipelines(pipelineIds: string[]): Promise<OpportunityRow[]>;
  /**
   * Remove rows the demo generator seeded for the HighLevel provider
   * (external ids prefixed "demo-"), FK-safe: nulls attribution call links
   * and contact/rep references before deleting calls → contacts → users.
   * Called after a successful LIVE HighLevel sync so real provider data
   * replaces demo content (idempotent; no-op when no demo rows remain).
   */
  deleteDemoHighLevelRows(): Promise<{ users: number; contacts: number; calls: number }>;
  /**
   * Remove rows the demo generator seeded for the ACUITY provider (appointment
   * ids prefixed "demo-", blocked times with provider="acuity" and demo
   * external ids). Called after a successful LIVE Acuity sync so demo slots
   * never mix with live availability (owner spec: no demo/live mixing).
   * Manual blocks (provider="manual") and recurring blocks (settings) are
   * untouched. Idempotent; no-op when no demo rows remain.
   */
  deleteDemoAcuityRows(): Promise<{ appointments: number; blocked: number }>;
  upsertAppointments(
    rows: (AppointmentRow & {
      acuity_appointment_id: string;
      client_name?: string | null;
      client_phone?: string | null;
      client_email?: string | null;
      /** S7c: ET business date of the authoritative creation instant. */
      created_business_date?: string | null;
      created_time_source?: string | null;
      created_time_precision?: string | null;
      /** S7c: FULL provider object (appointments.raw). */
      raw?: Record<string, unknown> | null;
      /** BOOKING WIN payment model (rev 12; derived by the sync via payments.ts). */
      payment_state?: string | null;
      /** ET business date the deposit was received — win bucket. Write-once: an existing non-null value is never overwritten. */
      booking_win_business_date?: string | null;
      payment_business_date_source?: string | null;
      first_seen_paid_at?: string | null;
      /** Cancellation evidence (write-once at the store): the confirmation instant + path. */
      cancelled_at?: string | null;
      cancellation_source?: string | null;
    })[],
    opts?: IngestOptions,
  ): Promise<number>;
  /**
   * S7c: appointments CREATED on an ET BUSINESS DATE in [start, end] — the
   * created-based metrics bucket reads created_business_date (booking-MADE ET
   * calendar date), inclusive both ends. Replaces the old instant-bounds
   * created_at window that mis-bucketed date-only bookings one ET day early.
   */
  getAppointmentsCreatedBusinessDateBetween(start: string, end: string): Promise<AppointmentRow[]>;
  /**
   * BOOKING WIN metrics bucket (rev 12): the SUPERSET the win-date bucketing
   * needs — appointments whose booking_win_business_date falls in [start, end]
   * (a win counts on the date the deposit was received, regardless of when it
   * was created), UNION appointments with NO persisted win date whose
   * created_business_date falls in [start, end] (not-yet-derived and legacy
   * rows; the metrics layer filters those to wins by the same fallback rules).
   * Callers feed the result through the metrics layer's win filters — unpaid
   * rows in the result never count.
   */
  getAppointmentsByWinBusinessDateBetween(start: string, end: string): Promise<AppointmentRow[]>;
  /**
   * THE SAME win-bucket superset as getAppointmentsByWinBusinessDateBetween,
   * with the client identity columns (client_phone/client_email, stored
   * normalized) joined in — the per-source booking attribution's phone/email
   * fallback tier reads them. READ-ONLY; win filters stay in the metrics layer.
   */
  getWinsWithClientsBetween(start: string, end: string): Promise<(AppointmentRow & {
    client_phone: string | null;
    client_email: string | null;
  })[]>;
  getAppointmentsOverlapping(startUtc: string, endUtc: string): Promise<AppointmentRow[]>;
  getAllAppointmentsSince(startUtc: string): Promise<AppointmentRow[]>;
  /** Appointments with client contact fields joined (unattributed-bookings queue).
   *  excludePendingDismissed (owner request 2026-09-30): drops owner-dismissed
   *  pending payments (pending_dismissed_at non-null) — ONLY the Today page's
   *  pending list passes it; the attribution tick + unattributed queue use the
   *  default so dismissed appointments stay in the engine. */
  getAppointmentsWithClientsSince(startUtc: string, opts?: { excludePendingDismissed?: boolean }): Promise<(AppointmentRow & {
    acuity_appointment_id: string | null;
    client_name: string | null;
    client_phone: string | null;
    client_email: string | null;
    calendar_name: string | null;
  })[]>;
  /**
   * PENDING PAYMENT DISMISSAL (owner request 2026-09-30): mark ONE appointment's
   * pending payment as dismissed by the owner. Sets pending_dismissed_at
   * (keep-first, idempotent); the appointment row itself is NEVER deleted —
   * Acuity is the source of truth and the sync would re-create it. Affects
   * ONLY the pending list: a later-paid appointment still counts as a Booking
   * Win everywhere (paid wins are never dismissible — callers guard).
   */
  dismissPendingPayment(appointmentId: string): Promise<void>;
  /**
   * CANCELLATION RECONCILIATION (owner report 2026-10-06): mark appointments
   * whose cancellation was CONFIRMED via the Acuity single-appointment GET.
   * Monotone (false→true only), write-once stamps (COALESCE/keep-first), win
   * evidence untouched, demo ids skipped. Returns rows actually flipped.
   */
  markAppointmentsCancelled(acuityIds: string[], cancelledAtIso: string, source: string): Promise<number>;
  /**
   * FLAG LIST (owner report 2026-10-06): appointments counted as Booking Wins
   * (persisted win bucket) that are NOW confirmed cancelled — the honest
   * report-only surface for already-counted wins; stored closed records are
   * never rewritten.
   */
  getCancelledWinAppointments(): Promise<(AppointmentRow & { acuity_appointment_id: string | null })[]>;

  // attributions
  /**
   * Replace-attribution upsert (the ONE engine persist path). WRITER
   * PROTECTION (owner directive 2026-09-27): the write runs under a PG
   * advisory lock (one writer at a time; no-op in the memory store) and the
   * DEGRADATION GUARD — a write that would strip attribution from a large
   * share of the currently-attributed rows it touches (the 49→3 stale-writer
   * shape) throws and the table is left untouched. `force` bypasses the
   * degradation guard for a deliberate recovery recompute (manual_override
   * rows are still skipped, always).
   */
  upsertAttributions(rows: AttributionRow[], opts?: { force?: boolean; deadline?: RunDeadline }): Promise<number>;
  getAttributions(): Promise<AttributionRow[]>;
  /** Manual assignment from the overrides UI — force-writes method="manual", manual_override=true. */
  setManualAttribution(row: AttributionRow): Promise<void>;
  /**
   * Remove ONE appointment's attribution row entirely (manual UNASSIGN). The
   * row is computed data — deleting it returns the appointment to the engine's
   * control, and the next attribution tick recomputes it from raw rows.
   */
  deleteAttribution(appointmentId: string): Promise<void>;
  /**
   * OWNER DESIGNATION (directive 2026-11-04): mark ONE appointment as a
   * proven client-created Online Booking — the exact sticky row shape the
   * creation-source engine feeds back in (deriveCreationSourceEvidence):
   * rep NULL, call NULL, method "owner-designation", reason_code
   * "online-booking", manual_override TRUE, confidence 1. manual_override=true
   * also pins the row through the tick's manual-wins path, so the designation
   * survives every re-derivation until explicitly undone.
   */
  setOnlineBookingDesignation(appointmentId: string, note: string): Promise<void>;
  /**
   * UNDO of the designation: restore the NEUTRAL row (method "none", rep NULL,
   * call NULL, reason_code NULL, manual_override false) — the next attribution
   * tick re-derives the appointment from evidence like any other row. No-op
   * when the appointment has no row.
   */
  clearOnlineBookingDesignation(appointmentId: string, note: string | null): Promise<void>;

  // leads
  upsertLeads(
    rows: (LeadRow & { source_id: string; provider: string; name?: string | null; phone?: string | null; email?: string | null; source_raw_date?: string | null })[],
    opts?: IngestOptions,
  ): Promise<number>;
  /**
   * Remove every stored lead for one source sheet (provider google_sheets,
   * e.g. "family"). NOT used by the Sheets sync anymore — the sync is
   * upsert-only under content keys (v2) and never mass-deletes stored leads
   * a fetch didn't include. Kept as an explicit store primitive for tests and
   * deliberate repairs. Manual lead-count adjustments live in their own table
   * and are unaffected.
   */
  deleteLeadsForSheet(sourceSheet: string): Promise<void>;
  /**
   * All stored leads of one provider with their FULL identity columns
   * (source_id, name, phone, email) — the re-key migration and the sheets
   * sync's drift guard read these. Heavier than getLeadsByWorkDates; not for
   * per-request page paths.
   */
  getLeadsByProvider(provider: string): Promise<(LeadRow & { source_id: string; provider: string; name: string | null; phone: string | null; email: string | null; source_raw_date?: string | null })[]>;
  /** Delete stored leads by exact provider + source_id (re-key migration, demo purge). Returns rows deleted. */
  deleteLeadsBySourceIds(provider: string, sourceIds: string[]): Promise<number>;
  getLeadsByWorkDates(dates: string[]): Promise<LeadRow[]>;
  /**
   * Read-only counterpart of getLeadsByWorkDates keyed on SOURCE_DATE (the
   * date the lead entered the sheet). The Weekly Report's lead section and
   * assigned-lead conversion denominator are source-dated (owner directive
   * 2026-09-29) — work_date deliberately does NOT biject with source_date
   * across a week boundary (Fri/Sat/Sun sources work the NEXT Monday), so a
   * work-date fetch cannot substitute. Presentation reads only; never written.
   */
  getLeadsBySourceDates(dates: string[]): Promise<LeadRow[]>;
  /**
   * PER-SOURCE ATTRIBUTION join fetch: leads whose source_date falls in the
   * INCLUSIVE range [startSourceDate, endSourceDate], with the identity
   * columns (contact_id/phone/email/created_at) the booking→source join and
   * the lead-cohort outcomes read. READ-ONLY materialization of stored rows;
   * the metric-layer filters stay in metrics/source-attribution.ts.
   */
  getLeadsJoinRange(startSourceDate: string, endSourceDate: string): Promise<LeadJoinRow[]>;
  /**
   * Cheap count of a provider's stored leads (no row materialization). Used by
   * the Sheets sync's demo-seed guard: demo rows may only ever seed a dataset
   * with NO stored google_sheets leads — live data is never demo-replaced.
   */
  countLeads(provider: string): Promise<number>;
  /** Manual work-date correction (overrides UI); caller writes the audit row. */
  updateLeadWorkDate(id: string, workDate: string): Promise<void>;

  // lead count adjustments (manual corrections; applied inside the metrics layer)
  upsertLeadCountAdjustment(row: Omit<LeadCountAdjustmentRow, "updated_at">): Promise<void>;
  getLeadCountAdjustments(dates: string[]): Promise<LeadCountAdjustmentRow[]>;

  // availability
  /** Mirror refresh (REPLACE semantics): the list is the COMPLETE rule set; multi-block per weekday supported. */
  upsertAvailabilityRules(rows: AvailabilityRule[]): Promise<void>;
  getAvailabilityRules(): Promise<AvailabilityRule[]>;
  upsertBlockedTimes(rows: (BlockedTimeRow & { provider: string; external_id: string })[]): Promise<number>;
  getBlockedTimesBetween(startUtc: string, endUtc: string): Promise<BlockedTimeRow[]>;
  /** Manual one-off block (overrides UI); provider="manual", external_id generated. */
  insertBlockedTime(row: { start_at: string; end_at: string; reason: string | null }): Promise<BlockedTimeRow>;
  deleteBlockedTime(id: string): Promise<void>;

  // daily priorities
  upsertDailyPriorities(row: DailyPrioritiesRow): Promise<void>;
  getDailyPriorities(date: string): Promise<DailyPrioritiesRow | null>;

  // integrations + sync
  upsertConnection(row: ConnectionRow): Promise<void>;
  getConnections(): Promise<ConnectionRow[]>;
  insertSyncRun(provider: string): Promise<string>;
  /** Resolves true when the transition applied (the run was still 'running');
   * false when the run was already reaped/finished — a late zombie's finish
   * never overwrites the reaper's record. */
finishSyncRun(id: string, status: string, recordsUpserted: number, error: string | null): Promise<boolean>;
  getSyncRuns(limit: number): Promise<SyncRunRow[]>;
  /**
   * The most recent SUCCESSFUL sync_runs row per provider, keyed by provider,
   * value = the row's finished_at normalized to ISO (fallback: started_at —
   * a success row is always finished, this is belt-and-braces). Providers
   * with no success row in their history are ABSENT from the map.
   *
   * Reliability Phase 2a (owner directive 2026-10-16): the freshness
   * watchdog + /health read this instead of getSyncRuns(200)'s recency
   * window — at the 90s HighLevel cadence 200 rows span only a few hours,
   * so a provider stale for longer than that would look "fresh" to any
   * recent-N read. Deliberately NOT wrapped in the pg read cache: /health
   * must answer with the current truth, and the per-provider indexed query
   * is already fast.
   */
  getLatestSuccessfulSyncRunByProvider(): Promise<Record<string, string>>;
  /**
   * EVERY in-flight sync_runs row (status=running, finished_at null) of any
   * age, oldest first — the stale-run reaper's full scan. NOT bounded by
   * getSyncRuns' recent-N window: at the ~90s sync cadence the 200 most
   * recent runs span only a few hours, which is exactly how zombies older
   * than that survived the reaper (the 2026-09-27 HighLevel row: 37h).
   */
  getRunningSyncRuns(): Promise<SyncRunRow[]>;
  /**
   * The in-flight sync_runs row for a provider (status=running, finished_at
   * null), or null. Guards background/manual sync overlap.
   * FRESHNESS BOUND (owner directive 2026-09-28): a running row older than
   * STALE_RUN_REAP_MINUTES is a hung process — reported as NOT running so a
   * zombie can never wedge the header's "Syncing…" indicator or the tick
   * guards; the reaper marks it failed on the next tick. An unparsable
   * started_at is treated as stale (null), never a crash.
   */
  getRunningSyncRun(provider: string): Promise<SyncRunRow | null>;
  /** Incremental HighLevel sync watermark (ISO timestamp: everything before it is already stored), or null when never synced. */
  getSyncWatermark(provider: string): Promise<string | null>;
  setSyncWatermark(provider: string, watermarkIso: string): Promise<void>;
  /** Generic named checkpoint KV (jsonb value) — used by resumable backfill jobs (e.g. the HL contacts backfill cursor). */
  getSyncCheckpoint(key: string): Promise<string | null>;
  setSyncCheckpoint(key: string, value: string): Promise<void>;

  // call harvest (resumable; see src/server/sync/call-harvest.ts)
  /** One progress row per listing pass (id e.g. 'highlevel-calls-calllast' or 'highlevel-calls-all'). */
  getHarvestProgress(id?: string): Promise<HarvestProgressRow | null>;
  saveHarvestProgress(p: HarvestProgressRow): Promise<void>;
  upsertHarvestConversations(rows: HarvestConvRow[]): Promise<number>;
  /** Conversation ledger rows for the given HL conversation ids (parent-contact resolution). */
  getHarvestConversationsByIds(convIds: string[]): Promise<HarvestConvRow[]>;
  /** Upsert call-message ledger rows (harvest_calls mirror; the backfill's direct tier). */
  upsertHarvestCalls(rows: HarvestCallRow[]): Promise<number>;
  /** Call-message ledger rows for the given HL message ids (direct-contact resolution). */
  getHarvestCallsByMessageIds(messageIds: string[]): Promise<HarvestCallRow[]>;
  /** Harvest ledger rows started at/after startUtc (s1 window-interaction evidence read). */
  getHarvestCallsSince(startUtc: string): Promise<HarvestCallRow[]>;
  /** Upsert non-call conversation messages (SMS/live-chat) as attribution evidence (dedupe by message id). */
  upsertEvidenceMessages(rows: EvidenceMessageRow[]): Promise<number>;
  /** Evidence messages date_added at/after startUtc (s1 SMS-evidence read). */
  getEvidenceMessagesSince(startUtc: string): Promise<EvidenceMessageRow[]>;
  /**
   * RAW HighLevel call-record upsert (call-source W1, owner directive
   * 2026-11-04): one row per /conversations/messages/export record, dedupe by
   * message_id — re-seeing a record (5-min watermark overlap, re-runs) is
   * harmless and never duplicates. Writes ONLY hl_call_records; the `calls` /
   * `harvest_calls` pipelines stay untouched until the W3 KPI switch.
   */
  upsertHlCallRecords(rows: HlCallRecordRow[]): Promise<number>;
  /** Stored raw call records for the given HL message ids (ingest diff + tests). */
  getHlCallRecordsByMessageIds(messageIds: string[]): Promise<HlCallRecordRow[]>;
  /** Cheap population count (backfill summary + verification). */
  countHlCallRecords(): Promise<number>;
  /**
   * W3 CALL-KPI SOURCE (owner directive 2026-11-04): raw call records whose
   * date_added falls in [startUtc, endUtc) — the SAME instant-bounds shape as
   * getCallsBetween. Reads ONLY; never drops rows (IVR/null-user rows are
   * filtered/scoped by the metrics layer, not the store).
   */
  getHlCallRecordsBetween(startUtc: string, endUtc: string): Promise<HlCallRecordRow[]>;
  /** Raw call records date_added at/after startUtc (parity with getAllCallsSince). */
  getAllHlCallRecordsSince(startUtc: string): Promise<HlCallRecordRow[]>;
  /**
   * Call→contact restoration verdicts, FILL-NULL-ONLY: an existing non-null
   * calls.contact_id is never touched (direct source data always wins); only
   * NULL contact_ids are filled, and the resolution method/timestamp are
   * recorded on the same row (ambiguous/unresolved keep contact_id NULL).
   */
  applyCallContactBackfill(rows: CallContactBackfillUpdate[]): Promise<void>;
  /** Unvisited conversations with lastMessageDate >= windowStartMs, newest first; call-flagged first when requested. */
  getUnvisitedInWindow(windowStartMs: number, limit: number, callFlaggedFirst: boolean): Promise<HarvestConvRow[]>;
  markHarvestVisited(convIds: string[], callsFoundByConv: Record<string, number>, messagesScannedByConv?: Record<string, number>): Promise<void>;
  /** Aggregated harvest coverage over the window, per ET calendar day of lastMessageDate. */
  getHarvestCoverageSummary(windowStartMs: number): Promise<{
    total: number;
    visited: number;
    callFlagged: number;
    byDay: { day: string; total: number; visited: number }[];
  }>;

  // manual overrides
  insertManualOverride(row: Omit<ManualOverrideRow, "id" | "changed_at">): Promise<void>;
  getManualOverrides(limit: number): Promise<ManualOverrideRow[]>;

  // ---- Performance Management (PIP module, Phase 1 — owner directive 9/30) ----
  // STATUS GUARDS (enforced INSIDE both stores — the UI can never bypass):
  //   draft     → fully editable (document fields only)
  //   issued    → document FROZEN (snapshot written once at issue); check-ins only
  //   completed → fully immutable
  //   cancelled → fully immutable
  // Transitions happen ONLY via these explicit manager actions — nothing
  // auto-transitions, ever.
  /** Create a PIP draft (status born 'draft'; requires rep_id + title). Audit: pip_created. */
  createPip(input: PipCreateInput): Promise<PipRow>;
  /** Edit a DRAFT's document fields. Rejects on any non-draft status. Audit: pip_edited (+ pip_observation_changed). */
  updatePipDraft(id: string, patch: PipDraftPatch): Promise<PipRow>;
  getPip(id: string): Promise<PipRow | null>;
  /** All PIPs (newest first), or only one status when given. */
  listPips(status?: PipStatus | null): Promise<PipRow[]>;
  /**
   * draft → issued. Requires goal_text + pip_start_date + pip_end_date.
   * Writes the version-1 frozen-evidence snapshot (pip_evidence_snapshots)
   * transactionally with the status flip. Audit: pip_issued.
   */
  issuePip(id: string, opts: { issuedBy: string; snapshotExtras?: Record<string, unknown> }): Promise<PipRow>;
  /** issued → completed. Requires conclusion_category + conclusion_notes. Audit: pip_completed. */
  completePip(id: string, opts: { conclusionCategory: string; conclusionNotes: string; actor: string }): Promise<PipRow>;
  /** issued → cancelled. Requires a cancellation reason. Audit: pip_cancelled. */
  cancelPip(id: string, opts: { cancelledBy: string; reason: string }): Promise<PipRow>;
  /**
   * PHASE 4 — record the manager acknowledgment on an ISSUED PIP (stamps
   * manager_acked_at/manager_acked_by, who+when audited). No employee logins:
   * the manager records it (owner directive 9/30). This is the ACTION behind
   * the existing ack_awaiting derivation — the derivation itself is untouched
   * and clears the moment this lands. Guard: issued only; a recorded
   * acknowledgment is never re-stamped. Audit: pip_ack_recorded.
   */
  recordPipAck(id: string, opts: { ackedBy: string }): Promise<PipRow>;
  /** Log a check-in (ISSUED pips only — drafts have no review period yet; terminal states are frozen). Audit: pip_checkin_added. */
  addPipCheckin(row: Omit<PipCheckinRow, "id" | "created_at">): Promise<PipCheckinRow>;
  /** Check-ins of one PIP, oldest first (append-only history). */
  getPipCheckins(pipId: string): Promise<PipCheckinRow[]>;
  /** Frozen-evidence snapshots of one PIP, version ascending. Write-once rows — never updated. */
  getPipEvidenceSnapshots(pipId: string): Promise<PipEvidenceSnapshotRow[]>;
  createPipTemplate(input: PipTemplateCreateInput): Promise<PipTemplateRow>;
  updatePipTemplate(id: string, patch: PipTemplatePatch): Promise<PipTemplateRow>;
  deletePipTemplate(id: string): Promise<void>;
  getPipTemplate(id: string): Promise<PipTemplateRow | null>;
  listPipTemplates(): Promise<PipTemplateRow[]>;
  /** ACTIVE PIPs per template id (draft + issued) — the Phase-4 "in use" counts that tell managers a template is still referenced by a live plan. */
  getPipTemplateUsage(): Promise<Map<string, number>>;
  /** Append a typed module event (also mirrored compactly into manual_overrides by callers' store methods). */
  insertPipEvent(row: Omit<PipEventRow, "id" | "created_at">): Promise<void>;
  /** Module event log, newest first; optionally scoped to one PIP. */
  getPipEvents(opts?: { pipId?: string; limit?: number }): Promise<PipEventRow[]>;

  // ---- Commission Tracker (owner directive 2026-10-01, Phase A) ----
  /** Set/clear ONE rep's commission profile (Settings editor). Null clears (back to ineligible). */
  setUserCommissionProfile(repId: string, profile: CommissionProfileInput | null): Promise<void>;
  /**
   * Upsert ONE weekly record keyed (user_id, week_start) — the close job and the
   * historical backfill share it; re-running NEVER duplicates rows. Phase C
   * SUBMITTED-CYCLE LOCK: a rewrite of a record locked by a submitted cycle is
   * a no-op with an audit row (returns written:false, blocked:true) — stored
   * payroll freezes forever (spec §O/§19).
   */
  upsertCommissionWeeklyRecord(row: CommissionWeeklyRow): Promise<CommissionUpsertResult>;
  /** Weekly records, newest week first; any filter combination narrows the set. */
  getCommissionWeeklyRecords(filter?: { userId?: string; weekStart?: string; cycleId?: string; assignment?: CommissionAssignment }): Promise<CommissionWeeklyRow[]>;
  /**
   * Phase C corrections (spec §O/§20): the ONE audited way stored money moves
   * after approval — a dollars delta applied to manual_adjustment AND total
   * (the auto-calc fields stay frozen). Caller inserts the reason-required
   * adjustment row FIRST; this method only moves the money.
   */
  applyCommissionWeeklyCorrection(userId: string, weekStart: string, deltaDollars: number): Promise<void>;
  /**
   * Phase C week↔cycle membership (spec §S): targeted (user, week) update of
   * ONLY cycle_id/assignment — never money. The lifecycle layer validates +
   * audits; the store performs the surgical update (assignment flips at
   * submission and week re-assignment must not re-run the money upsert).
   */
  setCommissionRecordAssignment(userId: string, weekStart: string, patch: { cycleId: string | null; assignment: CommissionAssignment }): Promise<void>;
  /** Upsert a cycle by id (deterministic slugs; submission freezes the final snapshot, Phase C). */
  upsertCommissionCycle(cycle: CommissionCycleRow): Promise<void>;
  getCommissionCycle(cycleId: string): Promise<CommissionCycleRow | null>;
  /** All cycles, newest start_date first. */
  getCommissionCycles(): Promise<CommissionCycleRow[]>;
  /**
   * Append a corrections-audit row (§O: reason REQUIRED — both stores throw on
   * an empty/blank reason; who/what/old/new/reason/when is the contract).
   */
  insertCommissionAdjustment(row: CommissionAdjustmentInput): Promise<CommissionAdjustmentRow>;
  /** Adjustments, newest first; any filter combination narrows the set. */
  getCommissionAdjustments(filter?: { cycleId?: string; userId?: string; targetId?: string }): Promise<CommissionAdjustmentRow[]>;

  // ---- Availability feed cache (Acuity availability rebuild PR-1) ----
  /**
   * Full-month date-index cache: upsert per (calendar, appointmentType, month)
   * with REPLACE-of-the-row semantics (the fresh answer IS the month's truth,
   * including an EMPTY answer — that is the coverage horizon). Writer runs
   * inside the availability-feed advisory lock in pg (one writer at a time).
   * fetchedAt (optional) stamps the probe instant explicitly — the sweep-age
   * logic (feed-observed-closed vs not-yet-observed) keys off it, so tests pin
   * the fixture instant; production passes the run's own clock reading.
   */
  putAvailabilityDates(rows: AvailabilityDatesInput[], runId: string, fetchedAt?: string): Promise<void>;
  /** Cached month rows for the given months (empty list → []). */
  getAvailabilityDates(months: string[]): Promise<AvailabilityDatesRow[]>;
  /**
   * ONE (calendar, date) times-fetch result, REPLACE semantics for that
   * (calendar, date): the fresh feed answer is the current truth, so rows the
   * feed no longer offers are removed (a booked slot drops out of the feed —
   * the discrepancy detector compares against the CURRENT answer and the
   * mismatch history lives in availability_discrepancies, not in stale rows).
   * Returns the number of rows now present for the (calendar, date).
   */
  putAvailabilitySlotsForDate(calendarId: string, dateEt: string, times: { time_et: string; slots_available: number }[], runId: string): Promise<number>;
  /** Cached open-slot rows for the given ET dates (all calendars), date+time ascending. */
  getAvailabilitySlotsForDates(dates: string[]): Promise<AvailabilitySlotRow[]>;
  /** Open ONE detailed availability run (scope = months/dates/calendars/trigger; pairs with the generic sync_runs row). */
  insertAvailabilitySyncRun(scope: Record<string, unknown>): Promise<string>;
  finishAvailabilitySyncRun(id: string, status: string, callsMade: number, error: string | null): Promise<void>;
  /** Mark every 'running' detailed availability run started before cutoffMs as failed (reaper semantics). */
  reapStaleAvailabilitySyncRuns(cutoffMs: number, error: string): Promise<number>;
  /** Detailed availability-run rows, newest first. */
  getAvailabilitySyncRuns(limit: number): Promise<AvailabilitySyncRunRow[]>;
  /**
   * Apply ONE detector pass over the scanned (calendar, date) pairs (the pairs
   * whose feed state was freshly re-fetched this run): insert each mismatch
   * that has no UNRESOLVED row yet (dedupe on calendar+date+time+kind while
   * unresolved), and RESOLVE (set resolved_at) every still-unresolved row of
   * the scanned pairs that the current feed state no longer shows. Pairs not
   * in `scanned` are untouched (we did not look — never a resolution).
   */
  applyAvailabilityDiscrepancies(runId: string, scanned: { calendar_id: string; date_et: string }[], current: AvailabilityDiscrepancyInput[]): Promise<{ inserted: number; resolved: number }>;
  /** Discrepancy rows, newest detection first; unresolvedOnly narrows to the open list. */
  getAvailabilityDiscrepancies(opts?: { unresolvedOnly?: boolean; limit?: number }): Promise<AvailabilityDiscrepancyRow[]>;
  /**
   * Cache the /calendars + /appointment-types catalog (REPLACE-all — the fresh
   * answer is the truth). Written by every availability-feed run's catalog
   * step; read by the availability page's filter options (PR-3 §3).
   */
  putAvailabilityCatalog(catalog: AvailabilityCatalogInput, runId: string, fetchedAt?: string): Promise<void>;
  /** The cached catalog; empty arrays when no feed run has populated it yet. */
  getAvailabilityCatalog(): Promise<{ calendars: AvailabilityCalendarRow[]; types: AvailabilityTypeRow[] }>;

  // ---- RETENTION IDENTITY CHAIN (stage 2; plan §7; owner-approved D1–D14) ----
  // Idempotence contract shared by BOTH stores: clients are addressed by a
  // deterministic seed_key; link inserts are if-absent on the
  // (provider, entity, external_id) UNIQUE and NEVER update an existing row
  // (manual resolves are sticky — auto passes cannot override them); manual
  // resolveDataMatchException is the ONLY writer allowed to move a link, and
  // it stamps match_method='manual' + an audit trail. Exception inserts are
  // if-absent on dedupe_key. Re-running the backfill therefore mutates
  // nothing (the byte-identical gate criterion).
  /** Deterministic lookup by seed key ('hl-contact:<external_id>'). */
  getInternalClientBySeedKey(seedKey: string): Promise<InternalClientRow | null>;
  /** Insert one client; returns the row with its store-canonical id. Callers look up by seed key first. */
  insertInternalClient(input: InternalClientSeedInput): Promise<InternalClientRow>;
  getInternalClientsByIds(ids: string[]): Promise<InternalClientRow[]>;
  /** Every client (the matcher's candidate universe; production volumes are small — seeded clients only). */
  listInternalClients(): Promise<InternalClientRow[]>;
  /** Every link row (bulk prefetch for the backfill applier's read decisions). */
  listClientMatchLinks(): Promise<ClientMatchLinkRow[]>;
  /** STICKY link writer: insert-if-absent on (provider, entity, external_id); existing rows are returned UNCHANGED with created=false. */
  insertClientMatchLinkIfAbsent(link: ClientMatchLinkInput): Promise<{ link: ClientMatchLinkRow; created: boolean }>;
  getClientMatchLink(provider: string, entity: string, externalId: string): Promise<ClientMatchLinkRow | null>;
  getClientMatchLinksByInternalClient(internalClientId: string): Promise<ClientMatchLinkRow[]>;
  countClientMatchLinks(): Promise<number>;
  /** Dedupe on dedupe_key while open; an existing row is returned UNCHANGED with created=false. */
  insertDataMatchExceptionIfAbsent(input: DataMatchExceptionInput): Promise<{ exception: DataMatchExceptionRow; created: boolean }>;
  getDataMatchExceptions(opts?: { status?: string }): Promise<DataMatchExceptionRow[]>;
  countDataMatchExceptions(status?: string): Promise<number>;
  /** Manual resolution (management action; audited): resolves the exception AND writes/overrides the member link with match_method='manual' — the one writer allowed to move a link. */
  resolveDataMatchException(id: string, resolve: { internalClientId: string; method?: string; resolvedBy: string }): Promise<void>;
  /** Appointment → internal client (via the sticky acuity/appointment link). */
  getInternalClientForAppointment(acuityAppointmentId: string): Promise<InternalClientRow | null>;
  /** GHL contact external ids → internal clients (the call→client resolver core: call.contact_id → contacts.external_id → this). */
  getInternalClientsForContactExternalIds(externalIds: string[]): Promise<{ external_id: string; client: InternalClientRow | null }[]>;
  /** Call ids → internal client (join through contacts + the highlevel/contact link); null when the call has no resolvable client. */
  getInternalClientsForCallIds(callIds: string[]): Promise<{ call_id: string; internal_client_id: string | null }[]>;

  // ---- RETENTION ATTEMPT LEDGER + OUTCOMES (stage 3a; plan §9/§13) ----
  // Write API for the computation job. All reads are bulk (production volumes
  // are small — the 7-day excitement cohort only); all writes are content-
  // diffed by the CALLER (compute.ts) so an unchanged recompute writes nothing.
  /** Every attempt row (bulk read for the diff + tests). */
  listRetentionAttempts(): Promise<RetentionAttemptRow[]>;
  /** Batch insert of NEW attempt rows only (the core pre-dedupes). Returns the number actually inserted. */
  insertRetentionAttempts(rows: RetentionAttemptWrite[]): Promise<number>;
  /** Honest re-observation of ONE existing attempt row (same call — e.g. ringing → terminal); every field supplied is written. */
  updateRetentionAttempt(id: string, patch: Partial<Omit<RetentionAttemptWrite, "source" | "externalMessageId">>): Promise<void>;
  /** Every outcome row (bulk read for the diff + tests). */
  listRetentionAppointmentOutcomes(): Promise<RetentionOutcomeRow[]>;
  /** Batch insert of NEW outcome rows only (the core pre-dedupes). Returns the number actually inserted. */
  insertRetentionAppointmentOutcomes(rows: RetentionOutcomeWrite[]): Promise<number>;
  /** Content update of ONE existing outcome row (recomputed verdict); computed_at is set by the store. */
  updateRetentionAppointmentOutcome(row: RetentionOutcomeWrite): Promise<void>;

  // ---- RETENTION CANCELLATIONS LEDGER (stage 4a; plan §11) ----
  // Same discipline as the attempt/outcome ledger: bulk reads, content-diffed
  // by the CALLER so an unchanged recompute writes nothing.
  /** Every cancellation ledger row (bulk read for the diff + tests). */
  listRetentionCancellations(): Promise<RetentionCancellationRow[]>;
  /** Insert NEW ledger rows only (the engine pre-dedupes by appointment_id). Returns the number actually inserted. */
  insertRetentionCancellations(rows: RetentionCancellationWrite[]): Promise<number>;
  /** Content update of ONE existing ledger row (derived outcome advanced); computed stamp rides notes. */
  updateRetentionCancellation(row: RetentionCancellationWrite): Promise<void>;
  // ---- RETENTION NO-SHOW LEDGER (stage 4b; plan §16 + ruling D10) ----
  // Same discipline as the cancellations ledger: bulk reads, content-diffed
  // by the CALLER so an unchanged recompute writes nothing. session_at /
  // session_date_et / detected_at are WRITE-ONCE (the store COALESCEs them on
  // update); manual_overrides are never touched by the automatic writer.
  /** Every no-show ledger row (bulk read for the diff + the UI family). */
  listRetentionNoShows(): Promise<RetentionNoShowRow[]>;
  /** Insert NEW ledger rows only (the engine pre-dedupes by appointment_id). Returns the number actually inserted. */
  insertRetentionNoShows(rows: RetentionNoShowWrite[]): Promise<number>;
  /** Content update of ONE existing ledger row (follow-up state advanced); write-once fields are preserved. */
  updateRetentionNoShow(row: RetentionNoShowWrite): Promise<void>;
  // ---- RETENTION TRANSFERS LEDGER (stage 5; owner build order "transfers / original-booker exception") ----
  // Same discipline as the no-show/cancellations ledgers: bulk reads,
  // content-diffed by the CALLER so an unchanged recompute writes nothing.
  // detected_at / original_calendar_id / original_calendar_name are WRITE-ONCE
  // (the store COALESCEs them on update); manual_overrides are never touched
  // by the automatic writer.
  /** Every transfer ledger row (bulk read for the diff + the UI family). */
  listRetentionTransfers(): Promise<RetentionTransferRow[]>;
  /** Insert NEW transfer rows only (the engine pre-dedupes by appointment_id). Returns the number actually inserted. */
  insertRetentionTransfers(rows: RetentionTransferWrite[]): Promise<number>;
  /** Content update of ONE existing transfer row (receiving-side evidence advanced); write-once fields are preserved. */
  updateRetentionTransfer(row: RetentionTransferWrite): Promise<void>;
  /** Weekly scorecards (stage 3c): append-if-new storage — a stored week is never rewritten. */
  listRetentionScorecards(): Promise<RetentionScorecardRow[]>;
  getRetentionScorecard(weekStart: string): Promise<RetentionScorecardRow | null>;
  insertRetentionScorecardIfAbsent(row: RetentionScorecardWrite): Promise<{ created: boolean; row: RetentionScorecardRow | null }>;
  /** Management close of an exception WITHOUT a link write (audited via manual_overrides, like resolve). */
  dismissDataMatchException(id: string, opts: { resolvedBy: string }): Promise<void>;

  // ---- RETENTION OWNER HISTORY (read-only this stage; plan §12) ----
  /** Every role-history row, effective_start ascending (the Settings writer lands in the Settings delegation). */
  listRetentionOwnerHistory(): Promise<RetentionOwnerHistoryRow[]>;
}
