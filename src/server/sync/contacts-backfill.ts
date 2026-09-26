/**
 * RESUMABLE HIGHLEVEL CONTACTS BACKFILL (owner-ratified attribution program,
 * Session 1). Fetches the COMPLETE HL contact population (meta.total ≈ 116k,
 * probed live 2026-09-26) page by page and upserts it — never deletes, never
 * truncates, never holds more than one page in memory.
 *
 * ROOT CAUSE THIS JOB EXCLUDES (proven against the live API 2026-09-26):
 * the old fetchContacts() advanced pagination via meta.startAfterId alone.
 * This account's /contacts/ endpoint IGNORES a bare startAfterId and echoes
 * it back unchanged (currentPage stays 1, same 100 rows) — so every prior
 * sync re-read page 1 until the 2,000 snapshot cap and stored only ~100
 * unique contacts (DB held 119: one page + stragglers). The API's
 * meta.nextPageUrl — which carries BOTH startAfterId AND the startAfter
 * timestamp — DOES advance. This job therefore:
 *   1. follows meta.nextPageUrl verbatim, and
 *   2. refuses to continue if the API ever returns the same nextPageUrl
 *      twice in a row (the stuck-cursor failure mode, fail loudly instead
 *      of looping).
 *
 * RESUME SEMANTICS: the pagination cursor is persisted (checkpoint store)
 * after EVERY page. An interrupted run resumes from the stored cursor —
 * never from page 1. Upserts are keyed by HL contact ID so re-running any
 * page is idempotent.
 *
 * UPSERT-ONLY: a page only ever inserts/updates the rows it carries. Rows
 * absent from a page are untouched (the routine full sync is verified
 * upsert-not-replace as well — the only contacts DELETE in the codebase
 * targets demo-% ids).
 */
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";
import type { ContactRow } from "../store/types";

// ---------- pure row parsing (exported for tests) ----------
export interface HlContactRaw {
  id?: unknown;
  contactName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  phone?: unknown;
  email?: unknown;
  assignedTo?: unknown;
  dateAdded?: unknown;
  dateUpdated?: unknown;
}

function asStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length) return v.trim();
  return null;
}

export const CONTACTS_BACKFILL_CHECKPOINT_KEY = "hl_contacts_backfill_v1";

/**
 * One HL raw contact → the stored row. Raw values verbatim (phone/email AND
 * phone_raw/email_raw); canonical identity keys via the normalizers; source
 * timestamps from dateAdded/dateUpdated; last_synced_at = now.
 */
export function contactRowFromHl(raw: HlContactRaw, nowIso: string, userIdByExternal?: Map<string, string>): ContactRow | null {
  const id = asStr(raw.id);
  if (!id) return null;
  const first = asStr(raw.firstName);
  const last = asStr(raw.lastName);
  const name = asStr(raw.contactName) ?? [first, last].filter(Boolean).join(" ") ?? id;
  const phone = asStr(raw.phone);
  const email = asStr(raw.email);
  const assignedTo = asStr(raw.assignedTo);
  return {
    id: "",
    provider: "highlevel",
    external_id: id,
    name,
    first_name: first,
    last_name: last,
    phone,
    email,
    phone_raw: phone,
    email_raw: email,
    phone_normalized: normalizeUSPhone(phone),
    email_normalized: normalizeEmail(email),
    assigned_rep_id: assignedTo ? userIdByExternal?.get(`highlevel:${assignedTo}`) ?? null : null,
    source_created_at: asStr(raw.dateAdded),
    source_updated_at: asStr(raw.dateUpdated),
    last_synced_at: nowIso,
  };
}

// ---------- engine ----------
export interface ContactsPage {
  rows: HlContactRaw[];
  /** meta.nextPageUrl verbatim (absolute URL), or null on the last page. */
  nextPageUrl: string | null;
  /** meta.total from the API — the HL-reported source population size. */
  total: number | null;
}

export type FetchContactsPage = (url: string) => Promise<ContactsPage>;

export interface ContactsBackfillCheckpoint {
  /** Cursor for the NEXT page to fetch (absolute URL), null before the first fetch. */
  nextPageUrl: string | null;
  pagesDone: number;
  upserted: number;
  sourceTotal: number | null;
  /** Pages that permanently failed after sustained retries (cursor preserved → resumable). */
  failedPages: { url: string; error: string; at: string }[];
  updatedAt: string;
}

export interface ContactsBackfillDeps {
  fetchPage: FetchContactsPage;
  upsertContacts: (rows: ContactRow[]) => Promise<number>;
  loadCheckpoint: () => Promise<ContactsBackfillCheckpoint | null>;
  saveCheckpoint: (cp: ContactsBackfillCheckpoint) => Promise<void>;
  /** Milliseconds to sleep between pages (rate-limit pacing). Default 250 ≈ 4 req/s. */
  pageDelayMs?: number;
  /** Stop after this many pages this run (checkpoint stays valid; rerun to continue). */
  maxPagesThisRun?: number;
  /** Retry attempts per page on 429/5xx before giving up. Default 8. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  log?: (line: string) => void;
  /** Optional contact→user resolution for assigned_rep_id (raw id preserved in HL). */
  userIdByExternal?: Map<string, string>;
}

