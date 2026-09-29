/**
 * LIVE HighLevel adapter — API v2 (https://services.leadconnectorhq.com),
 * header `Version: 2021-07-28`, bearer HIGHLEVEL_API_KEY + locationId
 * HIGHLEVEL_LOCATION_ID (resolved case-insensitively by env.ts).
 *
 * REAL ENDPOINT QUIRKS (probed against the Mallory location, 2026-09-26 —
 * the docs and this account disagree in several places):
 *  - GET /calls/            → 404 on this account. Calls are therefore
 *    extracted from conversations: GET /conversations/search (offset pages)
 *    finds conversations active in the window, then
 *    GET /conversations/{id}/messages yields messages with
 *    messageType === "TYPE_CALL" carrying meta.call.duration (SECONDS, null
 *    for voicemail/missed), direction, status, userId, ISO dateAdded.
 *  - GET /users/            → 200 but REJECTS limit/offset (422
 *    "property limit should not exist") — single unpaginated request.
 *  - GET /contacts/         → cursor pagination. PROVEN QUIRK (2026-09-26):
 *    a bare `startAfterId` param is IGNORED and echoed back (page 1 repeats
 *    forever — the old bug that left ~119 contacts in the DB); pagination
 *    MUST follow meta.nextPageUrl verbatim (it carries startAfterId AND the
 *    startAfter timestamp). The location reports 116k contacts, so the
 *    snapshot is capped (CONTACT_SNAPSHOT_CAP) at the most recent contacts;
 *    truncation is recorded as a warning, never silently ignored. The FULL
 *    population is backfilled once by scripts/contacts-backfill.ts.
 *  - GET /opportunities/    → 404; POST /opportunities/search works.
 *    REAL CONTRACT (re-verified live 2026-09-29): body {locationId, limit,
 *    page} with page 1-BASED (page 0 is clamped to page 1 — identical rows);
 *    SUCCESS RETURNS HTTP 201 (any 2xx is success); the body REJECTS
 *    `offset` (422) AND `pipelineId` (422 "property pipelineId should not
 *    exist") — there is NO server-side pipeline filter, so the snapshot pages
 *    the FULL set and groups client-side. Each response carries a top-level
 *    `total` (no meta object); paging stops on a short page.
 *
 * BACKFILL DEPTH (documented per task spec):
 *  - calls:   trailing CALL_BACKFILL_DAYS (30) days. Every conversation whose
 *    lastMessageDate falls in the window is visited (a call inside the window
 *    is itself a message, so its conversation's lastMessageDate must be
 *    in-window — no call can be missed by this filter); each conversation's
 *    messages are scanned for TYPE_CALL messages within the window.
 *  - users:   full current snapshot (39 users).
 *  - contacts: most-recent snapshot up to CONTACT_SNAPSHOT_CAP (116k total —
 *    full snapshot is not cheaply fetchable; cap recorded as warning).
 *  - opportunities: full current snapshot up to OPPORTUNITY_SNAPSHOT_CAP.
 *
 * RATE LIMITS: 429 retries (Retry-After aware, exponential backoff), ~100ms
 * pacing between conversation-message fetches, hard page/visit caps with
 * warnings. Unexpected shapes/rows are skipped with warnings — a hard failure
 * throws HighLevelError whose message lands in sync_runs/connections (never
 * the secret values).
 */
import { addDays } from "../date-logic";
import { getSecret } from "../env";
import type { NormalizedCall, NormalizedContact, NormalizedUser } from "./adapters";

// ---------- errors ----------
export type HighLevelErrorKind = "config" | "auth" | "permission" | "rate_limit" | "network" | "api";

export class HighLevelError extends Error {
  constructor(readonly kind: HighLevelErrorKind, message: string) {
    super(message);
    this.name = "HighLevelError";
  }
}

// ---------- credentials ----------
export interface HighLevelCreds {
  apiKey: string;
  locationId: string;
}

