/**
 * BACKGROUND ATTRIBUTION TICK — the scheduler wiring for the pure booking
 * attribution engine (src/server/metrics/attribution.ts), pattern-matched on
 * availabilityTick (acuity-live.ts):
 *
 *   - RUNNING GUARD: skip while an "attribution" sync_runs row is in flight
 *     (a stale row older than 12h is a crashed process, not a live one);
 *   - THROTTLE: background triggers run at most once per
 *     ATTRIBUTION_MIN_INTERVAL_MS (5 min) — manual triggers (SYNC NOW /
 *     REFRESH) skip the throttle;
 *   - FAILURES NEVER FAIL THE TICK: errors are recorded on the sync_runs row
 *     and returned, never thrown into the scheduler loop.
 *
 * ONE computation core (computeAndPersistAttributions) is shared by the tick,
 * the full sync (run.ts recomputeAttributions) and therefore manual SYNC NOW —
 * the attribution table always comes from the same engine invocation:
 *
 *   1. Appointments: the last 30 days WITH client contact fields, filtered
 *      through appointmentInScope(a, settings.acuity) — the owner directive:
 *      Zoom bookings never enter attribution (the same scope rule every
 *      booking-feeding read applies).
 *   2. Calls: everything since (30d − attribution window look-back) so calls
 *      just outside the appointment window are still candidates.
 *   3. Contacts + ALL user rows feed the engine's identity indexes and the
 *      roster-eligibility machinery.
 *   4. Results convert to AttributionRow[] (toAttributionRows) and upsert by
 *      appointment_id — a re-run REPLACES prior computed attributions, except
 *      MANUAL WINS: an appointment with a manual_override row keeps it (the
 *      store's upsert skips manual rows; the tick reports those as reason
 *      "manually-assigned" instead of recomputing them).
 */
import { addDays, etDateStrFromInstant, etDayStartUtc } from "../date-logic";
import { appointmentInScope } from "../metrics/availability";
import { matchAppointmentsToCalls, type AttributionMatch } from "../metrics/attribution";
import { assertBookingInvariant, type AttributionRow } from "../metrics/compute";
import { buildRosterEligibility } from "../roster";
import type { AppSettings, Store } from "../store/types";

/** Minimum gap between BACKGROUND attribution recomputes (manual skips it). */
export const ATTRIBUTION_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * WRITER VERSION (owner directive 2026-09-27 — stale/multi-writer protection).
 * Bump on every semantic change to the attribution engine. A writer whose
 * version is LOWER than the latest recorded in sync_checkpoints refuses to
 * upsert and records an error sync_run — an outdated build can never silently
 * rewrite the attribution table with old semantics (the 9/26 stale-writer
 * incident: a pre-engine deployed process rewrote 49→3/121 every 2–5 min).
 * A writer with an EQUAL OR HIGHER version always proceeds (a fresh deploy
 * takes over automatically — the recovery path). `force` bypasses for a
 * deliberate owner-directed recompute.
 *
 * v4 = RULE B (owner-approved 2026-09-28): deterministic email-identity
 *      resolution for junk/shared stored contacts — a junk stored contact
 *      (appointments against it carry ≥2 distinct client emails) resolves via
 *      exact email match to the single non-junk contact, attributed under the
 *      unchanged s1 rules; guard-(b) rows queue with reason_code
 *      "email-resolves-non-roster"; resolved rows carry an
 *      "identity-resolved-via-email" note segment. The version bump retires
 *      v3 writers, whose conflict-updates would revert the resolution.
 * v3 = S4b reason_code persistence (the refined no-rep classification is
 *      written to booking_attributions.reason_code; verdicts unchanged — the
 *      version bump retires v2 writers, whose conflict-updates would leave
 *      stale reason_code values behind).
 * v2 = s1 window-interaction ownership. v1 = all builds before s6 (they carry
 * no version check — operationally retired by the 9/27 republish; from s6 on
 * every shipped writer carries the guard).
 */
export const ATTRIBUTION_WRITER_VERSION = 4;
/** sync_checkpoints key holding the latest writer version that has written. */
export const ATTRIBUTION_WRITER_VERSION_KEY = "attribution-writer-version";

export interface AttributionTickResult {
  outcome: "synced" | "skipped" | "error";
  /** In-scope appointments the engine evaluated. */
  appointments?: number;
  /** Engine rows that ended ATTRIBUTED (rep or mapped rep on the winning call). */
  attributed?: number;
  /** Engine rows that ended UNATTRIBUTED (the honest queue reasons). */
  unattributed?: number;
  /** Appointments whose existing manual_override row was preserved (manual wins). */
  manuallyAssigned?: number;
  reason?: string;
  error?: string;
}

