/**
 * INCREMENTAL HighLevel sync — the cheap per-tick counterpart to the 30-day
 * backfill in highlevel-live.ts. Reads ONLY activity newer than the stored
 * watermark (plus a small overlap), so a background tick costs a handful of
 * requests instead of a full conversation harvest:
 *
 *   1. GET /users/                     — 1 request, keeps reps current.
 *   2. GET /conversations/search       — newest-first; pages until every
 *      conversation on a page predates the watermark (or caps hit).
 *   3. GET /conversations/{id}/messages per in-window conversation —
 *      TYPE_CALL messages with dateAdded >= since are collected.
 *   4. GET /contacts/{id} per contact referenced by a NEW call (usually a
 *      handful) so rep/contact linkage stays resolvable without the 2k-cap
 *      contact snapshot.
 *
 * Upstreams upsert by external ID, so re-seeing a call is harmless. The
 * watermark is advanced by the CALLER (scheduler.ts) only after a successful
 * store write — this module is pure fetch+parse.
 */
import { hlRequest, listOf, parseHlCall, parseHlContact, parseHlUser, type FetchLike, type HighLevelCreds, type HlEndpointOpts } from "./highlevel-live";
import type { NormalizedCall, NormalizedContact, NormalizedUser } from "./adapters";

/** Extra lookback on the watermark so a call added with a slightly older dateAdded is not missed. */
export const WATERMARK_OVERLAP_SECONDS = 300;
/** Per-tick caps: a tick must stay cheap even if the API misbehaves. */
export const INCREMENTAL_CONVERSATION_CAP = 200;
export const INCREMENTAL_SCAN_PAGES = 3;
export const INCREMENTAL_CONTACT_FETCH_CAP = 100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface IncrementalHarvest {
  users: NormalizedUser[];
  contacts: NormalizedContact[];
  calls: NormalizedCall[];
  conversationsVisited: number;
  /** Newest message/call timestamp observed (ISO) — useful for watermark sanity checks. */
  newestActivityIso: string | null;
  warnings: string[];
}

/**
 * PURE window planner — which conversation ids should be visited this tick.
 * Conversations arrive newest-first (as the endpoint guarantees); a page where
 * every lastMessageDate predates `sinceMs` ends the scan. Exported for
 * fixture tests.
 */
export function planConversationsToVisit(
  pages: { id: string; lastMessageDateMs: number }[][],
  sinceMs: number,
  caps: { conversationCap?: number; scanPages?: number } = {},
): { visitIds: string[]; truncated: boolean } {
  const conversationCap = caps.conversationCap ?? INCREMENTAL_CONVERSATION_CAP;
  const scanPages = caps.scanPages ?? INCREMENTAL_SCAN_PAGES;
  const visitIds: string[] = [];
  let truncated = false;
  for (let p = 0; p < Math.min(pages.length, scanPages); p++) {
    const page = pages[p];
    let inWindow = 0;
    for (const c of page) {
      if (c.lastMessageDateMs >= sinceMs) {
        inWindow += 1;
        if (visitIds.length < conversationCap) visitIds.push(c.id);
        else truncated = true;
      }
    }
    // Newest-first: a page with zero in-window conversations means everything
    // after is older — stop (never page through the whole history per tick).
    if (inWindow === 0) break;
  }
  if (pages.length > scanPages) {
    const laterPagesHaveWindow = pages
      .slice(scanPages)
      .some((page) => page.some((c) => c.lastMessageDateMs >= sinceMs));
    if (laterPagesHaveWindow) truncated = true;
  }
  return { visitIds, truncated };
}

/**
 * Fetch everything newer than `sinceMs` through a stub-able fetchImpl.
 * `pages` of conversations are read until out-of-window; each visited
 * conversation's messages are scanned for calls in-window; referenced contacts
 * are fetched individually. No store access — tests run against fixtures.
 */
