/**
 * LIVE Google Sheets adapter — the first real data source in the dashboard.
 *
 * Auth: GOOGLE_SERVICE_ACCOUNT_JSON (service-account key) → RS256 JWT signed
 * with node:crypto → OAuth2 access token (spreadsheets.readonly scope) →
 * Sheets API v4 values.get. No new dependencies.
 *
 * Errors are ALWAYS actionable and safe to show in the Sync Center:
 *  - API not enabled on the project → say exactly that (owner enables it in
 *    the Google Cloud console).
 *  - 403 permission → "share both sheets with <service-account email>
 *    (Viewer)" using the email FROM the key (never the key itself).
 *  - 404 → wrong sheet ID.  401/bad JWT → check the key.
 *
 * SECURITY: the secret's VALUE never leaves this module; only the
 * service-account EMAIL is embedded in error/UI text.
 */
import { createSign } from "node:crypto";
import { addDays, etToday } from "../date-logic";
import { getSecret } from "../env";
import { isFetchTimeoutError, syncFetchTimeoutMs, timedFetch, type TimedFetchImpl } from "./fetch-timeout";
import { raceBodyRead } from "./body-read";
import type { AppSettings } from "../store/types";
import type { GoogleSheetsAdapter } from "./adapters";
import {
  detectSheetMapping,
  LEAD_BACKFILL_DAYS,
  parseSheetRows,
  SHEET_MODE_LABELS,
  type NormalizedLead,
  type SheetParseStats,
} from "./sheets-mapping";

// ---------- errors ----------
export type SheetsErrorKind = "config" | "auth" | "api_disabled" | "permission" | "not_found" | "network" | "api";

export class SheetsError extends Error {
  constructor(readonly kind: SheetsErrorKind, message: string) {
    super(message);
    this.name = "SheetsError";
  }
}

// ---------- service account ----------
export interface ServiceAccountInfo {
  clientEmail: string;
  projectId: string | null;
  privateKey: string;
}

/**
 * Per-call HTTP plumbing threaded from the adapter (or defaulted): the fetch
 * impl (tests inject a hanging/stub fetch; production uses global fetch) and
 * the per-call timeout cap (tests shrink it; production resolves
 * SYNC_FETCH_TIMEOUT_MS per call — default ~90s).
 */
export interface SheetsHttp {
  fetchImpl?: TimedFetchImpl;
  timeoutMs?: number;
}

function sheetsFetchImpl(http?: SheetsHttp): TimedFetchImpl {
  return http?.fetchImpl ?? (fetch as unknown as TimedFetchImpl);
}

function sheetsTimeoutMs(http?: SheetsHttp): number {
  return http?.timeoutMs ?? syncFetchTimeoutMs();
}

/** Map a per-call failure to its honest SheetsError: a FetchTimeoutError keeps
 * its provider-named line verbatim; anything else keeps the legacy wrap. */
function sheetsNetworkError(e: unknown, what: string): SheetsError {
  if (isFetchTimeoutError(e)) {
    return new SheetsError("network", e instanceof Error ? e.message : String(e));
  }
  return new SheetsError("network", `${what}: ${e instanceof Error ? e.message : String(e)}`);
}

/** Parse the saved secret into its usable parts (never log the value). */
export function readServiceAccount(): ServiceAccountInfo {
  const raw = getSecret("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) {
    throw new SheetsError("config", "GOOGLE_SERVICE_ACCOUNT_JSON secret is not set — save the service-account key in the dashboard Secrets, then run SYNC NOW.");
  }
  let parsed: { client_email?: unknown; private_key?: unknown; project_id?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SheetsError("config", "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — re-save the full service-account key exactly as Google issued it.");
  }
  const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email : null;
  const privateKey = typeof parsed.private_key === "string" ? parsed.private_key : null;
  if (!clientEmail || !privateKey || !privateKey.includes("PRIVATE KEY")) {
    throw new SheetsError("config", "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key — re-save the full service-account JSON key.");
  }
  return { clientEmail, projectId: typeof parsed.project_id === "string" ? parsed.project_id : null, privateKey };
}

// ---------- token (JWT → access token) ----------
let cachedToken: { token: string; expMs: number } | null = null;

