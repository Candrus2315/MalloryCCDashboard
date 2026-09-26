/**
 * ACUITY LIVE CLIENT — minimal read-only client for the Acuity Scheduling API
 * (v1). Owner spec design/availability-spec.md: Acuity is the PRIMARY source
 * of truth for existing appointments, status, cancellations and reschedules.
 *
 * Auth: HTTP Basic with ACUITY_USER_ID : ACUITY_API_KEY (base64) — both saved
 * as platform secrets, resolved case-insensitively via getSecret. Values are
 * NEVER logged or serialized.
 *
 * Endpoints used (read-only):
 *   GET /appointments      — minDate/maxDate window (ET dates), max=500
 *   GET /appointment-types — catalog (smoke script + future Settings scope UI)
 *
 * Semantics the sync guarantees:
 *  - Upsert by Acuity appointment id (store ON CONFLICT) — duplicate-safe; the
 *    same id fetched twice never creates two rows.
 *  - A CANCELLED appointment arrives with canceled:true and UPDATEs the
 *    existing row (cancelled=true) — it frees its slot and stays historical,
 *    never a duplicate.
 *  - A RESCHEDULED appointment keeps its id with a new datetime — the upsert
 *    moves the ONE row to the new time (old slot free, new slot occupied).
 *  - Blocked times: Acuity v1 exposes no bulk blocked-times listing (the
 *    per-calendar/per-day "unavailable" endpoint is too chatty for a sync);
 *    blocks are honored from Settings (manual one-off + recurring). Demo
 *    Acuity blocks are purged on the first live sync so demo and live data
 *    never mix.
 *  - Rate limit: Acuity allows ~1 req/sec — requests inside one sync are
 *    paced ≥1.1s apart (injectable sleep for tests).
 */
import { getSecret } from "../env";
import { addDays, etToday } from "../date-logic";
import { normalizeAttributionEmail, normalizeAttributionPhone } from "../metrics/attribution";
import type { Store } from "../store/types";
import type { NormalizedAppointment } from "./adapters";

// ---------- credentials ----------

export interface AcuityCreds {
  userId: string;
  apiKey: string;
}

/** Resolve ACUITY_USER_ID + ACUITY_API_KEY (either missing → null → demo mode). */
export function readAcuityCreds(): AcuityCreds | null {
  const userId = getSecret("ACUITY_USER_ID");
  const apiKey = getSecret("ACUITY_API_KEY");
  if (!userId || !apiKey) return null;
  return { userId, apiKey };
}

// ---------- pure parsers (exported for tests) ----------

