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
import type { AttributionRow } from "../metrics/compute";
import type { AppSettings, Store } from "../store/types";

/** Minimum gap between BACKGROUND attribution recomputes (manual skips it). */
export const ATTRIBUTION_MIN_INTERVAL_MS = 5 * 60_000;

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
  const CONFIDENCE: Record<string, number> = { contact_id: 1, phone: 0.8, email: 0.8 };
  const rows: AttributionRow[] = [];
  const manuallyAssignedIds: string[] = [];
  for (const m of matches) {
    const manual = manualByAppt.get(m.appointmentId);
    if (manual) {
      rows.push({ ...manual });
      manuallyAssignedIds.push(m.appointmentId);
      continue;
    }
    if (m.status === "attributed") {
      rows.push({
        id: `attr:${m.appointmentId}`,
        appointment_id: m.appointmentId,
        call_id: (m.callExternalId ? callIdByExternalId.get(m.callExternalId) : null) ?? m.callExternalId ?? null,
        rep_id: m.repId ?? null,
        method: m.method ?? "none",
        confidence: CONFIDENCE[m.method ?? ""] ?? 0.5,
        manual_override: false,
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
      });
    }
  }
  return { rows, manuallyAssignedIds };
}

/**
 * The ONE engine-invocation-and-persist path: run matchAppointmentsToCalls
 * over the stored window and upsert the results. Used by the background tick,
 * the full sync (run.ts) and manual SYNC NOW — one source of truth.
 */
export async function computeAndPersistAttributions(
  store: Store,
  settings: AppSettings,
  options?: { now?: () => Date },
): Promise<AttributionComputationResult> {
  const today = etDateStrFromInstant((options?.now ?? (() => new Date()))().getTime());
  // Look-back: the 30-day appointment window PLUS the attribution window so a
  // call just past the day boundary can still anchor a recent booking.
  const since = etDayStartUtc(addDays(today, -(30 + Math.ceil(settings.attribution_window_hours / 24))));
  const [storedAppts, storedCalls, storedContacts, allUsers, existing] = await Promise.all([
    store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
    store.getAllCallsSince(since),
    store.getContacts(),
    store.getAllUsers(),
    store.getAttributions(),
  ]);

  // OWNER DIRECTIVE: only in-scope Acuity calendars/types may feed attribution
  // — the same appointmentInScope rule every booking-feeding read applies.
  const appts = storedAppts.filter((a) => appointmentInScope(a, settings.acuity));

  const matches = matchAppointmentsToCalls(
    appts,
    storedCalls,
    storedContacts.map((c) => ({ id: c.id, phone: c.phone, email: c.email })),
    {
      meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
      attribution_window_hours: settings.attribution_window_hours,
      rep_mappings: settings.rep_mappings,
    },
    { today, users: allUsers.map((u) => ({ id: u.id, is_active: u.is_active })) },
  );

  const callIdByExternalId = new Map(
    storedCalls.filter((c) => c.external_call_id).map((c) => [c.external_call_id as string, c.id]),
  );
  const { rows, manuallyAssignedIds } = toAttributionRows(matches, existing, callIdByExternalId);
  await store.upsertAttributions(rows);

  return {
    outcome: "synced",
    appointments: appts.length,
    attributed: matches.filter((m) => m.status === "attributed").length,
    unattributed: matches.filter((m) => m.status === "unattributed").length,
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
