/**
 * AVAILABILITY FEED — the Acuity availability rebuild's data layer (PR-1 of 3).
 *
 * Blueprint: /home/team/shared/design/availability-rebuild-investigation.md
 * §3 (schema), §5 (capacity-source resolution), §6 PR-1. The owner's hard line
 * this implements: "Acuity authoritative — no separate interpretation that can
 * disagree", executable as ONE equation per (calendar, date, time):
 *
 *   expected_open = canonical-grid − booked(non-cancelled)      [our truth]
 *   acuity_open   = the availability feed                        [their truth]
 *   equal → clean; a difference → an availability_discrepancies row with BOTH
 *   sides attached (kinds: acuity-open-but-booked / acuity-silent-but-open /
 *   off-grid-acuity-time), resolved when a later run stops seeing it.
 *
 * The three sources (§5):
 *   OPEN     — Acuity feed (/availability/times), cached in availability_slots
 *              with last_confirmed_at; displayed open inside the horizon is
 *              acuity_open ∖ booked (belt-and-suspenders: a stale feed can
 *              never show a booked slot as open; the raw disagreement stays
 *              visible in the discrepancy list — never silently reconciled).
 *   BOOKED   — our Acuity-synced appointments table (the booking-truth every
 *              other page already uses; cancellation-reconciled, write-once).
 *   CAPACITY — the canonical grid (commission/derive.scheduledSlotTimesForDay —
 *              consumed, NEVER edited; the monthly goal 316 + commission hole
 *              logic keep their own untouched derivations).
 *
 * Sync strategy (rate-limit-aware — Acuity ~1 req/sec):
 *   - monthly /availability/dates sweep per (calendar × representative type) =
 *     3 calls/month, cached in availability_dates (an EMPTY answer is cached
 *     too — that IS the coverage horizon; "no data" and "fully closed" are
 *     indistinguishable at the API level, §1.3);
 *   - /availability/times per visible date on demand (only dates the cached
 *     month index marks open are probed), cached in availability_slots with
 *     last_confirmed_at refreshed per re-probe;
 *   - the tick + manual refresh run through the established runner machinery
 *     (their own sync_runs row, provider "acuity_availability", reaped by the
 *     existing stale-run reaper);
 *   - the page loader NEVER awaits API calls — it reads the cache and kicks a
 *     bounded background top-up for missing months/dates.
 *
 * WRITER PROTECTION (the established pattern): a writer-version stamp
 * (sync_checkpoints "availability-feed-writer-version") refuses an outdated
 * writer, and the pg store's availability writes hold one advisory lock —
 * background tick, manual refresh and page-loader top-up can never interleave.
 *
 * DEMO MODE NEVER CALLS THIS: without ACUITY credentials (or under
 * NODE_ENV=test) the client resolves null and every entry point skips with
 * "no-credentials" — the demo dataset keeps rendering the existing engine
 * output exactly as Today does (no demo Acuity availability calls).
 */
import { addDays, etDateStrFromInstant, etDayStartUtc, etToday } from "../date-logic";
import { etTimeOfInstant, scheduledSlotTimesForDay } from "../commission/derive";
import type { AppointmentRow } from "../metrics/compute";
import {
  AcuityAvailabilityClient,
  resolveAcuityAvailabilityClient,
  type AcuityCalendarInfo,
  type AcuityTypeFull,
} from "./acuity-availability";
import type {
  AvailabilityDatesRow,
  AvailabilityDiscrepancyInput,
  AvailabilityDiscrepancyKind,
  AvailabilitySlotRow,
  Store,
} from "../store/types";

// ---------- constants ----------

/** sync_checkpoints key holding the latest availability-feed writer version. */
export const AVAILABILITY_FEED_WRITER_VERSION_KEY = "availability-feed-writer-version";
/** v1 = the PR-1 feed writer (dates sweep + per-date times + discrepancy detector). */
export const AVAILABILITY_FEED_WRITER_VERSION = 1;

/** Minimum gap between BACKGROUND availability-feed runs (manual skips it). */
export const AVAILABILITY_FEED_MIN_INTERVAL_MS = 5 * 60_000;

