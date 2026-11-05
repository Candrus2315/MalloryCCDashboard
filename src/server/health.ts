/**
 * /HEALTH (Reliability Phase 2a, owner directive 2026-10-16) — the machine-
 * readable status surface the external scheduled ping (Phase 2b) will poll.
 *
 * JSON only, NO business data — version/commit, per-provider sync freshness
 * (last success, age minutes, status) and the overall status. HTTP 200 when
 * every tracked provider is ok, 503 when ANY provider is DEGRADED (last
 * success older than 3× its cadence). Safe to expose publicly: no secrets,
 * no customer data, no counts — just timestamps and statuses.
 *
 * FAST by contract: one indexed per-provider query (the freshest success row
 * per provider — sync_runs_provider_idx) + the settings row. No aggregations,
 * no scans. The freshness math is the SAME pure function the watchdog pass
 * uses (computeProviderFreshness) so the endpoint and the self-recovery
 * machinery can never disagree about what "stale" means.
 *
 * Honest states: "ok" = fresh; "degraded" = stale beyond 3× cadence; "unknown"
 * = the provider has no successful sync run in its history (fresh install /
 * never connected) — reported but NEVER counted against overall status,
 * because there is no cadence baseline to be stale against (the watchdog
 * module doc explains why). An unreachable store fails the check honestly
 * with a 503 and an error field — never a plausible-looking lie.
 *
 * PORTABILITY PART 2 (2026-11-05) — /health is the AUTHORITATIVE production
 * check. The payload gains ADDITIVE identity/state fields (existing fields and
 * the 200/503 contract unchanged):
 *   • identity: `bootedAt` + `uptimeSeconds` next to the existing
 *     version/commit — the operator sees WHICH boot is answering.
 *   • `database`: ONE fast probe query (`SELECT 1` via the store's own ping,
 *     the same bounded probe the sync passes use) + its latency in ms. An
 *     unreachable database is reported honestly and counts as degraded —
 *     a health check must never answer 200 while the database is down.
 *   • `scheduler`: the advisory-lock lease state (holder/standby/stopped),
 *     read QUERY-FREE from the loop's per-round mirror (scheduler.ts) —
 *     health never calls lease.acquire(); a probing standby could steal
 *     the lease from the holder.
 * DEADLINE-BOUNDED BY CONTRACT: every await in the health path races a
 * short deadline (HEALTH_QUERY_DEADLINE_MS, default 2s, clamped 0.1–10s) so
 * /health can never hang behind a wedged pool/seed — it stays independent of
 * the page-render path (PR #161) and answers fast with an honest error.
 */
import { getStore, type Store } from "./store";
import { computeProviderFreshness, FRESHNESS_PROVIDERS, type ProviderFreshness } from "./sync/freshness-watchdog";
import { readHeartbeatFreshness, type HeartbeatFreshness } from "./heartbeat-freshness";
import { schedulerLeaseState, type SchedulerLeaseState } from "./sync/scheduler";
import type { AppSettings } from "./store/types";

/**
 * App version — bump when a meaningful dashboard release ships. The git
 * commit resolves at runtime (the served build runs from the repo root; the
 * .git dir travels with the workspace). "unknown" is the honest fallback.
 */
export const APP_VERSION = "1.1.0";

/**
 * Process boot marker for the `bootedAt`/`uptimeSeconds` identity fields —
 * set when this module first evaluates in the process (the dist server bundle
 * imports it at boot; the serve.ts graph on first /health — the honest "how
 * old is the answering process" signal either way). Tests inject their own.
 */
export const APP_BOOTED_AT = new Date();

let cachedCommit: string | null = null;

/** Short HEAD commit, resolved once per process. Never throws. */
export function resolveGitCommit(): string {
  if (cachedCommit) return cachedCommit;
  try {
    const proc = Bun.spawnSync(["git", "-C", process.cwd(), "rev-parse", "--short", "HEAD"]);
    const out = proc.stdout.toString().trim();
    cachedCommit = out.length > 0 ? out : "unknown";
  } catch {
    cachedCommit = "unknown";
  }
  return cachedCommit;
}

/** The health-path deadline: every store await is raced against this (ms). */
const HEALTH_DEADLINE_DEFAULT_MS = 2000;

