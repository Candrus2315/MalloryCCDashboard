/**
 * AVAILABILITY page payload builders (Phase 1 + PR-2 range views) — moved verbatim from page-data.ts
 * (docs/DECOMPOSITION-PLAN.md step 3). page-data.ts re-exports this
 * module; import paths and the public surface are unchanged.
 */
import { getStore } from "../store";
import type { AppointmentRow, Store } from "../store/types";

import { addDays, etDayEndUtc, etDayStartUtc, etToday, weekStart } from "../date-logic";
import { materializeRecurringBlocks } from "../metrics/compute";



import { computeDayAvailability, type DayAvailability } from "../metrics/availability";
import { monthKeyOf } from "../metrics/weekly";


import { deriveWeeklyHoles, type DayHoleDetail } from "../commission/derive";
import { kickAvailabilityTopUp } from "../sync/availability-feed";
import { buildAvailabilityView } from "../availability-view";
import {
  availabilityFilterOptions,
  composeAvailabilitySync,
  fourteenDayWindowLabel,
  type AvailabilityFilterOptions,
  type AvailabilitySyncPanel,
} from "../availability-view";
import { deriveDatesToPush, pushRangeLabel, type AvailabilityPushRow } from "../availability-push";
import { availabilityPushCopy, type AvailabilityCopyDay } from "../../components/availability-copy";



import { syncStaleWarnings, type PageMeta } from "../queries";
import { loadPageMeta, type PageDeps } from "./shared";
import { AVAILABILITY_ARGS_LOST_WARNING } from "../../components/availability-flow";

// ---------- AVAILABILITY PAGE (merged-build playbook Phase 1 payload contract) ----------

/** Public contract name for one day of the availability payload. */
export type AvailabilityDay = DayAvailability;

/** Public contract name for the wave-2 holes adjacency map (per displayed date). */
export type { DayHoleDetail };

/** Acuity freshness for the availability header (honest states only). */
export interface AvailabilityConnection {
  connected: boolean;
  /** "live" = Acuity API data; "demo" = the labeled demo dataset; "disconnected" = no usable connection. */
  mode: "live" | "demo" | "disconnected";
  lastSyncAt: string | null; // last SUCCESSFUL sync (ISO)
  stale: boolean;
}

/** Data older than this warns "Availability may be outdated" (near-real-time is the goal). */
export const ACUITY_STALE_AFTER_MS = 30 * 60_000;

/**
 * Availability payload — the next 7 operational days (ET) through the ONE
 * availability engine, plus the Acuity connection state and the Settings
 * scope filters. Same PageDeps seam as the other builders: tests inject a
 * MemoryStore + pinned `today`; the loader passes nothing.
 */
