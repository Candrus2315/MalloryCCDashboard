/**
 * PER-FETCH HARD TIMEOUT (reliability Phase 2b, owner directive after the
 * 10/21–10/22 incidents) — one shared bound for EVERY outbound call the sync
 * engine makes, so a single hung provider call can never stall the tick or
 * block the providers behind it.
 *
 * WHY: the 15-min stale-run reaper honest-fails wedged RUN rows, but a hung
 * FETCH inside a live run just ages until the reap window passes — costing
 * cadence slots and leaving the other providers in the same tick stale
 * (10/21: two GHL incremental runs wedged >15 min; 10/22 morning: the sheets
 * call hung at wake while GHL and the rest of the tick sat behind it). The
 * per-RUN watchdog cap and the per-BODY-READ race (body-read.ts) cover other
 * failure classes; this module closes the per-CALL class uniformly.
 *
 * SCOPE — PER HTTP CALL, never per run: a full catch-up backfill makes many
 * calls and legitimately takes 25+ minutes. This cap bounds ONE call; runs
 * stay as long as their call count demands. Providers wire their existing
 * injectable per-request knobs (HlEndpointOpts.timeoutMs, the Acuity adapters'
 * timeoutMs, the sheets helpers' timeoutMs) to the SAME resolver so the env
 * var governs every provider.
 *
 * TWO independent bounds per call (the body-read.ts lesson, applied to the
 * request phase too):
 *   1. an AbortSignal.timeout armed on the request — a well-behaved fetch
 *      (Bun's) stops connecting/reading when it fires;
 *   2. a plain JS-timer race — the dependable bound that never depends on
 *      socket events or the fetch impl honoring the signal at all.
 * A caller-supplied signal (e.g. the run-level time budget from
 * makeBudgetBoundedFetch) is composed via AbortSignal.any and stays in force.
 */

/** Default per-call cap when SYNC_FETCH_TIMEOUT_MS is unset (~generous 90s). */
export const DEFAULT_SYNC_FETCH_TIMEOUT_MS = 90_000;

/** Env override for the per-call cap (ops lever; sane fallback when unset/invalid). */
export const SYNC_FETCH_TIMEOUT_ENV = "SYNC_FETCH_TIMEOUT_MS";

const MIN_TIMEOUT_MS = 5_000; // a cap below this would abort healthy slow calls
const MAX_TIMEOUT_MS = 10 * 60_000; // a cap above this defeats "never block the tick"

/**
 * Resolve the per-call timeout. Read at CALL time (not import time) so an env
 * change applies without a rebuild; clamped to a sane band; anything invalid
 * falls back to the default. Tests that need a sub-band cap inject timeoutMs
 * explicitly into the provider instead (they bypass this clamp on purpose).
 */
export function syncFetchTimeoutMs(envValue?: string): number {
  const raw = envValue ?? process.env[SYNC_FETCH_TIMEOUT_ENV];
  if (raw == null || raw === "") return DEFAULT_SYNC_FETCH_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SYNC_FETCH_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

/**
 * The timeout failure itself — carries the provider name and the cap so every
 * sync_runs error line reads the same honest shape:
 *   "fetch timeout after 90s (provider=google_sheets) — hung request aborted"
 * (Sub-second test caps render as ms: "fetch timeout after 250ms (…)".)
 * The message contains both "timeout" and "abort" so every existing
 * network-class classifier (SheetsError / HighLevelError / body-read
 * classifiers) recognizes it as retried-next-tick network class.
 */
export class FetchTimeoutError extends Error {
  readonly provider: string;
  readonly timeoutMs: number;
  constructor(provider: string, timeoutMs: number) {
    const rendered = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    super(`fetch timeout after ${rendered} (provider=${provider}) — hung request aborted`);
    this.name = "FetchTimeoutError";
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

/** Dual-path instanceof/name check (single module copy in this repo). */
export function isFetchTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.name === "FetchTimeoutError";
}

/** Same structural shape every sync client already injects (FetchLike in highlevel-live). */
export type TimedFetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface TimedFetchOpts {
  /** Provider label for the error line (highlevel / google_sheets / acuity / acuity_availability). */
  provider: string;
  /** Per-call cap in ms (the resolved syncFetchTimeoutMs() or an injected test cap). */
  timeoutMs: number;
}

/**
 * One outbound HTTP call under BOTH bounds. Arms AbortSignal.timeout composed
 * with any caller signal, races the call against a JS timer at the same cap,
 * and clears the timer on settle. Rejects with FetchTimeoutError when the cap
 * fires — the caller maps it verbatim into its own error class (or rethrows)
 * so the run fails honestly with the provider-named message.
 */
export async function timedFetch(
  impl: TimedFetchImpl,
  url: string,
  init: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal } | undefined,
  opts: TimedFetchOpts,
): Promise<Response> {
  const capSignal = AbortSignal.timeout(opts.timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, capSignal]) : capSignal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      impl(url, { ...(init ?? {}), signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FetchTimeoutError(opts.provider, opts.timeoutMs)), opts.timeoutMs);
      }),
    ])) as Response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