/**
 * HEALTH_QUERY_DEADLINE_MS — env-clamped 100..10_000, default 2000. The
 * deadline exists so a hung pool can never hang /health; it must stay WELL
 * below any external poller's HTTP timeout.
 */
export function healthDeadlineMs(): number {
  const raw = Number(process.env.HEALTH_QUERY_DEADLINE_MS ?? HEALTH_DEADLINE_DEFAULT_MS);
  if (!Number.isFinite(raw)) return HEALTH_DEADLINE_DEFAULT_MS;
  return Math.min(10_000, Math.max(100, Math.round(raw)));
}

/** Name-set error when a health-path await outlives the deadline. */
export class HealthDeadlineError extends Error {
  constructor(label: string, deadlineMs: number) {
    super(`${label} did not settle within the ${deadlineMs}ms health deadline`);
    this.name = "HealthDeadlineError";
  }
}

/**
 * Race one health-path await against the deadline. The fired cap does NOT
 * cancel the underlying query (nothing client-side can) — it stops /health
 * from waiting; the losing promise is suppressed so a late rejection can
 * never surface as an unhandled rejection after the honest answer shipped.
 * deadlineMs <= 0 disables the race (tests).
 */
export async function withHealthDeadline<T>(p: PromiseLike<T>, deadlineMs: number, label: string): Promise<T> {
  if (!(deadlineMs > 0)) return await p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HealthDeadlineError(label, deadlineMs)), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void Promise.resolve(p).catch(() => {}); // late loser: already reported
  }
}

export interface HealthProviderReport {
  lastSuccessAt: string | null;
  ageMinutes: number | null;
  status: "ok" | "degraded" | "unknown";
  cadenceMinutes: number;
  staleAfterMinutes: number;
}

/** The one fast probe result: `SELECT 1` through the store's own pool. */
export interface HealthDatabaseReport {
  reachable: boolean;
  /** Wall-clock ms of the probe; null when the store exposes no ping (test fakes). */
  latencyMs: number | null;
  error?: string;
}

export interface HealthSchedulerReport {
  role: "holder" | "standby" | "stopped";
  tickInFlight: boolean;
  leaseName: string | null;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  version: string;
  commit: string;
  now: string;
  /** Identity (portability PART 2): when this process booted + its age. */
  bootedAt: string;
  uptimeSeconds: number;
  /** One fast probe + latency — honest reachability of the business database. */
  database: HealthDatabaseReport;
  /** Advisory-lock lease state (holder/standby), read query-free. */
  scheduler: HealthSchedulerReport;
  /** Keyed by provider for the five tracked sync providers. */
  providers: Record<string, HealthProviderReport>;
  /**
   * Reliability 2b/3: sync-heartbeat liveness (the 240s driver of every
   * background sync), classified from the newest TICK line in its log.
   * ADDITIVE field — the existing fields above are untouched (the owner's
   * /health consumers and the banner read them). Deliberately NOT folded
   * into `status`/the 200-vs-503 contract: a dead heartbeat stops syncs, and
   * the providers' own staleness already degrades `status` through the
   * existing rule — double-counting would change the external ping's contract
   * without an owner ruling. /health + the banner surface it directly.
   */
  heartbeat: HeartbeatFreshness;
  error?: string;
}

/**
 * THE status→HTTP contract: 200 when every tracked provider is ok, 503 when
 * ANY provider is degraded (or the check itself failed). Extracted so the
 * endpoint wiring (serve.ts) and the tests share one rule.
 *
 * PART 2 extension (same HTTP shape): an explicitly unreachable database is
 * degraded — today that already lands here because the freshness reads fail
 * with it; the probe makes it deterministic even when the reads squeak by.
 */
export function healthHttpStatus(payload: HealthPayload): number {
  return payload.status === "ok" ? 200 : 503;
}

function reportOf(f: ProviderFreshness): HealthProviderReport {
  return {
    lastSuccessAt: f.lastSuccessAt,
    ageMinutes: f.ageMinutes,
    status: f.status,
    cadenceMinutes: Math.round((f.cadenceMs / 60_000) * 10) / 10,
    staleAfterMinutes: f.staleAfterMinutes,
  };
}

