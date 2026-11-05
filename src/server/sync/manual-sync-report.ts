/**
 * MANUAL-SYNC HONESTY (portability 2026-11-05, PART 2 deliverable 2) — the
 * pure outcome-reporting rules for the two manual sync actions.
 *
 * THE CONTRACT (owner directive):
 *   • the displayed "last synced" timestamp may advance ONLY after the
 *     triggered pass actually succeeds — a failed pass leaves the previous
 *     timestamp AND surfaces a visible error;
 *   • a manual action must never report success while the source data is
 *     stale — success display is derived from the REAL pass outcome, never
 *     optimistic.
 *
 * The server side already obeys the timestamp rule: both `syncNow` (the
 * Settings Sync Center) and `refreshNow` (the shell chip) AWAIT the real pass
 * and re-read their stamps from the store afterward — the store only stamps
 * `last_successful_sync_at` on success, so a failed pass cannot move them.
 * What was missing is honest MESSAGING: the Settings panel unconditionally
 * said "Sync complete" even when providers errored, and the shell chip had no
 * visible error text at all (only a red dot + a hover title). These pure
 * functions turn the real pass outcome into the displayed state; the routes
 * consume them verbatim. UI-classification only — no business logic.
 *
 * No React, no store, no network: unit-pinned end to end.
 */

// ---------------------------------------------------------------------------
// SYNC NOW (Settings Sync Center) — runDemoSync's per-provider outcome
// ---------------------------------------------------------------------------

export interface SyncProviderOutcome {
  provider: string;
  count: number;
  error: string | null;
}

export interface SyncCenterResult {
  mode: string;
  providers: SyncProviderOutcome[];
  startedAt?: string;
  finishedAt?: string;
}

export interface ManualSyncReport {
  /** False when ANY provider errored (or none ran) — never a fake "complete". */
  ok: boolean;
  /** The exact status line the Sync Center renders (danger-styled when !ok). */
  message: string;
}

/**
 * The SYNC NOW status line, derived from the REAL per-provider outcomes.
 * Success format is byte-identical to the pre-P2 line ("Sync complete (mode):
 * provider N, …"). Any provider error → the line says FAILED, names the
 * failing provider(s) with their errors, and lists the providers that DID
 * complete — stale source data can never display as a success.
 */
export function syncCenterReport(res: SyncCenterResult): ManualSyncReport {
  const failures = res.providers.filter((p) => !!p.error);
  const list = res.providers.map((p) => `${p.provider} ${p.count}`).join(", ");
  if (res.providers.length === 0) {
    return { ok: false, message: `Sync FAILED (${res.mode}): no provider ran — nothing synced` };
  }
  if (failures.length === 0) {
    return { ok: true, message: `Sync complete (${res.mode}): ${list}` };
  }
  const failedPart = failures.map((f) => `${f.provider}: ${f.error}`).join("; ");
  const okPart = res.providers.filter((p) => !p.error);
  const okSuffix = okPart.length > 0 ? ` — ok: ${okPart.map((p) => `${p.provider} ${p.count}`).join(", ")}` : "";
  return { ok: false, message: `Sync FAILED (${res.mode}): ${failedPart}${okSuffix}` };
}

// ---------------------------------------------------------------------------
// SHELL REFRESH — the freshness chip after one manual tick
// ---------------------------------------------------------------------------

/** The slice of SchedulerTickResult the chip needs (serializable). */
export interface TickOutcomeLite {
  outcome: "synced" | "skipped" | "error";
  reason?: string;
  error?: string;
}

/** refreshNow's server-fn response (stamps are re-read from the store). */
export interface FreshnessResponse {
  tick: TickOutcomeLite;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  newestSuccessAt: string | null;
  lastError: string | null;
  running: boolean;
  serverNow: string;
}

/** The freshness state the chip displays (the highlevel view + the newest stamp). */
export interface FreshnessStateSnapshot {
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  newestSuccessAt: string | null;
  lastError: string | null;
}

export interface FreshnessTickReport {
  /** False on error/skipped — the chip must NOT display a fresh success. */
  ok: boolean;
  /** Visible note under the chip: the failure/skip reason, null on success. */
  note: string | null;
  /** The next state for the chip — timestamps only ever move on real success. */
  next: FreshnessStateSnapshot;
}

/**
 * Map one awaited manual tick onto the freshness chip's next state.
 *
 * • synced   → connected; timestamps = the post-pass store reads (advanced).
 * • error    → error status, timestamps = the post-pass store reads (the store
 *              never stamped a success, i.e. unchanged), VISIBLE failure note.
 * • skipped  → the previous status is PRESERVED (a skip must not erase an
 *              error dot), timestamps unchanged, skip note shown.
 *
 * The timestamps come from res (store reads after the pass) in every branch —
 * the "fail leaves the previous timestamp" property is enforced by the store
 * (success-only stamping) and pinned by the tests.
 */
export function freshnessAfterTick(prev: FreshnessStateSnapshot, res: FreshnessResponse): FreshnessTickReport {
  const stamps = {
    lastSyncAt: res.lastSyncAt,
    lastSuccessAt: res.lastSuccessAt,
    newestSuccessAt: res.newestSuccessAt,
  };
  if (res.tick.outcome === "synced") {
    return {
      ok: true,
      note: null,
      next: { status: "connected", ...stamps, lastError: res.lastError },
    };
  }
  if (res.tick.outcome === "error") {
    const err = res.lastError ?? res.tick.error ?? "sync failed";
    return {
      ok: false,
      note: `Sync failed — ${err}`,
      next: { status: "error", ...stamps, lastError: err },
    };
  }
  // skipped: another run holds the tick slot (or the provider said skip) —
  // report the skip honestly and keep the previous error state.
  const reason = res.tick.reason || "another sync is already running";
  return {
    ok: false,
    note: `Sync skipped — ${reason}`,
    next: { status: prev.status, ...stamps, lastError: res.lastError ?? prev.lastError },
  };
}

/** The visible note when the manual action itself throws (server fn rejected). */
export function noteFromThrownSync(e: unknown): string {
  return `Sync failed — ${e instanceof Error ? e.message : String(e)}`;
}
