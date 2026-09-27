/**
 * BACKGROUND SCHEDULER — near-real-time freshness for HighLevel data.
 *
 * Started from serve.ts (runs with the serving process; no manual script).
 * Every `highlevel_sync_interval_seconds` (settings, default 90, clamp
 * 30–3600) it runs one TICK:
 *
 *   1. SKIP if a sync run for highlevel is already in progress (sync_runs row
 *      with status='running') — a backfill or manual sync owns the provider.
 *      A running row older than STALE_RUNNING_CUTOFF_HOURS is treated as a
 *      crashed process and ignored so it cannot wedge the scheduler forever.
 *   2. SKIP when no HighLevel credentials resolve (demo mode).
 *   3. No watermark yet → run the FULL sync (runDemoSync) once; it harvests
 *      the 30-day window and sets the watermark on success.
 *      Watermark present → INCREMENTAL harvest of only newer activity.
 *   4. On success: advance the watermark to the tick start, upsert the
 *      connection row (connected / not-demo), and RECOMPUTE ATTRIBUTIONS so
 *      bookings-from-calls stays current.
 *   5. On failure: record the error on the connection row (keeping the last
 *      successful timestamp) and keep retrying on the next tick.
 */
import { getStore, type Store } from "../store";
import type { AppSettings } from "../store/types";
import { isRosterUser } from "../roster";
import { readHighLevelCreds, type HighLevelCreds } from "./highlevel-live";
import { harvestIncremental, WATERMARK_OVERLAP_SECONDS } from "./highlevel-incremental";
import { recomputeAttributions, runDemoSync } from "./run";
import { availabilityTick, type AvailabilityTickResult } from "./acuity-live";
import { attributionTick, type AttributionTickResult } from "./attribution-tick";

/** A "running" sync_runs row older than this is a crashed process, not a live one. */
export const STALE_RUNNING_CUTOFF_HOURS = 12;

/** Pure interval resolution: settings value clamped; anything non-finite → default 90. */
export function readSchedulerIntervalSeconds(raw: unknown): number {
  const DEFAULT = 90;
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : DEFAULT;
  return Math.min(3600, Math.max(30, n));
}

export interface SchedulerTickResult {
  outcome: "synced" | "skipped" | "error";
  reason?: string;
  mode?: "incremental" | "full";
  calls?: number;
  contacts?: number;
  users?: number;
  attributions?: number;
  error?: string;
  /** Independent Acuity availability refresh piggy-backed on the same tick (never fails the tick). */
  availability?: AvailabilityTickResult;
  /** Independent attribution recompute piggy-backed on the same tick (never fails the tick). */
  attribution?: AttributionTickResult;
}

/** Attribution recompute wrapped in its own sync_runs row (visible in the Sync Center). */
async function runAttributionRun(store: Store, settings: AppSettings, opts?: { force?: boolean }): Promise<number> {
  const runId = await store.insertSyncRun("attribution");
  try {
    const n = await recomputeAttributions(store, settings, opts);
    await store.finishSyncRun(runId, "success", n, null);
    return n;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(runId, "error", 0, msg);
    throw e;
  }
}

/**
 * HighLevel portion of a tick (incremental harvest / bootstrap full sync).
 * Wrapped by schedulerTick, which piggy-backs the independent availability
 * refresh. Injectable for tests: store, creds, fetchImpl, sleep and the clock
 * are all options — no live API and no real time needed.
 */