export async function availabilityPageData(deps?: PageDeps) {
  const today = deps?.today ?? etToday();
  // PERF: meta + settings + the rules mirror all independent — one parallel wave.
  const metaPromise: Promise<PageMeta> = deps?.store
    ? Promise.resolve({ mode: "memory", dbReason: null, today, demoSeeded: false })
    : loadPageMeta();
  const store = deps?.store ?? (await getStore());

  const [meta, settings, storedRules] = await Promise.all([
    metaPromise,
    store.getSettings(),
    store.getAvailabilityRules(),
  ]);

  // studio hours: availability_rules is the runtime mirror; fall back to the
  // settings rules when the mirror is empty (fresh store/tests) — never invent
  const rules = storedRules.length > 0 ? storedRules : settings.studio.hours;
  const recurring = settings.studio.recurring_blocks ?? [];

  // ---- AVAILABILITY REBUILD PR-2: range views (Month default / 14-Day / Day) ----
  // A view request swaps the legacy 7-day strip payload for the range-view
  // payload (the route always sends one — default = month of today; the
  // contract tests don't, so the legacy path below stays byte-identical).
  const viewRequest = normalizeAvailabilityView(deps?.view, today);
  if (viewRequest) {
    // PR-3 §3/§4: the filter options come from the CACHED catalog (written by
    // every feed run), the sync panel from the feed's run rows + the
    // unresolved discrepancy list — all cache reads, no API calls.
    const [view, connections, catalog, feedRuns, discrepancies] = await Promise.all([
      buildAvailabilityView({ store, today, settings, rules, recurring, request: viewRequest }),
      store.getConnections(),
      store.getAvailabilityCatalog(),
      store.getAvailabilitySyncRuns(10),
      store.getAvailabilityDiscrepancies({ unresolvedOnly: true, limit: 200 }),
    ]);
    const { connection, warnings } = availabilityConnectionState(connections);
    if (deps?.viewArgsLost) {
      warnings.push(AVAILABILITY_ARGS_LOST_WARNING);
    }
    // PR-1's designed page-loader top-up: read the cache NOW, kick ONE bounded
    // background run for what the visible range is missing — never awaited
    // (SSR stays fast; the next load or tick sees fresh cache), and a no-op
    // under test/demo (no client resolves there). A range with no future dates
    // never triggers calls (the feed has no past availability worth caching).
    if (view.dates.some((d) => d >= today)) {
      kickAvailabilityTopUp({ dates: view.dates }, { store });
    }
    // §10 copy targets: ONE extra cache-read build of the rolling 14-day
    // window (today..today+13) backs Today / Next 7 / Next 14 / the
    // specific-date picker in EVERY view — a visible month alone cannot answer
    // a window that crosses its edge. Skipped when the request already IS
    // that window (the 14-Day view's own build is reused).
    const isCopyBase = viewRequest.kind === "days" && viewRequest.from === today;
    const copyView = isCopyBase
      ? view
      : await buildAvailabilityView({
          store,
          today,
          settings,
          rules,
          recurring,
          request: {
            kind: "days",
            month: "",
            from: today,
            to: addDays(today, AVAILABILITY_DAYS_VIEW_WINDOW - 1),
            date: "",
            filters: viewRequest.filters,
          },
        });
    const copyDays = copyView.days.map(toCopyDay);
    const copyByDate: Record<string, string> = {};
    for (const d of copyDays) copyByDate[d.date] = availabilityPushCopy([d]);
    // §7 push rows derive ONCE off the view payload's days — the pageView
    // field AND the copy target read the same rows (deriveDatesToPush is
    // pure, but two calls would invite drift; the copy mapper reshapes,
    // never re-sorts).
    const pushRows = deriveDatesToPush(view.days, today);
    const pageView: AvailabilityPageView = {
      ...view,
      filterOptions: availabilityFilterOptions(catalog),
      sync: composeAvailabilitySync({
        connection,
        feedRuns,
        discrepancies,
        coverageHorizonDate: view.coverage.horizonDate,
        noFeedData: view.coverage.noFeedData,
      }),
      datesToPush: pushRows,
      pushRangeLabel: pushRangeLabel(
        { kind: viewRequest.kind, label: view.label },
        fourteenDayWindowLabel(today),
      ),
      copy: {
        today: copyByDate[today] ?? availabilityPushCopy([]),
        next7: availabilityPushCopy(copyDays.filter((d) => d.date >= today && d.date < addDays(today, 7))),
        next14: availabilityPushCopy(copyDays),
        datesToPush: availabilityPushCopy(
          pushRows.map((r) => ({
            date: r.date,
            openCount: r.openings,
            holes: r.holes,
            capacity: r.capacity,
            booked: r.booked,
            utilization: r.utilization,
          })),
        ),
        day: viewRequest.kind === "day" ? availabilityPushCopy(view.days.map(toCopyDay)) : null,
        copyDates: copyDays.map((d) => d.date),
        byDate: copyByDate,
      },
    };
    return {
      meta,
      today,
      connection,
      days: [] as AvailabilityDay[],
      holesByDate: {} as Record<string, DayHoleDetail>,
      filters: { calendars: settings.acuity.calendars_included, types: settings.acuity.types_included },
      warnings: [...warnings, ...view.warnings],
      view: pageView,
    };
  }

  const dayDates = Array.from({ length: 7 }, (_, off) => addDays(today, off));
  // Wave-2 holes adjacency input: the raw per-day overlap rows, kept before
  // the availability engine scopes them (the holes derivation consumes the
  // UNscoped superset — exactly what the Weekly report feeds deriveWeeklyHoles).
  const apptRowsByDate = new Map<string, AppointmentRow[]>();
  // PERF: the 7 per-day engine runs and the Acuity connection read share one wave.
  const [days, connections]: [DayAvailability[], Awaited<ReturnType<Store["getConnections"]>>] = await Promise.all([
    Promise.all(
      dayDates.map(async (date) => {
      const [appointments, blockedRaw] = await Promise.all([
        store.getAppointmentsOverlapping(etDayStartUtc(date), etDayEndUtc(date)),
        store.getBlockedTimesBetween(etDayStartUtc(date), etDayEndUtc(date)),
      ]);
      apptRowsByDate.set(date, appointments);
      return computeDayAvailability({
        date,
        rules,
        blocked: [...blockedRaw, ...materializeRecurringBlocks(date, recurring)],
        appointments,
        slotIntervalMin: settings.studio.slot_interval_min,
        durationMin: settings.studio.appointment_duration_min,
        paddingMin: settings.studio.padding_min,
        scope: settings.acuity,
      });
    }),
    ),
    store.getConnections(),
  ]);
  const row = connections.find((c) => c.provider === "acuity") ?? null;
  const lastSuccess = row?.last_successful_sync_at ?? null;
  const lastMs = lastSuccess ? Date.parse(lastSuccess) : NaN;
  const stale =
    row?.status === "connected" && Number.isFinite(lastMs) && Date.now() - lastMs > ACUITY_STALE_AFTER_MS;
  const connection: AvailabilityConnection = {
    connected: row?.status === "connected" ?? false,
    mode: row && row.is_demo ? "demo" : row?.status === "connected" ? "live" : "disconnected",
    lastSyncAt: lastSuccess,
    stale,
  };

  // honesty warnings — acuity-only slice of the shared stale warnings, plus
  // the explicit stale/outdated and disconnected lines the spec requires
  const warnings: string[] = syncStaleWarnings(connections).filter((w) => w.startsWith("Acuity"));
  if (stale) {
    warnings.push(
      `Availability may be outdated — last successful Acuity sync was ${Math.max(1, Math.round((Date.now() - lastMs) / 60_000))} minutes ago.`,
    );
  }
  if (connection.mode === "disconnected") {
    warnings.push("Acuity connection required — availability stays unavailable (no invented slots) until Acuity connects.");
  }

  // ---- OWNER HOLES ADJACENCY (wave 2) ----
  // Per-day holes for the 7 displayed dates, derived by the SAME
  // deriveWeeklyHoles the Weekly report + copied CC Report use (#34) — one
  // derivation, no second engine, no redefined arithmetic. The per-day
  // overlap fetches above are exactly the superset the derivation consumes
  // (getAppointmentsOverlapping per ET day); the union is deduped by row id
  // (one appointment can touch two adjacent ET days) and each covered Mon–Sun
  // week runs once. ONLY per-day details for the displayed dates are exposed:
  // every displayed date's own overlap fetch is complete, so its per-day
  // holes are real — a week whose coverage is partial never exposes its
  // AGGREGATE here (that would fabricate against the Weekly page's number).
  const weeksCovered = [...new Set(dayDates.map((d) => weekStart(d)))].sort();
  const unionById = new Map<string, AppointmentRow>();
  for (const rows of apptRowsByDate.values()) for (const a of rows) unionById.set(a.id, a);
  const sessionAppts = [...unionById.values()];
  const holesByDate: Record<string, DayHoleDetail> = {};
  for (const mon of weeksCovered) {
    const w = deriveWeeklyHoles({ weekStart: mon, sessionAppts });
    for (const d of w.days) if (dayDates.includes(d.date)) holesByDate[d.date] = d;
  }

  return {
    meta,
    today,
    connection,
    days,
    holesByDate,
    filters: { calendars: settings.acuity.calendars_included, types: settings.acuity.types_included },
    warnings,
  };
}

