/**
 * BOUNDED RESPONSE-BODY READS + BUDGET-BOUNDED FETCH (2026-10-17 hardening).
 *
 * WHY THIS EXISTS — the third hang of this failure class (harvest run of
 * 2026-10-15 21:46 UTC held the provider 'highlevel' sync_runs mutex for
 * ~14.8 HOURS): every sync client bound the REQUEST phase (connect + response
 * headers) with an AbortSignal AND a race timeout, but left the BODY READ
 * (`res.json()`) outside both bounds. Probe evidence (2026-10-12 + 10-15):
 * Bun's fetch honors an armed AbortSignal for a body read that is actively
 * streaming, but a body read PARKED on a stalled/dead socket does not wake
 * when the signal fires — the read sits on the socket until some network
 * event finally arrives (observed: 14.8h, 19.2h, 66.2h — /tmp/serve.log tick
 * durations and the harvest run's stopped_reason "The operation timed out."
 * surfacing only when the OS finally broke the connection). The abort signal
 * alone therefore cannot bound a parked body read; a plain JS-timer race can
 * (it never depends on socket events).
 *
 * Every sync client now races its body reads against the same per-request
 * cap used for the headers. Failure is classified DUAL-PATH (code OR message)
 * mirroring sheets-live's isNetworkBodyError convention, so a raced body
 * timeout surfaces as a network-class sync error — retried next tick — and
 * never as a plausible empty payload.
 */

/** The same dual-path network tokens sheets-live classifies body failures with. */
const NETWORK_BODY_ERROR_RE =
  /\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|CONNECT_TIMEOUT|CONNECTION_CLOSED|connection timed out|timed out|timeout|fetch failed|body read|aborted|underlying connection/i;

/**
 * True when a body-read rejection is network-class (stalled/truncated socket,
 * raced timeout, abort) rather than a merely non-JSON document. Dual-path per
 * the isTransientDbError classification convention: the token can arrive via
 * error.code OR error.message (Bun's fetch layer humanizes messages without
 * the errno token; node-layer errors carry it in code+message).
 */
export function isNetworkBodyErrorLike(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e instanceof SyntaxError && /unexpected end/i.test(e.message)) return true;
  const code = (e as { code?: unknown }).code;
  return NETWORK_BODY_ERROR_RE.test(String(code ?? "")) || NETWORK_BODY_ERROR_RE.test(e.message);
}

/**
 * Race a response-body promise against `timeoutMs`. The AbortSignal already
 * armed on the fetch cannot wake a body read parked on a silent socket (see
 * module docblock), so the race timer is the only dependable bound.
 * Rejects with an Error whose message contains "timed out" AND "aborted" so
 * every downstream classifier (HighLevelError / SheetsError / Acuity plain
 * errors) recognizes it as the network/timeouts class.
 */
export async function raceBodyRead<T>(body: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      body,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} stalled — no body bytes within ${Math.round(timeoutMs / 1000)}s, read aborted (hung body read timed out)`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type BoundedFetch = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal },
) => Promise<Response>;

/**
 * Wrap a fetch so the RUN-LEVEL time budget aborts an in-flight request even
 * when every per-request bound has already been honored (belt-and-braces for
 * scripts/run-harvest.ts: the `minutes` argument must actually abort a hung
 * fetch, not just be checked between chunks). The budget signal is combined
 * with whatever signal the caller passed (hlRequest arms its own per-request
 * signal) via AbortSignal.any; a budget abort rejects with the budget message
 * so the caller can map it to an honest "time-budget" stopped_reason instead
 * of a misleading per-request timeout message.
 */
export function makeBudgetBoundedFetch(base: BoundedFetch, budgetSignal: AbortSignal, what: string): BoundedFetch {
  return (url, init) => {
    if (budgetSignal.aborted) {
      return Promise.reject(new Error(`${what}: time budget exhausted — fetch aborted before it started`));
    }
    const budgetAbort = new Promise<never>((_, reject) => {
      budgetSignal.addEventListener(
        "abort",
        () => reject(new Error(`${what}: time budget exhausted — fetch aborted mid-flight`)),
        { once: true },
      );
    });
    const combined = init?.signal ? AbortSignal.any([init.signal, budgetSignal]) : budgetSignal;
    return Promise.race([base(url, { ...init, signal: combined }), budgetAbort]);
  };
}