async function highlevelTick(options?: {
  store?: Store;
  settings?: AppSettings;
  creds?: HighLevelCreds | null;
  fetchImpl?: (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  trigger?: "background" | "manual";
  /** Test injection for the bootstrap full-sync path; absent in production (real adapters). */
  liveAdapters?: { sheets: null; highlevel: import("./highlevel-live").LiveHighLevelAdapter };
  acuityAdapter?: import("./acuity-live").AcuityLiveAdapter | null;
}): Promise<SchedulerTickResult> {
  const now = options?.now ?? (() => new Date());
  const store = options?.store ?? (await getStore());
  const settings = options?.settings ?? (await store.getSettings());

  // --- skip 1: a sync run for this provider is already in progress ---
  const running = await store.getRunningSyncRun("highlevel");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = Number.isFinite(startedMs) && now().getTime() - startedMs > STALE_RUNNING_CUTOFF_HOURS * 3_600_000;
    if (!stale) return { outcome: "skipped", reason: "sync-in-progress", error: undefined };
  }

  // --- skip 2: no credentials (demo mode) — nothing incremental to fetch ---
  const creds = "creds" in (options ?? {}) ? (options?.creds ?? null) : readHighLevelCreds();
  if (!creds) return { outcome: "skipped", reason: "no-credentials" };

  const tickStart = now();
  const tickStartIso = tickStart.toISOString();

  try {
    // --- no watermark yet → one full bootstrap sync (sets the watermark) ---
    const watermark = await store.getSyncWatermark("highlevel");
    if (!watermark) {
      const adapterOpts = options?.liveAdapters
        ? { sheetsAdapter: options.liveAdapters.sheets, highlevelAdapter: options.liveAdapters.highlevel }
        : {};
      const acuityOpt = options && "acuityAdapter" in options ? { acuityAdapter: options.acuityAdapter } : {};
      // BOOTSTRAP = the fresh-writer takeover (owner directive 2026-09-27): on
      // a store with NO watermark there are no production verdicts to protect
      // — the table (if any) holds demo-computed rows the live sync is
      // replacing wholesale. The current writer's first write on a fresh store
      // always writes: pass force so the degradation guard's stale-writer
      // shape cannot brick the bootstrap. SYNC NOW / incremental paths never
      // set this — the guard stays fully enforced there.
      const full = await runDemoSync({ store, settings, ...adapterOpts, ...acuityOpt, attributionForce: true });
      const hlError = full.providers.find((p) => p.provider === "highlevel")?.error ?? null;
      if (hlError) return { outcome: "error", mode: "full", error: hlError };
      const after = await runAttributionRun(store, settings, { force: true });
      return { outcome: "synced", mode: "full", attributions: after };
    }

    // --- incremental: only activity newer than the watermark (minus overlap) ---
    const runId = await store.insertSyncRun("highlevel");
    try {
      const sinceMs = Date.parse(watermark) - WATERMARK_OVERLAP_SECONDS * 1000;
      const harvest = await harvestIncremental({
        creds,
        fetchImpl: options?.fetchImpl ?? fetch,
        sleep: options?.sleep,
        sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0,
      });

      // Upsert users → contacts → calls (same ordering/linking as the full sync).
      // ROSTER RULE: active iff name AND email match settings.active_roster —
      // the full users snapshot arrives every tick, so roster changes apply
      // without any manual step. Non-matching users keep their rows (inactive).
      await store.upsertUsers(
        harvest.users.map((u) => ({
          id: "",
          provider: "highlevel",
          external_id: u.external_id,
          name: u.name,
          email: u.email,
          is_active: isRosterUser(u.name, u.email, settings.active_roster),
        })),
      );
      // Linkage needs EVERY user (inactive included) so excluded users' rows
      // keep their rep references — raw rows stay resolvable for future needs.
      const storedUsers = await store.getAllUsers();
      const userIdByExt = new Map(storedUsers.map((u) => [`${u.provider}:${u.external_id}`, u.id]));
      if (harvest.contacts.length) {
        await store.upsertContacts(
          harvest.contacts.map((c) => ({
            id: "",
            provider: "highlevel",
            external_id: c.external_id,
            name: c.name,
            phone: c.phone,
            email: c.email,
            assigned_rep_id: c.assignedRepExternalId ? userIdByExt.get(`highlevel:${c.assignedRepExternalId}`) ?? null : null,
          })),
        );
      }
      const storedContacts = await store.getContacts();
      const contactIdByExt = new Map(storedContacts.map((c) => [`${c.provider}:${c.external_id}`, c.id]));
      if (harvest.calls.length) {
        await store.upsertCalls(
          harvest.calls.map((c) => ({
            provider: "highlevel",
            external_call_id: c.external_call_id,
            rep_id: userIdByExt.get(`highlevel:${c.repExternalId}`) ?? null,
            contact_id: contactIdByExt.get(`highlevel:${c.contactExternalId}`) ?? null,
            started_at: c.startedAt,
            duration_seconds: c.durationSeconds,
            over_two_minutes: c.durationSeconds > settings.meaningful_call_threshold_seconds,
            direction: c.direction,
            call_status: c.status,
          })),
        );
      }

      const records = harvest.calls.length + harvest.contacts.length + harvest.users.length;
      await store.finishSyncRun(runId, "success", records, null);

      // Roster hygiene: purge any demo rows that predate the live connection
      // (idempotent, no-op once clean) so demo reps can never resurface here.
      const purged = await store.deleteDemoHighLevelRows();
      const purgedTotal = purged.users + purged.contacts + purged.calls;

      // Success: advance the watermark, refresh the connection row, recompute attributions.
      await store.setSyncWatermark("highlevel", tickStartIso);
      const attributions = await runAttributionRun(store, settings);
      const nowIso = now().toISOString();
      const previous = (await store.getConnections()).find((c) => c.provider === "highlevel");
      await store.upsertConnection({
        provider: "highlevel",
        status: "connected",
        is_demo: false,
        last_sync_at: nowIso,
        last_successful_sync_at: nowIso,
        last_error: null,
        config: {
          ...(previous?.config ?? {}),
          source: "highlevel-api",
          note: `Incremental sync (${options?.trigger ?? "background"}): +${harvest.calls.length} calls, ${harvest.conversationsVisited} conversations${purgedTotal > 0 ? ` · demo rows purged: ${purgedTotal}` : ""}${harvest.warnings.length ? ` · ${harvest.warnings[0]}` : ""}`.slice(0, 500),
        },
      });
      return {
        outcome: "synced",
        mode: "incremental",
        calls: harvest.calls.length,
        contacts: harvest.contacts.length,
        users: harvest.users.length,
        attributions,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await store.finishSyncRun(runId, "error", 0, msg);
      throw e;
    }
  } catch (e) {
    // Failure: record on the connection row, keep the last successful sync
    // timestamp, keep retrying next tick. The message never contains secrets.
    const msg = e instanceof Error ? e.message : String(e);
    const previous = (await store.getConnections()).find((c) => c.provider === "highlevel");
    await store.upsertConnection({
      provider: "highlevel",
      status: "error",
      is_demo: false,
      last_sync_at: now().toISOString(),
      last_successful_sync_at: previous?.last_successful_sync_at ?? null,
      last_error: msg,
      config: {
        ...(previous?.config ?? {}),
        source: previous?.config && typeof previous.config.source === "string" ? previous.config.source : "highlevel-api",
        note: `Background sync failed — retrying next tick. ${msg}`.slice(0, 500),
      },
    });
    return { outcome: "error", error: msg };
  }
}

// ---------- composed tick (HighLevel + independent availability refresh) ----------

/**
 * One scheduler tick = the HighLevel harvest PLUS two independent refreshes:
 * the Acuity availability sync and the booking-attribution recompute (the
 * pure engine over stored rows — scope-filtered, manual overrides win).
 * Both piggy-backed refreshes record their failures (sync_runs rows) and
 * report them on the result — they never fail the tick or crash the scheduler
 * loop. Background refreshes are throttled (ACUITY_MIN_INTERVAL_MS /
 * ATTRIBUTION_MIN_INTERVAL_MS); manual triggers (REFRESH / SYNC NOW) skip the
 * throttle.
 */
export async function schedulerTick(options?: {
  store?: Store;
  settings?: AppSettings;
  creds?: HighLevelCreds | null;
  fetchImpl?: (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  trigger?: "background" | "manual";
  liveAdapters?: { sheets: null; highlevel: import("./highlevel-live").LiveHighLevelAdapter };
  /** Test injection for the availability refresh; absent → resolve from env (null when no creds → skip). */
  acuityAdapter?: import("./acuity-live").AcuityLiveAdapter | null;
}): Promise<SchedulerTickResult> {
  const base = await highlevelTick(options);
  let availability: AvailabilityTickResult;
  try {
    availability = await availabilityTick({
      store: options?.store,
      now: options?.now,
      trigger: options?.trigger,
      ...(options && "acuityAdapter" in options ? { adapter: options.acuityAdapter } : {}),
    });
  } catch (e) {
    availability = { outcome: "error", error: e instanceof Error ? e.message : String(e) };
  }
  let attribution: AttributionTickResult;
  try {
    attribution = await attributionTick({
      store: options?.store,
      settings: options?.settings,
      now: options?.now,
      trigger: options?.trigger,
    });
  } catch (e) {
    attribution = { outcome: "error", error: e instanceof Error ? e.message : String(e) };
  }
  return { ...base, availability, attribution };
}

// ---------- the always-on loop ----------

let inflight: Promise<SchedulerTickResult> | null = null;
let started = false;

/** In-process mutex so a manual refresh and a background tick never overlap. */
export function tickInFlight(): boolean {
  return inflight !== null;
}

/**
 * Start the background loop (serve.ts calls this once). Re-entrant safe:
 * multiple calls start at most one loop. Reads the interval from settings each
 * tick so a Settings change applies without a restart.
 */
export function startScheduler(options?: { tick?: typeof schedulerTick }): void {
  if (started) return;
  started = true;
  const tick = options?.tick ?? schedulerTick;
  void (async () => {
    for (;;) {
      let intervalSeconds = 90;
      try {
        const store = await getStore();
        intervalSeconds = readSchedulerIntervalSeconds((await store.getSettings()).highlevel_sync_interval_seconds);
      } catch {
        // store not ready yet — pace with the default and retry next round
      }
      await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
      if (inflight) continue; // previous tick still running — skip this round
      inflight = (async () => {
        const t0 = Date.now();
        try {
          const res = await tick();
          console.log(`[scheduler] tick ${res.outcome}${res.mode ? ` (${res.mode})` : ""}${res.reason ? ` — ${res.reason}` : ""}${typeof res.calls === "number" ? ` +${res.calls} calls` : ""}${typeof res.attributions === "number" ? `, ${res.attributions} attributions` : ""}${res.error ? ` ERROR: ${res.error}` : ""} [${Math.round((Date.now() - t0) / 1000)}s]`);
        } catch (e) {
          console.log(`[scheduler] tick crashed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          inflight = null;
        }
      })();
    }
  })();
}