/** Resolve creds from secrets; null when either is missing (demo fallback upstream). */
export function readHighLevelCreds(): HighLevelCreds | null {
  const apiKey = getSecret("HIGHLEVEL_API_KEY");
  const locationId = getSecret("HIGHLEVEL_LOCATION_ID");
  if (!apiKey || !locationId) return null;
  return { apiKey, locationId };
}

function requireCreds(): HighLevelCreds {
  const creds = readHighLevelCreds();
  if (!creds) {
    throw new HighLevelError(
      "config",
      "HIGHLEVEL_API_KEY and HIGHLEVEL_LOCATION_ID secrets are required for the live HighLevel sync — save both in the dashboard Secrets, then run SYNC NOW.",
    );
  }
  return creds;
}

// ---------- HTTP with retry/backoff ----------
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal }) => Promise<Response>;

const BASE_URL = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";
const RATE_LIMIT_RETRIES = 4;
const SERVER_ERROR_RETRIES = 1;
/**
 * HARD FETCH TIMEOUT (owner directive 2026-09-28): a hung HighLevel API call
 * used to wedge a sync run forever (two zombie "running" rows observed on
 * 2026-09-28 — no response, no error, no finish). Every request now carries
 * an abort signal at this cap AND a race timeout, so a hung request becomes
 * an ordinary (retried-next-tick) sync error.
 */
