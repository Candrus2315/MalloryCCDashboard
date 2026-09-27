/**
 * S4 INCREMENTAL CONTACTS WALK (design: scratch/s4-design-note.md §3a) — the
 * cheap per-tick counterpart to the resumable full backfill
 * (contacts-backfill.ts, ckpt hl_contacts_backfill_v1, which this module NEVER
 * reads or resumes from — a deep cursor is never reused).
 *
 * ROOT CAUSE IT CLOSES: a contact created in HighLevel that never generates a
 * harvested call was never picked up by any routine path (the tick fetched
 * contacts ONLY individually, call-referenced). The gap grew silently
 * (116,155 DB vs 116,189 source at design time).
 *
 * MECHANICS — identity-keyed early-exit differential walk:
 *   1. GET /contacts/?locationId&limit=100 — page 1 ALWAYS (never a resumed
 *      cursor). meta.total from page 1 is captured for diagnostics.
 *   2. Follow meta.nextPageUrl VERBATIM (this account ignores a bare
 *      startAfterId and echoes it back — only nextPageUrl advances; the
 *      absolute cursor URL's path+query are replayed through the same
 *      auth/retry request path). sameCursor guard: the API echoing the SAME
 *      cursor twice stops the walk with a loud warning — never a loop.
 *   3. EARLY-EXIT when a FULL page contains ZERO external ids absent from
 *      knownExternalIds — IDENTITY-based, deliberately NOT ordering-based
 *      (the endpoint's sort order is unverified). A page where every contact
 *      is already stored means the walk has reached the stored frontier;
 *      whatever comes after is assumed known — the every-tick reconciliation
 *      tripwire (reconcileContacts) makes a wrong assumption visible within
 *      a day instead of silently forever.
 *   4. Caps (CONTACTS_WALK_MAX_PAGES / CONTACTS_WALK_MAX_NEW) truncate with a
 *      LOUD warning — never silence.
 *   5. Returns ONLY the new rows (differential: known contacts are not
 *      re-upserted; SYNC NOW refreshes them). The caller upserts and then owns
 *      the checkpoint write (scheduler.ts, after the successful upsert only).
 *
 * RECONCILIATION TRIPWIRE (design §3c, owner-mandated every tick): one
 * GET /contacts/?limit=1 probe → meta.total vs the store's countContacts().
 * |delta| > CONTACTS_DRIFT_WARN_THRESHOLD (25 ≈ one day of growth) warns —
 * including NEGATIVE delta (DB larger than source = HL deletions). v1 is
 * warn-only: catch-up = the resumable scripts/contacts-backfill.ts run; the
 * drift streak (consecutive drifting ticks) is tracked in the checkpoint so
 * the message can say how long the gap has persisted. A failed or
 * unparsable probe NEVER warns (no invented numbers).
 */
import { hlRequest, listOf, parseHlContact, type FetchLike, type HighLevelCreds, type HlEndpointOpts } from "./highlevel-live";
import { sameCursor } from "./contacts-backfill";
import type { NormalizedContact } from "./adapters";

/** Per-tick caps: a tick must stay cheap even if the API misbehaves. */
export const CONTACTS_WALK_MAX_PAGES = 5;
export const CONTACTS_WALK_MAX_NEW = 500;

export const CONTACTS_INCREMENTAL_CHECKPOINT_KEY = "hl_contacts_incremental_v1";
export const CONTACTS_RECONCILIATION_CHECKPOINT_KEY = "hl_contacts_reconciliation_v1";

/** |delta| above this warns (~1 day of growth at the observed ~10-33/day). */
export const CONTACTS_DRIFT_WARN_THRESHOLD = 25;
/** Consecutive drifting ticks after which the message names the catch-up job. */
export const CONTACTS_DRIFT_CATCHUP_STREAK = 3;

