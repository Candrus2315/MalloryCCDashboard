/**
 * Centralized operational date logic for the Mallory CC dashboard.
 *
 * ALL Mallory operational date logic runs in America/New_York (per SPEC).
 * Calendar dates are represented as "YYYY-MM-DD" strings (ET calendar dates).
 * Instants are ISO-8601 UTC strings.
 *
 * LEAD DATE LOGIC (SPEC): "Leads Today" = leads the CC team is expected to
 * WORK today, not leads that arrived today.
 *  - Tuesday–Friday: today's working leads = leads received the PREVIOUS
 *    calendar day (Tue=Mon, Wed=Tue, Thu=Wed, Fri=Thu).
 *  - MONDAY: Monday's working leads = leads received previous Fri + Sat + Sun.
 *  - SATURDAY / SUNDAY (explicit, documented): the team is expected to work
 *    the cohort the upcoming Monday will work, i.e. the most recent
 *    Fri/Sat/Sun window. Saturday therefore returns [Fri, Sat(today), Sun
 *    (tomorrow)] and Sunday returns [Fri, Sat, Sun(today)] — "prefer Monday's
 *    cohort" so weekend views stay continuous with Monday morning's report.
 *
 * Every lead stores BOTH:
 *  - source_date: the date the lead actually entered the sheet
 *  - work_date:   the date the team is expected to work it
 * Operational reporting filters on work_date. Historical reporting may use
 * source_date.
 */

export const OPERATIONAL_TIMEZONE = "America/New_York";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateStr(d: string): string {
  if (!DATE_RE.test(d)) throw new Error(`Invalid date string: ${d} (expected YYYY-MM-DD)`);
  return d;
}

