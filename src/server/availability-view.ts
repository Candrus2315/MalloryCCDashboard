/**
 * AVAILABILITY REBUILD PR-2 — the range-view builder (Month / 14-Day / Day).
 *
 * Blueprint: /home/team/shared/design/availability-rebuild-investigation.md §6
 * PR-2 + owner directive §2–§4, §6, §8–§9. Split out of page-data.ts purely
 * for size; the public payload CONTRACT stays exported there (type-only
 * re-import — no runtime cycle). Every count comes from the ONE availability
 * engine (computeDayAvailability); every hole from the ONE derivation
 * (deriveAvailabilityHoles in availability-feed.ts — PR-2 placeholder = the
 * current rule, PR-3 swaps the owner's pick by editing only that body); every
 * Acuity number from the PR-1 feed cache. The loader NEVER awaits API calls.
 */
import {
  addDays,
  dateRange,
  etDateStrFromInstant,
  etDayEndUtc,
  etDayStartUtc,
  formatDateHuman,
  formatDateHumanFull,
} from "./date-logic";
import {
  appointmentEndMs,
  appointmentInScope,
  computeDayAvailability,
  slotLabelToMinutes,
  slotLabelToTime,
  slotMinutesToTime,
  slotTimeToLabel,
} from "./metrics/availability";
import { materializeRecurringBlocks, type AppointmentRow, type AvailabilityRule } from "./metrics/compute";
import { monthKeyOf } from "./metrics/weekly";
import {
  addMonths,
  AVAILABILITY_SWEEP_MONTHS_AHEAD,
  coverageHorizonFromCache,
  deriveAvailabilityHoles,
  monthDates,
} from "./sync/availability-feed";
import type {
  AvailabilityCalendarRow,
  AvailabilityDiscrepancyRow,
  AvailabilitySyncRunRow,
  AvailabilityTypeRow,
  AppSettings,
  Store,
} from "./store/types";
import type {
  AvailabilityAcuityState,
  AvailabilityConnection,
  AvailabilityPageFilters,
  AvailabilityRangeDay,
  AvailabilityRangeSummary,
  AvailabilitySlotAppointment,
  AvailabilitySlotStatus,
  AvailabilitySlotView,
  AvailabilityViewPayload,
  AvailabilityViewRequest,
} from "./page-data";

/** The view payload's heading label (pure). */
export function availabilityViewLabel(request: AvailabilityViewRequest): string {
  if (request.kind === "month") {
    const [y, m] = request.month.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(y, m - 1, 1)),
    );
  }
  if (request.kind === "days") {
    const endYear = request.to.slice(0, 4);
    const startYear = request.from.slice(0, 4);
    // the END always carries the year (a Dec→Jan window reads both); the start
    // drops it only inside the same year
    const endText = formatDateHumanFull(request.to);
    const startText = startYear === endYear ? formatDateHuman(request.from) : formatDateHumanFull(request.from);
    return `${startText} – ${endText}`;
  }
  return formatDateHumanFull(request.date);
}

/**
 * ONE range-view build. Two fetch waves total for ANY range size: the whole
 * range's appointments (bucketed per ET day — exactly the rows each per-day
 * overlap fetch would return, so the engine inputs are identical to the
 * legacy path), the range's blocked times (overlap-windowed; the engine
 * filters per day itself), and the feed cache (month index + per-date slots).
 */