/**
 * PURE page scanner — which ids on one fetched page are absent from the known
 * set. Exported for fixture tests (the early-exit rule lives here, so tests
 * pin the identity semantics directly). Rows without a usable id count as
 * KNOWN for the exit decision (an id-less row carries no new identity and can
 * never be upserted).
 */
export function pageUnknownIds(page: { id: unknown }[], knownExternalIds: Set<string>): string[] {
  const unknown: string[] = [];
  for (const raw of page) {
    const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : null;
    if (!id) continue;
    if (!knownExternalIds.has(id)) unknown.push(id);
  }
  return unknown;
}

export interface ContactsWalkPlan {
  /** Unknown (new) external ids in page order, capped at maxNew. */
  newIds: string[];
  /** Pages scanned before the planner stopped. */
  pagesConsumed: number;
  /** True when a full page had zero unknown ids (the healthy early exit). */
  stoppedAllKnown: boolean;
  /** True when a cap (not the data) ended the walk — the caller warns. */
  truncated: boolean;
}

/**
 * PURE walk planner (mirror of planConversationsToVisit) — given the pages
 * fetched this tick, decide which ids are new and whether the walk ended on
 * data (a fully-known page) or on a cap. Exported for fixture tests.
 */
export function planContactsWalk(
  pages: { id: unknown }[][],
  knownExternalIds: Set<string>,
  caps: { maxPages?: number; maxNew?: number } = {},
): ContactsWalkPlan {
  const maxPages = caps.maxPages ?? CONTACTS_WALK_MAX_PAGES;
  const maxNew = caps.maxNew ?? CONTACTS_WALK_MAX_NEW;
  const newIds: string[] = [];
  const seenNew = new Set<string>();
  let pagesConsumed = 0;
  let stoppedAllKnown = false;
  let truncated = false;
  for (const page of pages.slice(0, maxPages)) {
    pagesConsumed += 1;
    const unknown = pageUnknownIds(page, knownExternalIds);
    if (unknown.length === 0) {
      // IDENTITY-based stop: a full page of already-known ids ends the walk.
      stoppedAllKnown = true;
      break;
    }
    for (const id of unknown) {
      if (seenNew.has(id)) continue; // same id on a later page is NOT new again
      if (newIds.length < maxNew) { seenNew.add(id); newIds.push(id); }
      else { truncated = true; break; }
    }
    if (truncated) break;
  }
  // More pages were available than the planner was allowed to scan (cap, not
  // data) → truncated. A healthy all-known stop is never a truncation.
  if (pages.length > pagesConsumed && !stoppedAllKnown) truncated = true;
  return { newIds, pagesConsumed, stoppedAllKnown, truncated };
}

export interface ContactsWalkResult {
  /** ONLY the new contacts (differential — known rows are never re-upserted). */
  rows: NormalizedContact[];
  newCount: number;
  pagesFetched: number;
  /** meta.total from the first page (diagnostics; null when absent). */
  sourceTotalSeen: number | null;
  /** True when a cap ended the walk (a warning is always emitted with it). */
  truncated: boolean;
  stoppedAllKnown: boolean;
  warnings: string[];
}

interface WalkRequest { path: string; query: URLSearchParams }

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch the newest contacts pages and return the differential (new rows only).
 * No store access — tests run against fixtures. Page 1 is always
 * /contacts/?locationId&limit=100; later pages replay meta.nextPageUrl
 * (absolute) as path+query through the same auth/retry request path.
 */
