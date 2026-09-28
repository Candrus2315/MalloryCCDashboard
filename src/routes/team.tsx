import { createFileRoute } from "@tanstack/react-router";
import { WarningList } from "~/components/warnings";
import { Link, useRouter } from "@tanstack/react-router";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { getAuditData, getTeamData } from "~/server/queries";
import { auditRowView } from "~/server/date-logic";
import {
  RANGE_LABELS,
  RANGE_MODES,
  addDays,
  isHistoricalWeek,
  recentMondays,
  weekStart,
  formatDateHumanFull,
  formatDateHuman,
  type RangeMode,
} from "~/server/date-logic";
import { TREND_MIN_DENOMINATOR, type TrendPoint } from "~/server/metrics/compute";
import {
  formatCount,
  formatDuration,
  formatInt,
  formatPercent,
} from "~/server/metrics/report-text";
import { TrendCard, type TrendUnit } from "~/components/trend-chart";
import { Segmented, WeekOfSelect } from "~/components/Segmented";
import { StatusChip } from "~/components/StatusChip";
import { AttentionPanel } from "~/components/AttentionPanel";
import { DetailDrawer } from "~/components/DetailDrawer";
import { GoalProgress } from "~/components/GoalProgress";
import {
  assignedConversionLines,
  avgDurationLine,
  BOOKINGS_DRILL_UNAVAILABLE,
  buildTrendMeta,
  callRowViews,
  conversionComponents,
  drawerContextLines,
  drawerHeading,
  LEADS_DRILL_NOTE,
  leadCohortView,
  overThresholdRows,
  reconciliationText,
  trendTooltip,
  WEEK_BUCKET_DRILL_NOTE,
} from "~/components/drawer-views";
import {
  attentionNotes,
  bookingSplitLine,
  compareRepRows,
  leadPacing,
  paceSummary,
  repChips,
  type RepSortKey,
} from "~/components/team-views";

export const Route = createFileRoute("/team")({
  validateSearch: (search: Record<string, unknown>) => ({
    range: typeof search.range === "string" ? search.range : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
    // drawer state is URL state (§3): drill = metric key, date = TrendPoint key
    drill: typeof search.drill === "string" ? search.drill : undefined,
    date: typeof search.date === "string" ? search.date : undefined,
  }),
  loaderDeps: ({ search }) => ({
    range: search.range,
    from: search.from,
    to: search.to,
    drill: search.drill,
    date: search.date,
  }),
  loader: async ({ deps }) => {
    const data = await getTeamData({ data: deps });
    const drillMetric = typeof deps.drill === "string" ? deps.drill : null;
    const drillDate = typeof deps.date === "string" ? deps.date : null;
    // §16: record-level drill-down reconciles only for DAY buckets (ranges
    // ≤ 31 days). Weekly buckets get aggregate-only content and NO audit
    // fetch — a single day's rows must never masquerade as a week's records.
    const audit =
      drillMetric && drillDate && data.trends.bucketMode === "day"
        ? await getAuditData({ data: { rep: "roster", date: drillDate } })
        : null;
    return { ...data, drill: { metric: drillMetric, date: drillDate, audit } };
  },
  component: TeamPage,
});

/** Null renders "—" in stone-300 (never 0) — same rule as the Today/Reps pages. */
function num(v: string) {
  return v === "—" ? <span className="text-(--text-faint)">—</span> : v;
}

/**
 * KPI cell. Labels are sentence-case (team spec §microcopy: "Calls Over 2
 * Minutes", not an all-caps gray tag); primary stats run text-4xl, the
 * supporting row text-2xl — the page's two visible weights.
 */
function Field({
  label,
  value,
  sub,
  tone,
  size = "mid",
}: {
  label: string;
  /** ReactNode: num() renders "—" as a muted span, so values may be JSX. */
  value: ReactNode;
  sub?: string;
  tone?: "pos" | "neg";
  size?: "hero" | "mid";
}) {
  const toneCls = tone === "pos" ? "text-(--pos-text)" : tone === "neg" ? "text-(--neg-text)" : "text-(--text-primary)";
  return (
    <div>
      <p className="text-xs font-medium text-(--text-caption)">{label}</p>
      <p
        className={
          "mt-1.5 font-semibold tracking-tight tabular-nums " +
          (size === "hero" ? "text-4xl " : "text-2xl ") +
          toneCls
        }
      >
        {value}
      </p>
      {sub && <p className="kpi-sub mt-1">{sub}</p>}
    </div>
  );
}

