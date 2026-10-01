import { createFileRoute } from "@tanstack/react-router";
import { WarningList } from "~/components/warnings";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { getRepsData } from "~/server/queries";
import {
  RANGE_LABELS,
  RANGE_MODES,
  addDays,
  formatDateHuman,
  isHistoricalWeek,
  recentMondays,
  weekStart,
  weekdayName,
  type RangeMode,
} from "~/server/date-logic";
import { assignedLeadsCsv, type AssignedByDayCell } from "~/server/metrics/assigned-by-day";
import {
  formatCount,
  formatDiff,
  formatDuration,
  formatInt,
  formatPercent,
} from "~/server/metrics/report-text";
import type { ComparisonUnit } from "~/server/metrics/compute";
import { Segmented, WeekOfSelect } from "~/components/Segmented";
import { InfoTip } from "~/components/InfoTip";
import { StatusChip } from "~/components/StatusChip";
import {
  coachingObservations,
  goalProgress,
  type CoachingObservation,
} from "~/components/reps-views";
import {
  diffSampleDenominator,
  restrainedDiff,
  SMALL_SAMPLE_FOOTNOTE,
} from "~/components/team-views";

export const Route = createFileRoute("/reps")({
  validateSearch: (search: Record<string, unknown>) => ({
    rep: typeof search.rep === "string" ? search.rep : undefined,
    range: typeof search.range === "string" ? search.range : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
    week: typeof search.week === "string" ? search.week : undefined,
  }),
  loaderDeps: ({ search }) => ({
    rep: search.rep,
    range: search.range,
    from: search.from,
    to: search.to,
    week: search.week,
  }),
  loader: ({ deps }) => getRepsData({ data: deps }),
  component: RepsPage,
});

/** Null renders "—" in stone-300 (never 0) — same rule as the Today page. */
function num(v: string) {
  return v === "—" ? <span className="text-(--text-faint)">—</span> : v;
}

/** Rep value in the comparison table: counts whole, rates 1-dp %, durations m/s. */
function repCompareValue(v: number | null, unit: ComparisonUnit): string {
  if (v == null) return "—";
  if (unit === "pp") return formatPercent(v, 1);
  if (unit === "seconds") return formatDuration(v);
  return formatInt(v);
}

/**
 * Team-average column (spec precision fix): counts keep the decimal that
 * explains the difference (5.6, not 6 next to +78.6%); rates 1 decimal.
 */
function teamCompareValue(v: number | null, unit: ComparisonUnit): string {
  if (v == null) return "—";
  if (unit === "pp") return formatPercent(v, 1);
  if (unit === "seconds") return formatDuration(v);
  return formatCount(v);
}

const plural = (n: number, word: string) => `${formatInt(n)} ${Math.round(n) === 1 ? word : `${word}s`}`;

/** Week-scoped goal figures the page feeds to the goal block + coaching rules. */
interface WeekGoal {
  wtd: number;
  goalValue: number | null;
  label: string;
  sub: string | null;
  anchorDay: string;
}

type SortKey = "metric" | "rep" | "teamAvg" | "diff";

function RepsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const search = Route.useSearch();
  const d = data.detail;

  const [customFrom, setCustomFrom] = useState(search.from ?? "");
  const [customTo, setCustomTo] = useState(search.to ?? "");
  const [sortKey, setSortKey] = useState<SortKey>("metric");
  const [sortAsc, setSortAsc] = useState(true);

  const setRange = (mode: RangeMode) => {
    // week-of needs a Monday anchor (same rule as the Team page): stay on the
    // viewed week when it is historical, otherwise default to LAST week — a
    // historical picker whose default were the current week would show a live
    // week under a historical label. The dropdown refines it afterwards.
    const viewedWeekOf = weekStart(data.range.start);
    const defaultWeekOf = addDays(weekStart(data.today), -7);
    const weekAnchor = isHistoricalWeek(data.range.mode, data.range.start, data.today) ? viewedWeekOf : defaultWeekOf;
    router.navigate({
      to: "/reps",
      search: (prev) => ({
        rep: prev.rep,
        range: mode,
        from: mode === "custom" ? (customFrom || undefined) : mode === "week-of" ? weekAnchor : undefined,
        to: mode === "custom" ? (customTo || undefined) : undefined,
      }),
    });
  };
  const setWeekOf = (monday: string) => {
    router.navigate({
      to: "/reps",
      search: (prev) => ({
        rep: prev.rep,
        range: "week-of" as RangeMode,
        from: monday,
        to: undefined,
      }),
    });
  };

  const applyCustom = () => {
    router.navigate({
      to: "/reps",
      search: (prev) => ({
        rep: prev.rep,
        range: "custom" as const,
        from: customFrom || undefined,
        to: customTo || undefined,
      }),
    });
  };

  // ASSIGNED LEADS BY DAY: its own Mon–Sun week — navigations elsewhere on the
  // page keep it, and changing it keeps every other filter.
  const setAssignedWeek = (monday: string) => {
    router.navigate({
      to: "/reps",
      search: (prev) => ({ ...prev, week: monday }),
    });
  };

  const downloadAssignedCsv = () => {
    const grid = data.assignedByDay;
    if (!grid) return;
    const blob = new Blob([assignedLeadsCsv(grid)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `assigned-leads-${grid.week_start}-to-${grid.week_end}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const selectRep = (id: string) => {
    router.navigate({
      to: "/reps",
      search: (prev) => ({ rep: id, range: prev.range, from: prev.from, to: prev.to }),
    });
  };

  // ---------- WEEKLY GOAL PROGRESS source (spec: goal progress is ALWAYS
  // week-scoped — WTD vs the weekly goal, never the selected day ÷ week) ----
  // "This Week" already IS week-to-date (Mon..today) and "Last Week" is a
  // full week, so those (and multi-week ranges, whose weekly goals sum) come
  // straight from the payload. A SINGLE-DAY range fetches the same server
  // query scoped Mon..viewed-day — every number is still computed by the
  // metrics layer (getRepsData), nothing is recomputed in the component.
  const singleDay = data.range.start === data.range.end;
  const weekScoped = singleDay || data.range.mode === "this-week" || data.range.mode === "last-week";
  const weekOf = weekStart(data.range.start);

  let goalFromPayload: WeekGoal | null = null;
  if (!singleDay && d) {
    const isThisWeek = data.range.mode === "this-week";
    const isLastWeek = data.range.mode === "last-week";
    goalFromPayload = {
      wtd: d.actual,
      goalValue: d.goal?.value ?? null,
      label: isThisWeek ? "Bookings WTD" : isLastWeek ? "Bookings Last Week" : "Bookings in Range",
      sub: isThisWeek
        ? `week of ${formatDateHuman(weekOf)}`
        : `through ${formatDateHuman(data.range.end)}`,
      anchorDay: data.range.end <= data.today ? data.range.end : data.today,
    };
  }

  const [weekGoal, setWeekGoal] = useState<WeekGoal | null>(null);
  const fetchKey = singleDay && d ? `${d.rep.id}|${weekOf}|${data.range.start}` : null;
  useEffect(() => {
    if (!fetchKey) return;
    const repId = data.detail?.rep.id;
    if (!repId) return;
    let alive = true;
    setWeekGoal(null);
    getRepsData({
      data: { rep: repId, range: "custom", from: weekOf, to: data.range.start },
    })
      .then((res) => {
        if (!alive) return;
        const det = res.detail;
        setWeekGoal(
          det
            ? {
                wtd: det.actual,
                goalValue: det.goal?.value ?? null,
                label: "Bookings WTD",
                sub:
                  data.range.mode === "today"
                    ? `week of ${formatDateHuman(weekOf)}`
                    : `week of ${formatDateHuman(weekOf)} · through ${formatDateHuman(data.range.start)}`,
                anchorDay: data.range.start,
              }
            : null,
        );
      })
      .catch(() => {
        if (alive) setWeekGoal(null);
      });
    return () => {
      alive = false;
    };
    // key on fetchKey — it already encodes rep + week + viewed day
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey]);

  const goalViewRaw = singleDay ? weekGoal : goalFromPayload;
  const gp = goalViewRaw ? goalProgress({ wtd: goalViewRaw.wtd, goalValue: goalViewRaw.goalValue }) : null;
  const goalHit = gp?.achievement != null && gp.achievement >= 1;
  const barPct = gp?.achievement != null ? Math.min(gp.achievement, 1) * 100 : null;

  // ---------- Coaching Focus (rule-based, max 3) ----------
  const conversationOthers = data.repList.filter((r) => !r.isSelected && r.callsOverThreshold > 0).length;
  const observations: CoachingObservation[] = d
    ? coachingObservations({
        repName: d.rep.name,
        totalCalls: d.metrics.totalCalls,
        callsOverThreshold: d.metrics.callsOverThreshold,
        totalBookings: d.metrics.totalBookings,
        assignedLeads: d.metrics.assignedLeads,
        comparisons: data.comparisons,
        teamAverages: {
          totalCalls: data.teamAverages.totalCalls,
          callsOverThreshold: data.teamAverages.callsOverThreshold,
          conversationConversion: data.teamAverages.conversationConversion,
          assignedLeadConversion: data.teamAverages.assignedLeadConversion,
        },
        conversationOthers,
        // pace is a weekly notion — multi-week ranges skip the pace rule
        goal:
          weekScoped && goalViewRaw && goalViewRaw.goalValue
            ? { wtd: goalViewRaw.wtd, goalValue: goalViewRaw.goalValue, anchorDay: goalViewRaw.anchorDay }
            : null,
        today: data.today,
        // Not Yet Active reps get NO coaching verdicts (owner spec)
        operatingState: data.selectedOperatingState,
      })
    : [];

  // ---------- sortable comparison table (native, no deps) ----------
  const sortedComparisons = useMemo(() => {
    const canonical = new Map(data.comparisons.map((c, i) => [c.metric, i] as const));
    const rows = [...data.comparisons];
    rows.sort((a, b) => {
      if (sortKey === "metric") {
        return (canonical.get(a.metric)! - canonical.get(b.metric)!) * (sortAsc ? 1 : -1);
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // missing data sorts last, never as zero
      if (bv == null) return -1;
      return (av - bv) * (sortAsc ? 1 : -1);
    });
    return rows;
  }, [data.comparisons, sortKey, sortAsc]);

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(key === "metric");
    }
  };

  const th = (key: SortKey, label: string, opts?: { left?: boolean; stickyLeft?: boolean }) => {
    const active = sortKey === key;
    const caret = active ? (sortAsc ? "↑" : "↓") : key === "metric" ? "↑" : "↓";
    return (
      <th
        scope="col"
        aria-sort={active ? (sortAsc ? "ascending" : "descending") : undefined}
        className={
          (opts?.stickyLeft ? "sticky left-0 z-[2] bg-(--card-bg) " : "") +
          (opts?.left ? "text-left" : "text-right")
        }
      >
        <button type="button" className="th-sort-btn" onClick={() => sortBy(key)}>
          {label}
          <span aria-hidden="true" className={active ? "text-(--text-primary)" : "text-(--text-muted)"}>
            {caret}
          </span>
        </button>
      </th>
    );
  };

  const rangeCaption = `${data.range.label} · ${
    singleDay
      ? formatDateHuman(data.range.start)
      : `${formatDateHuman(data.range.start)} – ${formatDateHuman(data.range.end)}`
  } · America/New_York`;

  return (
    <div className="space-y-4">
      {/* header — matches the Today page: title — subtitle, context line, honesty banner */}
      <header>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className="text-xl font-semibold tracking-tight text-(--text-primary)">Reps</h1>
          <span className="text-[15px] font-medium text-(--text-faint)" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-(--text-caption)">Individual Rep Performance</span>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-(--text-caption)">
          <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
          <span>{rangeCaption}</span>
          {/* live-state indicator (owner hard rule): live vs historical is never ambiguous */}
          {data.range.isCurrentWeek ? (
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-(--chip-positive-bg) bg-(--chip-positive-bg) px-2 py-0.5 font-semibold text-(--pos-text)">
              <span className="h-1.5 w-1.5 rounded-full bg-(--dot-positive)" aria-hidden="true" />
              Current Week
            </span>
          ) : (
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-(--chip-risk-bg) bg-(--chip-risk-bg) px-2 py-0.5 font-semibold text-(--banner-fg)">
              <span className="h-1.5 w-1.5 rounded-full bg-(--dot-caution)" aria-hidden="true" />
              Historical · {data.range.label}
            </span>
          )}
        </p>
        {data.meta.mode === "memory" && (
          <div className="status-banner mt-2" role="status">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
            <span className="min-w-0 truncate">
              Demo data (in-memory) — database not connected
              {data.meta.dbReason ? `: ${data.meta.dbReason}` : ""}.
            </span>
          </div>
        )}
      </header>

      {/* missing-data warnings — never a plausible number */}
      <WarningList items={data.warnings} />

      {/* date range — compact segmented filter control (spec) */}
      <section aria-label="Date range" className="flex flex-wrap items-center gap-3">
        <Segmented
          ariaLabel="Date range"
          options={RANGE_MODES.map((m) => ({ value: m, label: RANGE_LABELS[m] }))}
          value={data.range.mode}
          onChange={(m) => setRange(m)}
        />
        {data.range.mode === "week-of" && (
          <WeekOfSelect
            mondays={recentMondays(data.today, 8)}
            value={weekStart(data.range.start)}
            onChange={(monday) => setWeekOf(monday)}
          />
        )}
        {data.range.mode === "custom" && (
          <span className="flex items-center gap-2 text-[13px] text-(--text-caption)">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-(--card-border) bg-(--card-bg) px-2 py-1.5 text-[13px] text-(--text-primary) outline-none focus:border-(--input-focus-border)"
              aria-label="From date"
            />
            <span>–</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-(--card-border) bg-(--card-bg) px-2 py-1.5 text-[13px] text-(--text-primary) outline-none focus:border-(--input-focus-border)"
              aria-label="To date"
            />
            <button
              type="button"
              onClick={applyCustom}
              className="rounded-lg bg-(--accent-solid) px-3 py-1.5 font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover)"
            >
              Apply
            </button>
          </span>
        )}
      </section>

      {/* main: rep selector (left) + selected rep performance (right) */}
      <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside aria-label="Rep selector">
          <p className="section-heading mb-2">Reps</p>
          <div className="card p-0">
            <div className="flex gap-2 overflow-x-auto p-2 lg:block lg:space-y-0 lg:overflow-visible lg:p-0 lg:divide-y lg:divide-(--table-border-weak)">
              {data.repList.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => selectRep(r.id)}
                  aria-pressed={r.isSelected}
                  className={
                    "block w-full min-w-[190px] shrink-0 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) lg:min-w-0 lg:rounded-none " +
                    (r.isSelected ? "bg-(--surface-selected)" : "hover:bg-(--surface-hover)")
                  }
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        "h-1.5 w-1.5 shrink-0 rounded-full " +
                        (r.isSelected ? "bg-(--accent-solid)" : "bg-(--dot-muted)")
                      }
                      aria-hidden="true"
                    />
                    <span
                      className={
                        "truncate text-[13px] " + (r.isSelected ? "font-semibold text-(--text-primary)" : "font-medium text-(--text-body)")
                      }
                    >
                      {r.name}
                    </span>
                  </span>
                  <span
                    className={
                      "mt-0.5 block pl-3.5 text-xs tabular-nums " +
                      (r.isSelected ? "text-(--text-caption)" : "text-(--text-muted)")
                    }
                  >
                    {r.operatingState === "not-yet-active" ? (
                      <span className="font-medium normal-case tabular-nums">Not Yet Active · </span>
                    ) : null}
                    {plural(r.totalBookings, "booking")} · {plural(r.totalCalls, "call")}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-(--text-muted)">Bookings · calls in the selected range.</p>

          {/* CALL-OWNERSHIP BUCKETS (design/data-terminology.md — three, mutually
              exclusive). "Non Roster Calls" = a KNOWN HL user outside the CC
              roster; "Unattributed" = ONLY rows with no determinable owner.
              Both stay visible here and are EXCLUDED from every roster/team
              total; mapping a user (Settings) moves them into roster math at
              query time without touching any source record. */}
          {data.nonRoster && (
            <div className="mt-4">
              <p className="section-heading mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                Non Roster Calls
                <InfoTip
                  tip="Calls from valid HighLevel users outside the CC roster. Fully visible and auditable but excluded from CC rep metrics, team metrics, conversions, goal progress and coaching logic — unless the user is mapped to the roster in Settings → Roster Mapping. Raw rows: Audit page → Non Roster Calls."
                  label="What Non Roster Calls means"
                />
              </p>
              <div className="card p-3">
                {data.nonRoster.users.length === 0 ? (
                  <p className="text-[12px] text-(--text-caption)">No non-roster calls in this window.</p>
                ) : (
                  <ul className="divide-y divide-(--table-border-weak)">
                    {data.nonRoster.users.map((u) => (
                      <li key={u.key} className="flex items-baseline justify-between gap-2 py-1.5 first:pt-0 last:pb-0">
                        <span className="min-w-0 truncate text-[12px] font-medium text-(--text-body)" title={u.key}>
                          {u.name ?? u.key}
                        </span>
                        <span className="shrink-0 tabular-nums text-[12px] text-(--text-caption)">
                          {formatInt(u.calls)} call{u.calls === 1 ? "" : "s"} ·{" "}
                          {formatInt(u.overThreshold)} &gt;{data.thresholdSeconds}s
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {data.nonRoster.totalCalls > 0 && (
                  <p className="mt-2 border-t border-(--table-border-weak) pt-2 text-xs tabular-nums text-(--text-caption)">
                    Total: {formatInt(data.nonRoster.totalCalls)} calls ·{" "}
                    {formatInt(data.nonRoster.totalOverThreshold)} over threshold — excluded from roster and team
                    totals.
                  </p>
                )}
              </div>
            </div>
          )}

          {data.unattributed && (
            <div className="mt-4">
              <p className="section-heading mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                Unattributed
                <InfoTip
                  tip="Reserved EXCLUSIVELY for call records whose ownership genuinely cannot be determined (no HighLevel user id). Never used for non-roster users; excluded from every roster and team total."
                  label="What Unattributed means"
                />
              </p>
              <div className="card p-3">
                {data.unattributed.totalCalls === 0 ? (
                  <p className="text-[12px] text-(--text-caption)">No unattributed calls in this window.</p>
                ) : (
                  <p className="text-[12px] tabular-nums text-(--text-body)">
                    {formatInt(data.unattributed.totalCalls)} call{data.unattributed.totalCalls === 1 ? "" : "s"} ·{" "}
                    {formatInt(data.unattributed.totalOverThreshold)} &gt;{data.thresholdSeconds}s
                  </p>
                )}
              </div>
            </div>
          )}
        </aside>

        {d ? (
          <div className="min-w-0 space-y-4">
            {/* summary header */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="flex items-center gap-2 text-[15px] font-semibold text-(--text-primary)">
                {d.rep.name} — {RANGE_LABELS[data.range.mode]} performance
                {data.selectedOperatingState === "not-yet-active" && (
                  <StatusChip kind="neutral" label="Not Yet Active" />
                )}
              </p>
            </div>
            {data.selectedOperatingState === "not-yet-active" && (
              <p className="text-xs text-(--text-caption)">
                {d.rep.name} is rostered but begins calling{" "}
                {d.rep.call_start_date ? formatDateHuman(d.rep.call_start_date) : "on their start date"}. Zero calls
                are expected before then — no performance flags apply, and normal monitoring begins that day.
              </p>
            )}

            {/* PRIMARY PERFORMANCE METRICS (spec: stronger typography) */}
            <section className="card" aria-label="Primary performance metrics">
              <div className="grid grid-cols-1 gap-y-6 sm:grid-cols-3 sm:gap-y-0 sm:divide-x sm:divide-(--table-border-weak)">
                <div className="sm:pr-6">
                  <p className="kpi-label flex items-center gap-1.5">
                    Total Bookings
                    <InfoTip tip="Non-cancelled bookings, counted by created date" label="How Total Bookings is counted" />
                  </p>
                  <p className="kpi-hero mt-2">{formatInt(d.metrics.totalBookings)}</p>
                </div>
                <div className="sm:px-6">
                  <p className="kpi-label flex items-center gap-1.5">
                    Conversation Conversion
                    <InfoTip
                      tip={`Bookings ÷ calls over ${data.thresholdSeconds}s (the meaningful-call threshold, set in Settings → Operational Rules)`}
                      label="How Conversation Conversion is calculated"
                    />
                  </p>
                  <p className="kpi-hero mt-2">{num(formatPercent(d.metrics.conversationConversion, 1))}</p>
                </div>
                <div className="sm:pl-6">
                  <p className="kpi-label">Assigned Lead Conversion</p>
                  <p className="kpi-hero mt-2">{num(formatPercent(d.metrics.assignedLeadConversion, 1))}</p>
                  <p className="kpi-sub mt-1.5">{plural(d.metrics.assignedLeads, "assigned lead")}</p>
                </div>
              </div>

              <hr className="my-4 border-(--table-border-weak)" />

              {/* WEEKLY GOAL PROGRESS — always WTD vs the weekly goal (spec) */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5">
                  <p className="section-heading">{weekScoped ? "Weekly Goal Progress" : "Goal Progress"}</p>
                  {d.goal?.note && (
                    <InfoTip tip={d.goal.note} label="Where this week's goal comes from" />
                  )}
                </span>
              </div>
              {gp && goalViewRaw ? (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                    <div>
                      <p className="kpi-label">{goalViewRaw.label}</p>
                      <p className="kpi-hero mt-2">
                        {formatInt(gp.wtd)}
                        {gp.goal != null && (
                          <span className="text-2xl font-medium text-(--text-muted)"> / {formatCount(gp.goal)}</span>
                        )}
                      </p>
                      {goalViewRaw.sub && <p className="kpi-sub mt-1.5">{goalViewRaw.sub}</p>}
                    </div>
                    <div>
                      <p className="kpi-label">Goal Achievement</p>
                      <p className="kpi-hero mt-2">{num(formatPercent(gp.achievement, 1))}</p>
                      <p className="kpi-sub mt-1.5">{gp.goal != null ? "of weekly goal" : "—"}</p>
                    </div>
                    <div>
                      <p className="kpi-label">Remaining</p>
                      <p
                        className={
                          "kpi-hero mt-2 " +
                          (gp.remainingTone === "positive" ? "text-(--pos-text)" : "text-(--text-primary)")
                        }
                      >
                        {gp.remainingHero}
                      </p>
                      <p
                        className={
                          "kpi-sub mt-1.5 " + (gp.remainingTone === "positive" ? "text-(--pos-text)" : "")
                        }
                      >
                        {gp.remainingSub}
                      </p>
                    </div>
                  </div>
                  {gp.goal != null && barPct != null && (
                    <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
                      <div
                        className={"h-1.5 rounded-full " + (goalHit ? "bg-(--dot-positive)" : "bg-(--bar-fill)")}
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                  )}
                </>
              ) : (
                <p className="kpi-sub mt-3">Week progress loading…</p>
              )}
            </section>

            {/* SECONDARY ACTIVITY METRICS */}
            <section className="card" aria-label="Activity metrics">
              <p className="section-heading">Activity — {RANGE_LABELS[data.range.mode]}</p>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                <KpiMid label="Total Calls" value={formatInt(d.metrics.totalCalls)} />
                <KpiMid
                  label="Calls Over 2 Minutes"
                  value={formatInt(d.metrics.callsOverThreshold)}
                  info={`Calls lasting more than ${data.thresholdSeconds}s — the meaningful-call threshold, set in Settings → Operational Rules.`}
                />
                <KpiMid
                  label="Bookings From Calls Over 2 Minutes"
                  value={formatInt(d.metrics.bookingsFromOverThreshold)}
                  sub="attributed to >2 min calls"
                />
                <KpiMid label="Average Call Duration" value={formatDuration(d.metrics.avgCallDurationSeconds)} />
              </div>
            </section>
          </div>
        ) : (
          <div className="card flex items-center justify-center py-10 text-sm text-(--text-muted)">
            Select a rep to see their performance.
          </div>
        )}
      </div>

      {/* COACHING FOCUS — rule-based from real metrics (spec: NO fake AI) */}
      {d && (
        <section className="card card-dense" aria-label="Coaching focus">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <p className="section-heading">Coaching Focus</p>
              <InfoTip
                tip="Rule-based from selected-range metrics — no scores."
                label="How Coaching Focus works"
              />
            </span>
          </div>
          {observations.length === 0 ? (
            <p className="mt-3 text-[13px] text-(--text-body)">
              No major performance flags for the selected period.
            </p>
          ) : (
            <ul className="mt-1">
              {observations.map((o, i) => (
                <li
                  key={`${i}-${o.text.slice(0, 24)}`}
                  className="flex items-start gap-2.5 border-b border-(--table-border-weak) py-2 first:pt-2.5 last:border-0 last:pb-0"
                >
                  <span
                    className={
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full " +
                      (o.severity === "risk" ? "bg-(--dot-caution)" : "bg-(--dot-positive)")
                    }
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 text-[13px] text-(--text-body)">{o.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* PERFORMANCE COMPARED WITH TEAM AVERAGE */}
      {d && (
        <section aria-label="Performance compared with team average">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <p className="section-heading">Performance Compared With Team Average</p>
              <InfoTip
                tip={`Team average excludes the selected rep. Counts compare as % difference; conversion rates as percentage points (pp); durations in m/s. Team averages cover the ${data.teamAverages.repCount} other active ${data.teamAverages.repCount === 1 ? "rep" : "reps"}; rate averages include only reps with a value — a missing value renders as — rather than a guess.`}
                label="How team averages and differences are computed"
              />
            </span>
          </div>
          <div className="card mt-3 overflow-hidden p-0">
            <div className="overflow-x-auto">
              {/* Metric column pinned on horizontal scroll (phones) so the
                  metric name stays visible while the numbers slide. */}
              <table className="data-table min-w-[640px] [&_td]:py-2.5 [&_td]:text-right [&_td:first-child]:text-left">
                <thead>
                  <tr>
                    {th("metric", "Metric", { left: true, stickyLeft: true })}
                    {th("rep", "Rep")}
                    {th("teamAvg", "Team Average")}
                    {th("diff", "Difference")}
                  </tr>
                </thead>
                <tbody>
                  {sortedComparisons.map((c) => {
                    // §11 restraint: a diff standing on a thin sample (rate
                    // denominators below 3, or a tiny count basis like "4 vs an
                    // average of 0.5 = +700%") keeps its exact math but renders
                    // muted — no color emphasis, reference only.
                    const restrained = d
                      ? restrainedDiff(c.diff, diffSampleDenominator(c, d.metrics))
                      : false;
                    return (
                      <tr key={c.metric}>
                        <td className="sticky left-0 z-[1] bg-(--card-bg) text-(--text-body)">{c.metric}</td>
                        <td className="font-medium text-(--text-primary)">{repCompareValue(c.rep, c.unit)}</td>
                        <td className="text-(--text-caption)">{teamCompareValue(c.teamAvg, c.unit)}</td>
                        <td
                          className={
                            "font-medium " +
                            (c.diff == null
                              ? "text-(--text-faint)"
                              : restrained
                                ? "font-normal text-(--text-muted)"
                                : c.diff >= 0
                                  ? "text-(--pos-text)"
                                  : "text-(--neg-text)")
                          }
                        >
                          {formatDiff(c.diff, c.unit)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {sortedComparisons.some(
            (c) => c.diff != null && restrainedDiff(c.diff, diffSampleDenominator(c, d.metrics)),
          ) && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-(--text-muted)">
              <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
              {SMALL_SAMPLE_FOOTNOTE}
            </p>
          )}
        </section>
      )}

      {/* ASSIGNED LEADS BY DAY (owner directive 2026-10-01) — the weekly table
          the owner assembles by hand today. Assigned sheet leads (work-date
          cohort) + Alliance/Auction opportunities per rep × ET day, from the
          same verified sources as every other page — no new math. Its own
          Mon–Sun week (picker includes the current week); CSV matches the
          owner's shared file schema. */}
      <section className="card card-dense" aria-label="Assigned leads by day">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="inline-flex items-center gap-1.5">
            <p className="section-heading">Assigned Leads by Day</p>
            <InfoTip
              tip="Assigned sheet leads per rep and ET work day, plus Alliance/Auction leads owned by their HighLevel rep (bucketed by created date). Unassigned sheet leads are excluded. Each cell reads Animalia / Family; Al · Au are Alliance/Auction when that rep owns them."
              label="What Assigned Leads by Day shows"
            />
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <WeekOfSelect
              mondays={data.assignedWeek.mondays}
              value={data.assignedByDay.week_start}
              onChange={(monday) => setAssignedWeek(monday)}
            />
            <button
              type="button"
              onClick={downloadAssignedCsv}
              className="rounded-lg bg-(--accent-solid) px-3 py-1.5 text-[13px] font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover)"
            >
              Download CSV
            </button>
          </span>
        </div>
        <p className="mt-1 text-xs text-(--text-caption)">
          {formatDateHuman(data.assignedByDay.week_start)} – {formatDateHuman(data.assignedByDay.week_end)} ·
          America/New_York · sheet leads with an assigned rep + Alliance/Auction opportunities · unassigned leads
          excluded
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="data-table min-w-[760px] [&_td]:py-1.5 [&_td]:text-right [&_td:first-child]:text-left">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-[2] bg-(--card-bg) text-left">Rep</th>
                {data.assignedByDay.dates.map((date) => (
                  <th key={date} scope="col" className="text-right">
                    {assignedDayHeader(date)}
                  </th>
                ))}
                <th scope="col" className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.assignedByDay.rows.map((r) => (
                <tr key={r.rep_id}>
                  <td className="sticky left-0 z-[1] bg-(--card-bg) text-left font-medium text-(--text-body)">
                    {r.rep_name}
                  </td>
                  {r.days.map((c, i) => (
                    <td key={i}>
                      <AssignedCell c={c} />
                    </td>
                  ))}
                  <td className="font-medium text-(--text-primary)">
                    <AssignedCell c={r.total} />
                  </td>
                </tr>
              ))}
              <tr className="border-t border-(--table-border)">
                <td className="sticky left-0 z-[1] bg-(--card-bg) text-left font-semibold text-(--text-primary)">
                  Week Total
                </td>
                {data.assignedByDay.dayTotals.map((c, i) => (
                  <td key={i} className="font-semibold text-(--text-primary)">
                    <AssignedCell c={c} />
                  </td>
                ))}
                <td className="font-semibold text-(--text-primary)">
                  <AssignedCell c={data.assignedByDay.weekTotal} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {data.assignedByDay.warnings.length > 0 && (
          <ul className="mt-2 space-y-1">
            {data.assignedByDay.warnings.map((w) => (
              <li key={w} className="flex items-start gap-1.5 text-xs text-(--text-muted)">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
                <span className="min-w-0">{w}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 flex items-center gap-1.5 text-xs text-(--text-muted)">
          <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
          Cell = Animalia / Family · Al / Au = Alliance / Auction leads owned by the rep. CSV columns:
          rep, day, genre, assigned_leads.
        </p>
      </section>
    </div>
  );
}

/** Day column header: "Mon 9/21" (ET calendar date of the column). */
function assignedDayHeader(date: string): string {
  return `${weekdayName(date, false)} ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** One grid cell: "animalia / family" split; Alliance/Auction appended when owned. All-zero renders — (never a fake 0). */
function AssignedCell({ c }: { c: AssignedByDayCell }) {
  const allZero = c.animalia === 0 && c.family === 0 && c.alliance === 0 && c.auction === 0;
  if (allZero) return <span className="text-(--text-faint)">—</span>;
  return (
    <span className="whitespace-nowrap leading-tight tabular-nums">
      <span className="text-(--text-primary)">{c.animalia}</span>
      <span className="text-(--text-faint)"> / </span>
      <span className="text-(--text-body)">{c.family}</span>
      {(c.alliance > 0 || c.auction > 0) && (
        <span className="ml-1.5 text-[11px] text-(--text-muted)">
          {c.alliance > 0 && <span>Al {c.alliance}</span>}
          {c.alliance > 0 && c.auction > 0 && <span> · </span>}
          {c.auction > 0 && <span>Au {c.auction}</span>}
        </span>
      )}
    </span>
  );
}

/** Secondary KPI cell — same stack as the Today page at text-3xl. */
function KpiMid({ label, value, sub, info }: { label: string; value: string; sub?: string; info?: string }) {
  return (
    <div>
      <p className="kpi-label flex items-center gap-1.5">
        {label}
        {info && <InfoTip tip={info} label={`About ${label}`} />}
      </p>
      <p className="kpi-mid mt-2">{num(value)}</p>
      {sub && <p className="kpi-sub mt-1.5">{sub}</p>}
    </div>
  );
}
