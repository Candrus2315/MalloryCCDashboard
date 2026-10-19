/**
 * PROVIDER FRESHNESS WATCHDOG (Reliability Phase 2a, owner directive
 * 2026-10-16: behave like commercial SaaS — self-recovery with zero operator
 * action, and alert when a sync goes stale).
 *
 * PR #73's watchdog/reaper covers a HUNG TICK (the loop is released; stale
 * rows are reaped). This module covers the NEXT failure class: a provider
 * whose lane is nominally healthy but whose last SUCCESS is far older than
 * its cadence — repeated tick failures, a stuck mutex the reaper cleared but
 * the provider never re-ran, a provider the loop stopped reaching, etc.
 *
 * THE RULE: for each watched provider, age = now − last successful sync_runs
 * finished_at. When age exceeds STALE threshold = 3 × cadence, the watchdog:
 *   (a) clears any stale 'running' sync_runs rows for that provider
 *       (reaper-style honest error text) so the tick guards cannot block the
 *       recovery attempt;
 *   (b) forces ONE immediate bounded sync attempt for that provider (its own
 *       tick function with trigger:"manual" — throttle bypassed, all the
 *       usual guards intact, its own sync_runs audit row written). At most
 *       ONE forced attempt per RECOVERY_ATTEMPT_MIN_INTERVAL_MS per provider
 *       — no stampede;
 *   (c) records every action honestly: console log + the attempt's own
 *       sync_runs row + the persisted incident state (sync checkpoint KV).
 *
 * ESCALATION: a provider still stale after FRESHNESS_ESCALATION_ATTEMPTS
 * recovery attempts is marked DEGRADED and ONE ops alert fires per incident
 * (rate-limited; incident state persists in the DB so a restart cannot
 * re-storm). Recovery fires one low-priority 'resolved' alert per incident.
 *
 * The pass runs on the EXISTING independent reaper loop's cadence (every
 * REAPER_INTERVAL_MS) — no new timer, no duplicated loop (see
 * runStaleRunReaperLoop in scheduler.ts).
 *
 * SCOPE NOTE — never-succeeded providers: freshness needs a baseline. A
 * provider with NO successful sync run in its history is reported
 * status:"unknown" and is never recovered/alerted by this watchdog (there is
 * no cadence to compare against; fresh installs surface their real problem
 * through tick errors on the connection rows). A provider that USED to
 * succeed and then breaks is exactly the case this watchdog owns.
 */
import { getStore, type Store } from "../store";
import { withSyncWriteRetry } from "../store/sync-write-retry";
import { parseSyncStartedMs, STALE_RUN_REAP_MINUTES, type AppSettings } from "../store/types";
import { readSchedulerIntervalSeconds } from "./scheduler";
import { ACUITY_MIN_INTERVAL_MS } from "./acuity-live";
import { ATTRIBUTION_MIN_INTERVAL_MS } from "./attribution-tick";
import { SHEETS_MIN_INTERVAL_MS } from "./sheets-tick";
import { AVAILABILITY_FEED_MIN_INTERVAL_MS } from "./availability-feed";
import { sendOpsAlert } from "../ops-alert";
import type { LiveSheetsAdapter } from "./sheets-live";

// ---------------------------------------------------------------------------
// Tuned constants — documented rationale, change here and nowhere else.
// ---------------------------------------------------------------------------

/**
 * STALE threshold = FRESHNESS_STALE_AGE_FACTOR × cadence. 3× absorbs one
 * missed throttle window plus ordinary tick jitter/failures without crying
 * wolf: a provider healthy at every cadence tick can never reach 3× (its age
 * resets each window), while real breakage crosses the line within ~3
 * cadence periods — 4.5 min for HighLevel, 30 min for the 5/10-min piggybacks.
 */
export const FRESHNESS_STALE_AGE_FACTOR = 3;

/**
 * At most ONE forced recovery attempt per provider per this window. The
 * watchdog pass itself runs every REAPER_INTERVAL_MS (5 min); 10 min means a
 * struggling provider gets recovered-and-rechecked at most every other pass
 * — bounded API load, and the escalation clock stays meaningful (N attempts
 * ≈ N × 10 min of genuine attempts, not N passes of hammering).
 */