export async function buildAvailabilityView(ctx: {
  store: Store;
  today: string;
  settings: AppSettings;
  rules: AvailabilityRule[];
  recurring: NonNullable<AppSettings["studio"]["recurring_blocks"]>;
  request: AvailabilityViewRequest;
}): Promise<AvailabilityViewPayload> {
  const { store, today, settings, rules, recurring, request } = ctx;
  const dates = availabilityViewDates(request);
  const first = dates[0];
  const last = dates[dates.length - 1];
  const slotIntervalMin = settings.studio.slot_interval_min;
  const durationMin = settings.studio.appointment_duration_min;
  const paddingMin = settings.studio.padding_min;

  // The coverage horizon is a GLOBAL fact (the booking template's end), so the
  // month index must include the feed's standing sweep window too — a visible
  // month alone would understate it (an October view would never see the
  // November row that ends the template at 11-01).
  const cacheMonths = [
    ...new Set([
      ...dates.map(monthKeyOf),
      ...Array.from({ length: AVAILABILITY_SWEEP_MONTHS_AHEAD + 1 }, (_, i) => addMonths(monthKeyOf(today), i)),
    ]),
  ];
  const [apptRows, blockedRows, cachedDates, cachedSlots] = await Promise.all([
    store.getAppointmentsOverlapping(etDayStartUtc(first), etDayEndUtc(last)),
    store.getBlockedTimesBetween(etDayStartUtc(first), etDayEndUtc(last)),
    store.getAvailabilityDates(cacheMonths),
    store.getAvailabilitySlotsForDates(dates),
  ]);

  // Appointments bucketed per ET day — exactly the per-day overlap fetches.
  const apptsByDate = new Map<string, AppointmentRow[]>();
  for (const d of dates) apptsByDate.set(d, []);
  for (const a of apptRows) {
    const d = etDateStrFromInstant(Date.parse(a.appointment_datetime));
    const list = apptsByDate.get(d);
    if (list) list.push(a);
  }

  // ---- feed cache mapping (PR-1 tables; the ONLY Acuity source here) ----
  const horizon = coverageHorizonFromCache(cachedDates, today);
  const coveredMonths = new Set(horizon.months.filter((m) => m.calendarCount > 0).map((m) => m.month));
  const openDatesByMonth = new Map<string, Set<string>>();
  const sweepDateByMonth = new Map<string, string>();
  for (const r of cachedDates) {
    const set = openDatesByMonth.get(r.month) ?? new Set<string>();
    for (const d of r.dates_et) set.add(d);
    openDatesByMonth.set(r.month, set);
    const prev = sweepDateByMonth.get(r.month);
    if (!prev || r.fetched_at > prev) sweepDateByMonth.set(r.month, r.fetched_at);
  }
  // Feed slots scoped by the EFFECTIVE scope (Settings scope ∩ the page-level
  // filter — PR-3 §3): id match, or name match via the calendar names the
  // range's own appointments carry. A calendar with no appointment rows cannot
  // be name-matched and is conservatively EXCLUDED when a name-typed scope is
  // set (never silently counted in).
  const pageFilters: AvailabilityPageFilters = request.filters;
  const scope = mergeAvailabilityPageScope(settings.acuity, pageFilters);
  const calNameById = new Map<string, string>();
  for (const a of apptRows) {
    if (a.calendar_id && a.calendar_name && !calNameById.has(a.calendar_id)) calNameById.set(a.calendar_id, a.calendar_name);
  }
  const calScope = scope.calendars_included ?? [];
  const feedCalInScope = (calendarId: string): boolean => {
    if (calScope.length === 0) return true;
    const name = calNameById.get(calendarId);
    return calScope.some((c) => c === calendarId || (name != null && c === name));
  };
  const feedTimesByDate = new Map<string, Set<string>>();
  for (const s of cachedSlots) {
    if (!feedCalInScope(s.calendar_id)) continue;
    const set = feedTimesByDate.get(s.date_et) ?? new Set<string>();
    set.add(s.time_et);
    feedTimesByDate.set(s.date_et, set);
  }
  const probedDates = new Set(cachedSlots.map((s) => s.date_et));
  const noFeedData = cachedDates.length === 0;

  // ---- per-day engine + slot classification ----
  const days: AvailabilityRangeDay[] = [];
  const slotsByDate = new Map<string, AvailabilitySlotView[]>();
  const offGridByDate = new Map<string, AvailabilitySlotAppointment[]>();
  let beyondHorizon = false;
  let hasUncoveredDays = false;
  let pendingProbeDays = 0;

  for (const date of dates) {
    const appts = apptsByDate.get(date) ?? [];
    const day = computeDayAvailability({
      date,
      rules,
      blocked: [...blockedRows, ...materializeRecurringBlocks(date, recurring)],
      appointments: appts,
      slotIntervalMin,
      durationMin,
      paddingMin,
      scope,
    });

    // ---- display-level interval build (mirrors the engine's apptReal/apptBuffer/blockBusy) ----
    const dayStartMs = new Date(etDayStartUtc(date)).getTime();
    const dayEndMs = new Date(etDayEndUtc(date)).getTime();
    const padMs = paddingMin * 60_000;
    interface Iv { start: number; end: number; a: AppointmentRow }
    const real: Iv[] = [];
    const cancelledRows: Iv[] = [];
    for (const a of appts) {
      const start = Date.parse(a.appointment_datetime);
      if (!Number.isFinite(start)) continue;
      const end = appointmentEndMs(a, durationMin);
      if (end == null) continue;
      if (end <= dayStartMs || start >= dayEndMs) continue;
      const isCancelled = a.cancelled || a.status === "cancelled";
      if (isCancelled) {
        cancelledRows.push({ start, end, a });
        continue;
      }
      if (!appointmentInScope(a, scope)) continue;
      real.push({ start, end, a });
    }
    const buffer: Iv[] = paddingMin > 0 ? real.map((iv) => ({ start: iv.start - padMs, end: iv.end + padMs, a: iv.a })) : [];
    const blockIvs: Array<{ start: number; end: number; reason: string | null }> = [];
    for (const b of [...blockedRows, ...materializeRecurringBlocks(date, recurring)]) {
      const start = new Date(b.start_at).getTime();
      const end = new Date(b.end_at).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= dayStartMs || start >= dayEndMs) continue;
      blockIvs.push({ start, end, reason: b.reason });
    }
    const overlapsSlot = (iv: { start: number; end: number }, slotStartMs: number, slotEndMs: number) =>
      iv.start < slotEndMs && iv.end > slotStartMs;

    // ---- coverage state for the day ----
    const month = monthKeyOf(date);
    const monthCovered = coveredMonths.has(month);
    const inDatesEt = openDatesByMonth.get(month)?.has(date) ?? false;
    const probed = probedDates.has(date);
    const sweepRaw = sweepDateByMonth.get(month);
    const sweepDateEt = sweepRaw ? etDateStrFromInstant(Date.parse(sweepRaw)) : null;
    let acuity: AvailabilityAcuityState;
    let feedPending = false;
    if (date < today) acuity = "past";
    else if (noFeedData) acuity = "estimated";
    else if (!monthCovered) acuity = "none";
    else if (horizon.lastOfferedDate != null && date > horizon.lastOfferedDate) acuity = "estimated";
    else if (inDatesEt && probed) acuity = "feed";
    else if (inDatesEt) {
      acuity = "feed";
      feedPending = true;
      pendingProbeDays += 1;
    } else if (sweepDateEt != null && date > sweepDateEt) acuity = "feed"; // feed-observed closed (a REAL 0 open)
    else acuity = "estimated"; // between today and the sweep snapshot — not observed yet
    const feedAuthoritative = acuity === "feed" && probed && !feedPending;
    const dayBeyondFlag = acuity === "estimated" && horizon.lastOfferedDate != null && date > horizon.lastOfferedDate;

    // ---- classify every engine slot ----
    const toApptView = (a: AppointmentRow): AvailabilitySlotAppointment => ({
      id: a.id,
      clientName: a.client_name ?? null,
      appointmentType: a.appointment_type,
      calendarName: a.calendar_name ?? null,
      cancelled: a.cancelled || a.status === "cancelled",
      cancelledAt: a.cancelled_at ?? null,
      paymentState: a.payment_state ?? null,
      durationMinutes: a.duration_minutes ?? null,
    });
    const slotViews: AvailabilitySlotView[] = [];
    const bookedTimes: string[] = [];
    const blockedSlotTimes: string[] = [];
    const feedSet = feedTimesByDate.get(date) ?? new Set<string>();
    // The day-level ESTIMATE reason (the honesty ladder — which schedule/feed
    // fact stands behind an unobserved slot). Booked slots carry it too: past
    // the horizon a BOOKED slot is still an engine estimate, and the label
    // must say so (PR-2 FIX 3 — booked rows rendered reasonless before).
    const dayEstimateReason =
      acuity === "feed" && feedPending
        ? "Acuity open times not probed yet — studio-schedule estimate"
        : acuity === "feed" && !inDatesEt
          ? "Not offered by the Acuity booking template"
          : dayBeyondFlag
            ? "Beyond the Acuity booking horizon — studio-schedule estimate"
            : acuity === "estimated"
              ? "Studio-schedule estimate (no Acuity availability data)"
              : acuity === "none"
                ? "No Acuity data for this month yet"
                : null;
    // A feed-offered time whose SLOT overlaps a booking's padding buffer
    // contradicts the engine's turnover model for THAT booking (Acuity happily
    // offers back-to-back slots there). Its buffer can then no longer honestly
    // explain a silent slot — the slot renders the candidate-block gray
    // (PR-2 FIX 3: an uncontradicted buffer keeps the turnover explanation).
    const feedSlotOverlapsBuffer = (bufStartMs: number, bufEndMs: number): boolean => {
      for (const t of feedSet) {
        const h = Number(t.slice(0, 2));
        const m = Number(t.slice(3, 5));
        if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
        const slotStartMs = dayStartMs + (h * 60 + m) * 60_000;
        if (slotStartMs < bufEndMs && slotStartMs + durationMin * 60_000 > bufStartMs) return true;
      }
      return false;
    };
    for (const label of day.slotTimes) {
      const minutes = slotLabelToMinutes(label);
      if (minutes == null) continue; // unclassifiable label — never guessed (the label round-trip is tested)
      const time = slotMinutesToTime(minutes);
      const slotStartMs = dayStartMs + minutes * 60_000;
      const slotEndMs = slotStartMs + durationMin * 60_000;
      const active = real
        .filter((iv) => overlapsSlot(iv, slotStartMs, slotEndMs))
        .sort((x, y) => x.start - y.start || x.a.id.localeCompare(y.a.id));
      const cancelledHere = cancelledRows.filter((iv) => overlapsSlot(iv, slotStartMs, slotEndMs));
      const blockHere = blockIvs.filter((b) => overlapsSlot(b, slotStartMs, slotEndMs));
      const bufferHere = buffer.filter((iv) => overlapsSlot(iv, slotStartMs, slotEndMs));
      const feedOffers = feedSet.has(time);
      let status: AvailabilitySlotStatus;
      let reason: string | null = null;
      let unexplained = false;
      let blocked = false;
      if (active.length > 0) {
        // Placeholder swap point for the pending_payment ruling: all-active-
        // pending slots render BOOKED-PENDING; mixed slots render BOOKED with
        // the pending row's own payment_state visible in its detail line.
        status = active.every((iv) => iv.a.payment_state === "pending_payment") ? "booked-pending" : "booked";
        bookedTimes.push(time);
        reason = dayEstimateReason; // a booked slot is still engine-estimated where no feed answer stands behind it
      } else if (blockHere.length > 0) {
        status = "blocked";
        blocked = true;
        blockedSlotTimes.push(time);
        reason = blockHere[0].reason ? `Blocked — ${blockHere[0].reason}` : "Blocked";
      } else if (feedAuthoritative) {
        if (feedOffers) {
          status = "open";
          if (bufferHere.length > 0) reason = "Offered by Acuity — the engine's turnover buffer flags it";
        } else if (bufferHere.length > 0 && bufferHere.some((iv) => feedSlotOverlapsBuffer(iv.start, iv.end))) {
          // Inside the horizon the feed answers per slot; a free grid slot it
          // does not offer — where the ONLY available explanation (the padding
          // buffer) is itself contradicted by the feed's own offers — is a
          // CANDIDATE block, rendered gray "unexplained", never claimed as
          // open or as a real block (the discrepancy detector flags the same
          // case as acuity-silent-but-open).
          status = "blocked";
          blocked = true;
          unexplained = true;
          blockedSlotTimes.push(time);
          reason = "Unexplained — not offered by Acuity (candidate block)";
        } else if (bufferHere.length > 0) {
          status = "blocked";
          blocked = true;
          blockedSlotTimes.push(time);
          reason = "Turnover buffer (studio padding)";
        } else {
          status = "blocked";
          blocked = true;
          unexplained = true;
          blockedSlotTimes.push(time);
          reason = "Unexplained — not offered by Acuity (candidate block)";
        }
      } else if (acuity === "feed" && !inDatesEt) {
        // OWNER-FLAGGED POLISH (PR-3 §5): a feed-observed CLOSED day — the
        // month sweep saw this date absent from the offered index. Empty grid
        // slots render CLOSED so the chips agree with the day's real 0 open
        // (they used to read OPEN with the "Not offered by the Acuity booking
        // template" reason while the day row said 0). A phone booking on such
        // a day still renders BOOKED (the booked branch hits first); the day's
        // hole count stays the LOCKED capacity − booked rule (feed-closed day
        // = all grid slots holes — the owner ruling PR-2 verified).
        status = "closed";
        reason = dayEstimateReason;
      } else {
        status = "open";
        reason = cancelledHere.length > 0 ? "Cancelled — the slot is free again" : dayEstimateReason;
      }
      slotViews.push({
        time,
        label,
        status,
        isHole: false, // filled below from the ONE hole derivation
        estimated: status === "closed" ? false : !feedAuthoritative, // a feed-observed CLOSED slot is not an estimate
        reason,
        unexplained,
        blocked,
        appointments: active.map((iv) => toApptView(iv.a)),
        cancelledAppointments: cancelledHere.map((iv) => toApptView(iv.a)),
        extraCount: Math.max(0, active.length - 1),
        offGrid: false,
      });
    }

    // ---- the ONE hole derivation (current rule placeholder; PR-3 swaps the body) ----
    const slotTimesHhmm = day.slotTimes.map(slotLabelToTime).filter((t): t is string => t != null);
    const hole = deriveAvailabilityHoles({ slotTimes: slotTimesHhmm, bookedTimes, blockedTimes: blockedSlotTimes });
    const holeSet = new Set(hole.holeSlots);
    for (const s of slotViews) {
      // BLOCKED rows render BLOCKED (never pushable) even when the day count
      // includes them — the current rule counts every empty grid slot; the
      // Holes stat's InfoTip explains the difference.
      s.isHole = holeSet.has(s.time) && (s.status === "open" || s.status === "cancelled");
    }

    // ---- off-grid active appointments (invisible to the slot grid — honest extra section) ----
    const offGrid: AvailabilitySlotAppointment[] = [];
    for (const iv of real) {
      const onGrid = day.slotTimes.some((label) => {
        const minutes = slotLabelToMinutes(label);
        if (minutes == null) return false;
        const slotStartMs = dayStartMs + minutes * 60_000;
        return iv.start < slotStartMs + durationMin * 60_000 && iv.end > slotStartMs;
      });
      if (!onGrid) offGrid.push(toApptView(iv.a));
    }

    // ---- off-grid feed times (extra OPEN rows after the grid, Day view) ----
    const gridTimes = new Set(slotViews.map((s) => s.time));
    const offGridFeed: AvailabilitySlotView[] = [...feedSet]
      .filter((t) => !gridTimes.has(t))
      .sort()
      .map((t) => ({
        time: t,
        label: slotTimeToLabel(t) ?? t,
        status: "open" as AvailabilitySlotStatus,
        isHole: false,
        estimated: false,
        reason: "Off-grid Acuity time (outside the generated studio grid)",
        unexplained: false,
        blocked: false,
        appointments: [] as AvailabilitySlotAppointment[],
        cancelledAppointments: [] as AvailabilitySlotAppointment[],
        extraCount: 0,
        offGrid: true,
      }));

    // ---- displayed open count + feed open labels ----
    let openCount: number | null;
    let feedOpenTimes: string[] | null = null;
    if (feedAuthoritative) {
      // Acuity-authoritative: the displayed open set is the feed answer minus
      // our known booked slots (belt-and-suspenders — a stale feed can never
      // show a booked slot as open; the raw disagreement stays in the
      // discrepancy list, never silently reconciled).
      feedOpenTimes = [...feedSet].filter((t) => !bookedTimes.includes(t)).sort();
      openCount = feedOpenTimes.length;
    } else if (acuity === "feed" && feedPending) {
      openCount = day.openSlotTimes.length;
    } else if (acuity === "feed") {
      openCount = 0; // feed-observed closed — a REAL zero, not a bare placeholder
    } else if (acuity === "none") {
      openCount = null; // honest "—" until the sweep covers the month
    } else {
      openCount = day.openSlotTimes.length;
    }

    if (acuity === "none") hasUncoveredDays = true;
    if (dayBeyondFlag) beyondHorizon = true;

    days.push({
      date,
      totalCapacity: day.totalCapacity,
      booked: day.booked,
      openCount,
      openSlotTimes: day.openSlotTimes,
      utilization: day.utilization,
      blockedCount: day.blockedCount,
      holes: hole.holes,
      acuity,
      feedOpenTimes,
      feedPending,
      beyondHorizon: dayBeyondFlag,
    });
    slotsByDate.set(date, [...slotViews, ...offGridFeed].sort((a, b) => a.time.localeCompare(b.time)));
    offGridByDate.set(date, offGrid);
  }

  // ---- range summary (dynamic top summary — recomputed for the selected range) ----
  let capacity = 0;
  let booked = 0;
  let open = 0;
  let holes = 0;
  let openKnown = true;
  for (const d of days) {
    capacity += d.totalCapacity;
    booked += d.booked;
    holes += d.holes;
    if (d.openCount == null) openKnown = false;
    else open += d.openCount;
  }

  const warnings: string[] = [];
  if (beyondHorizon) {
    warnings.push(
      horizon.lastOfferedDate
        ? `Beyond Acuity booking horizon (the booking template ends ${horizon.lastOfferedDate}) — capacity from the studio schedule; open times estimated (grid − booked).`
        : "Beyond Acuity booking horizon — capacity from the studio schedule; open times estimated (grid − booked).",
    );
  }
  if (noFeedData) {
    warnings.push("No Acuity availability data yet — showing studio-schedule estimates for every day.");
  } else if (hasUncoveredDays) {
    warnings.push(
      `No Acuity availability data for ${availabilityViewLabel(request)} yet — Open shows — until the availability feed covers it.`,
    );
  }
  if (pendingProbeDays > 0) {
    warnings.push(
      `Acuity open times not probed yet for ${pendingProbeDays} day${pendingProbeDays === 1 ? "" : "s"} — showing studio-schedule estimates until the probe lands.`,
    );
  }

  const summary: AvailabilityRangeSummary = {
    capacity,
    booked,
    open,
    holes,
    utilization: capacity > 0 ? booked / capacity : null,
    openKnown,
  };

  return {
    kind: request.kind,
    month: request.month,
    from: request.from,
    to: request.to,
    date: request.date,
    label: availabilityViewLabel(request),
    dates,
    days,
    summary,
    slots:
      request.kind === "day"
        ? filterDaySlotsByStatuses(slotsByDate.get(request.date) ?? [], request.filters.statuses)
        : null,
    offGridAppointments: request.kind === "day" ? offGridByDate.get(request.date) ?? [] : [],
    coverage: {
      horizonDate: horizon.lastOfferedDate,
      months: horizon.months,
      coveredMonths: [...coveredMonths].sort(),
      noFeedData,
    },
    beyondHorizon,
    hasUncoveredDays,
    warnings,
  };
}

