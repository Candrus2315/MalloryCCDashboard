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
import { parseSyncStartedMs, STALE_RUN_REAP_MINUTES, type AppSettings } from "../store/types";
import { isRosterUser } from "../roster";
import { readHighLevelCreds, type HighLevelCreds, type LiveHighLevelAdapter } from "./highlevel-live";
import { harvestIncremental, WATERMARK_OVERLAP_SECONDS } from "./highlevel-incremental";
import {
  CONTACTS_INCREMENTAL_CHECKPOINT_KEY,
  CONTACTS_RECONCILIATION_CHECKPOINT_KEY,
  harvestContactsIncremental,
  parseReconciliationCheckpoint,
  reconcileContacts,
  type ContactsReconciliationCheckpoint,
} from "./contacts-incremental";
import { recomputeAttributions, runDemoSync } from "./run";
import { availabilityTick, type AvailabilityTickResult } from "./acuity-live";
import { attributionTick, type AttributionTickResult } from "./attribution-tick";
import { sheetsTick, type SheetsTickResult } from "./sheets-tick";
import { commissionCloseTick, type CommissionCloseResult } from "../commission/close";
import type { LiveSheetsAdapter } from "./sheets-live";

/** A "running" sync_runs row older than this is a crashed process, not a live one. */
export const STALE_RUNNING_CUTOFF_HOURS = 12;

/** COMMISSION CLOSE throttle: weekly data settles daily — a check every 15 min is plenty (manual triggers skip the throttle). */
export const COMMISSION_CLOSE_MIN_INTERVAL_MS = 15 * 60_000;
let lastCommissionCloseAt = 0;

/**
 * STALE-RUN REAP WINDOW — the constant now lives in store/types (both stores
 * need it for getRunningSyncRun's freshness bound; defining it there avoids a
 * store→scheduler import cycle). Re-exported here for existing callers/tests.
 */
export { STALE_RUN_REAP_MINUTES } from "../store/types";
// "acuity_availability" rides the machinery too (2026-10-07: a hung feed run
// blocked every background tick for its 12h window — the provider was missing
// from this set so the reaper never closed its rows).
const REAPABLE_SYNC_PROVIDERS = new Set(["highlevel", "google_sheets", "acuity", "attribution", "acuity_availability"]);

/**
 * Mark every "running" sync_runs row of a bounded provider that is older than
 * STALE_RUN_REAP_MINUTES as failed. Returns the number of rows reaped.
 * Injectable clock for tests. Best-effort: callers never let a reaper error
 * fail the tick.
 *
 * Scans by STATUS (store.getRunningSyncRuns — every 'running' row of any age),
 * NOT by the getSyncRuns(200) recency window: at the ~90s sync cadence 200
 * rows span only a few hours, so zombies older than that (the 2026-09-27
 * HighLevel row: 37h) were invisible to the reaper forever.
 */