function pointsOf(points: TrendPoint[], pick: (p: TrendPoint) => number | null) {
  return points.map((p) => ({ label: p.label, value: pick(p) }));
}

type SortKey = RepSortKey;

/**
 * §12 row-click target: the EXACT search the rep-name Link has always used —
 * a rep lands on the Reps page preselected with the identical range (custom
 * range included), so Christopher never reselects rep + period.
 */
function repsSearch(r: { id: string }, range: { mode: RangeMode; start: string; end: string }) {
  return {
    rep: r.id,
    range: range.mode,
    from: range.mode === "custom" || range.mode === "week-of" ? range.start : undefined,
    to: range.mode === "custom" ? range.end : undefined,
  };
}

function TeamPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const search = Route.useSearch();
  const m = data.metrics;
  const t = data.trends;

  const [customFrom, setCustomFrom] = useState(search.from ?? "");
  const [customTo, setCustomTo] = useState(search.to ?? "");
  const [sortKey, setSortKey] = useState<SortKey>("bookings");
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedRep, setExpandedRep] = useState<string | null>(null);

  const setRange = (mode: RangeMode) => {
    // week-of needs a Monday anchor: stay on the viewed week when it is
    // historical, otherwise default to LAST week (a historical picker whose
    // default were the current week would show a live week under a historical
    // label). The dropdown refines it afterwards.
    const viewedWeekOf = weekStart(data.range.start);
    const defaultWeekOf = addDays(weekStart(data.today), -7);
    const weekAnchor = isHistoricalWeek(data.range.mode, data.range.start, data.today) ? viewedWeekOf : defaultWeekOf;
    router.navigate({
      to: "/team",
      search: () => ({
        range: mode,
        from: mode === "custom" ? (customFrom || undefined) : mode === "week-of" ? weekAnchor : undefined,
        to: mode === "custom" ? (customTo || undefined) : undefined,
      }),
    });
  };

  const setWeekOf = (monday: string) => {
    router.navigate({
      to: "/team",
      search: () => ({ range: "week-of" as RangeMode, from: monday, to: undefined }),
    });
  };

  const applyCustom = () => {
    router.navigate({
      to: "/team",
      search: () => ({ range: "custom" as RangeMode, from: customFrom || undefined, to: customTo || undefined }),
    });
  };

  // ---------- presentation compositions (payload numbers only — see team-views) ----------
  const ps = paceSummary({ metrics: m, rangeEnd: data.range.end, today: data.today });
  const lp = leadPacing(t.points);
  const chips = repChips(data.repRows);
  const notes = attentionNotes({
    metrics: m,
    points: t.points,
    bucketMode: t.bucketMode,
    repRows: data.repRows,
    rangeEnd: data.range.end,
    today: data.today,
  });

  // Assigned-Lead-Conversion-unavailable stays as an inline notice next to the
  // metric (team spec §alert treatment) — never a top-of-page warning.
  const topWarnings = data.warnings.filter((w) => !w.startsWith("No assigned leads worked in this range"));

  const lastRef = t.points.length > 0 ? t.points[t.points.length - 1].budgetRef : 0;
  const refLine =
    t.bucketMode === "week"
      ? { value: lastRef, label: `budget ${formatInt(lastRef)}/wk` }
      : { value: lastRef, label: `budget pace ${formatInt(lastRef)}/day` };

  const sparseNote = `Fewer than ${TREND_MIN_DENOMINATOR} qualifying rows: value hidden.`;
  const leadNote =
    "Leads by work date (what the team works that day) · " +
    (t.bucketMode === "week" ? "dashed line = weekly lead budget." : "dashed line = budget pace (weekly budget ÷ 7 per day).");

  // ---------- drill-down (§3/§12/§16): drawer state lives in the URL ----------
  const drillMetric = data.drill.metric;
  const drillDate = data.drill.date;
  const drawerOpen = drillMetric != null && drillDate != null;
  const drillPoint = drawerOpen ? (t.points.find((p) => p.key === drillDate) ?? null) : null;
  const auditResult = data.drill.audit;
  const auditError = auditResult?.error ?? null;
  const auditPayload = auditResult && !auditResult.error ? auditResult.payload : null;
  const drillRows = auditPayload?.rows ?? [];
  const overRows = overThresholdRows(drillRows);
  const weekMode = t.bucketMode === "week";

  const openDrill = (metric: string, index: number) => {
    const point = t.points[index];
    if (!point) return;
    // preserves range/from/to — closing later restores the identical search (§3)
    router.navigate({ to: "/team", search: (prev) => ({ ...prev, drill: metric, date: point.key }) });
  };
  const closeDrill = () => {
    router.navigate({ to: "/team", search: (prev) => ({ ...prev, drill: undefined, date: undefined }) });
  };

  // ---------- trend cards: one config, shared meta + tooltip + drill wiring ----------
  interface CardDef {
    key: string;
    title: string;
    pick: (p: TrendPoint) => number | null;
    unit: TrendUnit;
    noun?: string;
    pctKind?: "conversation" | "assigned";
    note?: string | null;
    wide?: boolean;
    refLine?: { value: number; label: string } | null;
  }
  const cardDefs: CardDef[] = [
    { key: "bookings", title: "Bookings", pick: (p) => p.bookings, unit: "int", noun: "bookings" },
    { key: "calls", title: "Calls", pick: (p) => p.calls, unit: "int", noun: "calls" },
    {
      key: "calls-over",
      title: "Calls Over 2 Minutes",
      pick: (p) => p.callsOverThreshold,
      unit: "int",
      noun: "calls over 2 min",
      note: `duration > ${data.thresholdSeconds}s`,
    },
    {
      key: "conv",
      title: "Conversation Conversion",
      pick: (p) => p.conversationConversion,
      unit: "pct",
      pctKind: "conversation",
      note: sparseNote,
    },
    {
      key: "assigned-conv",
      title: "Assigned Lead Conversion",
      pick: (p) => p.assignedLeadConversion,
      unit: "pct",
      pctKind: "assigned",
      note: sparseNote,
    },
    { key: "avg-duration", title: "Average Call Duration", pick: (p) => p.avgCallDurationSeconds, unit: "duration" },
    {
      key: "leads",
      title: "Leads by work date",
      pick: (p) => p.leads,
      unit: "int",
      noun: "leads",
      refLine,
      note: leadNote,
      wide: true,
    },
  ];
  const cardByKey = new Map(cardDefs.map((c) => [c.key, c]));
  const trendMeta = buildTrendMeta(t.points, data.today, t.bucketMode);

  const tooltipFor = (c: CardDef) => (i: number) => {
    const point = t.points[i];
    if (!point) return null;
    return trendTooltip({
      value: c.pick(point),
      label: point.label,
      unit: c.unit,
      noun: c.noun,
      pctKind: c.pctKind,
      point,
      today: data.today,
      bucketMode: t.bucketMode,
    });
  };

  const renderTrendCard = (c: CardDef) => (
    <TrendCard
      title={c.title}
      points={pointsOf(t.points, c.pick)}
      unit={c.unit}
      note={c.note}
      wide={c.wide}
      refLine={c.refLine}
      meta={trendMeta}
      tooltip={tooltipFor(c)}
      onPointClick={(i) => openDrill(c.key, i)}
    />
  );

  // ---------- drawer content per metric (day buckets reconcile; weeks stay aggregate) ----------
  const drillNeedsRecords =
    drillMetric === "calls" || drillMetric === "calls-over" || drillMetric === "conv" || drillMetric === "avg-duration";
  const drawerLoading = drawerOpen && !weekMode && drillPoint != null && drillNeedsRecords && !auditPayload && !auditError;

  const drawerEmpty = (() => {
    if (drawerOpen && !drillPoint) return "That date is outside the selected range.";
    if (auditError) return auditError;
    if (drawerOpen && drillMetric === "bookings") return BOOKINGS_DRILL_UNAVAILABLE;
    return undefined;
  })();

  const drawerContext = (() => {
    if (!drawerOpen || !drillPoint) return [];
    const count =
      auditError || weekMode || !drillNeedsRecords
        ? null
        : drillMetric === "calls-over" || drillMetric === "conv"
          ? overRows.length
          : drillRows.length;
    return drawerContextLines({
      rangeLabel: data.range.label,
      isHistorical: !data.range.isCurrentWeek,
      thresholdSeconds: data.thresholdSeconds,
      count,
      scopeLabel: drillMetric === "leads" ? "Work-date cohort" : "Roster calls",
    });
  })();

  const drawerTitle =
    drawerOpen && drillPoint && drillMetric
      ? drawerHeading(cardByKey.get(drillMetric)?.title ?? "Detail", drillPoint.label)
      : "Detail";

  const recordTable = (rows: typeof drillRows, reconcileAgainst: number) => {
    const rec = reconciliationText(reconcileAgainst, rows.length);
    return (
      <>
        {rows.length === 0 ? (
          <p className="text-[13px] text-(--text-caption)">No records for this day.</p>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-(--card-border) text-left text-[11px] text-(--text-caption)">
                <th scope="col" className="py-1.5 pr-2 font-medium">Time</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Rep</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Contact</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Dir</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Duration</th>
                <th scope="col" className="py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {callRowViews(rows.map(auditRowView)).map((r, i) => (
                <tr key={rows[i].external_call_id ?? i} className="border-b border-(--table-border-weak) last:border-0">
                  <td className="py-1.5 pr-2 tabular-nums text-(--text-body)">{r.time}</td>
                  <td className="py-1.5 pr-2 text-(--text-body)">{r.rep}</td>
                  <td className="py-1.5 pr-2 text-(--text-body)">{r.contact}</td>
                  <td className="py-1.5 pr-2 text-(--text-caption)">{r.direction}</td>
                  <td className="py-1.5 pr-2 tabular-nums text-(--text-body)">{r.duration}</td>
                  <td className="py-1.5 text-(--text-caption)">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className={"mt-3 text-[11px] " + (rec.ok ? "text-(--text-caption)" : "text-(--banner-fg)")}>{rec.text}</p>
      </>
    );
  };

  const weekAggregate = (line: string) => (
    <div>
      <p className="text-[13px] font-medium text-(--text-primary)">{line}</p>
      <p className="mt-2 text-[11px] leading-snug text-(--text-muted)">{WEEK_BUCKET_DRILL_NOTE}</p>
    </div>
  );

  const drillBody = (() => {
    if (drawerEmpty || !drillPoint || !drillMetric) return null;
    switch (drillMetric) {
      case "calls":
        return weekMode
          ? weekAggregate(`${formatInt(drillPoint.calls)} calls in this weekly bucket`)
          : recordTable(drillRows, drillPoint.calls);
      case "calls-over":
        return weekMode
          ? weekAggregate(`${formatInt(drillPoint.callsOverThreshold)} calls over 2 min in this weekly bucket`)
          : recordTable(overRows, drillPoint.callsOverThreshold);
      case "conv": {
        return (
          <div>
            <p className="text-[13px] font-medium text-(--text-primary)">
              {conversionComponents(drillPoint.bookingsFromOverThreshold, drillPoint.callsOverThreshold)}
            </p>
            {weekMode ? (
              <p className="mt-2 text-[11px] leading-snug text-(--text-muted)">{WEEK_BUCKET_DRILL_NOTE}</p>
            ) : (
              <>
                <p className="mt-2 text-[11px] leading-snug text-(--text-muted)">
                  Bookings (the numerator) are not record-loaded yet — the calls below are the denominator, over
                  threshold only.
                </p>
                {recordTable(overRows, drillPoint.callsOverThreshold)}
              </>
            )}
          </div>
        );
      }
      case "avg-duration":
        return weekMode ? (
          weekAggregate(
            drillPoint.avgCallDurationSeconds == null
              ? "No calls in this weekly bucket"
              : `${formatDuration(drillPoint.avgCallDurationSeconds)} average in this weekly bucket`,
          )
        ) : (
          <div>
            <p className="text-[13px] font-medium text-(--text-primary)">{avgDurationLine(drillPoint)}</p>
            <p className="mt-2 text-[11px] leading-snug text-(--text-muted)">The calls behind the average:</p>
            <div className="mt-1">{recordTable(drillRows, drillPoint.calls)}</div>
          </div>
        );
      case "assigned-conv":
        return (
          <div>
            {assignedConversionLines(drillPoint).map((line, i) => (
              <p key={i} className="text-[13px] font-medium text-(--text-primary)">
                {line}
              </p>
            ))}
            <p className="mt-2 text-[11px] leading-snug text-(--text-muted)">
              Record-level assigned-lead rows are not loaded yet — the components come from the metrics layer (bookings
              ÷ assigned leads worked).
            </p>
          </div>
        );
      case "leads": {
        const lc = leadCohortView(drillPoint, t.bucketMode);
        return (
          <div>
            <p className="text-[13px] font-medium text-(--text-primary)">{lc.split}</p>
            {lc.cohort.length > 0 && (
              <p className="mt-2 text-xs leading-relaxed text-(--chip-neutral-fg)">
                Works leads from source dates: {lc.cohort.join(" · ")}
              </p>
            )}
            <p className="mt-2 text-[11px] leading-snug text-(--text-muted)">{LEADS_DRILL_NOTE}</p>
          </div>
        );
      }
      case "bookings":
        return null; // drawerEmpty carries the honest unavailable state
      default:
        return null;
    }
  })();


  const renderCard = (key: string) => {
    const c = cardByKey.get(key);
    return c ? renderTrendCard(c) : null;
  };

  // sortable by-rep rows (native, no deps; missing values sort last, never as zero)
  const sortedRepRows = useMemo(
    () => [...data.repRows].sort((a, b) => compareRepRows(a, b, sortKey, sortAsc)),
    [data.repRows, sortKey, sortAsc],
  );

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(key === "rep");
    }
  };

  // Sticky header (index.tsx pattern, offsets pair with the shell header:
  // top-[68px] on phones where the header is 68px, md:top-14 on desktop).
  // The rep header cell is sticky left too (opaque bg so horizontal scroll
  // keeps rep identity, §6/§15) and sits above the other header cells; body
  // rep cells get z-[1].
  const th = (key: SortKey, label: string, opts?: { left?: boolean }) => {
    const active = sortKey === key;
    const caret = active ? (sortAsc ? "↑" : "↓") : key === "rep" ? "↑" : "↓";
    return (
      <th
        scope="col"
        aria-sort={active ? (sortAsc ? "ascending" : "descending") : undefined}
        className={
          opts?.left
            ? "sticky left-0 top-[68px] z-[3] bg-(--card-bg) pb-2 text-left md:top-14"
            : "sticky top-[68px] z-[2] bg-(--sticky-header-bg) pb-2 text-right backdrop-blur-sm md:top-14"
        }
      >
        <button type="button" className="th-sort-btn normal-case tracking-normal text-xs text-(--text-caption)" onClick={() => sortBy(key)}>
          {label}
          <span aria-hidden="true" className={active ? "text-(--text-primary)" : "text-(--text-muted)"}>
            {caret}
          </span>
        </button>
      </th>
    );
  };

  const singleDay = data.range.start === data.range.end;
  const rangeCaption = `${data.range.label} · ${
    singleDay ? formatDateHumanFull(data.range.start) : `${formatDateHumanFull(data.range.start)} – ${formatDateHumanFull(data.range.end)}`
  } · America/New_York`;

  return (
    <div className="space-y-4">
      {/* header — matches Today/Reps: title — subtitle, context line, honesty banner */}
      <header>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className="text-xl font-semibold tracking-tight text-(--text-primary)">Team</h1>
          <span className="text-[15px] font-medium text-(--text-faint)" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-(--text-caption)">Team Performance</span>
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

      {/* missing-data warnings — never a plausible number (assigned-lead note moved inline) */}
      <WarningList items={topWarnings} />

      {/* date range — compact segmented filter control (spec) */}
      <section aria-label="Date range" className="flex flex-wrap items-center gap-3">
        <Segmented
          ariaLabel="Date range"
          options={RANGE_MODES.map((mode) => ({ value: mode, label: RANGE_LABELS[mode] }))}
          value={data.range.mode}
          onChange={(mode) => setRange(mode)}
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

      {/* team performance summary + goal pacing — the above-the-fold story */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <section className="card" aria-label="Team performance summary">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="section-heading">Team Performance</p>
            <p className="text-xs text-(--text-muted)">Meaningful call threshold: {data.thresholdSeconds}s</p>
          </div>

          {/* PRIMARY — bookings + goal pace (spec: not all KPIs equal) */}
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
            <Field size="hero" label="Total Bookings" value={formatInt(m.totalBookings)} sub="non-cancelled, by created date" />
            <Field size="hero" label="Goal Achievement" value={num(formatPercent(m.goalAchievement, 1))} sub="actual ÷ goal" />
            <Field
              size="hero"
              label="Bookings Remaining"
              value={num(formatCount(m.remaining))}
              sub="goal − actual, floored at 0"
              tone={m.remaining === 0 ? "pos" : undefined}
            />
            <Field
              size="hero"
              label="Daily Pace Needed"
              value={formatInt(m.paceNeeded)}
              sub="per working day"
              tone={m.paceNeeded > 0 ? "neg" : "pos"}
            />
          </div>

          {/* THREE-WAY ATTRIBUTION SPLIT (owner directive 2026-09-27, S5b) — the
              three states are separate numbers, never folded together: Total
              Bookings = Attributed + Ambiguous + Unattributed (a booking with
              no stored verdict yet shows as its own honest clause). */}
          <p className="mt-3 text-xs text-(--text-caption)" data-testid="booking-attribution-split">
            {bookingSplitLine(data.bookingSplit)}
            <span className="text-(--text-muted)"> · {formatInt(data.bookingSplit.total)} total bookings in range</span>
          </p>

          <hr className="my-5 border-(--table-border-weak)" />

          {/* SECONDARY — calls & conversions */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
            <Field label="Total Team Calls" value={formatInt(m.totalCalls)} />
            <Field label="Calls Over 2 Minutes" value={formatInt(m.callsOverThreshold)} sub={`duration > ${data.thresholdSeconds}s`} />
            <Field label="Bookings From Calls Over 2 Minutes" value={formatInt(m.bookingsFromOverThreshold)} sub="attributed to >2 min calls" />
            <Field
              label="Team Conversation Conversion"
              value={num(formatPercent(m.conversationConversion, 1))}
              sub={`bookings ÷ calls >${data.thresholdSeconds}s`}
            />
            <Field
              label="Assigned Lead Conversion"
              value={num(formatPercent(m.assignedLeadConversion, 1))}
              sub={m.assignedLeads > 0 ? `${formatInt(m.assignedLeads)} assigned leads` : undefined}
            />
            <Field label="Average Call Duration" value={formatDuration(m.avgCallDurationSeconds)} />
          </div>

          {/* inline notice — compact, never louder than the performance story (spec) */}
          {m.assignedLeads === 0 && (
            <p className="mt-4 flex items-start gap-1.5 text-xs text-(--banner-fg)">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
              Assigned Lead Conversion unavailable for this range because no assigned leads were worked.
            </p>
          )}
        </section>

        {/* GOAL PACING — one unit: number line, bar, sentence (spec §2) — sizes to its
            own content height (equal-height abolition: items-start on the grid above) */}
        <section className="card" aria-label="Goal pacing">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="section-heading">Goal Pacing</p>
            <p className="max-w-[240px] text-right text-[11px] leading-snug text-(--text-muted)">{m.goal.note}</p>
          </div>
          <div className="mt-3">
            <p className="kpi-hero">
              {formatInt(ps.actual)}
              {ps.goalValue > 0 && (
                <span className="text-2xl font-medium text-(--text-muted)"> / {formatCount(ps.goalValue)} bookings</span>
              )}
            </p>
            <p className="kpi-sub mt-1.5">bookings created in range</p>
          </div>
          {ps.barPct != null && (
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
              <div
                className={"h-1.5 rounded-full " + (ps.hit ? "bg-(--dot-positive)" : "bg-(--bar-fill)")}
                style={{ width: `${ps.barPct}%` }}
              />
            </div>
          )}
          {ps.achieved != null ? (
            <p className="mt-4 text-[13px] leading-relaxed text-(--text-caption)">
              <span className={"font-semibold " + (ps.hit ? "text-(--pos-text)" : "text-(--text-primary)")}>{ps.achieved}</span>{" "}
              achieved
              <span className="mx-1.5 text-(--text-faint)">·</span>
              <span className="font-semibold text-(--text-primary)">{ps.remaining}</span> remaining
              <span className="mx-1.5 text-(--text-faint)">·</span>
              <span className="font-medium text-(--text-body)">{ps.paceClause}</span>
            </p>
          ) : (
            <p className="mt-4 text-[13px] text-(--text-caption)">{ps.paceClause}</p>
          )}
          {ps.paceFootnote && <p className="kpi-sub mt-1.5">{ps.paceFootnote}</p>}
        </section>
      </div>

      {/* TRENDS — structured analytics grid, two labeled rows (spec §3) */}
      <section aria-label="Trends">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="section-heading">Trends</p>
          <p className="text-xs text-(--text-muted)">{t.bucketNote}</p>
        </div>
        <p className="mt-3 text-xs font-semibold text-(--text-caption)">Performance trends</p>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          {renderCard("bookings")}
          {renderCard("calls")}
          {renderCard("calls-over")}
          {renderCard("conv")}
        </div>
        <p className="mt-4 text-xs font-semibold text-(--text-caption)">Lead &amp; efficiency trends</p>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          {renderCard("assigned-conv")}
          {renderCard("avg-duration")}
        </div>
        <p className="mt-3 text-[11px] leading-snug text-(--text-muted)">
          Hover any point for exact values · click a point for that day's records.
        </p>
      </section>

      {/* LEAD VOLUME & BUDGET PACING — answers "are we getting enough leads?" (spec §4) */}
      <section aria-label="Lead volume and budget pacing">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="section-heading">Lead Volume &amp; Budget Pace</p>
          {lp.verdict ? (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] font-medium text-(--text-body)">
              <span
                className={
                  "h-1.5 w-1.5 shrink-0 rounded-full " +
                  (lp.verdict === "Below budget pace" ? "bg-(--dot-caution)" : "bg-(--dot-positive)")
                }
                aria-hidden="true"
              />
              <span className={lp.verdict === "Below budget pace" ? "text-(--banner-fg)" : "text-(--pos-text)"}>
                {lp.verdict}
              </span>
              <span className="font-normal text-(--text-caption)">
                · {formatInt(lp.leads)} leads in range · {lp.pct} of budget pace
                {lp.delta ? ` (${lp.delta})` : ""}
              </span>
            </p>
          ) : (
            <p className="text-[13px] text-(--text-caption)">{formatInt(lp.leads)} leads in range</p>
          )}
        </div>
        <div className="mt-2">{renderCard("leads")}</div>
      </section>

      {/* BY REP — sortable, chips rule-based from real metrics (spec §5) */}
      <section aria-label="Team by rep">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="section-heading">By Rep</p>
          <p className="text-xs text-(--text-muted)">Click a rep for their full detail on the Reps page</p>
        </div>
        <div className="card mt-2 overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="border-b border-(--card-border)">
                  {th("rep", "Rep", { left: true })}
                  {th("bookings", "Bookings")}
                  {th("calls", "Calls > 2 Min")}
                  {th("conv", "Conversation Conversion")}
                  {th("avg-duration", "Avg Duration")}
                </tr>
              </thead>
              <tbody>
                {sortedRepRows.map((r) => {
                  const chip = chips.get(r.id);
                  const expanded = expandedRep === r.id;
                  return (
                    <Fragment key={r.id}>
                      {/* §12: the whole row is clickable (the name Link stays the
                          accessible affordance; chevron/stopPropagation keep the
                          toggle and link from double-firing the navigation) */}
                      <tr
                        className="group cursor-pointer border-b border-(--table-border-weak) hover:bg-(--surface-hover)"
                        onClick={() => router.navigate({ to: "/reps", search: repsSearch(r, data.range) })}
                      >
                        <td className="sticky left-0 z-[1] bg-(--card-bg) py-2.5 pr-4 group-hover:bg-(--surface-hover)">
                          <span className="flex items-center gap-1.5">
                            <button
                              type="button"
                              aria-expanded={expanded}
                              aria-label={expanded ? `Hide details for ${r.name}` : `Show details for ${r.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedRep(expanded ? null : r.id);
                              }}
                              className="shrink-0 rounded p-0.5 text-(--text-muted) hover:bg-(--surface-subtle) hover:text-(--text-body) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                            >
                              <span
                                aria-hidden="true"
                                className={"block text-[10px] leading-none transition-transform " + (expanded ? "rotate-90" : "")}
                              >
                                ▶
                              </span>
                            </button>
                            <Link
                              to="/reps"
                              search={repsSearch(r, data.range)}
                              onClick={(e) => e.stopPropagation()}
                              className="font-medium text-(--text-primary) hover:underline"
                            >
                              {r.name}
                            </Link>
                            {chip && <StatusChip kind={chip.kind} label={chip.label} />}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-right">
                          <GoalProgress actual={r.totalBookings} goal={r.goal?.value ?? null} />
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-(--text-primary)">
                          {formatInt(r.callsOverThreshold)}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-(--text-body)">
                          {num(formatPercent(r.conversationConversion, 1))}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-(--text-body)">
                          {num(formatDuration(r.avgCallDurationSeconds))}
                        </td>
                      </tr>
                      {/* expanded row — secondary strip (§7: reduce columns before
                          readability; every displaced metric stays reachable) */}
                      {expanded && (
                        <tr className="border-b border-(--table-border-weak) bg-(--surface-inset) last:border-0">
                          <td colSpan={5} className="px-4 py-3">
                            <dl className="flex flex-wrap gap-x-10 gap-y-2 text-[12px]">
                              <div>
                                <dt className="text-[11px] text-(--text-muted)">Total Calls</dt>
                                <dd className="mt-0.5 tabular-nums text-(--text-body)">{formatInt(r.totalCalls)}</dd>
                              </div>
                              <div className="min-w-0">
                                <dt className="text-[11px] text-(--text-muted)">Goal basis</dt>
                                <dd className="mt-0.5 text-(--text-body)">
                                  {r.goal?.note ?? "No booking goal for this range"}
                                </dd>
                              </div>
                              {r.operatingState === "not-yet-active" && (
                                <div>
                                  <dt className="text-[11px] text-(--text-muted)">Status</dt>
                                  <dd className="mt-0.5 text-(--text-body)">
                                    Not Yet Active
                                    {r.callStartDate ? ` — begins calling ${formatDateHuman(r.callStartDate)}` : ""}
                                  </dd>
                                </div>
                              )}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {data.repRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-(--text-muted)">
                      No reps found — sync HighLevel users.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-(--text-muted)">
          Chips are rule-based from these columns — top bookings, conversion above team average (≥
          {TREND_MIN_DENOMINATOR} reps with a value), calls but no bookings, or no recorded activity; no grades.
          Assigned Lead Conversion per rep lives on each rep's page. Expand a row (▸) for calls, goal basis and start
          date.
        </p>
      </section>

      {/* TEAM ATTENTION — rule-based, 3–5 notes, no fake AI (spec §6) */}
      <AttentionPanel
        title="Team Attention"
        subtitle="Rule-based from this range's metrics — no scores."
        notes={notes}
      />

      {/* DETAIL DRAWER (§3/§12/§16) — open state is URL state; Escape/backdrop
          close restores the identical search so the range context never moves */}
      <DetailDrawer
        open={drawerOpen}
        onClose={closeDrill}
        title={drawerTitle}
        contextLines={drawerContext}
        loading={drawerLoading}
        emptyMessage={drawerEmpty}
      >
        {drillBody}
      </DetailDrawer>

      <p className="text-[11px] leading-snug text-(--text-muted)">
        Bookings counted by created_at (America/New_York) · leads by work_date · team goal = weekly goals summed over
        the range's weeks · Daily Pace Needed = bookings remaining ÷ working days left in the range's final week (never
        negative). Every figure comes from the same metrics layer as every other page.
      </p>
    </div>
  );
}