/**
 * The ET dates a view request displays (month → its calendar dates; days → the window; day → itself). PURE.
 */
export function availabilityViewDates(request: AvailabilityViewRequest): string[] {
  if (request.kind === "month") return monthDates(request.month);
  if (request.kind === "days") return dateRange(request.from, request.to);
  return [request.date];
}

/** The rolling 14-day window label for a given ET today (the Day view's push range). */
export function fourteenDayWindowLabel(today: string): string {
  return availabilityViewLabel({ kind: "days", month: "", from: today, to: addDays(today, 13), date: "", filters: { calendars: [], types: [], statuses: [] } });
}

// ---------- PR-3 §3 helpers: page scope merge + status filter ----------

/**
 * The page-level calendar/type filter merged INTO the Settings scope (the
 * established machinery: `appointmentInScope` + the engine's `scope` input).
 * Page filter EMPTY = everything in scope (the Settings selection alone).
 * Both non-empty = intersection (the page can only NARROW what Settings
 * includes — it can never widen past Settings). Settings stores type NAMES
 * (the machinery compares `appointment_type`), so the page filter carries
 * names too; calendar values match id or name like the machinery does.
 */
export function mergeAvailabilityPageScope(
  settingsScope: AppSettings["acuity"],
  pageFilters: AvailabilityPageFilters,
): AppSettings["acuity"] {
  const narrow = (settingsList: string[] | undefined, page: string[]): string[] => {
    const s = settingsList ?? [];
    if (page.length === 0) return [...s];
    if (s.length === 0) return [...page];
    return s.filter((x) => page.includes(x));
  };
  return {
    ...settingsScope,
    calendars_included: narrow(settingsScope.calendars_included, pageFilters.calendars),
    types_included: narrow(settingsScope.types_included, pageFilters.types),
  };
}