/** Months the background tick keeps swept: the running month + this many ahead. */
export const AVAILABILITY_SWEEP_MONTHS_AHEAD = 3;
/** Cached month index older than this is re-swept (the horizon must track the owner's template edits). */
export const AVAILABILITY_DATES_TTL_MS = 6 * 3_600_000;
/** Cached per-date open-slot rows older than this are re-probed on the next tick. */
export const AVAILABILITY_TIMES_TTL_MS = 2 * 3_600_000;
/** Max /availability/times calls per background tick (~1.1s each, paced client-side). */
export const AVAILABILITY_TICK_TIMES_CAP = 20;
/** Max /availability/times calls for one awaited manual refresh of a range. */
export const AVAILABILITY_REFRESH_TIMES_CAP = 60;
/** The default "visible" window (today, ET … +13) the tick keeps fresh. */
export const AVAILABILITY_TICK_WINDOW_DAYS = 14;

/** Generic sync_runs provider name (the machinery's own row for this sync). */
export const AVAILABILITY_FEED_PROVIDER = "acuity_availability";

// ---------- PURE: month helpers ----------

/** "2026-10-13" → "2026-10" (pure string math, ET dates are plain strings). */
export function monthKeyOf(dateStr: string): string {
  return /^\d{4}-\d{2}/.test(dateStr) ? dateStr.slice(0, 7) : "";
}

/** All ET calendar dates of a month key ("2026-11" → ["2026-11-01"…]). */
export function monthDates(month: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  const [y, m] = month.split("-").map(Number);
  const out: string[] = [];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= days; d += 1) out.push(`${month}-${String(d).padStart(2, "0")}`);
  return out;
}