// ---------- AVAILABILITY REBUILD PR-2: range views (Month default / 14-Day / Day) ----------
// Blueprint: /home/team/shared/design/availability-rebuild-investigation.md §6
// PR-2 + owner directive §2–§4, §6, §8–§9. One builder, three view kinds, ONE
// availability engine (computeDayAvailability) for every count, ONE hole
// derivation (deriveAvailabilityHoles in availability-feed.ts — the PR-2
// placeholder is the current rule; PR-3 swaps the owner's pick by editing only
// that body), and the PR-1 feed cache as the ONLY Acuity source (the loader
// never awaits API calls — it reads the cache and kicks a bounded top-up).

/** Raw search fields the availability route passes through (normalized below). */
export interface AvailabilityViewRawSearch {
  view?: string;
  month?: string;
  from?: string;
  to?: string;
  date?: string;
  /** PR-3 §3 page-level filters (comma-separated): calendar IDs, appointment-type NAMES, status tokens. */
  cal?: string;
  type?: string;
  st?: string;
}

export type AvailabilityViewKind = "month" | "days" | "day";

/** The 14-Day view's rolling window length. */
export const AVAILABILITY_DAYS_VIEW_WINDOW = 14;

/**
 * PR-3 §3 — the availability page's own filters. They NARROW the Settings
 * scope server-side (through the existing appointmentInScope machinery —
 * page-level can never widen past Settings); empty = everything in scope.
 * Status toggles filter the Day view's slot LIST only (counts stay whole-day).
 */