export const RECOVERY_ATTEMPT_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * Escalation bar: a provider still stale after this many forced recovery
 * attempts (≈ 30 min of trying at the 10-min window) is marked DEGRADED and
 * pages ops once. Three attempts is enough to ride out a transient blip the
 * background ticks would fix anyway, without letting a dead provider sit
 * silent for hours.
 */
export const FRESHNESS_ESCALATION_ATTEMPTS = 3;

/**
 * When an escalation alert FAILS to send (Knock down/network error), the next
 * attempt may fire at most once per this interval — an alerting outage must
 * not become its own retry storm.
 */
export const ALERT_RETRY_MIN_INTERVAL_MS = 60 * 60_000;

/**
 * Incident-state checkpoint key (generic sync checkpoint KV — DB-backed, so
 * a restart cannot re-storm alerts for a still-degraded provider).
 */
export const INCIDENT_CHECKPOINT_KEY = "sync_freshness_incidents_v1";

/** The watched set — exactly the scheduler's providers (reaper's REAPABLE set). */
export const FRESHNESS_PROVIDERS = [
  "highlevel",
  "acuity",
  "google_sheets",
  "acuity_availability",
  "attribution",
] as const;

export type FreshnessProvider = (typeof FRESHNESS_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Cadence + staleness math
// ---------------------------------------------------------------------------

/**
 * The per-provider background cadence — the REAL numbers the scheduler runs
 * on, imported from their home modules (never guesses):
 *   highlevel            — the settings interval (default 90s, clamp 30–3600)
 *   acuity               — ACUITY_MIN_INTERVAL_MS (5 min)   [acuity-live.ts]
 *   attribution          — ATTRIBUTION_MIN_INTERVAL_MS (5) [attribution-tick.ts]
 *   acuity_availability  — AVAILABILITY_FEED_MIN_INTERVAL_MS (5) [availability-feed.ts]
 *   google_sheets        — SHEETS_MIN_INTERVAL_MS (10 min) [sheets-tick.ts]
 */
export function providerCadenceMs(provider: string, settings?: AppSettings): number {
  switch (provider) {
    case "highlevel":
      return readSchedulerIntervalSeconds(settings?.highlevel_sync_interval_seconds) * 1000;
    case "acuity":
      return ACUITY_MIN_INTERVAL_MS;
    case "attribution":
      return ATTRIBUTION_MIN_INTERVAL_MS;
    case "acuity_availability":
      return AVAILABILITY_FEED_MIN_INTERVAL_MS;
    case "google_sheets":
      return SHEETS_MIN_INTERVAL_MS;
    default:
      return 0;
  }
}

export type ProviderFreshnessStatus = "ok" | "degraded" | "unknown";

export interface ProviderFreshness {
  provider: string;
  /** Last successful sync (finished_at), ISO — null when the provider never succeeded. */
  lastSuccessAt: string | null;
  /** Minutes since lastSuccessAt; null when unknown. */
  ageMinutes: number | null;
  cadenceMs: number;
  /** The staleness line: cadence × FRESHNESS_STALE_AGE_FACTOR, in minutes. */
  staleAfterMinutes: number;
  status: ProviderFreshnessStatus;
}

/**
 * PURE freshness evaluation — shared by the watchdog pass and /health so the
 * two can never disagree. status:"unknown" = no success row in history (never
 * degraded by this watchdog — see the module scope note).
 */
export function computeProviderFreshness(
  lastSuccessByProvider: Record<string, string>,
  settings?: AppSettings,
  now: () => Date = () => new Date(),
): ProviderFreshness[] {
  return FRESHNESS_PROVIDERS.map((provider) => {
    const cadenceMs = providerCadenceMs(provider, settings);
    const staleAfterMinutes = (cadenceMs * FRESHNESS_STALE_AGE_FACTOR) / 60_000;
    const lastSuccessAt = lastSuccessByProvider[provider] ?? null;
    if (!lastSuccessAt) {
      return { provider, lastSuccessAt: null, ageMinutes: null, cadenceMs, staleAfterMinutes, status: "unknown" as const };
    }
    const successMs = parseSyncStartedMs(lastSuccessAt);
    const ageMinutes = Number.isFinite(successMs)
      ? Math.max(0, Math.round(((now().getTime() - successMs) / 60_000) * 10) / 10)
      : null;
    const degraded = Number.isFinite(successMs) && now().getTime() - successMs > cadenceMs * FRESHNESS_STALE_AGE_FACTOR;
    return { provider, lastSuccessAt, ageMinutes, cadenceMs, staleAfterMinutes, status: degraded ? ("degraded" as const) : ("ok" as const) };
  });
}

// ---------------------------------------------------------------------------
// Incident state — persisted per provider, restart-proof
// ---------------------------------------------------------------------------

export interface ProviderIncidentState {
  /** First pass the provider was observed stale (ISO). */
  openedAt: string;
  /** Forced recovery attempts so far IN THIS INCIDENT. */
  attempts: number;
  /** Last forced-attempt start (ISO) — the recovery-window throttle key. */
  lastAttemptAt: string | null;
  /** Escalated: N attempts exhausted and the provider is still stale. */
  degraded: boolean;
  /** An escalation alert was sent (or logged in log-only mode) for this incident. */
  alerted: boolean;
  /** Last FAILED alert attempt (ISO) — retries at most once per ALERT_RETRY_MIN_INTERVAL_MS. */
  alertFailedAt: string | null;
  /** A 'resolved' alert already fired for this incident (never re-fires). */
  resolvedAlertSent: boolean;
  /** Set when the provider recovered — the incident is closed (kept for audit). */
  recoveredAt: string | null;
}

interface IncidentFile {
  version: 1;
  providers: Record<string, ProviderIncidentState>;
}

function emptyIncident(nowIso: string): ProviderIncidentState {
  return {
    openedAt: nowIso,
    attempts: 0,
    lastAttemptAt: null,
    degraded: false,
    alerted: false,
    alertFailedAt: null,
    resolvedAlertSent: false,
    recoveredAt: null,
  };
}

function parseIncidentFile(raw: string | null): IncidentFile {
  if (!raw) return { version: 1, providers: {} };
  try {
    const parsed = JSON.parse(raw) as IncidentFile;
    if (parsed && parsed.version === 1 && parsed.providers && typeof parsed.providers === "object") return parsed;
  } catch {
    // corrupt state — start clean, never crash the watchdog
  }
  return { version: 1, providers: {} };
}

/**
 * In-process mirror of the persisted incident state. The DB checkpoint is the
 * durable source (restart-proof); this mirror keeps rapid successive passes
 * consistent even while a checkpoint write is failing, and loses only the
 * rate-limit memory on a hard process crash — the DB copy covers that.
 */
let incidentMemory: IncidentFile = { version: 1, providers: {} };

async function loadIncidentState(store: Store): Promise<IncidentFile> {
  try {
    const raw = await store.getSyncCheckpoint(INCIDENT_CHECKPOINT_KEY);
    incidentMemory = parseIncidentFile(raw);
  } catch (e) {
    console.log(`[freshness] incident state read failed — using in-process mirror (${e instanceof Error ? e.message : String(e)})`);
  }
  return incidentMemory;
}

async function saveIncidentState(store: Store, state: IncidentFile): Promise<void> {
  incidentMemory = state;
  try {
    await store.setSyncCheckpoint(INCIDENT_CHECKPOINT_KEY, JSON.stringify(state));
  } catch (e) {
    // Durable write failed — keep the in-process mirror so rate-limiting still
    // works this process; the next successful pass persists it.
    console.log(`[freshness] incident state write failed — kept in-process mirror (${e instanceof Error ? e.message : String(e)})`);
  }
}

// ---------------------------------------------------------------------------
// The recovery dispatcher — ONE bounded forced attempt per provider
// ---------------------------------------------------------------------------

export type ForceAttemptFn = (provider: string) => Promise<void>;

/**
 * The production dispatcher: run the provider's OWN tick function once with
 * trigger:"manual" (throttle bypassed, all guards intact) — the same bounded
 * code path the scheduler and SYNC NOW already use. Each attempt writes its
 * own sync_runs audit row; nothing here invents a new write path.
 */
export function createDefaultForceAttempt(liveAdapters?: {
  sheets?: LiveSheetsAdapter | null;
}): ForceAttemptFn {
  return async (provider: string): Promise<void> => {
    switch (provider) {
      case "highlevel": {
        const { highlevelTick } = await import("./scheduler");
        await highlevelTick({
          trigger: "manual",
          ...(liveAdapters ? { liveAdapters } : {}),
        });
        return;
      }
      case "acuity": {
        const { availabilityTick } = await import("./acuity-live");
        await availabilityTick({ trigger: "manual" });
        return;
      }
      case "acuity_availability": {
        const { availabilityFeedTick } = await import("./availability-feed");
        await availabilityFeedTick({ trigger: "manual" });
        return;
      }
      case "google_sheets": {
        const { sheetsTick } = await import("./sheets-tick");
        await sheetsTick({
          trigger: "manual",
          ...(liveAdapters && "sheets" in liveAdapters ? { adapter: liveAdapters.sheets ?? null } : {}),
        });
        return;
      }
      case "attribution": {
        const { attributionTick } = await import("./attribution-tick");
        await attributionTick({ trigger: "manual" });
        return;
      }
      default:
        throw new Error(`no recovery dispatcher for provider ${provider}`);
    }
  };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface FreshnessAlertRecord {
  provider: string;
  level: "degraded" | "resolved";
  configured: boolean;
  delivered: boolean;
  error?: string;
}

export interface FreshnessPassResult {
  /** Full freshness snapshot this pass evaluated. */
  providers: ProviderFreshness[];
  /** Providers the watchdog forced ONE recovery attempt for this pass. */
  forced: string[];
  /** Providers whose freshness RESTORED this pass (attempt succeeded or background tick got there first). */
  recovered: string[];
  /** Providers newly escalated to DEGRADED this pass. */
  escalated: string[];
  /** Recovery attempts skipped — inside the per-provider recovery window. */
  skippedInWindow: string[];
  /** Recovery attempts skipped — a running row younger than the reap window still guards the provider. */
  guardBlocked: string[];
  /** Stale 'running' rows cleared for stale providers (reaper-style honest errors). */
  clearedRunningRows: number;
  alerts: FreshnessAlertRecord[];
}

export type SendAlertFn = (
  level: "degraded" | "resolved",
  subject: string,
  body: string,
) => Promise<{ configured: boolean; delivered: boolean; error?: string }>;

const defaultSendAlert: SendAlertFn = (level, subject, body) =>
  sendOpsAlert(subject, body, level === "resolved" ? "low" : "high");

function describeIncident(provider: string, f: ProviderFreshness, incident: ProviderIncidentState): string {
  return [
    `provider=${provider}`,
    `lastSuccess=${f.lastSuccessAt ?? "never"}`,
    `age=${f.ageMinutes ?? "?"}min`,
    `threshold=${f.staleAfterMinutes}min (cadence ${Math.round(f.cadenceMs / 60_000)}min × ${FRESHNESS_STALE_AGE_FACTOR})`,
    `recoveryAttempts=${incident.attempts}`,
  ].join(" ");
}

/**
 * ONE freshness watchdog pass. Best-effort and fail-honest: it never throws,
 * never crashes the reaper loop, and every action is logged. Injectable
 * store/settings/clock/forceAttempt/sendAlert — tests need no timers, no DB,
 * no network.
 */
export async function runFreshnessWatchdogPass(opts?: {
  store?: Store;
  settings?: AppSettings;
  now?: () => Date;
  forceAttempt?: ForceAttemptFn;
  sendAlert?: SendAlertFn;
  liveAdapters?: { sheets?: LiveSheetsAdapter | null };
}): Promise<FreshnessPassResult> {
  const now = opts?.now ?? (() => new Date());
  const result: FreshnessPassResult = {
    providers: [],
    forced: [],
    recovered: [],
    escalated: [],
    skippedInWindow: [],
    guardBlocked: [],
    clearedRunningRows: 0,
    alerts: [],
  };
  try {
    // SYNC WRITE RESILIENCE: the pass's writes (reap-style clears, checkpoint)
    // retry transient DB failures like every other sync entry point.
    const store = withSyncWriteRetry(opts?.store ?? (await getStore()));
    const settings = opts?.settings ?? (await store.getSettings());
    const lastSuccess = await store.getLatestSuccessfulSyncRunByProvider();
    result.providers = computeProviderFreshness(lastSuccess, settings, now);

    const forceAttempt = opts?.forceAttempt ?? createDefaultForceAttempt(opts?.liveAdapters);
    const sendAlert = opts?.sendAlert ?? defaultSendAlert;
    const incidents = await loadIncidentState(store);
    const nowMs = now().getTime();
    const nowIso = now().toISOString();

    // 1) Independent recovery of providers that went stale and came back on
    //    their own (background tick succeeded between passes) — close their
    //    incident and fire the one 'resolved' alert.
    for (const f of result.providers) {
      const incident = incidents.providers[f.provider];
      if (!incident || incident.recoveredAt) continue;
      if (f.status === "ok" && (incident.degraded || incident.alerted || incident.attempts > 0)) {
        incident.recoveredAt = nowIso;
        if ((incident.degraded || incident.alerted) && !incident.resolvedAlertSent) {
          incident.resolvedAlertSent = true;
          const out = await sendAlert(
            "resolved",
            `[Mallory CC] sync RECOVERED: ${f.provider} is fresh again`,
            `The ${f.provider} sync provider recovered on its own after being stale.\n${describeIncident(f.provider, f, incident)}\nNo operator action needed — this closes the incident opened ${incident.openedAt}.`,
          );
          result.alerts.push({ provider: f.provider, level: "resolved", ...out });
        }
        result.recovered.push(f.provider);
        console.log(`[freshness] ${f.provider} recovered (last success ${f.lastSuccessAt}); incident closed`);
      }
    }

    // 2) Stale providers: recover, then escalate when recovery keeps failing.
    for (const f of result.providers) {
      if (f.status !== "degraded") continue; // unknown never pages; ok needs nothing
      const incident = (incidents.providers[f.provider] ??= emptyIncident(nowIso));
      if (incident.recoveredAt) {
        // A new stale period on the same provider = a NEW incident.
        incidents.providers[f.provider] = emptyIncident(nowIso);
      }
      const inc = incidents.providers[f.provider];

      // Recovery window: at most one forced attempt per provider per window.
      const lastAttemptMs = inc.lastAttemptAt ? Date.parse(inc.lastAttemptAt) : NaN;
      if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < RECOVERY_ATTEMPT_MIN_INTERVAL_MS) {
        result.skippedInWindow.push(f.provider);
        continue;
      }

      // (a) clear stale 'running' rows for THIS provider (reaper-style). Rows
      // younger than the reap window MIGHT be a genuinely live run — those
      // guard-block the recovery attempt (the tick guard would skip anyway)
      // and are left for the reaper; the next pass recovers if still stale.
      const running = (await store.getRunningSyncRuns()).filter((r) => r.provider === f.provider);
      let liveRemains = false;
      for (const run of running) {
        const startedMs = parseSyncStartedMs(run.started_at);
        if (Number.isFinite(startedMs) && nowMs - startedMs <= STALE_RUN_REAP_MINUTES * 60_000) {
          liveRemains = true;
          continue;
        }
        await store.finishSyncRun(
          run.id,
          "error",
          run.records_upserted,
          `stale: this ${f.provider} run exceeded ${STALE_RUN_REAP_MINUTES} minutes without finishing while the provider was freshness-stale — marked failed by the provider freshness watchdog (the process hung or died; one bounded recovery sync follows)`,
        );
        result.clearedRunningRows++;
      }
      if (liveRemains) {
        result.guardBlocked.push(f.provider);
        console.log(`[freshness] ${f.provider} stale ${f.ageMinutes}min but a running sync may still be live — recovery attempt deferred to the next pass`);
        continue;
      }

      // (b) force ONE bounded attempt for THIS provider.
      inc.attempts++;
      inc.lastAttemptAt = nowIso;
      result.forced.push(f.provider);
      console.log(`[freshness] ${f.provider} stale ${f.ageMinutes}min (threshold ${f.staleAfterMinutes}min) — forcing one recovery sync (attempt ${inc.attempts})`);
      try {
        await forceAttempt(f.provider);
      } catch (e) {
        console.log(`[freshness] recovery attempt for ${f.provider} errored (${e instanceof Error ? e.message : String(e)}) — recorded; the next pass re-evaluates`);
      }

      // (c) re-evaluate THIS provider against the fresh store truth.
      const after = await store.getLatestSuccessfulSyncRunByProvider();
      const fAfter = computeProviderFreshness(after, settings, now).find((p) => p.provider === f.provider);
      if (fAfter && fAfter.status === "ok") {
        result.recovered.push(f.provider);
        incident.recoveredAt = nowIso;
        if ((incident.degraded || incident.alerted) && !incident.resolvedAlertSent) {
          incident.resolvedAlertSent = true;
          const out = await sendAlert(
            "resolved",
            `[Mallory CC] sync RECOVERED: ${f.provider} is fresh again`,
            `The forced recovery sync succeeded — the ${f.provider} provider is fresh again.\n${describeIncident(fAfter.provider, fAfter, incident)}\nNo operator action needed — this closes the incident opened ${incident.openedAt}.`,
          );
          result.alerts.push({ provider: f.provider, level: "resolved", ...out });
        }
        console.log(`[freshness] recovery attempt succeeded — ${f.provider} last success ${fAfter.lastSuccessAt}`);
      } else if (inc.attempts >= FRESHNESS_ESCALATION_ATTEMPTS) {
        // Still stale after N attempts → DEGRADED + one ops alert per incident.
        const wasDegraded = inc.degraded;
        inc.degraded = true;
        if (!wasDegraded) result.escalated.push(f.provider);
        const canAlert = !inc.alerted && (!inc.alertFailedAt || nowMs - Date.parse(inc.alertFailedAt) >= ALERT_RETRY_MIN_INTERVAL_MS);
        if (!inc.alerted && canAlert) {
          const lastError = (await store.getConnections()).find((c) => c.provider === f.provider)?.last_error ?? null;
          const out = await sendAlert(
            "degraded",
            `[Mallory CC] sync DEGRADED: ${f.provider} stale ${f.ageMinutes}min (self-recovery failed ${inc.attempts}×)`,
            [
              `The ${f.provider} sync provider is DEGRADED on the Mallory CC dashboard.`,
              describeIncident(fAfter?.provider ?? f.provider, fAfter ?? f, inc),
              lastError ? `Last recorded error: ${lastError.slice(0, 300)}` : "No error recorded on the connection row.",
              `Self-recovery forced ${inc.attempts} bounded syncs without restoring freshness. Sync data shown in the dashboard may be stale.`,
              `This alert fires once per incident. The watchdog keeps retrying recovery every ${Math.round(RECOVERY_ATTEMPT_MIN_INTERVAL_MS / 60_000)} minutes; a 'resolved' alert will follow when freshness restores.`,
            ].join("\n"),
          );
          result.alerts.push({ provider: f.provider, level: "degraded", ...out });
          if (out.delivered) {
            inc.alerted = true;
            inc.alertFailedAt = null;
          } else {
            inc.alertFailedAt = nowIso;
          }
        }
        console.log(`[freshness] ${f.provider} DEGRADED — still stale after ${inc.attempts} recovery attempt(s); incident opened ${inc.openedAt}`);
      }
    }

    await saveIncidentState(store, incidents);
    return result;
  } catch (e) {
    // Fail-honest: a watchdog pass must never crash the loop that runs it.
    console.log(`[freshness] pass errored (best-effort, retried next round): ${e instanceof Error ? e.message : String(e)}`);
    result.providers = result.providers.length
      ? result.providers
      : computeProviderFreshness({}, opts?.settings, opts?.now);
    return result;
  }
}