export async function harvestIncremental(opts: {
  creds: HighLevelCreds;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  sinceMs: number;
}): Promise<IncrementalHarvest> {
  const endpointOpts: HlEndpointOpts = { creds: opts.creds, fetchImpl: opts.fetchImpl, sleep: opts.sleep ?? defaultSleep };
  const warnings: string[] = [];

  // 1) users snapshot (single unpaginated request on this account)
  const usersBody = (await hlRequest({ path: "/users/", query: new URLSearchParams({ locationId: opts.creds.locationId }) }, endpointOpts)) as Record<string, unknown> | null;
  const users: NormalizedUser[] = [];
  for (const raw of listOf(usersBody, "users", "data")) {
    const u = parseHlUser(raw as Record<string, unknown>);
    if (u) users.push(u);
  }

  // 2) conversations newer than the watermark (newest-first, stop when old)
  const convs: { id: string; lastMessageDateMs: number }[] = [];
  for (let page = 0; page < INCREMENTAL_SCAN_PAGES; page++) {
    const query = new URLSearchParams({ locationId: opts.creds.locationId, limit: "100", offset: String(page * 100) });
    const body = (await hlRequest({ path: "/conversations/search", query }, endpointOpts)) as Record<string, unknown> | null;
    const items = listOf(body, "conversations", "data") as Record<string, unknown>[];
    if (items.length === 0) break;
    for (const c of items) {
      const id = typeof c["id"] === "string" ? c["id"] : null;
      if (!id) continue;
      const last = typeof c["lastMessageDate"] === "number" ? c["lastMessageDate"] : Date.parse(String(c["lastMessageDate"] ?? "")) || 0;
      convs.push({ id, lastMessageDateMs: last });
    }
    if (!items.some((c) => {
      const last = typeof c["lastMessageDate"] === "number" ? c["lastMessageDate"] : Date.parse(String(c["lastMessageDate"] ?? "")) || 0;
      return last >= opts.sinceMs;
    })) break;
  }
  const plan = planConversationsToVisit([convs], opts.sinceMs);
  if (plan.truncated) warnings.push(`incremental: visit cap hit (${plan.visitIds.length} conversations) — some very recent activity may wait for the next tick`);

  // 3) messages per visited conversation → in-window TYPE_CALL rows
  const calls = new Map<string, NormalizedCall>();
  const contactIds = new Set<string>();
  let newestActivityMs = 0;
  for (const convId of plan.visitIds) {
    const body = (await hlRequest({ path: `/conversations/${convId}/messages`, query: new URLSearchParams({ limit: "50" }) }, endpointOpts)) as Record<string, unknown> | null;
    const wrapper = (body?.["messages"] ?? null) as Record<string, unknown> | null;
    for (const m of listOf(wrapper as Record<string, unknown> | null, "messages", "data")) {
      const call = parseHlCall(m as Record<string, unknown>);
      if (!call) continue;
      const ts = Date.parse(call.startedAt);
      if (ts >= opts.sinceMs) {
        calls.set(call.external_call_id, call);
        contactIds.add(call.contactExternalId);
        if (ts > newestActivityMs) newestActivityMs = ts;
      }
    }
  }

  // 4) fetch each referenced contact not already known from the snapshot path
  const contacts: NormalizedContact[] = [];
  let fetchedContacts = 0;
  for (const contactId of contactIds) {
    if (fetchedContacts >= INCREMENTAL_CONTACT_FETCH_CAP) {
      warnings.push(`incremental: contact fetch cap (${INCREMENTAL_CONTACT_FETCH_CAP}) hit — some new calls may link by phone/email on the next full sync`);
      break;
    }
    try {
      const body = (await hlRequest({ path: `/contacts/${contactId}`, query: new URLSearchParams({ locationId: opts.creds.locationId }) }, endpointOpts)) as Record<string, unknown> | null;
      const raw = (body?.["contact"] ?? body) as Record<string, unknown> | null;
      const c = raw ? parseHlContact(raw) : null;
      if (c) {
        contacts.push(c);
        fetchedContacts += 1;
      }
    } catch {
      warnings.push(`incremental: contact ${contactId} fetch failed — call stored, contact link retried next sync`);
    }
  }

  return {
    users,
    contacts,
    calls: [...calls.values()],
    conversationsVisited: plan.visitIds.length,
    newestActivityIso: newestActivityMs ? new Date(newestActivityMs).toISOString() : null,
    warnings,
  };
}
