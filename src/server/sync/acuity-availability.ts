/**
 * ACUITY AVAILABILITY CLIENT — read-only client for Acuity v1's FUTURE
 * availability endpoints (availability rebuild Phase 1, PR-1 of 3).
 *
 * Blueprint: /home/team/shared/design/availability-rebuild-investigation.md
 * (§1 capability map — probed live 2026-10-06; raw JSON snapshots in
 * /home/team/shared/design/availability-probe-evidence/).
 *
 * Endpoints used (read-only):
 *   GET /calendars                — the studio's calendars (3: main 1335091,
 *                                   Annex 12107308, Zoom 4932380)
 *   GET /appointment-types        — the catalog WITH calendarIDs: types are
 *                                   HARD-BOUND to calendars; availability
 *                                   queried for a type×calendar mismatch
 *                                   answers 400 invalid_calendar — so the
 *                                   per-calendar representative type must
 *                                   come from this endpoint's calendarIDs
 *                                   (§1.2), never guessed.
 *   GET /availability/dates       — dates within a month that still have
 *                                   bookable open slots. appointmentTypeID is
 *                                   REQUIRED (400 required_appointment_type_id
 *                                   without it). Months past the owner's Acuity
 *                                   booking-template horizon answer HTTP-200
 *                                   [] — "no data" and "fully closed" are
 *                                   indistinguishable at the API level, so the
 *                                   EMPTY month is cached too and the coverage
 *                                   horizon is tracked from the cache (§3).
 *   GET /availability/times       — OPEN (bookable) start times for ONE date:
 *                                   [{time:"2026-10-13T13:30:00-0400",
 *                                     slotsAvailable:1}, ...]. The feed is
 *                                   OPEN-only — booked slots are invisible,
 *                                   so capacity can NEVER be derived from it
 *                                   (booked truth stays in our appointments
 *                                   table; capacity stays the canonical grid).
 *
 * Auth + pacing mirror acuity-live.ts exactly (same credentials, same ~1
 * req/sec rate limit — every request spaced ≥1.1s, injectable sleep for
 * tests). Demo mode NEVER resolves this client (resolveAcuityAvailabilityClient
 * returns null under NODE_ENV=test and without credentials — the owner's real
 * credentials sit in this machine's environment, so an unguarded env lookup
 * would make every `bun test` run fire live API calls).
 */
import { getSecret } from "../env";

// ---------- credentials (same pattern as acuity-live.ts) ----------

export interface AcuityCreds {
  userId: string;
  apiKey: string;
}

/** Resolve ACUITY_USER_ID + ACUITY_API_KEY (either missing → null → no calls). */
export function readAcuityAvailabilityCreds(): AcuityCreds | null {
  const userId = getSecret("ACUITY_USER_ID");
  const apiKey = getSecret("ACUITY_API_KEY");
  if (!userId || !apiKey) return null;
  return { userId, apiKey };
}

// ---------- pure parsers (exported for tests; fixture-backed) ----------

export interface AcuityCalendarInfo {
  id: string;
  name: string;
  timezone: string;
}

export function parseAcuityCalendar(raw: Record<string, unknown>): AcuityCalendarInfo | null {
  const id = raw.id != null ? String(raw.id) : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;
  return {
    id,
    name,
    timezone: typeof raw.timezone === "string" && raw.timezone ? raw.timezone : "America/New_York",
  };
}

export interface AcuityTypeFull {
  id: string;
  name: string;
  duration: number | null;
  /** Calendars the type is bookable on — the hard type↔calendar binding (§1.2). */
  calendarIDs: string[];
}

export function parseAcuityTypeFull(raw: Record<string, unknown>): AcuityTypeFull | null {
  const id = raw.id != null ? String(raw.id) : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;
  const rawList = Array.isArray(raw.calendarIDs) ? raw.calendarIDs : [];
  const calendarIDs = rawList
    .map((v) => (v != null && String(v).trim() !== "" ? String(v).trim() : ""))
    .filter((v) => v !== "");
  return {
    id,
    name,
    duration: typeof raw.duration === "number" && Number.isFinite(raw.duration) ? raw.duration : null,
    calendarIDs,
  };
}

/** One /availability/dates row: {"date":"2026-10-13"} → the ET date string. */
export function parseAvailabilityDateRow(raw: Record<string, unknown>): string | null {
  const d = raw.date;
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null;
}

export interface AcuityOpenTime {
  /** HH:mm ET (the feed's stated time IS the calendar's America/New_York clock — §1.4). */
  timeEt: string;
  slotsAvailable: number;
}

/**
 * Acuity availability times carry the offset inline ("2026-10-13T13:30:00-0400",
 * some builds without the colon). The instant is parsed (offset respected) and
 * formatted back in the calendar's America/New_York clock — never by
 * string-slicing (a non-ET offset or a DST edge must not shift the label).
 */
export function parseAcuityOpenTime(raw: Record<string, unknown>): AcuityOpenTime | null {
  const t = raw.time;
  if (typeof t !== "string" || t.trim() === "") return null;
  const normalized = /([+-]\d{2})(\d{2})$/.test(t) ? `${t.slice(0, -2)}:${t.slice(-2)}` : t;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  const timeEt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
  const slots = typeof raw.slotsAvailable === "number" && Number.isFinite(raw.slotsAvailable) ? raw.slotsAvailable : null;
  // slotsAvailable absent/invalid → 1 is the honest minimum for a session slot
  // (sessions are classSize:null / private — the probed account never returns
  // group capacity). Never a guess: absent means "at least one".
  if (slots == null) return { timeEt, slotsAvailable: 1 };
  return { timeEt, slotsAvailable: Math.max(1, Math.round(slots)) };
}

// ---------- the live client ----------

