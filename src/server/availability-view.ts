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
import { coverageHorizonFromCache, deriveAvailabilityHoles, monthDates } from "./sync/availability-feed";
import type { AppSettings, Store } from "./store/types";
import type {
  AvailabilityAcuityState,
  AvailabilityRangeDay,
  AvailabilityRangeSummary,
  AvailabilitySlotAppointment,
  AvailabilitySlotStatus,
  AvailabilitySlotView,
  AvailabilityViewPayload,
  AvailabilityViewRequest,
} from "./page-data";

/** The view payload's heading label (pure). */
function availabilityViewLabel(request: AvailabilityViewRequest): string {
  if (request.kind === "month") {
    const [y, m] = request.month.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(y, m - 1, 1)),
    );
  }
  if (request.kind === "days") {
    const endYear = request.to.slice(0, 4);
    const startYear = request.from.slice(0, 4);
    const endText = formatDateHuman(request.to);
    const startText =
      startYear === endYear
        ? formatDateHuman(request.from).replace(`, ${startYear}`, "")
        : formatDateHuman(request.from);
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

  const [apptRows, blockedRows, cachedDates, cachedSlots] = await Promise.all([
    store.getAppointmentsOverlapping(etDayStartUtc(first), etDayEndUtc(last)),
    store.getBlockedTimesBetween(etDayStartUtc(first), etDayEndUtc(last)),
    store.getAvailabilityDates([...new Set(dates.map(monthKeyOf))]),
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
  // Feed slots scoped by Settings calendars: id match, or name match via the
  // calendar names the range's own appointments carry. A calendar with no
  // appointment rows cannot be name-matched and is conservatively EXCLUDED
  // when a name-typed scope is set (never silently counted in).
  const calNameById = new Map<string, string>();
  for (const a of apptRows) {
    if (a.calendar_id && a.calendar_name && !calNameById.has(a.calendar_id)) calNameById.set(a.calendar_id, a.calendar_name);
  }
  const calScope = settings.acuity.calendars_included ?? [];
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
      scope: settings.acuity,
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
      if (!appointmentInScope(a, settings.acuity)) continue;
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
      } else if (blockHere.length > 0) {
        status = "blocked";
        blocked = true;
        blockedSlotTimes.push(time);
        reason = blockHere[0].reason ? `Blocked — ${blockHere[0].reason}` : "Blocked";
      } else if (feedAuthoritative) {
        if (feedOffers) {
          status = "open";
          if (bufferHere.length > 0) reason = "Offered by Acuity — the engine's turnover buffer flags it";
        } else if (bufferHere.length > 0) {
          status = "blocked";
          blocked = true;
          blockedSlotTimes.push(time);
          reason = "Turnover buffer (studio padding)";
        } else {
          // Inside the horizon the feed answers per slot; a free grid slot it
          // does not offer is a CANDIDATE block — rendered gray "unexplained",
          // never claimed as open or as a real block (the discrepancy detector
          // flags the same case as acuity-silent-but-open).
          status = "blocked";
          blocked = true;
          unexplained = true;
          blockedSlotTimes.push(time);
          reason = "Unexplained — not offered by Acuity (candidate block)";
        }
      } else {
        status = "open";
        reason = cancelledHere.length > 0
          ? "Cancelled — the slot is free again"
          : acuity === "feed" && feedPending
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
      }
      slotViews.push({
        time,
        label,
        status,
        isHole: false, // filled below from the ONE hole derivation
        estimated: !feedAuthoritative,
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
    slots: request.kind === "day" ? slotsByDate.get(request.date) ?? [] : null,
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

/** The ET dates a view request displays (month → its calendar dates; days → the window; day → itself). PURE. */
export function availabilityViewDates(request: AvailabilityViewRequest): string[] {
  if (request.kind === "month") return monthDates(request.month);
  if (request.kind === "days") return dateRange(request.from, request.to);
  return [request.date];
}