/** Calendar date (YYYY-MM-DD) of an instant in the operational timezone. */
export function etDateStrFromInstant(instantMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OPERATIONAL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/** Current calendar date in America/New_York. */
export function etToday(): string {
  return etDateStrFromInstant(Date.now());
}

/** Offset (ms) of the operational timezone at a given instant. */
function etOffsetMs(instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATIONAL_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - instantMs;
}

/**
 * UTC instant (ISO string) of midnight at the START of an ET calendar date.
 * Two-pass to survive DST boundaries. Used to bound DB timestamp queries.
 */
export function etDayStartUtc(dateStr: string): string {
  assertDateStr(dateStr);
  const [y, m, d] = dateStr.split("-").map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  let start = midnightUtc - etOffsetMs(midnightUtc + 12 * 3600_000);
  start = midnightUtc - etOffsetMs(start);
  return new Date(start).toISOString();
}

/** UTC instant of the START of the ET calendar day AFTER dateStr (exclusive upper bound). */
export function etDayEndUtc(dateStr: string): string {
  return etDayStartUtc(addDays(dateStr, 1));
}

/** Add n calendar days to a YYYY-MM-DD string (pure calendar arithmetic). */
export function addDays(dateStr: string, n: number): string {
  assertDateStr(dateStr);
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Day of week: 0 = Sunday ... 6 = Saturday. Calendar dates are TZ-unambiguous. */
export function weekday(dateStr: string): number {
  assertDateStr(dateStr);
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the (Mon–Sun) week containing dateStr. Operational week = Mon..Sun. */
export function weekStart(dateStr: string): string {
  const wd = weekday(dateStr);
  // Mon=1 → 0 days back; Sun=0 → 6 days back.
  return addDays(dateStr, wd === 0 ? -6 : 1 - wd);
}

/** All dates in [startStr, endStr] inclusive. */
export function dateRange(startStr: string, endStr: string): string[] {
  const out: string[] = [];
  let cur = startStr;
  while (cur <= endStr) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * THE centralized lead cohort function (SPEC).
 * Given the report date (the day the team is working), return the list of
 * source_dates whose leads the team works that day. All pages must use this —
 * never filter sheets by "today".
 */
export function getLeadCohort(reportDate: string): string[] {
  const wd = weekday(reportDate);
  if (wd >= 2 && wd <= 5) {
    // Tuesday(2)–Friday(5): previous calendar day.
    return [addDays(reportDate, -1)];
  }
  if (wd === 1) {
    // Monday: previous Fri + Sat + Sun.
    return [addDays(reportDate, -3), addDays(reportDate, -2), addDays(reportDate, -1)];
  }
  // Saturday(6)/Sunday(0): prefer Monday's cohort (documented above) — the
  // Fri/Sat/Sun window the upcoming Monday works.
  const nextMonday = wd === 6 ? addDays(reportDate, 2) : addDays(reportDate, 1);
  return [addDays(nextMonday, -3), addDays(nextMonday, -2), addDays(nextMonday, -1)];
}

/**
 * Inverse of getLeadCohort: for a lead that entered the sheet on sourceDate,
 * the date the CC team is expected to work it. Stored on every lead row.
 */
export function getWorkDate(sourceDate: string): string {
  const wd = weekday(sourceDate);
  switch (wd) {
    case 1: // Mon → Tue
    case 2: // Tue → Wed
    case 3: // Wed → Thu
    case 4: // Thu → Fri
      return addDays(sourceDate, 1);
    case 5: // Fri → Mon
      return addDays(sourceDate, 3);
    case 6: // Sat → Mon
      return addDays(sourceDate, 2);
    case 0: // Sun → Mon
      return addDays(sourceDate, 1);
    default:
      throw new Error("unreachable weekday");
  }
}

// ---------- working-day (Mon–Fri) pace math (owner-corrected) ----------

/**
 * WORKING-DAY semantics: agents work Mon–Fri ONLY. Weekly counters still reset
 * Monday, but every "days left" / pace / expected-to-date figure counts
 * WORKING days, never weekend calendar days.
 *
 * Days left in the work week INCLUDING today: Mon=5 … Fri=1, Sat/Sun=0 (no
 * working days remain — pace resumes Monday).
 */
export function daysLeftInWorkWeek(reportDate: string): number {
  const wd = weekday(reportDate);
  return wd >= 1 && wd <= 5 ? 6 - wd : 0; // Mon(1)=5 … Fri(5)=1; weekend=0
}

/**
 * ET wall-clock cutoff for the DAILY PACE figures (owner-ratified 2026-09-29):
 * at/after 18:30 America/New_York the working day is over for pace purposes —
 * today no longer counts as a remaining working day.
 */
export const PACE_DAY_CUTOFF_ET_MINUTES = 18 * 60 + 30; // 18:30 ET

/** Current America/New_York wall-clock as minutes since midnight (0–1439). */
export function etNowMinutes(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/**
 * PACE-ONLY sibling of daysLeftInWorkWeek (owner-ratified rule): today counts
 * as a remaining working day ONLY before 18:30 America/New_York; at/after the
 * cutoff it is worked out and excluded (Mon 18:29 → 5, Mon 18:30 → 4,
 * Fri 18:29 → 1, Fri 18:30 → 0). Weekend behavior unchanged (0 — pace resumes
 * Monday); never negative. daysLeftInWorkWeek keeps the always-count-today
 * semantics for non-pace callers.
 */
export function daysLeftInWorkWeekAt(date: string, etMinutes: number): number {
  const base = daysLeftInWorkWeek(date);
  if (base === 0) return 0; // weekend — unchanged
  return etMinutes >= PACE_DAY_CUTOFF_ET_MINUTES ? base - 1 : base;
}

/** True when the date is a working day (Mon–Fri). */
export function isWorkday(dateStr: string): boolean {
  const wd = weekday(dateStr);
  return wd >= 1 && wd <= 5;
}

/**
 * Weekday name for an ET calendar date: "Friday" (long) or "Fri" (short).
 * Used by the Daily Report labels/banners, which name the day the
 * performance figures cover.
 */
export function weekdayName(dateStr: string, long = true): string {
  assertDateStr(dateStr);
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: long ? "long" : "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * OWNER DIRECTIVE — the Daily Report PERFORMANCE ANCHOR date. The Daily
 * Report's performance figures (bookings, conversation conversion, assigned
 * lead conversion) cover a complete OPERATING DAY, never the calendar prior
 * day and never a weekend:
 *  - Workday at/after 18:30 ET (the owner-established operating-day end,
 *    PACE_DAY_CUTOFF_ET_MINUTES) → anchor = TODAY (EOD: show today's numbers).
 *  - Otherwise (before 18:30 on a workday, or Sat/Sun at any time) → anchor =
 *    the most recent PRIOR workday: Mon→Fri, Tue–Fri→yesterday, Sat/Sun→Fri.
 *    Never Sunday, never Saturday.
 *
 * `etNowMinutes` is injectable for deterministic tests; default is the live
 * America/New_York wall clock (aliased below to dodge param shadowing).
 */
const liveEtNowMinutes = () => etNowMinutes();

export function dailyReportAnchorDate(today: string, etNowMinutes?: number): string {
  const minutes = etNowMinutes ?? liveEtNowMinutes();
  if (isWorkday(today) && minutes >= PACE_DAY_CUTOFF_ET_MINUTES) return today;
  let prior = addDays(today, -1);
  while (!isWorkday(prior)) prior = addDays(prior, -1);
  return prior;
}

// ---------- rep operating state (call_start_date, design/data-terminology.md) ----------

export type RepOperatingState = "active" | "not-yet-active";

/**
 * Rep operating state for an ET calendar date, from the rep's explicit
 * activation field (users.call_start_date). BEFORE the start date the rep is
 * "not-yet-active": visible in the roster with zero calls EXPECTED — never
 * flagged for zero activity, never coached, never labeled underperforming,
 * never part of zero-activity exception logic, and never given negative
 * performance messaging. Normal monitoring begins ON the start date
 * (boundary: today === call_start_date is ACTIVE). No start date (null) means
 * the rep has always been monitored.
 */
export function repOperatingState(
  callStartDate: string | null | undefined,
  today: string,
): RepOperatingState {
  if (typeof callStartDate !== "string" || !DATE_RE.test(callStartDate) || callStartDate <= today) {
    return "active";
  }
  return "not-yet-active";
}

/**
 * Fraction of the work week elapsed INCLUDING today: Mon=1/5 … Fri=5/5.
 * Sat/Sun=5/5 — the week's work is done, expected-to-date is the full goal.
 */
export function weekElapsedWorkFraction(reportDate: string): number {
  const wd = weekday(reportDate);
  return wd >= 1 && wd <= 5 ? wd / 5 : 1;
}

/** Working days (Mon–Fri) in [startStr, endStr] inclusive; 0 when end < start. */
export function workingDaysBetween(startStr: string, endStr: string): number {
  if (endStr < startStr) return 0;
  let n = 0;
  for (let cur = startStr; cur <= endStr; cur = addDays(cur, 1)) {
    if (isWorkday(cur)) n += 1;
  }
  return n;
}

/** Format an ET calendar date for humans, e.g. "Fri, Sep 25". */
export function formatDateHuman(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Format an ET calendar date for humans WITH the year, e.g. "Wed, Sep 24, 2026". */
export function formatDateHumanFull(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Compact month-day label for week pickers, e.g. "Sep 21" (no weekday/year). */
export function formatDateShort(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The most recent Mondays (week starts), current operating week first, for
 * the historical "Week of…" picker. Centralized so no page invents its own
 * week list.
 */
export function recentMondays(today: string, count = 8): string[] {
  const current = weekStart(today);
  return Array.from({ length: Math.max(1, count) }, (_, i) => addDays(current, -7 * i));
}

/**
 * True when the resolved range is a HISTORICAL week (week-of mode anchored
 * before the current operating week's Monday). Only "week-of" can be
 * historical: every other preset either tracks now (Today/This Week/Last 7/
 * Last 30/This Month) or is labeled as its own past preset (Yesterday/Last
 * Week). Drives the "Current Week" vs "Historical · Week of …" live-state
 * indicator (owner hard rule: live vs historical is never ambiguous).
 */
export function isHistoricalWeek(mode: RangeMode, start: string, today: string): boolean {
  return mode === "week-of" && start < weekStart(today);
}

// ---------- report date-range resolution (Reps / Team page filters) ----------

export type RangeMode =
  | "today"
  | "yesterday"
  | "this-week"
  | "last-week"
  | "week-of"
  | "last-7"
  | "last-30"
  | "this-month"
  | "custom";

export const RANGE_MODES: RangeMode[] = [
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "week-of",
  "last-7",
  "last-30",
  "this-month",
  "custom",
];

/** Display labels for the filter pills — shared by the Reps and Team pages. */
export const RANGE_LABELS: Record<RangeMode, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "this-week": "This Week",
  "last-week": "Last Week",
  "week-of": "Week of…",
  "last-7": "Last 7 Days",
  "last-30": "Last 30 Days",
  "this-month": "This Month",
  custom: "Custom Range",
};

export function isRangeMode(v: unknown): v is RangeMode {
  return typeof v === "string" && (RANGE_MODES as string[]).includes(v);
}

export interface ResolvedRange {
  mode: RangeMode;
  /** Inclusive ET calendar dates. */
  start: string;
  end: string;
  /** Short label for the mode, e.g. "This Week". */
  label: string;
  /** True when the mode covers only elapsed days (week/month to date). */
  toDate: boolean;
  /** Non-fatal warning (e.g. invalid custom range) — surfaced by the page. */
  warning: string | null;
}

/**
 * Resolve a named filter mode to an inclusive ET date range. "This Week" and
 * "This Month" are TO DATE (Mon..today / 1st..today) — future days have no
 * activity and to-date matches the rest of the app (Bookings WTD). "Last
 * Week" is the full previous Mon..Sun. "Week of…" is a full historical
 * Mon..Sun week anchored on the supplied `from` Monday (owner directive
 * 9/26: whole-page historical context — the ONE resolved range drives every
 * payload section through the single metrics engine). Custom is validated; an
 * invalid custom range falls back to Today with a warning (never silently
 * mislabeled); an invalid week-of falls back to This Week with a warning.
 */
export function resolveRange(
  mode: RangeMode,
  today: string,
  from?: string,
  to?: string,
): ResolvedRange {
  switch (mode) {
    case "today":
      return { mode, start: today, end: today, label: "Today", toDate: true, warning: null };
    case "yesterday": {
      const y = addDays(today, -1);
      return { mode, start: y, end: y, label: "Yesterday", toDate: true, warning: null };
    }
    case "this-week":
      return {
        mode,
        start: weekStart(today),
        end: today,
        label: "This Week",
        toDate: true,
        warning: null,
      };
    case "last-week": {
      const ws = addDays(weekStart(today), -7);
      return {
        mode,
        start: ws,
        end: addDays(ws, 6),
        label: "Last Week",
        toDate: false,
        warning: null,
      };
    }
    case "week-of": {
      const fromOk = typeof from === "string" && DATE_RE.test(from);
      if (fromOk) {
        const ws = weekStart(from!); // normalize any day to its Monday
        return {
          mode,
          start: ws,
          end: addDays(ws, 6),
          label: `Week of ${formatDateShort(ws)}`,
          toDate: false,
          warning: null,
        };
      }
      return {
        mode: "this-week",
        start: weekStart(today),
        end: today,
        label: "This Week",
        toDate: true,
        warning: "Invalid week — showing This Week instead.",
      };
    }
    case "last-7":
      return {
        mode,
        start: addDays(today, -6),
        end: today,
        label: "Last 7 Days",
        toDate: true,
        warning: null,
      };
    case "last-30":
      return {
        mode,
        start: addDays(today, -29),
        end: today,
        label: "Last 30 Days",
        toDate: true,
        warning: null,
      };
    case "this-month":
      return {
        mode,
        start: today.slice(0, 7) + "-01",
        end: today,
        label: "This Month",
        toDate: true,
        warning: null,
      };
    case "custom": {
      const fromOk = typeof from === "string" && DATE_RE.test(from);
      const toOk = typeof to === "string" && DATE_RE.test(to);
      if (fromOk && toOk && from! <= to!) {
        return {
          mode,
          start: from!,
          end: to!,
          label: "Custom Range",
          toDate: false,
          warning: null,
        };
      }
      const why = !fromOk || !toOk ? "both dates required" : "start date is after end date";
      return {
        mode: "today",
        start: today,
        end: today,
        label: "Today",
        toDate: true,
        warning: `Invalid custom range (${why}) — showing Today instead.`,
      };
    }
  }
}

/** All Mondays (week starts) covered by an inclusive ET date range. */
export function mondaysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  let ws = weekStart(start);
  while (ws <= end) {
    out.push(ws);
    ws = addDays(ws, 7);
  }
  return out;
}

/** UTC bounds [startUtc, endUtc) covering inclusive ET calendar dates start..end. */
export function etRangeBounds(start: string, end: string): { startUtc: string; endUtc: string } {
  return { startUtc: etDayStartUtc(start), endUtc: etDayEndUtc(end) };
}

/**
 * ET presentation fields for one audit/call row (ET date + human clock time).
 * Lives here (not in a server-runtime module) so BOTH server code and client
 * bundles can import it — the vite build externalizes node builtins, and a
 * routes->server-runtime import drags the pg driver into the client graph.
 * Generic over anything carrying started_at; type flows through the map.
 */
export function auditRowView<T extends { started_at: string }>(
  r: T,
): T & { et_date: string; started_at_et: string } {
  const ms = Date.parse(r.started_at);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ms));
  return { ...r, et_date: etDateStrFromInstant(ms), started_at_et: parts };
}