export interface AvailabilityPageFilters {
  /** Calendar IDs (the machinery matches id or name). */
  calendars: string[];
  /** Appointment type NAMES (the machinery compares appointment_type). */
  types: string[];
  /** Slot-list tokens: booked | open | holes | cancelled | blocked. */
  statuses: string[];
}

export const AVAILABILITY_STATUS_TOKENS = ["booked", "open", "holes", "cancelled", "blocked"] as const;

export interface AvailabilityViewRequest {
  kind: AvailabilityViewKind;
  /** kind=month → the visible month "YYYY-MM"; "" otherwise. */
  month: string;
  /** kind=days → window start (the end is start + window − 1). */
  from: string;
  to: string;
  /** kind=day → the single date. */
  date: string;
  /** The page-level filters (empty = everything in scope). */
  filters: AvailabilityPageFilters;
}

const AVAIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AVAIL_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Normalize the raw search into a view request — PURE. Invalid/absent fields
 * fall back to honest defaults (month of today / today), never an error page.
 * Filter lists are comma-separated; unknown status tokens are dropped (a
 * typo'd token must not silently empty the slot list — dropping it narrows
 * less, which is the honest direction); calendar/type values pass through
 * as-is (an unmatched value honestly yields an empty in-scope set).
 * `null` = no view requested (the legacy 7-day payload contract keeps running
 * for anything that does not opt in).
 */
export function normalizeAvailabilityView(
  raw: AvailabilityViewRawSearch | undefined,
  today: string,
): AvailabilityViewRequest | null {
  if (
    !raw ||
    (raw.view == null && raw.month == null && raw.from == null && raw.to == null && raw.date == null && raw.cal == null && raw.type == null && raw.st == null)
  ) {
    return null;
  }
  const csv = (v: string | undefined): string[] =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  const validStatuses = csv(raw.st).filter((s) => (AVAILABILITY_STATUS_TOKENS as readonly string[]).includes(s));
  const filters: AvailabilityPageFilters = { calendars: csv(raw.cal), types: csv(raw.type), statuses: validStatuses };
  const validDate = (v: string | undefined) => (v && AVAIL_DATE_RE.test(v) ? v : null);
  const validMonth = (v: string | undefined) => (v && AVAIL_MONTH_RE.test(v) ? v : null);
  if (raw.view === "day") {
    return { kind: "day", month: "", from: "", to: "", date: validDate(raw.date) ?? today, filters };
  }
  if (raw.view === "days") {
    const from = validDate(raw.from) ?? today;
    return { kind: "days", month: "", from, to: addDays(from, AVAILABILITY_DAYS_VIEW_WINDOW - 1), date: "", filters };
  }
  return { kind: "month", month: validMonth(raw.month) ?? monthKeyOf(today), from: "", to: "", date: "", filters };
}