/**
 * ONE fast connectivity probe (`SELECT 1` through the store's own pool — the
 * same bounded ping surface the sync passes warm with). Never throws: the
 * outcome IS the report. Stores without a ping (test fakes) report
 * reachable with null latency — absence of a probe surface is not a failure.
 */
export async function probeDatabase(store: Store, deadlineMs: number): Promise<HealthDatabaseReport> {
  const ping = (store as { ping?: () => Promise<unknown> }).ping;
  if (typeof ping !== "function") return { reachable: true, latencyMs: null };
  const t0 = Date.now();
  try {
    await withHealthDeadline(Promise.resolve(ping.call(store)), deadlineMs, "database probe");
    return { reachable: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { reachable: false, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

const unknownProviderReport = (): HealthProviderReport => ({
  lastSuccessAt: null,
  ageMinutes: null,
  status: "unknown",
  cadenceMinutes: 0,
  staleAfterMinutes: 0,
});

export async function buildHealthPayload(opts?: {
  store?: Store;
  now?: () => Date;
  settings?: AppSettings;
  /** Injected heartbeat freshness (tests); otherwise read from the log. */
  heartbeat?: HeartbeatFreshness;
  /** Override the heartbeat log path (tests); default per heartbeat-freshness. */
  heartbeatLogPath?: string;
  /** Injected boot time (tests); default the module's boot marker. */
  bootedAt?: Date;
  /** Injected scheduler state (tests); default the live query-free mirror. */
  scheduler?: HealthSchedulerReport;
  /** Override the per-await deadline (tests pin the slow-store behavior). */
  deadlineMs?: number;
}): Promise<HealthPayload> {
  const now = opts?.now ?? (() => new Date());
  const deadlineMs = opts?.deadlineMs ?? healthDeadlineMs();
  const bootedAt = opts?.bootedAt ?? APP_BOOTED_AT;
  const base = {
    version: APP_VERSION,
    commit: resolveGitCommit(),
    now: now().toISOString(),
    bootedAt: bootedAt.toISOString(),
    uptimeSeconds: Math.max(0, Math.round((now().getTime() - bootedAt.getTime()) / 1000)),
  };
  // Heartbeat freshness is store-INDEPENDENT (a local log read, never
  // throws) — computed outside the try so a store outage never blanks it.
  const heartbeat =
    opts?.heartbeat ??
    (await readHeartbeatFreshness({ now: now(), ...(opts?.heartbeatLogPath ? { logPath: opts.heartbeatLogPath } : {}) }));
  // Scheduler lease state is a query-free module read (never throws) —
  // reported even when the store is down: holder/standby/stopped is about
  // THIS process, not the database.
  const scheduler: HealthSchedulerReport = opts?.scheduler ?? schedulerLeaseState();
  let database: HealthDatabaseReport | null = null;
  try {
    const store = opts?.store ?? (await withHealthDeadline(getStore(), deadlineMs, "store resolution"));
    database = await probeDatabase(store, deadlineMs);
    const settings = opts?.settings ?? (await withHealthDeadline(store.getSettings(), deadlineMs, "settings read"));
    const lastSuccess = await withHealthDeadline(
      store.getLatestSuccessfulSyncRunByProvider(),
      deadlineMs,
      "sync-freshness read",
    );
    const freshness = computeProviderFreshness(lastSuccess, settings, now);
    const providers: Record<string, HealthProviderReport> = {};
    for (const f of freshness) providers[f.provider] = reportOf(f);
    const anyDegraded = freshness.some((f) => f.status === "degraded") || !database.reachable;
    return { status: anyDegraded ? "degraded" : "ok", ...base, database, scheduler, providers, heartbeat };
  } catch (e) {
    // The health check itself could not read its inputs (store unreachable…).
    // Honest 503 with the real reason — never a plausible-looking ok.
    const unknownProviders: Record<string, HealthProviderReport> = {};
    for (const p of FRESHNESS_PROVIDERS) unknownProviders[p] = unknownProviderReport();
    const db =
      database ??
      ({
        reachable: false,
        latencyMs: null,
        error: e instanceof Error ? e.message : String(e),
      } satisfies HealthDatabaseReport);
    return {
      status: "degraded",
      ...base,
      database: db,
      scheduler,
      providers: unknownProviders,
      heartbeat,
      error: `health check failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