export interface AvailabilityRunReport {
  requests: number;
  /** The endpoints actually called this run (for the sync panel's audit). */
  calls: Array<{ path: string; params: Record<string, string> }>;
  warnings: string[];
}

type FetchImpl = (url: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Response>;

export class AcuityAvailabilityClient {
  lastRun: AvailabilityRunReport | null = null;
  private lastRequestAt = 0;

  constructor(
    private creds: AcuityCreds,
    private fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * Begin ONE availability run's report: resets the request/call audit so a
   * multi-call run (catalog -> month sweeps -> per-date times) accumulates
   * into ONE report the sync orchestration can store. Each GET appends;
   * without a startRun the report is simply not recorded.
   */
  startRun(): void {
    this.lastRun = { requests: 0, calls: [], warnings: [] };
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.creds.userId}:${this.creds.apiKey}`).toString("base64")}`;
  }

  /** GET with Basic auth + the ~1 req/sec pacing Acuity expects (≥1.1s gap). */
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
        "User-Agent": "MalloryCCDashboard/1.0 (availability feed sync)",
      },
    });
    if (this.lastRun) {
      this.lastRun.requests += 1;
      this.lastRun.calls.push({ path, params });
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Acuity authentication failed (${res.status}) — check ACUITY_USER_ID / ACUITY_API_KEY`);
    }
    if (res.status === 429) {
      throw new Error("Acuity rate limited (429) — availability sync will retry on the next tick");
    }
    if (!res.ok) {
      let hint = "";
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        hint = body?.error ? ` (${body.error})` : "";
      } catch {
        // body was not JSON — the status alone is the message
      }
      throw new Error(`Acuity API error ${res.status} on GET /${path}${hint}`);
    }
    return res.json();
  }

  /** GET /calendars — the studio's calendars (probed: exactly 3, §1.1). */
  async fetchCalendars(): Promise<AcuityCalendarInfo[]> {
    this.lastRun = { requests: 0, calls: [], warnings: [] };
    const body = await this.getJson("calendars", {});
    const list = Array.isArray(body) ? body : [];
    const out: AcuityCalendarInfo[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const parsed = parseAcuityCalendar(raw as Record<string, unknown>);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** GET /appointment-types — the full catalog WITH the calendarIDs binding (§1.2). */
  async fetchAppointmentTypes(): Promise<AcuityTypeFull[]> {
    this.lastRun = { requests: 0, calls: [], warnings: [] };
    const body = await this.getJson("appointment-types", {});
    const list = Array.isArray(body) ? body : [];
    const out: AcuityTypeFull[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const parsed = parseAcuityTypeFull(raw as Record<string, unknown>);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /**
   * GET /availability/dates?month=YYYY-MM&appointmentTypeID=X[&calendarID=Y] —
   * the dates within the month that still have bookable open slots. Throws
   * WITHOUT an appointmentTypeId (the endpoint requires it — 400
   * required_appointment_type_id; there is no calendar-only availability
   * query, §1.3). A month past the booking-template horizon answers [] — a
   * REAL empty answer the caller caches as the coverage horizon.
   */
  async fetchAvailabilityDates(input: { month: string; appointmentTypeId: string; calendarId?: string }): Promise<string[]> {
    if (!/^\d{4}-\d{2}$/.test(input.month)) throw new Error(`availability/dates: month must be YYYY-MM (got ${input.month})`);
    if (!input.appointmentTypeId) throw new Error("availability/dates: appointmentTypeId is required (Acuity answers 400 without it)");
    const params: Record<string, string> = { month: input.month, appointmentTypeID: input.appointmentTypeId };
    if (input.calendarId) params.calendarID = input.calendarId;
    const body = await this.getJson("availability/dates", params);
    const list = Array.isArray(body) ? body : [];
    const out: string[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const parsed = parseAvailabilityDateRow(raw as Record<string, unknown>);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /**
   * GET /availability/times?date=YYYY-MM-DD&appointmentTypeID=X[&calendarID=Y] —
   * the OPEN (bookable) start times for the date (OPEN-only feed: booked slots
   * are invisible, §1.4). Same appointmentTypeId requirement.
   */
  async fetchAvailabilityTimes(input: { date: string; appointmentTypeId: string; calendarId?: string }): Promise<AcuityOpenTime[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error(`availability/times: date must be YYYY-MM-DD (got ${input.date})`);
    if (!input.appointmentTypeId) throw new Error("availability/times: appointmentTypeId is required (Acuity answers 400 without it)");
    const params: Record<string, string> = { date: input.date, appointmentTypeID: input.appointmentTypeId };
    if (input.calendarId) params.calendarID = input.calendarId;
    const body = await this.getJson("availability/times", params);
    const list = Array.isArray(body) ? body : [];
    const out: AcuityOpenTime[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const parsed = parseAcuityOpenTime(raw as Record<string, unknown>);
      if (parsed) out.push(parsed);
    }
    return out;
  }
}

/**
 * Default client resolution for SYNC PATHS (the availability-feed tick, the
 * manual refresh, the page-loader top-up). Mirrors resolveAcuityAdapterForSync:
 * under the test runner this ALWAYS returns null — tests inject a stub client
 * and must NEVER hit live Acuity. Production (serve/publish) is unaffected.
 * Demo mode never resolves it either (no credentials → null → the feed sync
 * skips; the demo dataset keeps rendering the existing engine output).
 */
export function resolveAcuityAvailabilityClient(options?: {
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}): AcuityAvailabilityClient | null {
  if (process.env.NODE_ENV === "test") return null;
  const creds = readAcuityAvailabilityCreds();
  if (!creds) return null;
  return new AcuityAvailabilityClient(creds, options?.fetchImpl, options?.sleep);
}