export async function harvestContactsIncremental(opts: {
  creds: HighLevelCreds;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** External ids already stored — the walk's identity frontier. */
  knownExternalIds: Set<string>;
  maxPages?: number;
  maxNew?: number;
}): Promise<ContactsWalkResult> {
  const endpointOpts: HlEndpointOpts = { creds: opts.creds, fetchImpl: opts.fetchImpl, sleep: opts.sleep ?? defaultSleep };
  const maxPages = opts.maxPages ?? CONTACTS_WALK_MAX_PAGES;
  const maxNew = opts.maxNew ?? CONTACTS_WALK_MAX_NEW;
  const warnings: string[] = [];

  const pages: { id: unknown }[][] = [];
  let sourceTotalSeen: number | null = null;
  let pagesFetched = 0;
  let stoppedAllKnown = false;
  let lastPageHadNext = false;
  let stuckCursor = false;
  let req: WalkRequest = { path: "/contacts/", query: new URLSearchParams({ locationId: opts.creds.locationId, limit: "100" }) };
  let lastNextPageUrl: string | null = null;

  while (pagesFetched < maxPages) {
    const body = (await hlRequest(req, endpointOpts)) as Record<string, unknown> | null;
    pagesFetched += 1;
    const meta = (body?.["meta"] ?? null) as Record<string, unknown> | null;
    if (pagesFetched === 1 && typeof meta?.["total"] === "number" && Number.isFinite(meta["total"])) {
      sourceTotalSeen = meta["total"] as number;
    }
    const items = listOf(body, "contacts", "data") as Record<string, unknown>[];
    pages.push(items);
    if (pageUnknownIds(items, opts.knownExternalIds).length === 0) {
      // IDENTITY-based early exit: a full page with zero new ids ends the walk.
      stoppedAllKnown = true;
      lastPageHadNext = false;
      break;
    }
    const nextRaw = meta?.["nextPageUrl"];
    const next = typeof nextRaw === "string" && nextRaw.trim() ? nextRaw.trim() : null;
    if (next && lastNextPageUrl != null && sameCursor(next, lastNextPageUrl)) {
      // Documented stuck-cursor failure mode (startAfterId echo) — stop loudly.
      warnings.push("contacts walk: stuck cursor — the API returned the same nextPageUrl twice (startAfterId-echo); walk stopped after the current page");
      stuckCursor = true;
      lastPageHadNext = false;
      break;
    }
    lastNextPageUrl = next;
    lastPageHadNext = next != null;
    if (!next) break;
    // Follow the cursor VERBATIM: replay the absolute URL's path+query through
    // the auth/retry request path (same host by construction of the API).
    const u = new URL(next);
    req = { path: u.pathname, query: u.searchParams };
  }

  const plan = planContactsWalk(pages, opts.knownExternalIds, { maxPages, maxNew });
  const newIdSet = new Set(plan.newIds);
  const rows: NormalizedContact[] = [];
  for (const page of pages) {
    for (const raw of page) {
      const id = typeof raw?.id === "string" ? raw.id : null;
      if (!id || !newIdSet.has(id)) continue;
      const c = parseHlContact(raw);
      if (c) rows.push(c);
    }
  }
  // A cap ended the walk when: the planner hit the new cap, or we stopped at
  // maxPages while the API still offered a next page (more data exists).
  const truncated = plan.truncated || stuckCursor || (lastPageHadNext && pagesFetched >= maxPages);
  if (truncated) {
    warnings.push(`contacts walk: cap hit (${pagesFetched} page(s) fetched, ${rows.length} new this tick) — remaining new contacts wait for the next tick`);
  }
  return {
    rows,
    newCount: rows.length,
    pagesFetched,
    sourceTotalSeen,
    truncated,
    stoppedAllKnown: plan.stoppedAllKnown,
    warnings,
  };
}

// ---------- every-tick reconciliation tripwire ----------

export interface ContactsReconciliationCheckpoint {
  lastCheckedAt: string;
  sourceTotal: number | null;
  dbCount: number | null;
  delta: number | null;
  status: "ok" | "drift" | "probe_failed";
  /** Consecutive ticks with |delta| above the warn threshold. */
  driftStreak: number;
  updatedAt: string;
}