export interface AttributionComputationResult extends AttributionTickResult {
  outcome: "synced";
}

/**
 * Pure conversion: engine matches → AttributionRow[] for the store upsert.
 *
 * - Attributed match → row with the winning call's INTERNAL id (the
 *   eligibility machinery and the queue join attributions.call_id ↔ calls.id)
 *   and the engine's method/confidence.
 * - Unattributed match → row with method "none", rep NULL — an honest,
 *   queryable record of WHY (the queue renders the reason).
 * - Existing manual_override row → MANUAL WINS: the manual row is carried
 *   verbatim (upserting it again is a no-op) and reported as
 *   "manually-assigned"; the engine's judgment for that appointment is never
 *   allowed to overwrite Christopher's assignment.
 */
export function toAttributionRows(
  matches: AttributionMatch[],
  existingAttributions: AttributionRow[],
  callIdByExternalId: Map<string, string>,
): { rows: AttributionRow[]; manuallyAssignedIds: string[] } {
  const manualByAppt = new Map(
    existingAttributions.filter((r) => r.manual_override).map((r) => [r.appointment_id, r]),
  );
  const CONFIDENCE: Record<string, number> = { contact_id: 1, phone: 0.8, email: 0.8, window_interaction: 0.6 };
  const rows: AttributionRow[] = [];
  const manuallyAssignedIds: string[] = [];
  for (const m of matches) {
    const manual = manualByAppt.get(m.appointmentId);
    if (manual) {
      rows.push({ ...manual });
      manuallyAssignedIds.push(m.appointmentId);
      continue;
    }
    // Audit/debug note: persist the window limitation ON the row — the marker
    // plus the exact window dates the match was evaluated against. S7c: the
    // anchor is the AUTHORITATIVE ET business date (created_business_date from
    // Acuity datetimeCreated; date-only rows keep the calendar date), so the
    // window is exact rather than inferred from a stored instant encoding.
    // s1 window-interaction rows PREPEND their evidence (source table + HL
    // message id + duration) so every ownership under the ANY-duration rule is
    // auditable on the stored row.
    const windowNote = m.window
      ? `${m.window.marker} call-dates ${m.window.from}..${m.window.to} ET (anchor=${m.window.anchoredOn})`
      : null;
    const s1Note =
      m.method === "window_interaction" && m.evidence
        ? `s1 window-interaction src=${m.evidence.source} evidence=${m.evidence.id} dur=${m.evidence.duration_seconds ?? "unknown"}`
        : null;
    // RULE B observability: rows whose identity was resolved away from a
    // junk/shared stored contact record WHICH contact was junk and which one
    // the booking resolved to — auditable on the Audit page without re-deriving.
    const resolutionNote = m.emailResolution
      ? `identity-resolved-via-email stored-contact=${m.emailResolution.storedContactId} resolved-contact=${m.emailResolution.resolvedContactId}`
      : null;
    const note = [s1Note, resolutionNote, windowNote].filter((n): n is string => !!n).join("; ") || null;
    if (m.status === "attributed") {
      rows.push({
        id: `attr:${m.appointmentId}`,
        appointment_id: m.appointmentId,
        call_id: (m.callExternalId ? callIdByExternalId.get(m.callExternalId) : null) ?? m.callExternalId ?? null,
        rep_id: m.repId ?? null,
        method: m.method ?? "none",
        confidence: CONFIDENCE[m.method ?? ""] ?? 0.5,
        manual_override: false,
        note,
        reason_code: null,
      });
    } else {
      rows.push({
        id: `attr:${m.appointmentId}`,
        appointment_id: m.appointmentId,
        call_id: null,
        rep_id: null,
        method: "none",
        confidence: 0,
        manual_override: false,
        note: m.reason ? `${m.reason}${m.detail ? ` — ${m.detail}` : ""}${note ? `; ${note}` : ""}` : note,
        // S4b triage category: the refined no-rep classification for
        // no-qualifying-call rows; "ambiguous" rows carry their own marker so
        // grouped queue counts cover the whole queue. RULE B guard (b): the
        // engine's explicit reasonCode (e.g. "email-resolves-non-roster")
        // wins — a DISTINCT queue code the owner can triage separately.
        // NEVER the note's job.
        reason_code: m.reasonCode ?? m.noRepReason ?? (m.reason === "ambiguous" ? "ambiguous" : null),
      });
    }
  }
  return { rows, manuallyAssignedIds };
}