async function getAccessToken(sa: ServiceAccountInfo, http?: SheetsHttp): Promise<string> {
  if (cachedToken && cachedToken.expMs > Date.now() + 60_000) return cachedToken.token;
  const b64url = (b: string | Buffer) => Buffer.from(b).toString("base64url");
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  let assertion: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    assertion = `${header}.${claims}.${b64url(signer.sign(sa.privateKey))}`;
  } catch (e) {
    throw new SheetsError("config", `Could not sign the service-account JWT — the private_key in GOOGLE_SERVICE_ACCOUNT_JSON looks invalid (${e instanceof Error ? e.message : String(e)}).`);
  }
  let res: Response;
  try {
    // PER-FETCH BOUNDS (fetch-timeout.ts, 2026-10-22): abort signal composed
    // into the request AND a JS-timer race at the shared per-call cap — a hung
    // token call aborts as a provider-named network error, never wedges the
    // run (the 2026-10-22 wake incident class).
    res = await timedFetch(sheetsFetchImpl(http), "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    }, { provider: "google_sheets", timeoutMs: sheetsTimeoutMs(http) });
  } catch (e) {
    throw sheetsNetworkError(e, "Could not reach Google's OAuth endpoint");
  }
  // BOUNDED + HONEST body read (2026-10-17): the armed fetch signal cannot
  // wake a read PARKED on a silent socket (body-read.ts docblock — the live
  // scheduler wedged ~8h on 2026-10-17 inside the sheets tick), and this
  // catch used to mask EVERY body failure as {} → a parked/failed token read
  // surfaced as a bogus "credentials rejected" auth error. Network-class
  // failures now throw SheetsError("network") (retry next tick); only a
  // genuine non-JSON body keeps the legacy {} → auth-classification path.
  const body = (await raceBodyRead(res.json(), sheetsTimeoutMs(http), "Google OAuth response body").catch((e) => {
    if (isNetworkBodyError(e)) {
      throw new SheetsError("network", `Google OAuth response body read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {};
  })) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new SheetsError("auth", `Google rejected the service-account credentials (HTTP ${res.status}${body.error ? ` ${body.error}` : ""}) — check GOOGLE_SERVICE_ACCOUNT_JSON. ${body.error_description ?? ""}`.trim());
  }
  cachedToken = { token: body.access_token, expMs: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

// ---------- error classification ----------
function classifySheetsError(status: number, apiMessage: string, sa: ServiceAccountInfo): SheetsError {
  const msg = apiMessage.slice(0, 300);
  if (status === 403 && /has not been used in project|has not been enabled|it is disabled|SERVICE_DISABLED/i.test(msg)) {
    return new SheetsError("api_disabled", `The Google Sheets API is not enabled for the key's Google Cloud project${sa.projectId ? ` ("${sa.projectId}")` : ""}. Enable "Google Sheets API" for that project in the Google Cloud Console (console.developers.google.com → APIs & Services → Library), then run SYNC NOW. Google said: ${msg}`);
  }
  if (status === 403) {
    return new SheetsError("permission", `Google Sheets denied access (403) — share BOTH the Family and Animalia sheets with the service account ${sa.clientEmail} (role: Viewer). Google said: ${msg}`);
  }
  if (status === 404) {
    return new SheetsError("not_found", `Spreadsheet not found (404) — check the sheet ID in Settings (wrong ID, or the sheet was deleted). Google said: ${msg}`);
  }
  if (status === 401) {
    return new SheetsError("auth", `Google rejected the service-account credentials (401) — check GOOGLE_SERVICE_ACCOUNT_JSON. Google said: ${msg}`);
  }
  return new SheetsError("api", `Google Sheets API error (HTTP ${status}): ${msg}`);
}

async function sheetsFetch(token: string, url: string, sa: ServiceAccountInfo, http?: SheetsHttp): Promise<unknown> {
  let res: Response;
  try {
    // PER-FETCH BOUNDS (fetch-timeout.ts, 2026-10-22): the 2026-10-22 wake
    // incident class — a hung values call used to age until the reaper window
    // while the tick sat behind it; now the abort signal + JS-timer race
    // abort it at the shared per-call cap with a provider-named error.
    res = await timedFetch(sheetsFetchImpl(http), url, { headers: { authorization: `Bearer ${token}` } }, { provider: "google_sheets", timeoutMs: sheetsTimeoutMs(http) });
  } catch (e) {
    throw sheetsNetworkError(e, "Could not reach Google Sheets");
  }
  // BODY-READ HONESTY (2026-10-12 hardening): this catch used to swallow EVERY
  // body-read failure as {} — including a socket dying MID-BODY, which then
  // surfaced downstream as an empty sheet. The lead-count sheets feed
  // commissions, so silent-empty is corruption risk: a network-class body
  // failure now surfaces as SheetsError("network") (same class as the connect
  // path); only a genuine NON-JSON body keeps the legacy {} path so the
  // !res.ok classification below still renders Google's status/message.
  const body = (await raceBodyRead(res.json(), sheetsTimeoutMs(http), "Google Sheets response body").catch((e) => {
    if (isNetworkBodyError(e)) {
      throw new SheetsError("network", `Google Sheets response body read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {};
  })) as { values?: unknown; sheets?: unknown; error?: { message?: string } };
  if (!res.ok) {
    throw classifySheetsError(res.status, body.error?.message ?? `HTTP ${res.status}`, sa);
  }
  return body;
}

/**
 * Network-class failure vs a merely non-JSON body, dual-path (code OR message)
 * per the isTransientDbError classification convention. Step-0 probe: Bun's
 * fetch layer reports a truncated/stalled body read as TypeError with
 * code "ECONNRESET" and a HUMANIZED message without the token (an
 * AbortSignal timeout during the body read surfaces as TimeoutError
 * "The operation timed out." with a numeric code) — so the token can arrive
 * via either field and both must be checked. A genuine non-JSON body (proxy
 * HTML error page) is not network-class — it keeps the legacy {} → !res.ok
 * status-classification path.
 */
const NETWORK_BODY_ERROR_RE =
  /\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|CONNECT_TIMEOUT|CONNECTION_CLOSED|connection timed out|timed out|timeout|fetch failed|body read|aborted|underlying connection/i;

/** Exported for the body-read-honesty test (probe-recorded error shapes). */
export function isNetworkBodyError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // JSON.parse truncation = the body stream ended before the document did
  if (e instanceof SyntaxError && /unexpected end/i.test(e.message)) return true;
  const code = (e as { code?: unknown }).code;
  return NETWORK_BODY_ERROR_RE.test(String(code)) || NETWORK_BODY_ERROR_RE.test(e.message);
}

// ---------- API calls ----------
/** Title of the first worksheet tab (used to scope values.get ranges). */
export async function fetchFirstTabTitle(token: string, sheetId: string, sa: ServiceAccountInfo, http?: SheetsHttp): Promise<string> {
  const body = (await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.title,sheets.properties.title`, sa, http)) as {
    sheets?: { properties?: { title?: string } }[];
  };
  return body.sheets?.[0]?.properties?.title ?? "Sheet1";
}

/** All rows (header included) of a spreadsheet tab, as raw strings.
 * `tabName` — optional target tab (Fairyland wiring, owner directive
 * 2026-10-22): when set, THAT tab is fetched by name (a wrong name surfaces
 * Google's honest 400 error); absent/empty keeps the long-standing first-tab
 * behavior byte-identical (Family/Animalia pass no tab name). */
export async function fetchSheetRows(token: string, sheetId: string, sa: ServiceAccountInfo, http?: SheetsHttp, tabName?: string): Promise<{ tab: string; rows: string[][] }> {
  const tab = tabName?.trim() ? tabName.trim() : await fetchFirstTabTitle(token, sheetId, sa, http);
  const body = (await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${tab}!A1:ZZ`)}?majorDimension=ROWS`, sa, http)) as {
    values?: string[][];
  };
  return { tab, rows: body.values ?? [] };
}

export interface SheetSample {
  tab: string;
  header: string[];
  rows: string[][];
  /** Present when the sheet has no data rows yet (header shown instead). */
  notice: string | null;
}

/**
 * Live sample for the Settings "test mapping" action: the REAL header plus up
 * to `maxRows` real data rows from the sheet's first tab. Throws SheetsError
 * with an actionable message when access isn't granted yet.
 */
export async function fetchSheetSampleLive(sheetId: string, maxRows = 5, http?: SheetsHttp, tabName?: string): Promise<SheetSample> {
  const sa = readServiceAccount();
  const token = await getAccessToken(sa, http);
  const { tab, rows } = await fetchSheetRows(token, sheetId, sa, http, tabName);
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (dataRows.length === 0) {
    return { tab, header, rows: [header], notice: "Sheet has no data rows yet — showing the header row." };
  }
  return { tab, header, rows: dataRows.slice(0, maxRows), notice: null };
}

// ---------- the adapter ----------
export interface SheetsLivePerSheet extends SheetParseStats {
  ok: boolean;
  error: string | null;
  tab: string | null;
  header: string[] | null;
}

export interface SheetsLiveRunReport {
  perSheet: SheetsLivePerSheet[];
  warnings: string[];
  suggestions: string[];
  windowStart: string;
}

/**
 * Live adapter for both configured sheets. fetchLeads() returns the leads of
 * every sheet that synced; if EVERY sheet fails it throws (the sync runner
 * falls back to the demo seed and records the error). Per-sheet outcomes +
 * mapping suggestions land in lastRun for the connection note.
 */
export class LiveSheetsAdapter implements GoogleSheetsAdapter {
  provider = "google_sheets" as const;
  isDemo = false;
  lastRun: SheetsLiveRunReport | null = null;

  constructor(
    private cfg: AppSettings["sheets"],
    private windowDays: number = LEAD_BACKFILL_DAYS,
    /** Per-call HTTP plumbing: tests inject a stub/hanging fetch + a tiny cap; production leaves both to the defaults (global fetch + SYNC_FETCH_TIMEOUT_MS resolver). */
    private http?: SheetsHttp,
  ) {}

  async fetchLeads(): Promise<NormalizedLead[]> {
    const sa = readServiceAccount();
    const token = await getAccessToken(sa, this.http);
    const windowStart = addDays(etToday(), -this.windowDays);
    const leads: NormalizedLead[] = [];
    const perSheet: SheetsLivePerSheet[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    for (const sheet of ["family", "animalia", "fairyland"] as const) {
      const conf = this.cfg[sheet];
      // Third genre (owner directive 2026-10-22): the Fairyland sheet stays
      // UNCONFIGURED (empty id) until the owner saves one in Settings —
      // fail-honest skip with a visible note, never a guessed sheet id.
      if (!conf?.sheet_id?.trim()) {
        warnings.push(`${sheet}: no sheet id configured — skipped (set one in Settings → Sheets)`);
        continue;
      }
      const mapping = { mode: conf.mode, columns: conf.columns };
      try {
        // Optional tab targeting (Fairyland, owner directive 2026-10-22):
        // tab_name present → fetch THAT tab; absent → first tab as always.
        const { tab, rows } = await fetchSheetRows(token, conf.sheet_id, sa, this.http, conf.tab_name?.trim() || undefined);
        const res = parseSheetRows({ sheet, sheetId: conf.sheet_id, mapping, rows, windowStart });
        leads.push(...res.leads);
        warnings.push(...res.warnings.map((w) => `${sheet}: ${w}`));
        perSheet.push({ ...res.stats, ok: true, error: null, tab, header: res.header });
        const det = res.header.length ? detectSheetMapping(res.header) : null;
        if (det && det.mapping.mode !== conf.mode) {
          suggestions.push(`${sheet}: header suggests "${SHEET_MODE_LABELS[det.mapping.mode]}" (${det.note}) but the saved mode is "${SHEET_MODE_LABELS[conf.mode]}" — review Settings → Sheet column mapping.`);
        }
      } catch (e) {
        const err = e instanceof SheetsError ? e : new SheetsError("api", e instanceof Error ? e.message : String(e));
        perSheet.push({
          sheet, sheetId: conf.sheet_id, mode: conf.mode,
          totalRows: 0, dataRows: 0, usedRows: 0, leads: 0, skippedOld: 0, skippedBad: 0, skippedEmpty: 0,
          windowStart, ok: false, error: err.message, tab: null, header: null,
        });
        warnings.push(`${sheet}: ${err.message}`);
      }
    }

    this.lastRun = { perSheet, warnings, suggestions, windowStart };
    const failed = perSheet.filter((p) => !p.ok);
    if (failed.length === perSheet.length) {
      // Dedupe identical causes (e.g. API disabled hits both sheets).
      const unique = [...new Set(failed.map((f) => f.error ?? "unknown error"))];
      throw new SheetsError("api", unique.length === 1 ? unique[0] : failed.map((f) => `${f.sheet}: ${f.error}`).join(" · "));
    }
    return leads;
  }
}

/**
 * Live adapter when the secret exists, else null (demo fallback upstream).
 * Under the test runner this ALWAYS returns null — tests must inject a stub
 * adapter and must NEVER hit live Google Sheets (the owner's real service
 * account sits in this machine's environment, so an unguarded env lookup
 * would let an unpinned `bun test` tick fire live Sheets API calls). Mirrors
 * resolveAcuityAdapterForSync in acuity-live.ts. Production (serve.ts) is
 * unaffected: it self-resolves at boot under a non-test NODE_ENV and threads
 * the built adapter into startScheduler explicitly.
 */
export function createSheetsAdapter(cfg: AppSettings["sheets"]): LiveSheetsAdapter | null {
  if (process.env.NODE_ENV === "test") return null;
  if (!getSecret("GOOGLE_SERVICE_ACCOUNT_JSON")) return null;
  return new LiveSheetsAdapter(cfg);
}