/** The ET dates a view request displays (month → its calendar dates; days → the window; day → itself). PURE. */
export { availabilityViewDates } from "../availability-view";

/** How one day's OPEN numbers were produced — the honesty state the views render. */
export type AvailabilityAcuityState =
  | "feed" // Acuity-authoritative inside the coverage horizon (feed ∖ booked)
  | "estimated" // past the horizon / sweep snapshot — grid − booked arithmetic, labeled
  | "past" // before today: booked-truth territory, the engine numbers are what happened
  | "none"; // the month has no cached sweep yet — Open renders "—" (never a bare 0)

export interface AvailabilityRangeDay {
  date: string;
  totalCapacity: number;
  /** DISTINCT engine-booked slots (doubles collapse — the calendar-fill accuracy item). */
  booked: number;
  /** The displayed open count: feed-authoritative, engine-estimated, real 0 when feed-closed — null when no coverage. */
  openCount: number | null;
  /** The engine's open slot labels (the studio-schedule estimate / past-truth set). */
  openSlotTimes: string[];
  utilization: number | null;
  blockedCount: number;
  /** deriveAvailabilityHoles — the ONE hole derivation (current rule placeholder). */
  holes: number;
  acuity: AvailabilityAcuityState;
  /** Feed open ∖ booked (HH:mm sorted) when the feed answers with times; null otherwise. */
  feedOpenTimes: string[] | null;
  /** The month index marks the date open but the per-date times are not probed yet. */
  feedPending: boolean;
  /** This day sits past the coverage horizon (the month's "Beyond Acuity booking horizon" label). */
  beyondHorizon: boolean;
}

export interface AvailabilityRangeSummary {
  capacity: number;
  booked: number;
  /** Sum over days with a known open count; the UI renders "—" when openKnown is false. */
  open: number;
  holes: number;
  utilization: number | null;
  /** false when at least one visible day has no Acuity coverage — Open renders "—" honestly. */
  openKnown: boolean;
}

/**
 * Per-slot availability state (Day view). CANCELLED renders struck-through on
 * the slot's row; CLOSED = a feed-observed closed day's empty slots (PR-3 §5
 * polish — chips agree with the day's real 0 open).
 */
export type AvailabilitySlotStatus = "booked" | "booked-pending" | "open" | "blocked" | "cancelled" | "closed";

export interface AvailabilitySlotAppointment {
  id: string;
  clientName: string | null;
  appointmentType: string;
  calendarName: string | null;
  cancelled: boolean;
  cancelledAt: string | null;
  paymentState: string | null;
  durationMinutes: number | null;
}

export interface AvailabilitySlotView {
  /** "09:00" (HH:mm ET — the feed's shape) for grid slots; off-grid feed times keep their own. */
  time: string;
  /** "9:00 AM" — the engine's slot label shape. */
  label: string;
  status: AvailabilitySlotStatus;
  /** The hole definition counts this slot (OPEN·HOLE — the §9 token). */
  isHole: boolean;
  /** Open/hole derived from the studio schedule rather than the feed. */
  estimated: boolean;
  /** "Unexplained — not offered by Acuity (candidate block)" etc.; null when plain. */
  reason: string | null;
  /** Gray "unexplained" rendering (inferred candidate block — never claimed as a real block). */
  unexplained: boolean;
  /** A dashboard/recurring block or the turnover buffer occupies the slot's interval. */
  blocked: boolean;
  /** Active (non-cancelled, in-scope) appointments whose session overlaps the slot, chronological. */
  appointments: AvailabilitySlotAppointment[];
  /** Cancelled rows whose session overlaps the slot — struck-through, Day view only. */
  cancelledAppointments: AvailabilitySlotAppointment[];
  /** activeCount − 1 — the "+n" badge (distinct-slot counting). */
  extraCount: number;
  /** A feed-offered time outside the generated grid (extra row after the grid, Day view). */
  offGrid: boolean;
}

export interface AvailabilityCoverageView {
  /** Last date any calendar still offered slots (null = the feed has no cached data at all). */
  horizonDate: string | null;
  months: Array<{ month: string; calendarCount: number; offeredDates: number; fetchedAt: string | null }>;
  /** Months with a cached sweep (the feed answered them, [] included). */
  coveredMonths: string[];
  /** NOTHING is cached (feed never ran / demo) — engine output renders everywhere (existing behavior). */
  noFeedData: boolean;
}