/**
 * Day-view slot-list filter for the status toggles (Booked / Open / Holes /
 * Cancelled / Blocked). Day COUNTS are untouched — this narrows only which
 * slot rows render. Empty = everything. Tokens:
 *   booked    → status booked OR booked-pending (the pending placeholder)
 *   open      → status open (hole membership is a separate toggle)
 *   holes     → the ONE derivation flags the slot (OPEN · HOLE)
 *   cancelled → the slot carries struck-through cancelled rows
 *   blocked   → dashboard/recurring blocks, turnover buffer, or the honest
 *               gray "unexplained — candidate block"
 */
export function filterDaySlotsByStatuses(slots: AvailabilitySlotView[], statuses: string[]): AvailabilitySlotView[] {
  if (statuses.length === 0) return slots;
  const set = new Set(statuses);
  return slots.filter((s) => {
    if (set.has("booked") && (s.status === "booked" || s.status === "booked-pending")) return true;
    if (set.has("open") && s.status === "open") return true;
    if (set.has("holes") && s.isHole) return true;
    if (set.has("cancelled") && (s.cancelledAppointments.length > 0 || s.status === "cancelled")) return true;
    if (set.has("blocked") && s.status === "blocked") return true;
    return false;
  });
}

// ---------- PR-3 §3: filter option enumeration (from the CACHED catalog) ----------