export class ContactsBackfillPermanentError extends Error {
  constructor(message: string, readonly failedUrl: string, readonly checkpoint: ContactsBackfillCheckpoint) {
    super(message);
    this.name = "ContactsBackfillPermanentError";
  }
}

const DEFAULT_PAGE_DELAY_MS = 250; // ~4 req/s — conservative vs HL rate limits
const DEFAULT_MAX_RETRIES = 8;

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 60_000);
}

/** Cursor equality ignoring query-param ORDER (the API reorders params when it echoes a cursor back). */
export function sameCursor(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return a === b;
  const ua = new URL(a);
  const ub = new URL(b);
  if (ua.origin + ua.pathname !== ub.origin + ub.pathname) return false;
  const qa = [...ua.searchParams.entries()].sort(([k1], [k2]) => (k1 < k2 ? -1 : 1));
  const qb = [...ub.searchParams.entries()].sort(([k1], [k2]) => (k1 < k2 ? -1 : 1));
  return JSON.stringify(qa) === JSON.stringify(qb);
}

export interface ContactsBackfillOutcome {
  done: boolean;
  pagesDoneThisRun: number;
  upsertedTotal: number;
  sourceTotal: number | null;
  checkpoint: ContactsBackfillCheckpoint;
}

export async function runContactsBackfill(deps: ContactsBackfillDeps, startUrl: string): Promise<ContactsBackfillOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});
  const pageDelayMs = deps.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;

  const cp: ContactsBackfillCheckpoint = (await deps.loadCheckpoint()) ?? {
    nextPageUrl: null,
    pagesDone: 0,
    upserted: 0,
    sourceTotal: null,
    failedPages: [],
    updatedAt: now(),
  };
  let url: string | null = cp.nextPageUrl ?? startUrl;
  let pagesThisRun = 0;
  let lastNextPageUrl: string | null = cp.pagesDone > 0 ? cp.nextPageUrl : null;

  for (;;) {
    if (deps.maxPagesThisRun != null && pagesThisRun >= deps.maxPagesThisRun) {
      log(`pausing cleanly at checkpoint after ${pagesThisRun} page(s) this run (${cp.pagesDone} total) — rerun to resume`);
      return { done: false, pagesDoneThisRun: pagesThisRun, upsertedTotal: cp.upserted, sourceTotal: cp.sourceTotal, checkpoint: cp };
    }
    // fetch one page with retry/backoff; a permanently failed page is recorded
    // and the run STOPS at its checkpoint (the next page's cursor is unknown —
    // continuing would skip contacts, so fail loudly instead).
    let page: ContactsPage;
    for (let attempt = 0; ; attempt++) {
      try {
        page = await deps.fetchPage(url as string);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retryable = /429|rate|500|502|503|504|network|fetch/i.test(msg);
        if (!retryable || attempt >= maxRetries) {
          cp.failedPages = [...cp.failedPages, { url: url as string, error: msg, at: now() }].slice(-50);
          cp.updatedAt = now();
          await deps.saveCheckpoint(cp);
          throw new ContactsBackfillPermanentError(`page failed after ${attempt + 1} attempt(s): ${msg}`, url as string, cp);
        }
        log(`page attempt ${attempt + 1} failed (${msg}) — backing off ${backoffMs(attempt)}ms`);
        await sleep(backoffMs(attempt));
      }
    }

    if (page.total != null) cp.sourceTotal = page.total;
    if (lastNextPageUrl != null && page.nextPageUrl != null && sameCursor(page.nextPageUrl, lastNextPageUrl)) {
      // The documented stuck-cursor failure mode: the API echoed the same
      // cursor back. Fail loudly — looping would re-upsert page 1 forever.
      cp.updatedAt = now();
      await deps.saveCheckpoint(cp);
      throw new ContactsBackfillPermanentError(
        "stuck cursor: the API returned the same nextPageUrl twice in a row (startAfterId-echo failure mode) — pagination cannot advance",
        page.nextPageUrl,
        cp,
      );
    }

    const nowIso = now();
    const rows: ContactRow[] = [];
    for (const raw of page.rows) {
      const r = contactRowFromHl(raw, nowIso, deps.userIdByExternal);
      if (r) rows.push(r);
    }
    if (rows.length) await deps.upsertContacts(rows);
    cp.pagesDone += 1;
    cp.upserted += rows.length;
    cp.nextPageUrl = page.nextPageUrl;
    cp.updatedAt = nowIso;
    await deps.saveCheckpoint(cp); // checkpoint EVERY page — resume never restarts
    pagesThisRun += 1;
    log(`page ${cp.pagesDone}: +${rows.length} contacts (total upserted ${cp.upserted}${cp.sourceTotal != null ? ` / source ${cp.sourceTotal}` : ""})`);

    lastNextPageUrl = page.nextPageUrl;
    if (!page.nextPageUrl) {
      log(`DONE: ${cp.pagesDone} pages, ${cp.upserted} contacts upserted (source total ${cp.sourceTotal})`);
      return { done: true, pagesDoneThisRun: pagesThisRun, upsertedTotal: cp.upserted, sourceTotal: cp.sourceTotal, checkpoint: cp };
    }
    url = page.nextPageUrl;
    if (pageDelayMs > 0) await sleep(pageDelayMs);
  }
}