export function parseReconciliationCheckpoint(v: string | null): ContactsReconciliationCheckpoint | null {
  if (!v) return null;
  try {
    const raw = JSON.parse(v) as Partial<ContactsReconciliationCheckpoint>;
    if (typeof raw.lastCheckedAt !== "string") return null;
    return {
      lastCheckedAt: raw.lastCheckedAt,
      sourceTotal: typeof raw.sourceTotal === "number" ? raw.sourceTotal : null,
      dbCount: typeof raw.dbCount === "number" ? raw.dbCount : null,
      delta: typeof raw.delta === "number" ? raw.delta : null,
      status: raw.status === "drift" || raw.status === "probe_failed" ? raw.status : "ok",
      driftStreak: typeof raw.driftStreak === "number" && Number.isFinite(raw.driftStreak) ? raw.driftStreak : 0,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : raw.lastCheckedAt,
    };
  } catch {
    return null;
  }
}

export interface ContactsReconciliationResult {
  checkpoint: ContactsReconciliationCheckpoint;
  /** True ONLY when a real measured |delta| exceeds the warn threshold. */
  warn: boolean;
  /** Human-readable coverage message when warn (null otherwise). */
  message: string | null;
}

/**
 * ONE probe (GET /contacts/?limit=1 → meta.total) vs the store's contact
 * count. Warn when |delta| > 25 — the source growing past the stored frontier
 * (missed new contacts, e.g. a wrong walk assumption) OR the DB exceeding the
 * source (HL deletions). Missing/unparsable meta.total → status probe_failed,
 * warn FALSE (the tripwire never invents numbers). Pure fetch+compare; the
 * caller owns checkpoint + connection-row persistence.
 */
export async function reconcileContacts(opts: {
  creds: HighLevelCreds;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  dbCount: number;
  now?: () => string;
  previous?: ContactsReconciliationCheckpoint | null;
}): Promise<ContactsReconciliationResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const previous = opts.previous ?? null;
  const endpointOpts: HlEndpointOpts = { creds: opts.creds, fetchImpl: opts.fetchImpl, sleep: opts.sleep ?? defaultSleep };
  let sourceTotal: number | null = null;
  try {
    const body = (await hlRequest({ path: "/contacts/", query: new URLSearchParams({ locationId: opts.creds.locationId, limit: "1" }) }, endpointOpts)) as Record<string, unknown> | null;
    const meta = (body?.["meta"] ?? null) as Record<string, unknown> | null;
    const total = meta?.["total"];
    if (typeof total === "number" && Number.isFinite(total)) sourceTotal = total;
  } catch {
    sourceTotal = null;
  }
  const lastCheckedAt = now();
  if (sourceTotal == null) {
    return {
      checkpoint: {
        lastCheckedAt, sourceTotal: null, dbCount: opts.dbCount, delta: null, status: "probe_failed",
        driftStreak: 0, updatedAt: lastCheckedAt,
      },
      warn: false,
      message: null,
    };
  }
  const delta = sourceTotal - opts.dbCount;
  const warn = Math.abs(delta) > CONTACTS_DRIFT_WARN_THRESHOLD;
  const driftStreak = warn ? (previous?.driftStreak ?? 0) + 1 : 0;
  let message: string | null = null;
  if (warn) {
    const direction = delta < 0
      ? "more contacts stored than HighLevel reports (possible deletions in the source)"
      : "new contacts in HighLevel are not stored yet";
    message = `Contact coverage: HighLevel reports ${sourceTotal} contacts, dashboard holds ${opts.dbCount} — ${direction}. Run SYNC NOW in Settings to catch up.`;
    if (driftStreak >= CONTACTS_DRIFT_CATCHUP_STREAK) {
      message += ` Drift persists for ${driftStreak} consecutive ticks — the resumable contacts backfill (scripts/contacts-backfill.ts) closes large gaps.`;
    }
  }
  return {
    checkpoint: {
      lastCheckedAt, sourceTotal, dbCount: opts.dbCount, delta,
      status: warn ? "drift" : "ok", driftStreak, updatedAt: lastCheckedAt,
    },
    warn,
    message,
  };
}