/** The availability page's filter options, enumerated from the cached Acuity catalog. */
export interface AvailabilityFilterOptions {
  calendars: Array<{ id: string; name: string }>;
  /** ALL cached types with their REAL calendar bindings (the UI narrows by selected calendar). */
  types: Array<{ id: string; name: string; calendarIds: string[] }>;
  /** Valid (calendarId, typeId) pairs straight from the API's calendarIDs — never guessed. */
  validPairs: Array<{ calendarId: string; typeId: string }>;
  /** The catalog fetch stamp; null = nothing cached yet (options render honestly empty). */
  fetchedAt: string | null;
}

/**
 * Enumerate filter options from the cached /calendars + /appointment-types
 * rows. The binding comes ONLY from the API's calendarIDs (§1.2: a type×
 * calendar pair that doesn't match answers 400 invalid_calendar — offering a
 * guessed pair would hand the user a guaranteed error). Annex/Zoom still
 * enumerate even with zero appointments ever: the filter lists what Acuity
 * HAS, not what bookings exist.
 */
export function availabilityFilterOptions(catalog: {
  calendars: AvailabilityCalendarRow[];
  types: AvailabilityTypeRow[];
}): AvailabilityFilterOptions {
  const fetchedAt =
    [...catalog.calendars.map((c) => c.fetched_at), ...catalog.types.map((t) => t.fetched_at)].sort().at(-1) ?? null;
  return {
    calendars: catalog.calendars
      .filter((c) => c.calendar_id !== "")
      .map((c) => ({ id: c.calendar_id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    types: catalog.types
      .filter((t) => t.appointment_type_id !== "")
      .map((t) => ({ id: t.appointment_type_id, name: t.name, calendarIds: [...t.calendar_ids].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    validPairs: catalog.types.flatMap((t) =>
      [...t.calendar_ids].sort().map((calendarId) => ({ calendarId, typeId: t.appointment_type_id })),
    ),
    fetchedAt,
  };
}

// ---------- PR-3 §4: the sync-panel payload ----------

/** The availability page's sync panel: both sync rows, the horizon, the discrepancy list. */
export interface AvailabilitySyncPanel {
  connected: boolean;
  mode: "live" | "demo" | "disconnected";
  /** The appointment-sync row (integration_connections acuity) — last successful sync. */
  appointmentLastSyncAt: string | null;
  appointmentStale: boolean;
  /** The availability-feed detailed run rows, newest first (the feed's own audit). */
  feedRuns: Array<{
    status: string;
    trigger: string | null;
    startedAt: string;
    finishedAt: string | null;
    callsMade: number | null;
    error: string | null;
  }>;
  /** Last SUCCESSFUL availability-feed run finish (null = the feed never succeeded). */
  feedLastSuccessAt: string | null;
  /** "Acuity booking template ends {date}" — null when nothing is cached. */
  coverageHorizonDate: string | null;
  noFeedData: boolean;
  discrepancies: {
    /** UNRESOLVED count (resolved rows drop off via the existing resolved_at machinery). */
    count: number;
    rows: Array<{
      calendarId: string;
      dateEt: string;
      timeEt: string;
      kind: string;
      /** The feed's side: "open" | "silent". */
      acuitySide: string;
      /** The booked side: the non-cancelled appointments occupying the slot. */
      bookedCount: number;
      booked: Array<{ client: string | null; type: string | null; createdAt: string | null }>;
      grid: string;
      detectedAt: string;
    }>;
  };
}

/** Compose the sync-panel payload from the connection + feed runs + unresolved discrepancies. */
export function composeAvailabilitySync(input: {
  connection: AvailabilityConnection;
  feedRuns: AvailabilitySyncRunRow[];
  discrepancies: AvailabilityDiscrepancyRow[];
  coverageHorizonDate: string | null;
  noFeedData: boolean;
}): AvailabilitySyncPanel {
  const runs = input.feedRuns.slice(0, 10).map((r) => ({
    status: r.status,
    trigger: typeof r.scope?.trigger === "string" ? (r.scope.trigger as string) : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    callsMade: r.calls_made,
    error: r.error,
  }));
  const lastSuccess = input.feedRuns.find((r) => r.status === "success")?.finished_at ?? null;
  const rows = input.discrepancies.map((d) => {
    const detail = d.detail ?? {};
    const bookedList = Array.isArray(detail.booked) ? (detail.booked as Array<Record<string, unknown>>) : [];
    return {
      calendarId: d.calendar_id,
      dateEt: d.date_et,
      timeEt: d.time_et,
      kind: d.kind,
      acuitySide: typeof detail.acuity === "string" ? detail.acuity : "unknown",
      bookedCount: bookedList.length,
      booked: bookedList.map((b) => ({
        client: typeof b.client_name === "string" ? b.client_name : null,
        type: typeof b.appointment_type === "string" ? b.appointment_type : null,
        createdAt: typeof b.created_at === "string" ? b.created_at : null,
      })),
      grid: typeof detail.grid === "string" ? detail.grid : "canonical",
      detectedAt: d.detected_at,
    };
  });
  return {
    connected: input.connection.connected,
    mode: input.connection.mode,
    appointmentLastSyncAt: input.connection.lastSyncAt,
    appointmentStale: input.connection.stale,
    feedRuns: runs,
    feedLastSuccessAt: lastSuccess,
    coverageHorizonDate: input.coverageHorizonDate,
    noFeedData: input.noFeedData,
    discrepancies: { count: input.discrepancies.length, rows },
  };
}

