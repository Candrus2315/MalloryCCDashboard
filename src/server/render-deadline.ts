/**
 * SSR PAGE-RENDER DEADLINE (2026-11-04 live wedges) — pages must NEVER hang.
 *
 * The incident: six times tonight the live serve stopped rendering pages —
 * every page's request hung past the client's timeout while /health answered
 * instantly and the database showed all connections IDLE with zero waits.
 * Root cause (reproduced deterministically in
 * src/server/__tests__/page-render-deadline.test.ts): every page render
 * funnels through `loadPageMeta()` → `ensureDemoData()` (sync/run.ts), whose
 * module-level `seedInflight` memo is ADOPTED by every later caller. Nothing
 * bounded that memo's inner chain against a never-settling await — postgres.js
 * has NO pool-acquire timeout, so one hung checkout (a detached zombie
 * scheduler tick holding its connection; the tick watchdog deliberately leaves
 * such zombies running) parks every later `store.getUsers()` in the acquire
 * queue forever, the memo's clearing `finally` never runs, and EVERY page
 * render adopts the same never-settling promise until a restart. /health never
 * touches ensureDemoData — exactly the observed split.
 *
 * This module is the shared race-with-timer bound for that path (postgres.js
 * offers no driver-level acquire timeout; the same pattern as fetch-timeout.ts
 * and store/index.ts's raceProbe). Two use sites:
 *   1. ensureDemoData races its memoized inner work against
 *      pageRenderTimeoutMs() so the MEMO ITSELF always settles — on deadline
 *      the memo rejects honestly and its existing finally clears it, so the
 *      NEXT request starts fresh (no permanent poisoning).
 *   2. queries.ts page loaders wrap their builder with withPageRenderDeadline
 *      as belt-and-braces so any hang beyond the memo also fails fast
 *      per-request.
 *
 * LOSER RESOURCES: the losing promise is left detached (JS cannot cancel it).
 * It holds no memo (cleared by the deadline rejection) and, while merely
 * waiting on the pool acquire queue, no connection; an in-flight statement is
 * already server-capped (statement_timeout 300s) and a connect is capped at
 * 10s (db-pool-config) — so the loser cannot pin a pool connection forever.
 */
import {
  DEFAULT_PAGE_RENDER_TIMEOUT_MS,
  pageRenderTimeoutMs,
} from "./store/db-pool-config";

/** The deadline failure — honest, named, carries the cap for logs/error pages. */
export class PageRenderDeadlineError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    const rendered = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    super(
      `page render deadline: page data did not finish within ${rendered} — failing fast instead of hanging; retry the page`,
    );
    this.name = "PageRenderDeadlineError";
    this.timeoutMs = timeoutMs;
  }
}

/** Dual-path instanceof/name check (single module copy in this repo). */
export function isPageRenderDeadlineError(e: unknown): boolean {
  return e instanceof Error && e.name === "PageRenderDeadlineError";
}

/**
 * Race `work` against the deadline. `timeoutMs <= 0` disables the race
 * (passthrough — same convention as the probe backstop in store/index.ts).
 * The timer is cleared in the RACE's finally so a settled winner never leaves
 * a pending timer keeping the event loop alive.
 */
export function racePageRenderDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!(timeoutMs > 0)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PageRenderDeadlineError(timeoutMs)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Wrap a page-data builder (or any render-path thunk) in the deadline.
 * Reads pageRenderTimeoutMs() at CALL time (not import time) so an env change
 * applies without a rebuild; tests inject timeoutMs explicitly to avoid the
 * env clamp.
 */
export function withPageRenderDeadline<T>(
  work: () => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  return racePageRenderDeadline(work(), opts?.timeoutMs ?? pageRenderTimeoutMs());
}

/** Default surfaced for tests/docs (re-exported from the shared config). */
export const DEFAULT_RENDER_DEADLINE_MS = DEFAULT_PAGE_RENDER_TIMEOUT_MS;