export async function reapStaleSyncRuns(store: Store, now?: () => Date): Promise<number> {
  const nowFn = now ?? (() => new Date());
  const runs = await store.getRunningSyncRuns();
  let reaped = 0;
  for (const run of runs) {
    if (!REAPABLE_SYNC_PROVIDERS.has(run.provider)) continue;
    const startedMs = parseSyncStartedMs(run.started_at);
    if (!Number.isFinite(startedMs)) continue;
    if (nowFn().getTime() - startedMs <= STALE_RUN_REAP_MINUTES * 60_000) continue;
    await store.finishSyncRun(
      run.id,
      "error",
      run.records_upserted,
      `stale: this ${run.provider} run exceeded ${STALE_RUN_REAP_MINUTES} minutes without finishing — marked failed by the scheduler's stale-run reaper (the process hung or died; the next tick retries)`,
    );
    reaped++;
  }
  // The availability feed's DETAILED rows (availability_sync_runs) carry the
  // sync-panel audit; a hung process leaves them "running" forever unless
  // reaped here too (the generic row alone does not close them).
  try {
    reaped += await store.reapStaleAvailabilitySyncRuns(nowFn().getTime() - STALE_RUN_REAP_MINUTES * 60_000, "stale: this availability-feed run exceeded the reap window without finishing — marked failed by the scheduler's stale-run reaper (the process hung or died; the next tick retries)");
  } catch {
    // best-effort — the generic-row pass above already unblocked the tick guard
  }
  return reaped;
}

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
  /** S4: the per-tick contacts differential walk (new rows stored this tick). */
  contactsWalk?: { new: number; pages: number; truncated: boolean };
  /** S4: meta.total-vs-DB reconciliation tripwire outcome. */
  contactsReconciliation?: { dbCount: number | null; sourceTotal: number | null; delta: number | null; status: string };
  /** Independent Google Sheets lead sync piggy-backed on the same tick (never fails the tick). */
  sheets?: SheetsTickResult;
  /** Independent commission weekly close piggy-backed on the same tick (never fails the tick; throttled). */
  commission?: CommissionCloseResult;
  /** Stale-run reaper: zombie "running" rows (hung processes) marked failed this tick. */
  reaped?: number;
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
  /**
   * Live-adapter injection for the bootstrap full-sync path. Each piece is
   * independent: a piece ABSENT (or undefined) → the full sync resolves that
   * adapter itself (env/credentials); a piece PRESENT (even null) → used as
   * given. serve.ts passes only what it built; tests pass stubs for both.
   */
  liveAdapters?: { sheets?: LiveSheetsAdapter | null; highlevel?: import("./highlevel-live").LiveHighLevelAdapter | null };
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
      // Per-piece threading (see the option docs): only pieces the caller
      // actually provided are pinned; the rest self-resolve from credentials
      // — so serve.ts can supply the sheets adapter without ever pinning
      // HighLevel to demo (a wholesale { highlevel: null } would).
      const la = options?.liveAdapters;
      const adapterOpts: { sheetsAdapter?: LiveSheetsAdapter | null; highlevelAdapter?: LiveHighLevelAdapter | null } = {};
      if (la && la.sheets !== undefined) adapterOpts.sheetsAdapter = la.sheets;
      if (la && la.highlevel !== undefined) adapterOpts.highlevelAdapter = la.highlevel;
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
      // S4 (design §3a): the contacts walk runs FIRST so contacts created in
      // HighLevel without any harvested call still enter the DB this tick, and
      // so the call→contact linkage map below already contains them.
      // Light identity read (2 columns) replaces the old full getContacts()
      // 18-column materialization of ~116k rows EVERY tick: it feeds both the
      // walk's known-id frontier and the linkage map below.
      const storedContactIds = await store.getContactExternalIds("highlevel");
      const knownExternalIds = new Set(storedContactIds.map((c) => c.external_id));
      const contactIdByExt = new Map(storedContactIds.map((c) => [c.external_id, c.id]));
      const walk = await harvestContactsIncremental({
        creds,
        fetchImpl: options?.fetchImpl ?? fetch,
        sleep: options?.sleep,
        knownExternalIds,
      });

      const sinceMs = Date.parse(watermark) - WATERMARK_OVERLAP_SECONDS * 1000;
      const harvest = await harvestIncremental({
        creds,
        fetchImpl: options?.fetchImpl ?? fetch,
        sleep: options?.sleep,
        sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0,
      });

      // Upsert users → contacts (walk first, then call-referenced) → calls
      // (same ordering/linking as the full sync). ROSTER RULE: active iff name
      // AND email match settings.active_roster — the full users snapshot
      // arrives every tick, so roster changes apply without any manual step.
      // Non-matching users keep their rows (inactive).
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
      // Walk rows first: brand-new contacts (often zero, ~1 page when growth
      // happened since the last tick). COALESCE-protected upserts cannot
      // clobber backfill identity fields; hl_contacts_backfill_v1 is untouched.
      if (walk.rows.length) {
        await store.upsertContacts(
          walk.rows.map((c) => ({
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
      // Resolve internal ids for every contact touched this tick (walk + call-
      // referenced) with ONE targeted 2-column query — never a full re-read.
      const touchedExternalIds = [...new Set([...walk.rows, ...harvest.contacts].map((c) => c.external_id))];
      if (touchedExternalIds.length) {
        for (const row of await store.getContactExternalIds("highlevel", touchedExternalIds)) {
          contactIdByExt.set(row.external_id, row.id);
        }
      }
      if (harvest.calls.length) {
        await store.upsertCalls(
          harvest.calls.map((c) => ({
            provider: "highlevel",
            external_call_id: c.external_call_id,
            rep_id: userIdByExt.get(`highlevel:${c.repExternalId}`) ?? null,
            contact_id: contactIdByExt.get(c.contactExternalId) ?? null,
            started_at: c.startedAt,
            duration_seconds: c.durationSeconds,
            over_two_minutes: c.durationSeconds > settings.meaningful_call_threshold_seconds,
            direction: c.direction,
            call_status: c.status,
          })),
        );
      }

      // S4 checkpoint — written ONLY after the successful walk upsert (the
      // scheduler owns it; the walk module itself never persists).
      const walkCkptRaw = await store.getSyncCheckpoint(CONTACTS_INCREMENTAL_CHECKPOINT_KEY);
      let previousNoNewStreak = 0;
      try {
        const parsed = walkCkptRaw ? (JSON.parse(walkCkptRaw) as { noNewStreak?: number }) : null;
        previousNoNewStreak = typeof parsed?.noNewStreak === "number" && Number.isFinite(parsed.noNewStreak) ? parsed.noNewStreak : 0;
      } catch {
        previousNoNewStreak = 0;
      }
      await store.setSyncCheckpoint(CONTACTS_INCREMENTAL_CHECKPOINT_KEY, JSON.stringify({
        lastRunAt: now().toISOString(),
        lastNewCount: walk.newCount,
        pagesLastRun: walk.pagesFetched,
        noNewStreak: walk.newCount === 0 ? previousNoNewStreak + 1 : 0,
        sourceTotalSeen: walk.sourceTotalSeen,
        updatedAt: now().toISOString(),
      }));

      // S4 late-contact heal (design §5, bounded + best-effort): when the walk
      // inserted contacts, refill NULL contact_id on RECENT calls whose ledger
      // entry (harvest_calls) names an inserted contact — fill-null-only, so a
      // pre-existing link can never be overwritten. Failure never fails the tick.
      let healedCalls = 0;
      if (walk.rows.length) {
        try {
          const sinceIso = new Date(Date.parse(tickStartIso) - 7 * 86_400_000).toISOString();
          const insertedExternalIds = new Set(walk.rows.map((c) => c.external_id));
          const ledger = (await store.getHarvestCallsSince(sinceIso)).filter(
            (h) => h.contact_external_id != null && insertedExternalIds.has(h.contact_external_id),
          );
          if (ledger.length) {
            const ledgerByMessageId = new Map(ledger.map((h) => [h.message_id, h.contact_external_id as string]));
            const nullCalls = (await store.getAllCallsSince(sinceIso)).filter(
              (c) => c.contact_id == null && c.external_call_id != null && ledgerByMessageId.has(c.external_call_id as string),
            );
            const updates = nullCalls
              .map((c) => ({
                call_id: c.id,
                contact_id: contactIdByExt.get(ledgerByMessageId.get(c.external_call_id as string) as string) ?? null,
                resolution_method: "direct_message_contact" as const,
                contact_resolved_at: now().toISOString(),
              }))
              .filter((u) => u.contact_id != null);
            if (updates.length) {
              await store.applyCallContactBackfill(updates);
              healedCalls = updates.length;
            }
          }
        } catch {
          healedCalls = 0; // heal is opportunistic; next walk heals again
        }
      }

      const records = harvest.calls.length + walk.newCount + harvest.contacts.length + harvest.users.length;

      // S4 every-tick reconciliation tripwire (design §3c): meta.total vs
      // countContacts. Warn-only; a probe failure never fails the tick and
      // never warns (no invented numbers).
      const dbCount = await store.countContacts("highlevel");
      const reconPreviousRaw = await store.getSyncCheckpoint(CONTACTS_RECONCILIATION_CHECKPOINT_KEY);
      const reconPrevious: ContactsReconciliationCheckpoint | null = parseReconciliationCheckpoint(reconPreviousRaw);
      let recon: ContactsReconciliationCheckpoint;
      let reconWarn = false;
      let reconMessage: string | null = null;
      try {
        const r = await reconcileContacts({
          creds,
          fetchImpl: options?.fetchImpl ?? fetch,
          sleep: options?.sleep,
          dbCount,
          previous: reconPrevious,
        });
        recon = r.checkpoint;
        reconWarn = r.warn;
        reconMessage = r.message;
        await store.setSyncCheckpoint(CONTACTS_RECONCILIATION_CHECKPOINT_KEY, JSON.stringify(r.checkpoint));
      } catch (e) {
        recon = { lastCheckedAt: now().toISOString(), sourceTotal: null, dbCount, delta: null, status: "probe_failed", driftStreak: 0, updatedAt: now().toISOString() };
        reconMessage = null;
        void e;
      }

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
          note: `Incremental sync (${options?.trigger ?? "background"}): +${harvest.calls.length} calls, +${walk.newCount} contacts (walk ${walk.pagesFetched}p${healedCalls ? `, ${healedCalls} call links healed` : ""})${reconWarn && reconMessage ? ` · ${reconMessage}` : ""}${purgedTotal > 0 ? ` · demo rows purged: ${purgedTotal}` : ""}${harvest.warnings.length ? ` · ${harvest.warnings[0]}` : ""}`.slice(0, 500),
          // S4 reconciliation tripwire surfaces here (syncStaleWarnings reads
          // this field; Settings → Sync Center shows the note).
          contactsReconciliation: { ...recon, warn: reconWarn },
        },
      });
      return {
        outcome: "synced",
        mode: "incremental",
        calls: harvest.calls.length,
        contacts: walk.newCount + harvest.contacts.length,
        users: harvest.users.length,
        attributions,
        contactsWalk: { new: walk.newCount, pages: walk.pagesFetched, truncated: walk.truncated },
        contactsReconciliation: { dbCount: recon.dbCount, sourceTotal: recon.sourceTotal, delta: recon.delta, status: recon.status },
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
 * One scheduler tick = the HighLevel harvest PLUS three independent
 * refreshes: the Acuity availability sync, the booking-attribution recompute
 * (the pure engine over stored rows — scope-filtered, manual overrides win)
 * and the Google Sheets lead sync (throttled to SHEETS_MIN_INTERVAL_MS —
 * sheet data is daily; it seeds the work-date cohort the Today page opens
 * on). All three piggy-backed refreshes record their failures (sync_runs
 * rows) and report them on the result — they never fail the tick or crash
 * the scheduler loop. Background refreshes are throttled
 * (ACUITY_MIN_INTERVAL_MS / ATTRIBUTION_MIN_INTERVAL_MS / SHEETS_MIN_INTERVAL_MS);
 * manual triggers (REFRESH / SYNC NOW) skip the throttle.
 *
 * A STALE-RUN REAPER runs first: "running" sync_runs rows of the bounded
 * providers older than STALE_RUN_REAP_MINUTES are marked failed (hung
 * processes — the two wedged HighLevel rows of 2026-09-28) so they can never
 * block the tick guards forever.
 */
export async function schedulerTick(options?: {
  store?: Store;
  settings?: AppSettings;
  creds?: HighLevelCreds | null;
  fetchImpl?: (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  trigger?: "background" | "manual";
  liveAdapters?: { sheets?: LiveSheetsAdapter | null; highlevel?: LiveHighLevelAdapter | null };
  /** Test injection for the availability refresh; absent → resolve from env (null when no creds → skip). */
  acuityAdapter?: import("./acuity-live").AcuityLiveAdapter | null;
}): Promise<SchedulerTickResult> {
  const now = options?.now ?? (() => new Date());
  // Stale-run reaper (best-effort; never fails the tick). Runs FIRST so a
  // zombie row is cleared before this tick's own guards check for in-flight runs.
  let reaped: number | undefined;
  try {
    reaped = await reapStaleSyncRuns(options?.store ?? (await getStore()), now);
  } catch {
    reaped = undefined;
  }
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
  let sheets: SheetsTickResult;
  try {
    sheets = await sheetsTick({
      store: options?.store,
      now,
      trigger: options?.trigger,
      ...(options?.liveAdapters && "sheets" in options.liveAdapters
        ? { adapter: options.liveAdapters.sheets ?? null }
        : {}),
    });
  } catch (e) {
    sheets = { outcome: "error", error: e instanceof Error ? e.message : String(e) };
  }
  // COMMISSION WEEKLY CLOSE (owner directive 2026-10-01): independent finalize
  // of completed Mon–Sun weeks (idempotent — existing records are skipped).
  // Throttled like the sheets sync (commission data settles daily; a check
  // every COMMISSION_CLOSE_MIN_INTERVAL_MS is plenty) and never fails the tick.
  let commission: CommissionCloseResult | undefined;
  if (options?.trigger === "manual" || Date.now() - lastCommissionCloseAt >= COMMISSION_CLOSE_MIN_INTERVAL_MS) {
    lastCommissionCloseAt = Date.now();
    try {
      commission = await commissionCloseTick(options?.store ?? (await getStore()), { now });
    } catch (e) {
      commission = { outcome: "error", weeksConsidered: 0, recordsWritten: 0, weeksClosed: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ...base, availability, attribution, sheets, commission, reaped };
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
 * tick so a Settings change applies without a restart. `liveAdapters` threads
 * pre-built live adapters into every tick (serve.ts passes the sheets adapter
 * it built; pieces left undefined resolve themselves from credentials).
 */
export function startScheduler(options?: {
  tick?: typeof schedulerTick;
  liveAdapters?: { sheets?: LiveSheetsAdapter | null; highlevel?: LiveHighLevelAdapter | null };
}): void {
  if (started) return;
  started = true;
  const tick = options?.tick ?? schedulerTick;
  const liveAdapters = options?.liveAdapters;
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
          const res = await tick(liveAdapters ? { liveAdapters } : undefined);
          console.log(`[scheduler] tick ${res.outcome}${res.mode ? ` (${res.mode})` : ""}${res.reason ? ` — ${res.reason}` : ""}${typeof res.calls === "number" ? ` +${res.calls} calls` : ""}${typeof res.attributions === "number" ? `, ${res.attributions} attributions` : ""}${res.sheets ? `, sheets ${res.sheets.outcome}${typeof res.sheets.leads === "number" ? ` +${res.sheets.leads} leads` : ""}${res.sheets.reason ? ` (${res.sheets.reason})` : ""}` : ""}${typeof res.reaped === "number" && res.reaped > 0 ? `, reaped ${res.reaped} stale runs` : ""}${res.error ? ` ERROR: ${res.error}` : ""} [${Math.round((Date.now() - t0) / 1000)}s]`);
        } catch (e) {
          console.log(`[scheduler] tick crashed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          inflight = null;
        }
      })();
    }
  })();
}