export interface AvailabilityViewPayload {
  kind: AvailabilityViewKind;
  month: string;
  from: string;
  to: string;
  date: string;
  /** "October 2026" / "Oct 6 – Oct 19, 2026" / "Tuesday, October 13, 2026" — the summary heading. */
  label: string;
  dates: string[];
  days: AvailabilityRangeDay[];
  summary: AvailabilityRangeSummary;
  /** Day view only: the chronological slot list (grid slots + off-grid feed times). */
  slots: AvailabilitySlotView[] | null;
  /** Day view only: active in-scope appointments on the date outside every generated slot. */
  offGridAppointments: AvailabilitySlotAppointment[];
  coverage: AvailabilityCoverageView;
  /** The "Beyond Acuity booking horizon — estimated" month label. */
  beyondHorizon: boolean;
  /** Any visible day lacks a cached sweep (Open renders "—" for those days). */
  hasUncoveredDays: boolean;
  /** Range-level honesty lines (the page banner appends them). */
  warnings: string[];
}

/**
 * The availability page's FULL view payload (PR-3): the range view plus the
 * Dates-to-Push rows, the filter options and the sync panel — everything the
 * rebuilt route renders, all from cache reads + the ONE engine.
 */
export type AvailabilityPageView = AvailabilityViewPayload & {
  /** §7 Dates to Push — priority-sorted (holes → openings → utilization → date). */
  datesToPush: AvailabilityPushRow[];
  /** Which range the push list covers ("visible month October 2026" / "the 14-day window …"). */
  pushRangeLabel: string;
  /** §11 filter options from the CACHED /calendars + /appointment-types catalog. */
  filterOptions: AvailabilityFilterOptions;
  /** §1 sync visibility: both sync rows, coverage horizon, discrepancy list. */
  sync: AvailabilitySyncPanel;
  /** §10 copy targets — frozen block texts + the per-date map backing the specific-date picker. */
  copy: {
    today: string;
    next7: string;
    next14: string;
    datesToPush: string;
    /** Day view only — the visible day's own block; null elsewhere. */
    day: string | null;
    /** ET dates the specific-date picker can copy (today … today+13). */
    copyDates: string[];
    byDate: Record<string, string>;
  };
};

/** The view day's honest displayed numbers, in the copy formatters' shape. */
function toCopyDay(d: AvailabilityRangeDay): AvailabilityCopyDay {
  return { date: d.date, openCount: d.openCount, holes: d.holes, capacity: d.totalCapacity, booked: d.booked, utilization: d.utilization };
}

/** Acuity connection state + the stale/disconnected honesty lines (mirrors the legacy path exactly). */
function availabilityConnectionState(connections: Awaited<ReturnType<Store["getConnections"]>>): {
  connection: AvailabilityConnection;
  warnings: string[];
} {
  const row = connections.find((c) => c.provider === "acuity") ?? null;
  const lastSuccess = row?.last_successful_sync_at ?? null;
  const lastMs = lastSuccess ? Date.parse(lastSuccess) : NaN;
  const stale =
    row?.status === "connected" && Number.isFinite(lastMs) && Date.now() - lastMs > ACUITY_STALE_AFTER_MS;
  const connection: AvailabilityConnection = {
    connected: row?.status === "connected" ?? false,
    mode: row && row.is_demo ? "demo" : row?.status === "connected" ? "live" : "disconnected",
    lastSyncAt: lastSuccess,
    stale,
  };
  const warnings: string[] = syncStaleWarnings(connections).filter((w) => w.startsWith("Acuity"));
  if (stale) {
    warnings.push(
      `Availability may be outdated — last successful Acuity sync was ${Math.max(1, Math.round((Date.now() - lastMs) / 60_000))} minutes ago.`,
    );
  }
  if (connection.mode === "disconnected") {
    warnings.push("Acuity connection required — availability stays unavailable (no invented slots) until Acuity connects.");
  }
  return { connection, warnings };
}