/** Month key + n months (pure; "2026-10", 1 → "2026-11"; crossing years included). */
export function addMonths(month: string, n: number): string {
  if (!/^\d{4}-\d{2}$/.test(month)) return "";
  const [y, m] = month.split("-").map(Number);
  const zero = y * 12 + (m - 1) + n;
  const ny = Math.floor(zero / 12);
  const nm = (zero % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

// ---------- PURE: representative type per calendar (the /appointment-types binding) ----------

export interface CalendarTypePair {
  calendarId: string;
  calendarName: string;
  appointmentTypeId: string;
  appointmentTypeName: string;
}

/**
 * ONE representative appointment type per calendar. Availability is a property
 * of the calendar template (§1.4: every matching type returns the same open
 * times), so one pair per calendar answers the whole month sweep. Selection is
 * deterministic: prefer the exact "Portrait Session" type (the probed
 * representative), else the type with the FEWEST calendar bindings, else the
 * lowest type id. A calendar with no bound type is skipped with a warning —
 * never guessed (an unbound pair answers 400 invalid_calendar).
 */
export function representativeTypePairs(
  calendars: AcuityCalendarInfo[],
  types: AcuityTypeFull[],
): { pairs: CalendarTypePair[]; warnings: string[] } {
  const pairs: CalendarTypePair[] = [];
  const warnings: string[] = [];
  for (const cal of calendars) {
    const bound = types.filter((t) => t.calendarIDs.includes(cal.id));
    if (bound.length === 0) {
      warnings.push(`calendar "${cal.name}" (${cal.id}) has no bound appointment type — skipped (an unbound pair answers 400 invalid_calendar)`);
      continue;
    }
    const pick =
      bound.find((t) => t.name === "Portrait Session") ??
      [...bound].sort((a, b) => a.calendarIDs.length - b.calendarIDs.length || a.id.localeCompare(b.id))[0];
    pairs.push({ calendarId: cal.id, calendarName: cal.name, appointmentTypeId: pick.id, appointmentTypeName: pick.name });
  }
  return { pairs, warnings };
}

// ---------- PURE: the discrepancy detector (the owner's equation) ----------

export interface DiscrepancyCandidate {
  calendar_id: string;
  date_et: string;
  time_et: string;
  kind: AvailabilityDiscrepancyKind;
  detail: Record<string, unknown>;
}

/** Minimal appointment shape the detector reads (keeps it testable without full rows). */
export interface DetectorBookedAppt {
  id: string;
  acuity_appointment_id?: string | null;
  client_name?: string | null;
  appointment_type?: string | null;
  appointment_datetime: string;
  cancelled?: boolean;
  status?: string;
}

/**
 * ONE (calendar, date) comparison — PURE. `booked` = the non-cancelled
 * appointments ON THIS CALENDAR whose session falls on the ET date (the caller
 * filters calendar + cancellation; type scope is deliberately NOT applied —
 * Acuity's feed does not know our Settings filters, and a booked slot is
 * booked whatever its type). `acuityOpen` = the CURRENT feed answer (HH:mm ET,
 * sorted). `gridTimes` = the canonical grid (scheduledSlotTimesForDay).
 *
 * Kinds (both sides always in detail):
 *  - acuity-open-but-booked: the feed offers a slot our booked-truth occupies
 *    (the 2026-10-24 16:30 divergence — §1.5).
 *  - acuity-silent-but-open: a grid slot, free per our booked-truth, the feed
 *    does not offer (candidate Acuity-side block/booking lag — surfaced, never
 *    guessed into open or booked).
 *  - off-grid-acuity-time: the feed offers a time outside the canonical grid.
 */
export function detectAvailabilityDiscrepancies(input: {
  calendarId: string;
  date: string;
  gridTimes: string[];
  acuityOpen: string[];
  booked: DetectorBookedAppt[];
}): DiscrepancyCandidate[] {
  const { calendarId, date, gridTimes, acuityOpen } = input;
  const bookedByTime = new Map<string, DetectorBookedAppt[]>();
  for (const a of input.booked) {
    if (a.cancelled || a.status === "cancelled") continue; // cancelled frees its slot (§1.5: 10-13 14:30)
    const ms = Date.parse(a.appointment_datetime);
    if (!Number.isFinite(ms)) continue; // unparseable — never guessed
    const d = etDateStrFromInstant(ms);
    if (d !== date) continue;
    const t = etTimeOfInstant(ms);
    const list = bookedByTime.get(t) ?? [];
    list.push(a);
    bookedByTime.set(t, list);
  }
  const gridSet = new Set(gridTimes);
  const acuitySet = new Set(acuityOpen);
  const detailFor = (time: string): { acuity: "open" | "silent"; booked: Record<string, unknown>[]; grid: "canonical" } => ({
    acuity: acuitySet.has(time) ? "open" : "silent",
    booked: (bookedByTime.get(time) ?? []).map((a) => ({
      id: a.id,
      acuity_appointment_id: a.acuity_appointment_id ?? null,
      client_name: a.client_name ?? null,
      appointment_type: a.appointment_type ?? null,
      created_at: a.appointment_datetime,
    })),
    grid: "canonical",
  });
  const out: DiscrepancyCandidate[] = [];
  for (const time of acuitySet) {
    if (!gridSet.has(time)) {
      out.push({ calendar_id: calendarId, date_et: date, time_et: time, kind: "off-grid-acuity-time", detail: detailFor(time) });
      continue;
    }
    if (bookedByTime.has(time)) {
      out.push({ calendar_id: calendarId, date_et: date, time_et: time, kind: "acuity-open-but-booked", detail: detailFor(time) });
    }
  }
  for (const time of gridSet) {
    if (!acuitySet.has(time) && !bookedByTime.has(time)) {
      out.push({ calendar_id: calendarId, date_et: date, time_et: time, kind: "acuity-silent-but-open", detail: detailFor(time) });
    }
  }
  return out.sort((a, b) => a.time_et.localeCompare(b.time_et) || a.kind.localeCompare(b.kind));
}

// ---------- PURE: the fetch plan (rate-limit-aware) ----------

export type TimesFetchReason = "missing" | "stale";

export interface AvailabilityPlan {
  /** Month-index sweeps: one /availability/dates call per (month × calendar × representative type). */
  sweeps: Array<{ month: string; calendarId: string; appointmentTypeId: string; reason: "missing" | "stale" }>;
  /** Per-date open-slot probes: one /availability/times call per (date × calendar × type). */
  times: Array<{ date: string; calendarId: string; appointmentTypeId: string; reason: TimesFetchReason }>;
}

/**
 * Compute what a feed sync must fetch, PURELY from cache state.
 *
 * - Month sweeps: months >= today's month only (past dates are booked-truth,
 *   the feed has no past availability worth caching); a month is swept when
 *   its cached row is missing or older than datesTtlMs.
 * - Times probes: ONLY dates a cached month row marks open (a date absent
 *   from a FRESH month row is closed-by-cache — the feed answer is already
 *   known: probing it would burn a paced call to learn []). A month row that
 *   is missing or stale defers its dates' probes until AFTER the sweep (the
 *   executor re-plans once the fresh index exists). A date whose slot rows
 *   are absent is "missing"; whose newest last_confirmed_at is older than
 *   timesTtlMs is "stale".
 * - The times list is capped (soonest dates first) — bounded latency per run;
 *   the rest wait for the next tick/top-up.
 */
export function planAvailabilityFetches(input: {
  today: string;
  months: string[];
  dates: string[];
  pairs: CalendarTypePair[];
  cachedDates: AvailabilityDatesRow[];
  cachedSlots: AvailabilitySlotRow[];
  datesTtlMs: number;
  timesTtlMs: number;
  nowMs: number;
  timesCap: number;
}): AvailabilityPlan {
  const currentMonth = monthKeyOf(input.today);
  const plan: AvailabilityPlan = { sweeps: [], times: [] };
  if (input.pairs.length === 0) return plan;

  const monthsNeeded = [...new Set(input.months)]
    .filter((m) => /^\d{4}-\d{2}$/.test(m) && m >= currentMonth)
    .sort();
  for (const month of monthsNeeded) {
    for (const pair of input.pairs) {
      const row = input.cachedDates.find((r) => r.calendar_id === pair.calendarId && r.appointment_type_id === pair.appointmentTypeId && r.month === month);
      if (!row) {
        plan.sweeps.push({ month, calendarId: pair.calendarId, appointmentTypeId: pair.appointmentTypeId, reason: "missing" });
        continue;
      }
      if (input.nowMs - Date.parse(row.fetched_at) > input.datesTtlMs) {
        plan.sweeps.push({ month, calendarId: pair.calendarId, appointmentTypeId: pair.appointmentTypeId, reason: "stale" });
      }
    }
  }

  // the fresh month index per pair (a stale row does NOT authorize time probes —
  // its []-months may be wrong after a template edit; sweep first, probe next run)
  const freshIndex = new Map<string, Set<string>>();
  for (const row of input.cachedDates) {
    if (input.nowMs - Date.parse(row.fetched_at) > input.datesTtlMs) continue;
    freshIndex.set(`${row.calendar_id}|${row.month}`, new Set(row.dates_et));
  }

  const timesCandidates: Array<{ date: string; calendarId: string; appointmentTypeId: string; reason: TimesFetchReason }> = [];
  for (const date of [...new Set(input.dates)].sort()) {
    if (date < input.today) continue; // past dates are booked-truth, never probed
    const month = monthKeyOf(date);
    for (const pair of input.pairs) {
      const open = freshIndex.get(`${pair.calendarId}|${month}`);
      if (!open) continue; // month not freshly indexed — sweep first
      if (!open.has(date)) continue; // cached answer: closed — nothing to probe
      const rows = input.cachedSlots.filter((s) => s.calendar_id === pair.calendarId && s.date_et === date);
      if (rows.length === 0) {
        timesCandidates.push({ date, calendarId: pair.calendarId, appointmentTypeId: pair.appointmentTypeId, reason: "missing" });
        continue;
      }
      const freshest = Math.max(...rows.map((r) => Date.parse(r.last_confirmed_at)));
      if (input.nowMs - freshest > input.timesTtlMs) {
        timesCandidates.push({ date, calendarId: pair.calendarId, appointmentTypeId: pair.appointmentTypeId, reason: "stale" });
      }
    }
  }
  plan.times = timesCandidates
    .sort((a, b) => a.date.localeCompare(b.date) || a.calendarId.localeCompare(b.calendarId))
    .slice(0, Math.max(0, input.timesCap));
  return plan;
}

// ---------- the sync orchestration ----------

export interface AvailabilityFeedResult {
  outcome: "synced" | "skipped" | "error";
  reason?: string;
  callsMade?: number;
  monthsFetched?: number;
  datesProbed?: number;
  slotsCached?: number;
  discrepancies?: { inserted: number; resolved: number };
  warnings?: string[];
  error?: string;
}

export interface AvailabilityFeedOptions {
  store?: Store;
  /** Injected client (tests); ABSENT → resolveAcuityAvailabilityClient (null under test / demo). */
  client?: AcuityAvailabilityClient | null;
  now?: () => Date;
  trigger?: "background" | "manual";
  /** Month keys to sweep (default: today's month … +AVAILABILITY_SWEEP_MONTHS_AHEAD). */
  months?: string[];
  /** ET dates to probe for open times (default: today … +AVAILABILITY_TICK_WINDOW_DAYS−1). */
  dates?: string[];
  /** Cap on /availability/times calls for this run (default by trigger). */
  timesCap?: number;
  /** Skip the background throttle even for a background run (tests). */
  skipThrottle?: boolean;
}

/**
 * ONE availability-feed sync, injectable for tests (no live API, no real
 * time). Sequence: writer-version guard → runs open (generic + detailed) →
 * catalog (/calendars + /appointment-types, 2 calls) → month sweeps → per-date
 * times probes (capped) → the discrepancy detector over every probed
 * (calendar, date) → runs closed. Failures are recorded on BOTH run rows and
 * returned — never thrown into the scheduler loop.
 */
export async function runAvailabilityFeedSync(options?: AvailabilityFeedOptions): Promise<AvailabilityFeedResult> {
  const now = options?.now ?? (() => new Date());
  const store = options?.store ?? (await import("../store").then((m) => m.getStore()));
  const client =
    options && "client" in options ? options.client ?? null : resolveAcuityAvailabilityClient();
  if (!client) return { outcome: "skipped", reason: "no-credentials" }; // demo mode never calls

  const trigger = options?.trigger ?? "background";
  // the run's "today" respects the INJECTED clock (tests pin it; prod = etToday)
  const today = etDateStrFromInstant(now().getTime());

  const months =
    options?.months ??
    Array.from({ length: AVAILABILITY_SWEEP_MONTHS_AHEAD + 1 }, (_, i) => addMonths(monthKeyOf(today), i));
  const dates = options?.dates ?? Array.from({ length: AVAILABILITY_TICK_WINDOW_DAYS }, (_, i) => addDays(today, i));
  const timesCap = options?.timesCap ?? (trigger === "manual" ? AVAILABILITY_REFRESH_TIMES_CAP : AVAILABILITY_TICK_TIMES_CAP);

  const warnings: string[] = [];
  const genericRunId = await store.insertSyncRun(AVAILABILITY_FEED_PROVIDER);
  const detailedRunId = await store.insertAvailabilitySyncRun({
    trigger,
    months,
    dates: dates.slice(0, 40), // keep the scope row bounded (the audit, not the data)
    timesCap,
  });
  let callsMade = 0;
  let monthsFetched = 0;
  let datesProbed = 0;
  let slotsCached = 0;
  try {
    // WRITER-VERSION GUARD: an outdated build must never rewrite the feed cache
    // with old semantics (the attribution-writer pattern). The refusal is
    // recorded on BOTH run rows — visible in the Sync Center, never silent.
    const storedVersionRaw = await store.getSyncCheckpoint(AVAILABILITY_FEED_WRITER_VERSION_KEY);
    const storedVersion = storedVersionRaw != null ? Number(storedVersionRaw) : null;
    if (storedVersion != null && Number.isFinite(storedVersion) && storedVersion > AVAILABILITY_FEED_WRITER_VERSION) {
      throw new Error(
        `writer-version guard: stored availability-feed writer v${storedVersion} is newer than this writer v${AVAILABILITY_FEED_WRITER_VERSION} — refusing (deploy the current build)`,
      );
    }
    client.startRun();
    // 2 catalog calls — the type↔calendar binding must come from the API (§1.2)
    const calendars = await client.fetchCalendars();
    callsMade += 1;
    const types = await client.fetchAppointmentTypes();
    callsMade += 1;
    const { pairs, warnings: pairWarnings } = representativeTypePairs(calendars, types);
    warnings.push(...pairWarnings);
    if (pairs.length === 0) {
      throw new Error("availability feed: no calendar has a bound appointment type — nothing to sweep");
    }

    // ---- month sweeps (cheap index; [] answers are cached as the horizon) ----
    const sweepsDone: Array<{ month: string; calendarId: string; dates: string[] }> = [];
    for (const s of planAvailabilityFetches({
      today,
      months,
      dates: [], // sweep planning needs no dates
      pairs,
      cachedDates: await store.getAvailabilityDates(months),
      cachedSlots: [],
      datesTtlMs: AVAILABILITY_DATES_TTL_MS,
      timesTtlMs: AVAILABILITY_TIMES_TTL_MS,
      nowMs: now().getTime(),
      timesCap: 0,
    }).sweeps) {
      const datesEt = await client.fetchAvailabilityDates({ month: s.month, appointmentTypeId: s.appointmentTypeId, calendarId: s.calendarId });
      callsMade += 1;
      await store.putAvailabilityDates(
        [{ calendar_id: s.calendarId, appointment_type_id: s.appointmentTypeId, month: s.month, dates_et: datesEt }],
        detailedRunId,
      );
      monthsFetched += 1;
      sweepsDone.push({ month: s.month, calendarId: s.calendarId, dates: datesEt });
    }

    // ---- per-date times probes (planned from the NOW-current month index) ----
    const cachedDates = await store.getAvailabilityDates(months);
    const probedPairs: Array<{ calendar_id: string; date_et: string }> = [];
    const candidates: Array<{ date: string; calendarId: string; appointmentTypeId: string }> = [];
    {
      const freshPairs = pairs; // post-sweep the index is fresh where it was swept
      const cachedSlots = await store.getAvailabilitySlotsForDates(dates);
      const plan = planAvailabilityFetches({
        today,
        months,
        dates,
        pairs: freshPairs,
        cachedDates,
        cachedSlots,
        datesTtlMs: AVAILABILITY_DATES_TTL_MS,
        timesTtlMs: AVAILABILITY_TIMES_TTL_MS,
        nowMs: now().getTime(),
        timesCap,
      });
      candidates.push(...plan.times.map((t) => ({ date: t.date, calendarId: t.calendarId, appointmentTypeId: t.appointmentTypeId })));
    }
    for (const c of candidates) {
      const times = await client.fetchAvailabilityTimes({ date: c.date, appointmentTypeId: c.appointmentTypeId, calendarId: c.calendarId });
      callsMade += 1;
      const n = await store.putAvailabilitySlotsForDate(
        c.calendarId,
        c.date,
        times.map((t) => ({ time_et: t.timeEt, slots_available: t.slotsAvailable })),
        detailedRunId,
      );
      datesProbed += 1;
      slotsCached += n;
      probedPairs.push({ calendar_id: c.calendarId, date_et: c.date });
    }

    // ---- the discrepancy detector over every probed (calendar, date) ----
    const discrepancies = await detectAndApplyDiscrepancies(store, detailedRunId, probedPairs);

    await store.finishAvailabilitySyncRun(detailedRunId, "success", callsMade, null);
    await store.finishSyncRun(genericRunId, "success", callsMade, null);
    // STAMP: this writer's version is now the latest that has written.
    if (storedVersion !== AVAILABILITY_FEED_WRITER_VERSION) {
      await store.setSyncCheckpoint(AVAILABILITY_FEED_WRITER_VERSION_KEY, String(AVAILABILITY_FEED_WRITER_VERSION));
    }
    return {
      outcome: "synced",
      callsMade,
      monthsFetched,
      datesProbed,
      slotsCached,
      discrepancies,
      warnings: warnings.slice(0, 5),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await store.finishAvailabilitySyncRun(detailedRunId, "error", callsMade, msg);
      await store.finishSyncRun(genericRunId, "error", callsMade, msg);
    } catch {
      // best-effort close — the original error is what matters
    }
    return { outcome: "error", error: msg, callsMade, warnings: warnings.slice(0, 5) };
  }
}

/**
 * Run the pure detector over each probed (calendar, date) and apply the result
 * (dedupe-while-unresolved + resolve-when-not-seen). The booked side comes
 * from the appointments table (non-cancelled, THIS calendar, ET session date);
 * the feed side is the freshly-written availability_slots answer.
 */
export async function detectAndApplyDiscrepancies(
  store: Store,
  runId: string,
  probedPairs: Array<{ calendar_id: string; date_et: string }>,
): Promise<{ inserted: number; resolved: number }> {
  if (probedPairs.length === 0) return { inserted: 0, resolved: 0 };
  const dates = [...new Set(probedPairs.map((p) => p.date_et))];
  const [slots, dateApptLists] = await Promise.all([
    store.getAvailabilitySlotsForDates(dates),
    Promise.all(dates.map(async (d) => ({ date: d, appts: await store.getAppointmentsOverlapping(etDayStartUtc(d), etDayStartUtc(addDays(d, 1))) }))),
  ]);
  const apptsByDate = new Map(dateApptLists.map((x) => [x.date, x.appts]));
  const slotsByCalDate = new Map<string, string[]>();
  for (const s of slots) {
    const key = `${s.calendar_id}|${s.date_et}`;
    const list = slotsByCalDate.get(key) ?? [];
    list.push(s.time_et);
    slotsByCalDate.set(key, list);
  }
  const scanned: Array<{ calendar_id: string; date_et: string }> = [];
  const current: AvailabilityDiscrepancyInput[] = [];
  for (const pair of probedPairs) {
    scanned.push({ calendar_id: pair.calendar_id, date_et: pair.date_et });
    const acuityOpen = (slotsByCalDate.get(`${pair.calendar_id}|${pair.date_et}`) ?? []).sort();
    const booked = (apptsByDate.get(pair.date_et) ?? []).filter((a) => a.calendar_id === pair.calendar_id);
    current.push(
      ...detectAvailabilityDiscrepancies({
        calendarId: pair.calendar_id,
        date: pair.date_et,
        gridTimes: scheduledSlotTimesForDay(pair.date_et),
        acuityOpen,
        booked,
      }),
    );
  }
  return store.applyAvailabilityDiscrepancies(runId, scanned, current);
}

// ---------- the tick (the established pattern) ----------

/** Module-level background throttle stamp (manual triggers skip it). */
let lastBackgroundRunAt = 0;

/** Test seam: clear the background throttle between tests. */
export function resetAvailabilityFeedThrottle(): void {
  lastBackgroundRunAt = 0;
}

/**
 * One background availability-feed run (piggy-backed on the scheduler tick,
 * never failing it). Guards: skip while an acuity_availability run is in
 * flight; throttle background runs to AVAILABILITY_FEED_MIN_INTERVAL_MS.
 * Demos/tests without a resolved client skip with "no-credentials".
 */
export async function availabilityFeedTick(options?: {
  store?: Store;
  client?: AcuityAvailabilityClient | null;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<AvailabilityFeedResult> {
  const now = options?.now ?? (() => new Date());
  const trigger = options?.trigger ?? "background";
  const store = options?.store ?? (await import("../store").then((m) => m.getStore()));

  const running = await store.getRunningSyncRun(AVAILABILITY_FEED_PROVIDER);
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > 12 * 3_600_000;
    if (!stale) return { outcome: "skipped", reason: "sync-in-progress" };
  }
  if (trigger === "background" && !options?.skipThrottle) {
    if (now().getTime() - lastBackgroundRunAt < AVAILABILITY_FEED_MIN_INTERVAL_MS) {
      return { outcome: "skipped", reason: "recent-run" };
    }
    lastBackgroundRunAt = now().getTime();
  }
  const res = await runAvailabilityFeedSync({ ...options, trigger, now });
  return res;
}

/**
 * MANUAL REFRESH (server-side, for PR-3's sync panel): re-probe a visible
 * range NOW — awaited, unthrottled (an explicit user action), bounded by
 * AVAILABILITY_REFRESH_TIMES_CAP. Months default to the range's months plus
 * the sweep window so the coverage horizon refreshes too.
 */
export async function refreshAvailabilityRange(
  range: { months?: string[]; dates: string[] },
  options?: { store?: Store; client?: AcuityAvailabilityClient | null; now?: () => Date },
): Promise<AvailabilityFeedResult> {
  const today = etToday();
  const months = range.months ?? [...new Set(range.dates.map(monthKeyOf).concat(monthKeyOf(today)))];
  return runAvailabilityFeedSync({
    store: options?.store,
    ...(options && "client" in (options ?? {}) ? { client: options?.client ?? null } : {}),
    now: options?.now,
    trigger: "manual",
    months,
    dates: range.dates,
    timesCap: AVAILABILITY_REFRESH_TIMES_CAP,
  });
}

/**
 * Page-loader top-up: read the cache NOW, fire ONE bounded background run for
 * what is missing, and never await it (SSR stays fast; the next load or the
 * next tick sees the fresh cache). Dedupe: at most one top-up in flight per
 * process — the running-run guard makes overlapping runs harmless anyway.
 * Under NODE_ENV=test / demo this resolves immediately without calls.
 */
let topUpInFlight = false;
export function kickAvailabilityTopUp(
  range: { months?: string[]; dates: string[] },
  options?: { store?: Store; now?: () => Date; timesCap?: number },
): void {
  if (topUpInFlight) return;
  topUpInFlight = true;
  const today = etToday();
  const months = range.months ?? [...new Set(range.dates.map(monthKeyOf).concat(monthKeyOf(today)))];
  void runAvailabilityFeedSync({
    store: options?.store,
    now: options?.now,
    trigger: "manual",
    months,
    dates: range.dates,
    timesCap: options?.timesCap ?? AVAILABILITY_TICK_TIMES_CAP,
  })
    .catch(() => {
      // never let a top-up rejection surface as an unhandled rejection —
      // the failed run is recorded on the run rows
    })
    .finally(() => {
      topUpInFlight = false;
    });
}

/** Test seam: whether a page-loader top-up is currently in flight. */
export function availabilityTopUpInFlight(): boolean {
  return topUpInFlight;
}

// ---------- PURE: THE hole derivation (availability rebuild, PR-2) ----------

/** Result of the ONE hole derivation: day count + which slots count. */
export interface AvailabilityHoleDerivation {
  /** Day-level hole count — the top summary / month cells / 14-Day rows. */
  holes: number;
  /** Slot-level hole membership: HH:mm ET times the definition counts as holes. */
  holeSlots: string[];
}

/**
 * THE hole derivation of the availability rebuild — ONE pure, isolated
 * function and ONE swap point (PR-2 placeholder → PR-3 owner pick).
 *
 * PLACEHOLDER (PR-2) = the CURRENT rule: every empty grid slot is a hole —
 * holes = capacity − booked over DISTINCT occupied slots (investigation §4
 * candidate C). Inputs already carry everything a stricter definition needs,
 * so the owner's pick (gap-run §4-B is the recommendation, with the
 * "a blocked time ends the active schedule" sub-rule) swaps ONLY this body:
 *
 *   slotTimes    — the engine-generated candidate slots, chronological (HH:mm)
 *   bookedTimes  — distinct slot times an active appointment session occupies
 *   blockedTimes — slot times removed by dashboard blocks / turnover buffer
 *                  (they render BLOCKED, never pushable; under the current
 *                  rule they still count as empty grid slots)
 *
 * Weekly's deriveWeeklyHoles (appointment-count basis) and the commission
 * RULING-3 filled-hole derivation (week-start-open basis) answer DIFFERENT
 * questions and are consumed here — never edited.
 */
export function deriveAvailabilityHoles(input: {
  slotTimes: string[];
  bookedTimes: string[];
  blockedTimes?: string[];
}): AvailabilityHoleDerivation {
  const booked = new Set(input.bookedTimes);
  const holeSlots = input.slotTimes.filter((t) => !booked.has(t));
  return {
    holes: Math.max(0, input.slotTimes.length - booked.size),
    holeSlots,
  };
}

// ---------- PURE: weekday/horizon helpers used by the page-data extension ----------

/**
 * The coverage horizon's data from the cached month index: the LAST date any
 * calendar still offers slots (the "Acuity booking template ends {date}"
 * label) plus per-month sweep state. An uncached future month is honest
 * "no data" until swept — never claimed beyond a horizon we have not seen.
 */
export function coverageHorizonFromCache(cachedDates: AvailabilityDatesRow[], today: string): {
  lastOfferedDate: string | null;
  months: Array<{ month: string; calendarCount: number; offeredDates: number; fetchedAt: string | null }>;
  lastSweptAt: string | null;
} {
  const byMonth = new Map<string, AvailabilityDatesRow[]>();
  for (const r of cachedDates) {
    const list = byMonth.get(r.month) ?? [];
    list.push(r);
    byMonth.set(r.month, list);
  }
  const months = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, rows]) => ({
      month,
      calendarCount: rows.length,
      offeredDates: rows.reduce((n, r) => n + r.dates_et.length, 0),
      fetchedAt: rows.length ? rows.map((r) => r.fetched_at).sort().at(-1) ?? null : null,
    }));
  const lastOfferedDate = cachedDates.reduce<string | null>((max, r) => {
    for (const d of r.dates_et) if (!max || d > max) max = d;
    return max;
  }, null);
  const lastSweptAt = cachedDates.map((r) => r.fetched_at).sort().at(-1) ?? null;
  return { lastOfferedDate, months, lastSweptAt };
}
