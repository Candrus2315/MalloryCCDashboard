import { createFileRoute } from "@tanstack/react-router";
import { WarningList } from "~/components/warnings";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { getRepsData } from "~/server/queries";
import {
  RANGE_LABELS,
  RANGE_MODES,
  formatDateHuman,
  weekStart,
  type RangeMode,
} from "~/server/date-logic";
import {
  formatCount,
  formatDiff,
  formatDuration,
  formatInt,
  formatPercent,
} from "~/server/metrics/report-text";
import type { ComparisonUnit } from "~/server/metrics/compute";
import { Segmented } from "~/components/Segmented";
import {
  coachingObservations,
  goalProgress,
  type CoachingObservation,
} from "~/components/reps-views";

export const Route = createFileRoute("/reps")({
  validateSearch: (search: Record<string, unknown>) => ({
    rep: typeof search.rep === "string" ? search.rep : undefined,
    range: typeof search.range === "string" ? search.range : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
  }),
  loaderDeps: ({ search }) => ({
    rep: search.rep,
    range: search.range,
    from: search.from,
    to: search.to,
  }),
  loader: ({ deps }) => getRepsData({ data: deps }),
  component: RepsPage,
});

/** Null renders "—" in stone-300 (never 0) — same rule as the Today page. */
function num(v: string) {
  return v === "—" ? <span className="text-stone-300">—</span> : v;
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
    router.navigate({
      to: "/reps",
      search: (prev) => ({
        rep: prev.rep,
        range: mode,
        from: mode === "custom" ? (customFrom || undefined) : undefined,
        to: mode === "custom" ? (customTo || undefined) : undefined,
      }),
    });
  };

  const applyCustom = () => {
    router.navigate({
      to: "/reps",
      search: (prev) => ({
        rep: prev.rep,
        range: "custom",
        from: customFrom || undefined,
        to: customTo || undefined,
      }),
    });
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

  const th = (key: SortKey, label: string, opts?: { left?: boolean }) => {
    const active = sortKey === key;
    const caret = active ? (sortAsc ? "↑" : "↓") : key === "metric" ? "↑" : "↓";
    return (
      <th
        scope="col"
        aria-sort={active ? (sortAsc ? "ascending" : "descending") : undefined}
        className={opts?.left ? "text-left" : "text-right"}
      >
        <button type="button" className="th-sort-btn" onClick={() => sortBy(key)}>
          {label}
          <span aria-hidden="true" className={active ? "text-stone-900" : "text-stone-400"}>
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
          <h1 className="text-xl font-semibold tracking-tight text-stone-900">Reps</h1>
          <span className="text-[15px] font-medium text-stone-300" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-stone-500">Individual Rep Performance</span>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-stone-500">
          <span className="h-1 w-1 shrink-0 rounded-full bg-stone-300" aria-hidden="true" />
          <span>{rangeCaption}</span>
        </p>
        {data.meta.mode === "memory" && (
          <div className="status-banner mt-2" role="status">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
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
        {data.range.mode === "custom" && (
          <span className="flex items-center gap-2 text-[13px] text-stone-500">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-[13px] text-stone-900 outline-none focus:border-stone-500"
              aria-label="From date"
            />
            <span>–</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-[13px] text-stone-900 outline-none focus:border-stone-500"
              aria-label="To date"
            />
            <button
              type="button"
              onClick={applyCustom}
              className="rounded-lg bg-stone-900 px-3 py-1.5 font-medium text-white hover:bg-stone-700"
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
            <div className="flex gap-2 overflow-x-auto p-2 lg:block lg:space-y-0 lg:overflow-visible lg:p-0 lg:divide-y lg:divide-stone-100">
              {data.repList.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => selectRep(r.id)}
                  aria-pressed={r.isSelected}
                  className={
                    "block w-full min-w-[190px] shrink-0 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 lg:min-w-0 lg:rounded-none " +
                    (r.isSelected ? "bg-stone-100" : "hover:bg-stone-50")
                  }
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        "h-1.5 w-1.5 shrink-0 rounded-full " +
                        (r.isSelected ? "bg-stone-900" : "bg-stone-300")
                      }
                      aria-hidden="true"
                    />
                    <span
                      className={
                        "truncate text-[13px] " + (r.isSelected ? "font-semibold text-stone-900" : "font-medium text-stone-700")
                      }
                    >
                      {r.name}
                    </span>
                  </span>
                  <span
                    className={
                      "mt-0.5 block pl-3.5 text-[11px] tabular-nums " +
                      (r.isSelected ? "text-stone-500" : "text-stone-400")
                    }
                  >
                    {plural(r.totalBookings, "booking")} · {plural(r.totalCalls, "call")}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-stone-400">Bookings · calls in the selected range.</p>

          {/* UNASSIGNED — non-roster HighLevel users' calls in the same window.
              Deliberately SEPARATE from the roster list and every team total:
              held unassigned in the DB until the booking-attribution /
              manual-assignment work assigns them. */}
          {data.unassigned && (
            <div className="mt-4">
              <p className="section-heading mb-2">Unassigned</p>
              <div className="card p-3">
                {data.unassigned.users.length === 0 ? (
                  <p className="text-[12px] text-stone-500">No unassigned calls in this window.</p>
                ) : (
                  <ul className="divide-y divide-stone-100">
                    {data.unassigned.users.map((u) => (
                      <li key={u.key} className="flex items-baseline justify-between gap-2 py-1.5 first:pt-0 last:pb-0">
                        <span className="min-w-0 truncate text-[12px] font-medium text-stone-700" title={u.key}>
                          {u.name ?? u.key}
                        </span>
                        <span className="shrink-0 tabular-nums text-[12px] text-stone-500">
                          {formatInt(u.calls)} call{u.calls === 1 ? "" : "s"} ·{" "}
                          {formatInt(u.overThreshold)} &gt;{data.thresholdSeconds}s
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {data.unassigned.totalCalls > 0 && (
                  <p className="mt-2 border-t border-stone-100 pt-2 text-[11px] tabular-nums text-stone-500">
                    Total: {formatInt(data.unassigned.totalCalls)} calls ·{" "}
                    {formatInt(data.unassigned.totalOverThreshold)} over threshold — excluded from roster and team
                    totals.
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-stone-400">
                  Non-roster HighLevel users' calls, held unassigned in the database. They are never merged into the
                  roster or team numbers. Assignment happens via the upcoming booking-attribution / manual-assignment
                  work; inspect raw rows on the Audit page.
                </p>
              </div>
            </div>
          )}
        </aside>

        {d ? (
          <div className="min-w-0 space-y-4">
            {/* summary header */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-[15px] font-semibold text-stone-900">
                {d.rep.name} — {RANGE_LABELS[data.range.mode]} performance
              </p>
              <p className="text-xs text-stone-400">Meaningful call threshold: {data.thresholdSeconds}s</p>
            </div>

            {/* PRIMARY PERFORMANCE METRICS (spec: stronger typography) */}
            <section className="card" aria-label="Primary performance metrics">
              <div className="grid grid-cols-1 gap-y-6 sm:grid-cols-3 sm:gap-y-0 sm:divide-x sm:divide-stone-100">
                <div className="sm:pr-6">
                  <p className="kpi-label">Total Bookings</p>
                  <p className="kpi-hero mt-2">{formatInt(d.metrics.totalBookings)}</p>
                  <p className="kpi-sub mt-1.5">non-cancelled, by created date</p>
                </div>
                <div className="sm:px-6">
                  <p className="kpi-label">Conversation Conversion</p>
                  <p className="kpi-hero mt-2">{num(formatPercent(d.metrics.conversationConversion, 1))}</p>
                  <p className="kpi-sub mt-1.5">bookings ÷ calls &gt;{data.thresholdSeconds}s</p>
                </div>
                <div className="sm:pl-6">
                  <p className="kpi-label">Assigned Lead Conversion</p>
                  <p className="kpi-hero mt-2">{num(formatPercent(d.metrics.assignedLeadConversion, 1))}</p>
                  <p className="kpi-sub mt-1.5">{plural(d.metrics.assignedLeads, "assigned lead")}</p>
                </div>
              </div>

              <hr className="my-4 border-stone-100" />

              {/* WEEKLY GOAL PROGRESS — always WTD vs the weekly goal (spec) */}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="section-heading">{weekScoped ? "Weekly Goal Progress" : "Goal Progress"}</p>
                {d.goal?.note && <p className="text-xs text-stone-400">{d.goal.note}</p>}
              </div>
              {gp && goalViewRaw ? (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                    <div>
                      <p className="kpi-label">{goalViewRaw.label}</p>
                      <p className="kpi-hero mt-2">
                        {formatInt(gp.wtd)}
                        {gp.goal != null && (
                          <span className="text-2xl font-medium text-stone-400"> / {formatCount(gp.goal)}</span>
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
                          (gp.remainingTone === "positive" ? "text-emerald-700" : "text-stone-900")
                        }
                      >
                        {gp.remainingHero}
                      </p>
                      <p
                        className={
                          "kpi-sub mt-1.5 " + (gp.remainingTone === "positive" ? "text-emerald-600" : "")
                        }
                      >
                        {gp.remainingSub}
                      </p>
                    </div>
                  </div>
                  {gp.goal != null && barPct != null && (
                    <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-stone-200" aria-hidden="true">
                      <div
                        className={"h-1.5 rounded-full " + (goalHit ? "bg-emerald-600" : "bg-stone-900")}
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
                  sub={`duration > ${data.thresholdSeconds}s`}
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
          <div className="card flex items-center justify-center py-10 text-sm text-stone-400">
            Select a rep to see their performance.
          </div>
        )}
      </div>

      {/* COACHING FOCUS — rule-based from real metrics (spec: NO fake AI) */}
      {d && (
        <section className="card card-dense" aria-label="Coaching focus">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="section-heading">Coaching Focus</p>
            <p className="text-xs font-normal text-stone-400">
              Rule-based from selected-range metrics — no scores.
            </p>
          </div>
          {observations.length === 0 ? (
            <p className="mt-3 text-[13px] text-stone-700">
              No major performance flags for the selected period.
            </p>
          ) : (
            <ul className="mt-1">
              {observations.map((o, i) => (
                <li
                  key={`${i}-${o.text.slice(0, 24)}`}
                  className="flex items-start gap-2.5 border-b border-stone-100 py-2 first:pt-2.5 last:border-0 last:pb-0"
                >
                  <span
                    className={
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full " +
                      (o.severity === "risk" ? "bg-amber-500" : "bg-emerald-600")
                    }
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 text-[13px] text-stone-700">{o.text}</span>
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
            <p className="section-heading">Performance Compared With Team Average</p>
            <p className="text-xs font-normal text-stone-400">Team average excludes the selected rep.</p>
          </div>
          <div className="card mt-3 overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="data-table min-w-[640px] [&_td]:py-2.5 [&_td]:text-right [&_td:first-child]:text-left">
                <thead>
                  <tr>
                    {th("metric", "Metric", { left: true })}
                    {th("rep", "Rep")}
                    {th("teamAvg", "Team Average")}
                    {th("diff", "Difference")}
                  </tr>
                </thead>
                <tbody>
                  {sortedComparisons.map((c) => (
                    <tr key={c.metric}>
                      <td className="text-stone-700">{c.metric}</td>
                      <td className="font-medium text-stone-900">{repCompareValue(c.rep, c.unit)}</td>
                      <td className="text-stone-500">{teamCompareValue(c.teamAvg, c.unit)}</td>
                      <td
                        className={
                          "font-medium " +
                          (c.diff == null
                            ? "text-stone-300"
                            : c.diff >= 0
                              ? "text-emerald-700"
                              : "text-red-700")
                        }
                      >
                        {formatDiff(c.diff, c.unit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-stone-400">
            Counts compare as % difference; conversion rates as percentage points (pp); durations in
            m/s. Team averages cover the {data.teamAverages.repCount} other active{" "}
            {data.teamAverages.repCount === 1 ? "rep" : "reps"}; rate averages include only reps with
            a value — a missing value renders as — rather than a guess.
          </p>
        </section>
      )}
    </div>
  );
}

/** Secondary KPI cell — same stack as the Today page at text-3xl. */
function KpiMid({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="kpi-label">{label}</p>
      <p className="kpi-mid mt-2">{num(value)}</p>
      {sub && <p className="kpi-sub mt-1.5">{sub}</p>}
    </div>
  );
}