export const HL_FETCH_TIMEOUT_MS = 60_000;
/** Race a promise against the fetch timeout (the abort signal alone cannot cover non-cooperative fetch impls). */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s (no response) — hung request aborted`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export const CALL_BACKFILL_DAYS = 30;
export const CONTACT_SNAPSHOT_CAP = 2_000;
/**
 * FULL OPPORTUNITY SNAPSHOT (owner-verified 2026-09-29: Alliance/Auction leads
 * live in GHL opportunities — the real set is ~4,3xx across 13 pipelines, not
 * the ~200 rows the old cursor-paged fetch stored). The cap is now only a
 * runaway safety net far above the real population; hitting it is a loud
 * truncation warning, never a silent gap.
 */
export const OPPORTUNITY_SNAPSHOT_CAP = 20_000;
/** Paging termination guard (independent of the cap): 500 × 100/page = 50k rows. */
export const OPPORTUNITY_MAX_PAGES = 500;
export const CONVERSATION_SCAN_PAGES = 60; // offset pages of /conversations/search (100 each)
export const CONVERSATION_VISIT_CAP = 2_500; // message fetches per run (pacing-guarded)
export const MESSAGE_PAGES_PER_CONVERSATION = 5;

export interface HlEndpointOpts {
  creds: HighLevelCreds;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  /** Hard per-request timeout (tests shrink it); default HL_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

interface HlRequest {
  path: string;
  query?: URLSearchParams;
  body?: Record<string, unknown>;
}

/** One request with bearer auth; retries 429 (Retry-After aware) + 5xx once; classifies errors. (Exported for the incremental harvester.) */
export async function hlRequest(req: HlRequest, opts: HlEndpointOpts): Promise<unknown> {
  const url = `${BASE_URL}${req.path}${req.query?.toString() ? `?${req.query.toString()}` : ""}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.creds.apiKey}`,
    version: API_VERSION,
    accept: "application/json",
  };
  if (req.body) headers["content-type"] = "application/json";
  let rateLimited = 0;
  let serverErrors = 0;
  const timeoutMs = opts.timeoutMs ?? HL_FETCH_TIMEOUT_MS;
  for (;;) {
    let res: Response;
    try {
      res = await withTimeout(
        opts.fetchImpl(url, { headers, method: req.body ? "POST" : "GET", body: req.body ? JSON.stringify(req.body) : undefined, signal: AbortSignal.timeout(timeoutMs) }),
        timeoutMs + 1000, // backstop for non-cooperative fetch impls; the abort signal fires first for real fetch
        "HighLevel API request",
      );
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      throw new HighLevelError("network", /abort/i.test(raw)
        ? `HighLevel API request timed out after ${Math.round(timeoutMs / 1000)}s (no response) — hung request aborted`
        : `Could not reach the HighLevel API (${BASE_URL}): ${raw}`);
    }
    if (res.status === 429) {
      if (rateLimited >= RATE_LIMIT_RETRIES) {
        throw new HighLevelError("rate_limit", `HighLevel rate-limited the sync (429) after ${RATE_LIMIT_RETRIES} retries — the location hit its API quota; run SYNC NOW again in a minute.`);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      await opts.sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 30) * 1000 : backoffMs(rateLimited));
      rateLimited += 1;
      continue;
    }
    if (res.status >= 500 && res.status <= 504 && serverErrors < SERVER_ERROR_RETRIES) {
      serverErrors += 1;
      await opts.sleep(backoffMs(serverErrors));
      continue;
    }
    if (res.status === 401) {
      throw new HighLevelError("auth", "HighLevel rejected the API key (401) — check the HIGHLEVEL_API_KEY secret (it must be a current bearer/PIT token, not an expired OAuth access token).");
    }
    if (res.status === 403) {
      throw new HighLevelError("permission", "HighLevel denied access (403) — the API key may lack this location's scope, or HIGHLEVEL_LOCATION_ID points at a different location than the key can read.");
    }
    if (!res.ok) {
      const bodyText = (await res.text().catch(() => "")).slice(0, 300);
      throw new HighLevelError("api", `HighLevel API error (HTTP ${res.status} on ${req.path}): ${bodyText || "(no body)"}`);
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new HighLevelError("api", `HighLevel API returned non-JSON on ${req.path} (HTTP ${res.status}) — possibly an HTML error page; run SYNC NOW again.`);
    }
  }
}

/** Extract the first array value present (documented key, then generic fallbacks). */
export function listOf(body: Record<string, unknown> | null, ...keys: string[]): unknown[] {
  for (const k of keys) {
    const v = body?.[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

// ---------- pure parsers (exported for tests) ----------
function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * HighLevel reports call duration in inconsistent shapes across endpoints:
 * integer seconds (number), seconds as a string, ISO-8601 "PT#H#M#S", or
 * "h:mm:ss". Normalize to whole seconds; unparsable → 0 (never NaN — a NaN
 * would poison `over_two_minutes` and every downstream metric).
 */
export function parseDurationSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  if (typeof raw !== "string") return 0;
  const s = raw.trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const iso = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s.toUpperCase());
  if (iso && (iso[1] || iso[2] || iso[3] || iso[4])) {
    const [, d, h, m, sec] = iso;
    return Math.round(Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(sec ?? 0));
  }
  const clock = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s); // h:mm:ss / m:ss
  if (clock) {
    const [, h, m, sec] = clock;
    return Math.round(Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(sec ?? 0));
  }
  return 0;
}

/** ISO string or epoch-ms (number or numeric string) → ISO-8601 UTC string; null when unparsable. */
export function parseTimestamp(raw: unknown): string | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString();
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = asString(raw);
  if (!s) return null;
  if (/^\d{10,14}$/.test(s)) {
    const ms = Number(s) > 1e12 ? Number(s) : Number(s) * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseHlUser(u: Record<string, unknown>): NormalizedUser | null {
  const id = asString(u["id"]);
  if (!id) return null;
  if (u["deleted"] === true) return null; // deleted users never become reps
  const first = asString(u["firstName"]);
  const last = asString(u["lastName"]);
  const name = asString(u["name"]) ?? [first, last].filter(Boolean).join(" ") ?? id;
  return { external_id: id, name, email: asString(u["email"]) };
}

export function parseHlContact(c: Record<string, unknown>): NormalizedContact | null {
  const id = asString(c["id"]);
  if (!id) return null;
  const first = asString(c["firstName"]);
  const last = asString(c["lastName"]);
  const name = asString(c["contactName"]) ?? asString(c["name"]) ?? [first, last].filter(Boolean).join(" ") ?? id;
  return {
    external_id: id,
    name,
    phone: asString(c["phone"]),
    email: asString(c["email"]),
    assignedRepExternalId: asString(c["assignedUserId"]) ?? asString(c["assignedTo"]) ?? asString(c["userId"]),
  };
}

/**
 * A call = a conversation message with messageType "TYPE_CALL". Duration comes
 * from meta.call.duration (seconds; null for voicemail/missed — stored as 0,
 * which counts the call toward totals but not calls-over-threshold: honest to
 * what HighLevel reports). Calls without contactId or timestamp are skipped
 * (they can never enter attribution or rep metrics).
 */
export function parseHlCall(m: Record<string, unknown>): NormalizedCall | null {
  const type = asString(m["messageType"]) ?? asString(m["type"]);
  if (type && type !== "TYPE_CALL") return null;
  const id = asString(m["id"]);
  const startedAt = parseTimestamp(m["dateAdded"] ?? m["createdAt"] ?? m["timestamp"]);
  const contact = asString(m["contactId"]);
  if (!id || !startedAt || !contact) return null;
  const meta = m["meta"] as Record<string, unknown> | undefined;
  const call = (meta?.["call"] ?? null) as Record<string, unknown> | null;
  return {
    external_call_id: id,
    repExternalId: asString(m["userId"]) ?? "",
    contactExternalId: contact,
    startedAt,
    durationSeconds: parseDurationSeconds(call?.["duration"] ?? m["duration"]),
    direction: asString(m["direction"]) ?? "unknown",
    status: asString(call?.["status"]) ?? asString(m["status"]) ?? "unknown",
  };
}

export interface NormalizedOpportunity {
  external_id: string;
  name: string | null;
  status: string;
  monetaryValue: number;
  contactExternalId: string | null;
  assignedRepExternalId: string | null;
  pipelineId: string | null;
  stageId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function parseHlOpportunity(p: Record<string, unknown>): NormalizedOpportunity | null {
  const id = asString(p["id"]);
  if (!id) return null;
  const money = p["monetaryValue"];
  const value = typeof money === "number" ? money : Number(asString(money) ?? NaN);
  return {
    external_id: id,
    name: asString(p["name"]),
    status: asString(p["status"]) ?? "unknown",
    monetaryValue: Number.isFinite(value) ? value : 0,
    contactExternalId: asString(p["contactId"]),
    assignedRepExternalId: asString(p["assignedTo"]),
    pipelineId: asString(p["pipelineId"]),
    stageId: asString(p["pipelineStageId"]) ?? asString(p["stageId"]),
    createdAt: parseTimestamp(p["createdAt"]),
    updatedAt: parseTimestamp(p["updatedAt"]),
  };
}

// ---------- the adapter ----------
export interface HighLevelLiveRunReport {
  counts: { users: number; contacts: number; calls: number; opportunities: number };
  warnings: string[];
  windowStart: string | null;
  endpointNotes: string[];
}

/**
 * Live HighLevel API v2 adapter. fetch*() throw HighLevelError on hard
 * failures (the sync runner records the message); per-row/shape problems
 * become warnings on lastRun instead of crashing the run.
 */
export class LiveHighLevelAdapter {
  provider = "highlevel" as const;
  isDemo = false;
  lastRun: HighLevelLiveRunReport = { counts: { users: 0, contacts: 0, calls: 0, opportunities: 0 }, warnings: [], windowStart: null, endpointNotes: [] };

  private opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; pageSize?: number; callBackfillDays?: number; creds?: HighLevelCreds };
  private creds?: HighLevelCreds;

  constructor(
    opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; pageSize?: number; callBackfillDays?: number; creds?: HighLevelCreds } = {},
  ) {
    this.opts = opts;
    this.creds = opts.creds;
  }

  private endpointOpts(): HlEndpointOpts {
    return {
      creds: this.creds ?? requireCreds(),
      fetchImpl: this.opts.fetchImpl ?? fetch,
      sleep: this.opts.sleep ?? defaultSleep,
    };
  }

  private get pageSize(): number {
    return this.opts.pageSize ?? 100;
  }

  private warn(w: string): void {
    this.lastRun.warnings.push(w);
  }

  async fetchUsers(): Promise<NormalizedUser[]> {
    const body = (await hlRequest({ path: "/users/", query: new URLSearchParams({ locationId: this.endpointOpts().creds.locationId }) }, this.endpointOpts())) as Record<string, unknown> | null;
    const users: NormalizedUser[] = [];
    let skipped = 0;
    for (const raw of listOf(body, "users", "data")) {
      const u = parseHlUser(raw as Record<string, unknown>);
      if (u) users.push(u);
      else skipped += 1;
    }
    if (skipped) this.warn(`users: skipped ${skipped} rows (no id, or deleted)`);
    this.lastRun.counts.users = users.length;
    this.lastRun.endpointNotes.push(`users: ${users.length} snapshot`);
    return users;
  }

  /**
   * Contact snapshot via cursor pagination (meta.startAfterId), capped at
   * CONTACT_SNAPSHOT_CAP — the location reports 116k contacts, so this
   * deliberately syncs the most recent slice and says so.
   */
  async fetchContacts(): Promise<NormalizedContact[]> {
    const opts = this.endpointOpts();
    const contacts: NormalizedContact[] = [];
    let url: string | null = `${BASE_URL}/contacts/?locationId=${encodeURIComponent(opts.creds.locationId)}&limit=${this.pageSize}`;
    let truncated = false;
    // ROOT-CAUSE FIX (proven live 2026-09-26): this account IGNORES a bare
    // `startAfterId` query param and echoes it back unchanged — advancing via
    // meta.startAfterId alone re-read page 1 until the snapshot cap (the DB
    // held only ~119 contacts for months). meta.nextPageUrl — which carries
    // BOTH startAfterId AND the startAfter timestamp — advances correctly, so
    // it is followed verbatim. The stuck-cursor shape is guarded below.
    let lastNext: string | null = null;
    for (let page = 0; page < 200 && url != null; page++) {
      const body = (await hlRequest({ path: url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url }, opts)) as Record<string, unknown> | null;
      const meta = (body?.["meta"] ?? null) as Record<string, unknown> | null;
      const next = asString(meta?.["nextPageUrl"]);
      if (next != null && lastNext != null && next === lastNext) {
        // startAfterId-echo failure mode: the API handed back the same cursor
        // twice in a row. Stop instead of looping page 1 (stored contacts are
        // unaffected — syncs are upsert-only).
        this.warn("contacts: stuck cursor (meta.nextPageUrl unchanged) — stopping to avoid an infinite page-1 loop; stored contacts are unaffected (upsert-only).");
        break;
      }
      for (const raw of listOf(body, "contacts", "data")) {
        if (contacts.length >= CONTACT_SNAPSHOT_CAP) {
          truncated = true;
          break;
        }
        const c = parseHlContact(raw as Record<string, unknown>);
        if (c) contacts.push(c);
        else this.warn("contacts: skipped one row with no id");
      }
      url = next;
      lastNext = next;
      if (!truncated && url) await opts.sleep(100); // conservative inter-page pacing
    }
    if (truncated) this.warn(`contacts: snapshot capped at ${CONTACT_SNAPSHOT_CAP} most recent — the location has more; linked calls/leads still resolve by phone/email.`);
    this.lastRun.counts.contacts = contacts.length;
    this.lastRun.endpointNotes.push(`contacts: ${contacts.length} most-recent snapshot${truncated ? " (capped)" : ""}`);
    return contacts;
  }

  /**
   * Calls for the trailing CALL_BACKFILL_DAYS window, extracted from
   * conversations (GET /calls/ is 404 on this account — see header comment).
   * Conversations are newest-first; scanning stops at the first page with no
   * in-window conversations. Message fetches are paced to respect rate limits.
   */
  async fetchCalls(): Promise<NormalizedCall[]> {
    const days = this.opts.callBackfillDays ?? CALL_BACKFILL_DAYS;
    const windowStartIso = `${addDays(new Date().toISOString().slice(0, 10), -days)}T00:00:00.000Z`;
    // lastRun accumulates across the run's fetch*() calls (users, contacts,
    // calls, opportunities) — only the window marker is set here, never a reset.
    this.lastRun.windowStart = windowStartIso;
    const opts = this.endpointOpts();
    const windowStartMs = Date.parse(windowStartIso);
    const byId = new Map<string, NormalizedCall>();

    // 1) page conversations (newest-first) until out of window / capped
    const convIds: { id: string; lastMessageDate: number }[] = [];
    let scanned = 0;
    let outOfWindow = false;
    let convTruncated = false;
    for (let page = 0; page < CONVERSATION_SCAN_PAGES; page++) {
      const query = new URLSearchParams({ locationId: opts.creds.locationId, limit: String(this.pageSize), offset: String(page * this.pageSize) });
      const body = (await hlRequest({ path: "/conversations/search", query }, opts)) as Record<string, unknown> | null;
      const items = listOf(body, "conversations", "data") as Record<string, unknown>[];
      if (items.length === 0) break;
      scanned += items.length;
      for (const c of items) {
        const last = typeof c["lastMessageDate"] === "number" ? c["lastMessageDate"] : Date.parse(asString(c["lastMessageDate"]) ?? "") || 0;
        const id = asString(c["id"]);
        if (!id) continue;
        if (last >= windowStartMs && convIds.length < CONVERSATION_VISIT_CAP) convIds.push({ id, lastMessageDate: last });
      }
      // newest-first: a page with zero in-window conversations means we've
      // walked past the window; anything after is older.
      if (!items.some((c) => (typeof c["lastMessageDate"] === "number" ? c["lastMessageDate"] : Date.parse(asString(c["lastMessageDate"]) ?? "") || 0) >= windowStartMs)) {
        outOfWindow = true;
        break;
      }
      if (convIds.length >= CONVERSATION_VISIT_CAP) {
        convTruncated = true;
        break;
      }
    }
    if (convTruncated) this.warn(`calls: conversation scan capped at ${CONVERSATION_VISIT_CAP} visits — older calls in this window may be missing; raise the cap or narrow the window.`);
    else if (!outOfWindow) this.warn(`calls: conversation scan hit the ${CONVERSATION_SCAN_PAGES}-page cap (${scanned} scanned) — window may extend further.`);

    // 2) visit each in-window conversation, collect TYPE_CALL messages
    let visited = 0;
    for (const conv of convIds) {
      visited += 1;
      let lastMessageId: string | null = null;
      for (let msgPage = 0; msgPage < MESSAGE_PAGES_PER_CONVERSATION; msgPage++) {
        const query = new URLSearchParams({ limit: "50" });
        if (lastMessageId) query.set("lastMessageId", lastMessageId);
        const body = (await hlRequest({ path: `/conversations/${conv.id}/messages`, query }, opts)) as Record<string, unknown> | null;
        const wrapper = (body?.["messages"] ?? null) as Record<string, unknown> | null;
        const messages = listOf(wrapper as Record<string, unknown> | null, "messages", "data") as Record<string, unknown>[];
        for (const m of messages) {
          const call = parseHlCall(m);
          if (call && Date.parse(call.startedAt) >= windowStartMs) byId.set(call.external_call_id, call);
        }
        lastMessageId = asString(wrapper?.["lastMessageId"]);
        const more = wrapper?.["nextPage"];
        const hasNext = more === true || asString(more) !== null && asString(more) !== "false" && asString(more) !== "0";
        if (!hasNext || !lastMessageId || messages.length === 0) break;
        await opts.sleep(100); // pacing: stay well inside the rate limit
      }
      if (visited % 20 === 0) await opts.sleep(100); // coarse pacing across conversations
    }

    this.lastRun.counts.calls = byId.size;
    this.lastRun.endpointNotes.push(`calls: ${byId.size} in ${days}-day window (from ${windowStartIso}; ${visited} conversations visited)`);
    return [...byId.values()];
  }

  /**
   * Opportunities via POST /opportunities/search (GET /opportunities/ is 404
   * here). FULL SNAPSHOT AS FAR AS THE API ALLOWS (live-verified 2026-09-29):
   * the body accepts ONLY {locationId, limit, page} — page is 1-BASED (page 0
   * is clamped to page 1), success is HTTP 201, and `offset`, `pipelineId`,
   * `status` and cursor keys are all rejected (422). Paging runs until a SHORT
   * page (fewer than `limit` rows = last page) or until GHL's server-side
   * document wall: past offset 10,000 the endpoint answers HTTP 400 "Paginated
   * query has reached beyond allowed document limit. Please switch to Scroll
   * query" — that wall is a HARD API LIMIT (no scroll endpoint exists on API
   * version 2021-07-28), so the snapshot covers the 10,000 most recent
   * opportunities and SAYS SO (warning with the API's `total`), never silently.
   * Alliance/Auction rows verified complete inside that window (2026-09-29:
   * Alliance 18/18, every report-week AA lead present); the unfetched tail is
   * dominated by the Donations import. Stored rows are upsert-only, so the
   * snapshot window plus previous runs keep everything ever seen.
   */
  async fetchOpportunities(): Promise<NormalizedOpportunity[]> {
    const opts = this.endpointOpts();
    const opps: NormalizedOpportunity[] = [];
    let apiTotal: number | null = null;
    let truncated = false; // snapshot cap hit
    let atApiWall = false; // GHL's 10k-document boundary hit
    let page = 1;
    for (; page <= OPPORTUNITY_MAX_PAGES; page++) {
      const body: Record<string, unknown> = { locationId: opts.creds.locationId, limit: this.pageSize, page };
      let res: Record<string, unknown> | null;
      try {
        res = (await hlRequest({ path: "/opportunities/search", body }, opts)) as Record<string, unknown> | null;
      } catch (e) {
        if (e instanceof HighLevelError && /beyond allowed document limit/i.test(e.message)) {
          atApiWall = true; // offset wall reached — the API will not page further
          break;
        }
        throw e;
      }
      if (apiTotal == null && typeof res?.["total"] === "number") apiTotal = res["total"];
      const items = listOf(res, "opportunities", "data") as Record<string, unknown>[];
      if (items.length === 0) break;
      for (const raw of items) {
        if (opps.length >= OPPORTUNITY_SNAPSHOT_CAP) {
          truncated = true;
          break;
        }
        const p = parseHlOpportunity(raw);
        if (p) opps.push(p);
        else this.warn("opportunities: skipped one row with no id");
      }
      if (truncated) break;
      // Short page = last page (live-verified).
      if (items.length < this.pageSize) break;
      await opts.sleep(100); // conservative inter-page pacing (~100 pages to the API wall)
    }
    if (truncated) {
      this.warn(`opportunities: snapshot capped at ${OPPORTUNITY_SNAPSHOT_CAP}${apiTotal != null ? ` (API total ${apiTotal})` : ""}.`);
    } else if (atApiWall) {
      this.warn(
        `opportunities: GHL caps page-based search at 10,000 documents — snapshot covers the ${opps.length} most recent${apiTotal != null ? ` of API total ${apiTotal}` : ""}. Deeper history is not fetched (no scroll endpoint on this API version); rows already stored are kept (upsert-only).`,
      );
    } else if (page > OPPORTUNITY_MAX_PAGES) {
      this.warn(`opportunities: paging hit the ${OPPORTUNITY_MAX_PAGES}-page guard at ${opps.length} rows — snapshot incomplete.`);
    } else if (apiTotal != null && opps.length < apiTotal) {
      this.warn(`opportunities: snapshot ended at ${opps.length} rows vs API total ${apiTotal} — dataset may have shifted mid-paging; re-run SYNC NOW.`);
    }
    this.lastRun.counts.opportunities = opps.length;
    this.lastRun.endpointNotes.push(
      `opportunities: ${opps.length} snapshot (${page} page${page === 1 ? "" : "s"}${atApiWall ? ", at GHL 10k wall" : ""}, API total ${apiTotal ?? "n/a"}${truncated ? ", TRUNCATED at cap" : ""})`,
    );
    return opps;
  }
}

/** Live adapter when both secrets resolve, else null (demo fallback upstream). */
export function createHighLevelAdapter(): LiveHighLevelAdapter | null {
  if (!readHighLevelCreds()) return null;
  return new LiveHighLevelAdapter();
}