/**
 * The ONE engine-invocation-and-persist path: run matchAppointmentsToCalls
 * over the stored window and upsert the results. Used by the background tick,
 * the full sync (run.ts) and manual SYNC NOW — one source of truth.
 *
 * WRITER PROTECTION (owner directive 2026-09-27):
 *  - writer-version guard — refuse when the latest recorded writer version is
 *    NEWER than this build's (outdated writer; error sync_run, no upsert);
 *  - the store's upsertAttributions additionally holds a PG advisory lock
 *    (one writer at a time) and a degradation guard (refuse a write that
 *    strips a large share of currently-attributed rows — the 49→3 shape);
 *  - options.force bypasses the version check for a deliberate recovery
 *    recompute; the degradation guard's bypass lives on the store call.
 * On any guard refusal the tick records an error sync_run — visible in
 * Settings sync status, never silent.
 */
export async function computeAndPersistAttributions(
  store: Store,
  settings: AppSettings,
  options?: { now?: () => Date; force?: boolean },
): Promise<AttributionComputationResult> {
  const today = etDateStrFromInstant((options?.now ?? (() => new Date()))().getTime());

  // WRITER-VERSION GUARD: an outdated build must never rewrite the table with
  // old semantics. The latest writer version is stored machinery state
  // (sync_checkpoints — no settings/UI entanglement, no schema change).
  // ABSENCE of a recorded checkpoint is the fresh-store case and behaves like
  // the takeover case: this writer PROCEEDS and stamps its version below —
  // the first writer on a fresh store always writes. Only a RECORDED version
  // newer than this build refuses (outdated writer).
  const storedVersionRaw = await store.getSyncCheckpoint(ATTRIBUTION_WRITER_VERSION_KEY);
  const storedVersion = storedVersionRaw != null ? Number(storedVersionRaw) : null;
  if (!options?.force && storedVersion != null && Number.isFinite(storedVersion) && storedVersion > ATTRIBUTION_WRITER_VERSION) {
    throw new Error(
      `writer-version guard: stored writer v${storedVersion} is newer than this writer v${ATTRIBUTION_WRITER_VERSION} — refusing to upsert (outdated writer; deploy the current build, or recompute with force)`,
    );
  }

  // Look-back: the 30-day appointment window PLUS the call window. The
  // owner-ratified window is DATE-GRANULARITY (call ET date == booking
  // creation ET date or the day before — at most 2 ET days back), so 2 days
  // is the real requirement; the legacy hour-based setting can only widen the
  // margin, never narrow it below 2.
  const since = etDayStartUtc(addDays(today, -(30 + Math.max(2, Math.ceil(settings.attribution_window_hours / 24)))));
  const [storedAppts, storedCalls, storedContacts, allUsers, existing, harvestCalls] = await Promise.all([
    store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
    store.getAllCallsSince(since),
    store.getContacts(),
    store.getAllUsers(),
    store.getAttributions(),
    store.getHarvestCallsSince(since),
  ]);

  // OWNER DIRECTIVE: only in-scope Acuity calendars/types may feed attribution
  // — the same appointmentInScope rule every booking-feeding read applies —
  // and only QUALIFYING bookings (non-cancelled) need verdicts: the coverage
  // invariant counts qualifying bookings, and a cancelled booking is never a
  // sale the engine should chase.
  const appts = storedAppts.filter(
    (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
  );

  // s1 harvest interactions (parent-conversation user ownership): a harvested
  // conversation call message is VERIFIED ROSTER evidence only when its HL
  // user resolves to an ACTIVE roster user (or an owner-configured
  // rep_mapping). Everything else passes rep_id null and is never evidence.
  // Resolving here keeps the engine pure — the caller owns roster truth.
  const activeHlUserByExt = new Map(
    allUsers
      .filter((u) => u.provider === "highlevel" && u.external_id && u.is_active)
      .map((u) => [u.external_id as string, u.id]),
  );
  const harvestElig = buildRosterEligibility(
    allUsers.map((u) => ({ id: u.id, is_active: u.is_active })),
    settings.rep_mappings ?? [],
  );
  const s1Interactions = harvestCalls.map((h) => ({
    id: h.message_id,
    contact_external_id: h.contact_external_id,
    rep_id:
      (h.user_external_id ? activeHlUserByExt.get(h.user_external_id) : undefined) ??
      (h.user_external_id ? harvestElig.mapping.get(h.user_external_id) ?? null : null),
    started_at: h.started_at,
    duration_seconds: h.duration_seconds,
  }));

  const matches = matchAppointmentsToCalls(
    appts,
    storedCalls,
    storedContacts.map((c) => ({
      id: c.id,
      phone: c.phone,
      email: c.email,
      external_id: c.external_id,
      // RULE B guard (b): the contact's stored owner feeds the
      // active-roster check on email-resolved junk-contact bookings.
      assigned_rep_id: c.assigned_rep_id,
    })),
    {
      meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
      attribution_window_hours: settings.attribution_window_hours,
      rep_mappings: settings.rep_mappings,
    },
    { today, users: allUsers.map((u) => ({ id: u.id, is_active: u.is_active })), s1Interactions },
  );

  const callIdByExternalId = new Map(
    storedCalls.filter((c) => c.external_call_id).map((c) => [c.external_call_id as string, c.id]),
  );
  const { rows, manuallyAssignedIds } = toAttributionRows(matches, existing, callIdByExternalId);

  // METRIC INVARIANT (owner-ratified): the engine must produce exactly one
  // verdict per in-scope, non-cancelled appointment — attributed +
  // unattributed equals the ENGINE POPULATION (paid AND pending; pending
  // bookings keep their verdict row ready for the day the deposit lands,
  // while the coverage split counts Booking Wins = paid only). A violation is
  // a wiring/engine regression: record it as a sync error, never persist a
  // dishonest split.
  const attributedCount = matches.filter((m) => m.status === "attributed").length;
  const unattributedCount = matches.filter((m) => m.status === "unattributed").length;
  assertBookingInvariant(appts, rows, { engineAttributed: attributedCount, engineUnattributed: unattributedCount });

  await store.upsertAttributions(rows, { force: options?.force ?? false });

  // STAMP: this writer's version is now the latest that has written (takeover
  // — a fresh deploy always takes over; equal versions are idempotent).
  if (storedVersion !== ATTRIBUTION_WRITER_VERSION) {
    await store.setSyncCheckpoint(ATTRIBUTION_WRITER_VERSION_KEY, String(ATTRIBUTION_WRITER_VERSION));
  }

  return {
    outcome: "synced",
    appointments: appts.length,
    attributed: attributedCount,
    unattributed: unattributedCount,
    manuallyAssigned: manuallyAssignedIds.length,
  };
}

// ---------- the tick (availabilityTick pattern) ----------

/** A "running" attribution sync_runs row older than this is a crashed process. */
const STALE_RUNNING_CUTOFF_MS = 12 * 3_600_000;

/** Module-level background throttle stamp (manual triggers skip the throttle). */
let lastBackgroundTickAt = 0;

/** Test seam: clear the background throttle between tests. */
export function resetAttributionThrottle(): void {
  lastBackgroundTickAt = 0;
}

/**
 * One attribution recompute, injectable for tests (no clock, no live API —
 * everything reads from the store). Guards: skip while an attribution sync
 * run is in flight, throttle background runs to ATTRIBUTION_MIN_INTERVAL_MS.
 * Failures are recorded on the sync_runs row and returned — never thrown into
 * the scheduler loop.
 */
export async function attributionTick(options?: {
  store?: Store;
  settings?: AppSettings;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<AttributionTickResult> {
  const now = options?.now ?? (() => new Date());
  const store = options?.store ?? (await import("../store").then((m) => m.getStore()));
  const settings = options?.settings ?? (await store.getSettings());
  const trigger = options?.trigger ?? "background";

  const running = await store.getRunningSyncRun("attribution");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > STALE_RUNNING_CUTOFF_MS;
    if (!stale) return { outcome: "skipped", reason: "sync-in-progress" };
  }

  if (trigger === "background") {
    if (now().getTime() - lastBackgroundTickAt < ATTRIBUTION_MIN_INTERVAL_MS) {
      return { outcome: "skipped", reason: "recent-tick" };
    }
  }

  const runId = await store.insertSyncRun("attribution");
  try {
    const res = await computeAndPersistAttributions(store, settings, { now });
    await store.finishSyncRun(runId, "success", res.attributed + res.unattributed, null);
    if (trigger === "background") lastBackgroundTickAt = now().getTime();
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(runId, "error", 0, msg);
    return { outcome: "error", error: msg };
  }
}
