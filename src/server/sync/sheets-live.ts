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

async function getAccessToken(sa: ServiceAccountInfo): Promise<string> {
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
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new SheetsError("network", `Could not reach Google's OAuth endpoint: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
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

async function sheetsFetch(token: string, url: string, sa: ServiceAccountInfo): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new SheetsError("network", `Could not reach Google Sheets: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { values?: unknown; sheets?: unknown; error?: { message?: string } };
  if (!res.ok) {
    throw classifySheetsError(res.status, body.error?.message ?? `HTTP ${res.status}`, sa);
  }
  return body;
}

// ---------- API calls ----------
/** Title of the first worksheet tab (used to scope values.get ranges). */
export async function fetchFirstTabTitle(token: string, sheetId: string, sa: ServiceAccountInfo): Promise<string> {
  const body = (await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.title,sheets.properties.title`, sa)) as {
    sheets?: { properties?: { title?: string } }[];
  };
  return body.sheets?.[0]?.properties?.title ?? "Sheet1";
}

/** All rows (header included) of a spreadsheet's first tab, as raw strings. */
export async function fetchSheetRows(token: string, sheetId: string, sa: ServiceAccountInfo): Promise<{ tab: string; rows: string[][] }> {
  const tab = await fetchFirstTabTitle(token, sheetId, sa);
  const body = (await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${tab}!A1:ZZ`)}?majorDimension=ROWS`, sa)) as {
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
export async function fetchSheetSampleLive(sheetId: string, maxRows = 5): Promise<SheetSample> {
  const sa = readServiceAccount();
  const token = await getAccessToken(sa);
  const { tab, rows } = await fetchSheetRows(token, sheetId, sa);
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
  ) {}

  async fetchLeads(): Promise<NormalizedLead[]> {
    const sa = readServiceAccount();
    const token = await getAccessToken(sa);
    const windowStart = addDays(etToday(), -this.windowDays);
    const leads: NormalizedLead[] = [];
    const perSheet: SheetsLivePerSheet[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    for (const sheet of ["family", "animalia"] as const) {
      const conf = this.cfg[sheet];
      const mapping = { mode: conf.mode, columns: conf.columns };
      try {
        const { tab, rows } = await fetchSheetRows(token, conf.sheet_id, sa);
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

/** Live adapter when the secret exists, else null (demo fallback upstream). */
export function createSheetsAdapter(cfg: AppSettings["sheets"]): LiveSheetsAdapter | null {
  if (!getSecret("GOOGLE_SERVICE_ACCOUNT_JSON")) return null;
  return new LiveSheetsAdapter(cfg);
}