/** Acuity datetimes are ISO8601 with a tz offset; some builds omit the colon in the offset. */
export function parseAcuityInstant(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const normalized = /([+-]\d{2})(\d{2})$/.test(raw) ? `${raw.slice(0, -2)}:${raw.slice(-2)}` : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseAcuityDuration(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * One Acuity API appointment row → the normalized sync shape (same interface
 * the demo adapter produces, so the sync runner code path is identical).
 * Returns null for rows without an id or an unparseable datetime — never a
 * guessed row.
 */
export function parseAcuityAppointment(raw: Record<string, unknown>): NormalizedAppointment | null {
  const id = raw.id != null ? String(raw.id) : "";
  if (!id) return null;
  const datetime = parseAcuityInstant(raw.datetime);
  if (!datetime) return null;
  // dateCreated = when the booking was MADE (drives booking-created metrics);
  // fall back to the session datetime (a real timestamp) with a caller-visible
  // warning flag rather than inventing anything.
  const createdAt = parseAcuityInstant(raw.dateCreated) ?? datetime;
  const canceled = raw.canceled === true || raw.canceled === "true";
  const first = typeof raw.firstName === "string" ? raw.firstName : "";
  const last = typeof raw.lastName === "string" ? raw.lastName : "";
  const duration = parseAcuityDuration(raw.duration);
  return {
    acuity_appointment_id: id,
    calendarId: raw.calendarID != null ? String(raw.calendarID) : "",
    calendarName: typeof raw.calendar === "string" ? raw.calendar : "",
    appointmentType: typeof raw.type === "string" ? raw.type : "",
    appointmentDatetime: datetime,
    createdAt,
    status: canceled ? "cancelled" : "scheduled",
    canceledAndFallbackCreated: parseAcuityInstant(raw.dateCreated) == null,
    cancelled: canceled,
    clientName: `${first} ${last}`.trim(),
    // Contact identities NORMALIZED AT THE SOURCE (one definition lives in the
    // attribution engine): email lowercase-trimmed; phone digits-only with the
    // leading country-code 1 kept — stored as the raw digits string so the
    // booking-attribution phone tier compares apples to apples.
    clientPhone: normalizeAttributionPhone(typeof raw.phone === "string" ? raw.phone : "") ?? "",
    clientEmail: normalizeAttributionEmail(typeof raw.email === "string" ? raw.email : "") ?? "",
    durationMinutes: duration ?? 60,
    durationMissing: duration == null,
  } as NormalizedAppointment & { canceledAndFallbackCreated?: boolean; durationMissing?: boolean };
}

export function parseAcuityAppointmentType(raw: Record<string, unknown>): { id: string; name: string; duration: number | null } | null {
  const id = raw.id != null ? String(raw.id) : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!id || !name) return null;
  return { id, name, duration: parseAcuityDuration(raw.duration) };
}

// ---------- the live adapter ----------

export interface AcuityLiveRunReport {
  requests: number;
  window: { minDate: string; maxDate: string };
  /** Response hit the max cap — the window may be truncated (warn, don't guess). */
  truncated: boolean;
  warnings: string[];
}

type FetchImpl = (url: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Response>;

export class AcuityLiveAdapter {
  provider = "acuity" as const;
  isDemo = false;
  lastRun: AcuityLiveRunReport | null = null;
  private lastRequestAt = 0;

  constructor(
    private creds: AcuityCreds,
    private fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.creds.userId}:${this.creds.apiKey}`).toString("base64")}`;
  }

  /** GET with Basic auth + the ~1 req/sec pacing Acuity expects. */
  private async getJson(path: string, params: Record<string, string>): Promise<unknown> {
    const gapMs = 1_100;
    const sinceLast = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && sinceLast < gapMs) await this.sleep(gapMs - sinceLast);
    this.lastRequestAt = Date.now();

    const qs = new URLSearchParams(params).toString();
    const url = `https://acuityscheduling.com/api/v1/${path}${qs ? `?${qs}` : ""}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "User-Agent": "MalloryCCDashboard/1.0 (availability sync)",
      },
    });
    if (this.lastRun) this.lastRun.requests += 1;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Acuity authentication failed (${res.status}) — check ACUITY_USER_ID / ACUITY_API_KEY`);
    }
    if (res.status === 429) {
      throw new Error("Acuity rate limited (429) — sync will retry on the next tick");
    }
    if (!res.ok) {
      throw new Error(`Acuity API error ${res.status} on GET /${path}`);
    }
    return res.json();
  }

  /**
   * Fetch appointments for the rolling window (yesterday → +14 days, ET
   * calendar dates — Acuity interprets the date params in the account's
   * timezone, which is ET for this owner). Cancellations come back in the
   * same list with canceled:true so their stored rows UPDATE.
   */
  async fetchAppointments(): Promise<NormalizedAppointment[]> {
    const today = etToday();
    const minDate = addDays(today, -1);
    const maxDate = addDays(today, 14);
    this.lastRun = { requests: 0, window: { minDate, maxDate }, truncated: false, warnings: [] };
    const body = await this.getJson("appointments", { minDate, maxDate, max: "500" });
    const list = Array.isArray(body) ? body : [];
    if (list.length >= 500) {
      this.lastRun.truncated = true;
      this.lastRun.warnings.push("Response hit the 500-appointment cap — the window may be truncated");
    }
    const out: NormalizedAppointment[] = [];
    let fallbackCreated = 0;
    let missingDuration = 0;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const parsed = parseAcuityAppointment(raw as Record<string, unknown>);
      if (!parsed) {
        this.lastRun.warnings.push(`Skipped 1 appointment row without id/datetime`);
        continue;
      }
      const extra = parsed as { canceledAndFallbackCreated?: boolean; durationMissing?: boolean };
      if (extra.canceledAndFallbackCreated) fallbackCreated += 1;
      if (extra.durationMissing) missingDuration += 1;
      out.push(parsed);
    }
    if (fallbackCreated > 0) {
      this.lastRun.warnings.push(`${fallbackCreated} appointments without dateCreated — booking-created time falls back to the session time`);
    }
    if (missingDuration > 0) {
      this.lastRun.warnings.push(`${missingDuration} appointments without duration — slot math uses the configured studio duration`);
    }
    return out;
  }

  /** Appointment-type catalog (Settings scope UI + smoke script). */
  async fetchAppointmentTypes(): Promise<{ id: string; name: string; duration: number | null }[]> {
    const body = await this.getJson("appointment-types", {});
    const list = Array.isArray(body) ? body : [];
    const out: { id: string; name: string; duration: number | null }[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const parsed = parseAcuityAppointmentType(raw as Record<string, unknown>);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /**
   * Acuity v1 has no bulk blocked-times listing (see module docblock).
   * Returns [] — blocks reach the engine from Settings instead.
   */
  async fetchBlockedTimes(): Promise<{ external_id: string; startAt: string; endAt: string; reason: string }[]> {
    return [];
  }
}

/** Live adapter when both credentials resolve, else null (demo mode stays). */
export function createAcuityLiveAdapter(options?: { fetchImpl?: FetchImpl; sleep?: (ms: number) => Promise<void> }): AcuityLiveAdapter | null {
  const creds = readAcuityCreds();
  if (!creds) return null;
  return new AcuityLiveAdapter(creds, options?.fetchImpl, options?.sleep);
}

/**
 * Default adapter resolution for SYNC PATHS (runDemoSync, availabilityTick).
 * Under the test runner this ALWAYS returns null — tests must inject a stub
 * adapter and must NEVER hit live Acuity (the owner's real credentials sit in
 * this machine's environment, so an unguarded env lookup would make every
 * `bun test` run fire live API calls). Production (serve/publish) is unaffected.
 */
export function resolveAcuityAdapterForSync(): AcuityLiveAdapter | null {
  if (process.env.NODE_ENV === "test") return null;
  return createAcuityLiveAdapter();
}

// ---------- shared store writes (sync runner + scheduler tick) ----------

/**
 * Contact-link + upsert one batch of normalized Acuity appointments. ONE
 * definition shared by the full sync (run.ts) and the background availability
 * tick so the two paths can never diverge. Linkage: HighLevel contact by
 * external id (demo), then phone, then email (SPEC attribution priority).
 */
export async function upsertAcuityAppointments(store: Store, appts: NormalizedAppointment[]): Promise<number> {
  const storedContacts = await store.getContacts();
  const contactByExt = new Map(storedContacts.map((c) => [c.external_id, c.id]));
  const contactByPhone = new Map(storedContacts.map((c) => [c.phone?.replace(/\D/g, "").slice(-10) ?? "", c.id]));
  const contactByEmail = new Map(storedContacts.map((c) => [c.email?.toLowerCase() ?? "", c.id]));
  await store.upsertAppointments(
    appts.map((a) => {
      const contactId =
        contactByExt.get(a.clientName) ??
        contactByPhone.get(a.clientPhone.replace(/\D/g, "").slice(-10)) ??
        contactByEmail.get(a.clientEmail.toLowerCase()) ??
        null;
      return {
        acuity_appointment_id: a.acuity_appointment_id,
        contact_id: contactId,
        calendar_id: a.calendarId,
        calendar_name: a.calendarName,
        appointment_type: a.appointmentType,
        appointment_datetime: a.appointmentDatetime,
        duration_minutes: a.durationMinutes,
        created_at: a.createdAt,
        status: a.status,
        cancelled: a.cancelled,
        client_name: a.clientName,
        // Defensive re-normalization (idempotent): ANY adapter path — demo seed
        // included — lands identities in the same stored form the engine and
        // the contacts table compare with. Upsert by acuity id rewrites these
        // on every sync, so pre-normalization rows refill on the next pass.
        client_phone: normalizeAttributionPhone(a.clientPhone) ?? "",
        client_email: normalizeAttributionEmail(a.clientEmail) ?? "",
      };
    }),
  );
  return appts.length;
}

/**
 * Connection row for the Acuity provider — provider-aware honesty:
 * live success → connected; live failure → error (keeping the LAST successful
 * sync timestamp; data on the pages is stale real data, not demo); no
 * credentials → demo. Never log secret values.
 */
export async function writeAcuityConnection(
  store: Store,
  info: { live: boolean; error?: string | null; note: string | null; nowIso: string },
): Promise<void> {
  const previous = (await store.getConnections()).find((c) => c.provider === "acuity");
  const liveError = info.error ?? null;
  await store.upsertConnection({
    provider: "acuity",
    status: info.live ? "connected" : liveError ? "error" : "demo",
    is_demo: !info.live && !liveError,
    last_sync_at: info.nowIso,
    // success stamps now; a failed LIVE attempt KEEPS the previous successful
    // timestamp (the pages show stale real data, not a fresh-looking failure)
    last_successful_sync_at: info.live || !liveError ? info.nowIso : previous?.last_successful_sync_at ?? null,
    last_error: liveError,
    config: {
      ...(previous?.config ?? {}),
      source: info.live ? "acuity-api" : liveError ? "acuity-api (failed — showing last synced data)" : "demo-seed",
      note: info.note,
    },
  });
}

// ---------- background availability tick ----------

/** Minimum gap between background availability syncs (the window fetch is 1 paced request). */
export const ACUITY_MIN_INTERVAL_MS = 5 * 60_000;

export interface AvailabilityTickResult {
  outcome: "synced" | "skipped" | "error";
  appointments?: number;
  reason?: string;
  error?: string;
}

/**
 * One availability sync, injectable for tests (no live API, no real time).
 * Guards: skip while an acuity sync_runs row is in flight (stale rows are
 * crashed processes), skip without credentials, throttle background runs to
 * ACUITY_MIN_INTERVAL_MS via the connection row. Manual triggers skip the
 * throttle. Failures are recorded on the sync_runs + connection rows and
 * returned — never thrown into the scheduler loop.
 */
export async function availabilityTick(options?: {
  store?: Store;
  adapter?: AcuityLiveAdapter | null;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<AvailabilityTickResult> {
  const now = options?.now ?? (() => new Date());
  const store = options?.store ?? (await import("../store").then((m) => m.getStore()));
  const trigger = options?.trigger ?? "background";

  const running = await store.getRunningSyncRun("acuity");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > 12 * 3_600_000;
    if (!stale) return { outcome: "skipped", reason: "sync-in-progress" };
  }

  const adapter = "adapter" in (options ?? {}) ? options?.adapter ?? null : resolveAcuityAdapterForSync();
  if (!adapter) return { outcome: "skipped", reason: "no-credentials" };

  if (trigger === "background") {
    const prev = (await store.getConnections()).find((c) => c.provider === "acuity");
    const last = prev?.last_sync_at ? Date.parse(prev.last_sync_at) : NaN;
    if (Number.isFinite(last) && now().getTime() - last < ACUITY_MIN_INTERVAL_MS) {
      return { outcome: "skipped", reason: "recent-sync" };
    }
  }

  const runId = await store.insertSyncRun("acuity");
  try {
    const appts = await adapter.fetchAppointments();
    // demo slots never mix with live data (owner spec)
    await store.deleteDemoAcuityRows();
    const count = await upsertAcuityAppointments(store, appts);
    await store.finishSyncRun(runId, "success", count, null);
    const report = adapter.lastRun;
    const note = report
      ? [
          `window ${report.window.minDate} → ${report.window.maxDate}`,
          `${count} appointments`,
          report.truncated ? "TRUNCATED at cap" : null,
          ...report.warnings.slice(0, 3),
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500)
      : `window sync · ${count} appointments`;
    await writeAcuityConnection(store, { live: true, note, nowIso: now().toISOString() });
    return { outcome: "synced", appointments: count };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(runId, "error", 0, msg);
    await writeAcuityConnection(store, {
      live: false,
      error: msg,
      note: `Live availability sync failed — showing last synced data until fixed. ${msg}`.slice(0, 500),
      nowIso: now().toISOString(),
    });
    return { outcome: "error", error: msg };
  }
}
