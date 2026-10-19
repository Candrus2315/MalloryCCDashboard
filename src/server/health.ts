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
 */
import { getStore, type Store } from "./store";
import { computeProviderFreshness, FRESHNESS_PROVIDERS, type ProviderFreshness } from "./sync/freshness-watchdog";
import type { AppSettings } from "./store/types";

/**
 * App version — bump when a meaningful dashboard release ships. The git
 * commit resolves at runtime (the served build runs from the repo root; the
 * .git dir travels with the workspace). "unknown" is the honest fallback.
 */
export const APP_VERSION = "1.1.0";

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

export interface HealthProviderReport {
  lastSuccessAt: string | null;
  ageMinutes: number | null;
  status: "ok" | "degraded" | "unknown";
  cadenceMinutes: number;
  staleAfterMinutes: number;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  version: string;
  commit: string;
  now: string;
  /** Keyed by provider for the five tracked sync providers. */
  providers: Record<string, HealthProviderReport>;
  error?: string;
}

/**
 * THE status→HTTP contract: 200 when every tracked provider is ok, 503 when
 * ANY provider is degraded (or the check itself failed). Extracted so the
 * endpoint wiring (serve.ts) and the tests share one rule.
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

export async function buildHealthPayload(opts?: {
  store?: Store;
  now?: () => Date;
  settings?: AppSettings;
}): Promise<HealthPayload> {
  const now = opts?.now ?? (() => new Date());
  const base = {
    version: APP_VERSION,
    commit: resolveGitCommit(),
    now: now().toISOString(),
  };
  try {
    const store = opts?.store ?? (await getStore());
    const settings = opts?.settings ?? (await store.getSettings());
    const lastSuccess = await store.getLatestSuccessfulSyncRunByProvider();
    const freshness = computeProviderFreshness(lastSuccess, settings, now);
    const providers: Record<string, HealthProviderReport> = {};
    for (const f of freshness) providers[f.provider] = reportOf(f);
    const anyDegraded = freshness.some((f) => f.status === "degraded");
    return { status: anyDegraded ? "degraded" : "ok", ...base, providers };
  } catch (e) {
    // The health check itself could not read its inputs (store unreachable…).
    // Honest 503 with the real reason — never a plausible-looking ok.
    const unknownProviders: Record<string, HealthProviderReport> = {};
    for (const p of FRESHNESS_PROVIDERS) {
      unknownProviders[p] = {
        lastSuccessAt: null,
        ageMinutes: null,
        status: "unknown",
        cadenceMinutes: 0,
        staleAfterMinutes: 0,
      };
    }
    return {
      status: "degraded",
      ...base,
      providers: unknownProviders,
      error: `health check failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
