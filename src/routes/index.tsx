import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { demoAwarenessLine, getTodayData } from "~/server/queries";
import { formatDateHuman } from "~/server/date-logic";
import { AttentionPanel } from "~/components/AttentionPanel";
import { DayCardStrip, type DayCardData } from "~/components/DayCardStrip";
import { StatusChip } from "~/components/StatusChip";
import {
  attentionNotes,
  availabilityStatusView,
  chipFor,
  formatPtsDelta,
  goalProgressView,
  pooledBenchmarkExcluding,
  pooledPtsDelta,
  repPerfLink,
  studioClosedOn,
  weekElapsedFraction,
  type GoalProgressView,
  type PooledRate,
} from "~/components/today-views";
import type { RepPerformanceRow } from "~/server/metrics/compute";

export const Route = createFileRoute("/")({
  loader: () => getTodayData(),
  component: TodayPage,
});

function pct(v: number | null | undefined, digits = 0): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}
function mins(seconds: number | null): string {
  if (seconds == null) return "—";
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
/** Short weekday from an ET date, e.g. "Fri" — reuses the existing formatter. */
function shortWeekday(dateStr: string): string {
  return formatDateHuman(dateStr).split(",")[0];
}
/** Null renders "—" in stone-300 (never 0) per spec §5 polish. */
function num(v: string) {
  return v === "—" ? <span className="text-(--text-faint)">—</span> : v;
}

type SortKey =
  | "name"
  | "callsOverThreshold"
  | "bookingsFromOverThreshold"
  | "totalBookings"
  | "conversationConversion"
  | "assignedLeadConversion"
  | "avgCallDurationSeconds";

function TodayPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const m = data.metrics;
  const [sortKey, setSortKey] = useState<SortKey>("totalBookings");
  const [sortAsc, setSortAsc] = useState(false);
  /** The one rep whose secondary-metrics detail panel is open (owner directive). */
  const [expandedRepId, setExpandedRepId] = useState<string | null>(null);

  // Spec §0 composition — pace fraction of the work week (Mon 1/5 … Fri 5/5;
  // Sat/Sun 5/5). Working days only — agents work Mon–Fri.
  const weekElapsed = weekElapsedFraction(m.date);
  // Spec §6.1 pace state: emerald when goal achievement ≥ week elapsed, amber below, none when null.
  const paceState: "on" | "off" | null =
    m.bookings.goalAchievement == null
      ? null
      : m.bookings.goalAchievement >= weekElapsed
        ? "on"
        : "off";

  // Spec §4 honesty banner: store/db clauses + provider-aware live/demo line +
  // stale warnings, one slim line. Provider-aware so "leads live, calls demo"
  // is visibly honest instead of a blanket "Demo data" claim.
  const bannerMessages = useMemo(() => {
    const msgs: string[] = [];
    if (data.meta.mode === "memory") {
      let s = "In-memory store";
      if (data.meta.dbReason) s += ` — Database not connected: ${data.meta.dbReason}`;
      msgs.push(s);
    } else if (data.meta.dbReason) {
      msgs.push(`Database warning: ${data.meta.dbReason}`);
    }
    const aware = demoAwarenessLine(data.connections ?? []);
    if (aware) msgs.push(aware);
    return [...msgs, ...data.staleWarnings];
  }, [data.meta, data.connections, data.staleWarnings]);

  // OWNER DIRECTIVE (2026-09-27): pooled team benchmarks per rep —
  // sum(other ACTIVE reps' numerators) ÷ sum(other ACTIVE reps' denominators).
  // The selected rep AND every not-yet-active rep are excluded from BOTH sums;
  // a zero pooled denominator renders "—" with no pts delta. Replaces the old
  // arithmetic-average team means for every comparison in this section.
  const pooled = useMemo(() => {
    const map = new Map<string, { conv: PooledRate; assigned: PooledRate }>();
    for (const r of m.repRows) {
      map.set(r.repId, {
        conv: pooledBenchmarkExcluding(m.repRows, r.repId, "conversation"),
        assigned: pooledBenchmarkExcluding(m.repRows, r.repId, "assignedLead"),
      });
    }
    return map;
  }, [m.repRows]);

  // Spec §6.3 management-attention notes (existing outputs only).
  const notes = useMemo(() => attentionNotes(m.repRows, m.date), [m.repRows, m.date]);

  // Spec §3.4/§7.1 day cards — one per day the payload carries (today + the
  // next 6), prefix derived from the date offset. Status per the owner
  // directive: closed test mirrors the open-slot engine using the studio-hours
  // rules already in the payload (settings.studio.hours) — no backend change,
  // and closed is never merged into fully booked.
  const shortDate = (d: string) => formatDateHuman(d).split(", ")[1] ?? d;
  const studioHours = data.settings.studio.hours;
  const dayCards: DayCardData[] = m.openSlotsByDay.map((d, i) => ({
    key: d.date,
    prefix: i === 0 ? "Today" : i === 1 ? "Tomorrow" : shortWeekday(d.date),
    weekday: i >= 2 ? shortDate(d.date) : shortWeekday(d.date),
    openCount: d.slots.length,
    slots: d.slots,
    status: availabilityStatusView(d.slots.length, studioClosedOn(d.date, studioHours)),
  }));

  const sortedRows = useMemo(() => {
    const rows = [...m.repRows];
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const an = typeof av === "number" ? av : String(av ?? "");
      const bn = typeof bv === "number" ? bv : String(bv ?? "");
      if (an < bn) return sortAsc ? -1 : 1;
      if (an > bn) return sortAsc ? 1 : -1;
      return 0;
    });
    return rows;
  }, [m.repRows, sortKey, sortAsc]);

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(key === "name");
    }
  };

  // Real <button> sort headers with aria-sort (spec §3.6); idle caret hints the
  // direction the next click applies (name ascends, numbers descend).
  const th = (key: SortKey, label: string, opts?: { left?: boolean; hideBelowMd?: boolean }) => {
    const active = sortKey === key;
    const caret = active ? (sortAsc ? "↑" : "↓") : key === "name" ? "↑" : "↓";
    return (
      <th
        scope="col"
        aria-sort={active ? (sortAsc ? "ascending" : "descending") : undefined}
        className={`sticky top-14 z-[1] bg-(--sticky-header-bg) backdrop-blur-sm ${opts?.left ? "text-left" : "text-right"} ${opts?.hideBelowMd ? "hidden md:table-cell" : ""}`}
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

  return (
    <div className="space-y-5">
      {/* 1 — header & context */}
      <header>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className="text-xl font-semibold tracking-tight text-(--text-primary)">Today</h1>
          <span className="text-[15px] font-medium text-(--text-faint)" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-(--text-caption)">{formatDateHuman(m.date)}</span>
          <span className="text-[15px] font-medium text-(--text-faint)" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-(--text-caption)">
            Week of {formatDateHuman(m.weekStart)}
          </span>
          {/* live-state indicator (owner hard rule): Today is always the live week */}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-(--chip-positive-bg) bg-(--chip-positive-bg) px-2 py-0.5 text-xs font-semibold text-(--chip-positive-fg)">
            <span className="h-1.5 w-1.5 rounded-full bg-(--dot-positive)" aria-hidden="true" />
            Current Week
          </span>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-(--text-caption)">
          <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
          <span>
            {data.cohortNote} (America/New_York)
          </span>
        </p>
        {bannerMessages.length > 0 && (
          <div className="status-banner mt-2" role="status">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
            <span className="min-w-0 truncate" title={bannerMessages.join(" · ")}>
              {bannerMessages.join(" · ")}
            </span>
          </div>
        )}
      </header>

      {/* 2 — primary performance KPI row (the 10-second answer) */}
      <section aria-label="Bookings and pace">
        <div className="card grid grid-cols-2 gap-y-6 p-0 sm:grid-cols-3 xl:grid-cols-6 xl:gap-y-0 xl:divide-x xl:divide-(--table-border-weak)">
          <KpiHero label="Bookings WTD" value={m.bookings.wtd} sub={`of ${m.bookings.weeklyGoal} goal`} pace={paceState ?? undefined} />
          <KpiHero label="Remaining" value={m.bookings.remaining} sub="bookings left" />
          <KpiHero
            label="Daily Pace Needed"
            value={m.bookings.paceNeeded}
            sub={m.paceWeekend ? "team is off — pace resumes Monday" : "to hit goal"}
          />
          <KpiHero
            label="Goal Achievement"
            value={pct(m.bookings.goalAchievement, 1)}
            sub="of weekly goal"
            pace={paceState ?? undefined}
          />
          <KpiHero label="Yesterday's Bookings" value={m.bookings.yesterday} />
          <KpiHero label="Bookings Today" value={m.bookings.today} />
        </div>
      </section>

      {/* 3 — secondary operations row */}
      <section aria-label="Calls and conversions">
        <div className="card">
          <p className="section-heading">Calls &amp; Conversions (today)</p>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-5">
            <KpiMid label="Total Calls" value={m.callsToday.total} />
            <KpiMid label="Calls Over 2 Min" value={m.callsToday.overThreshold} sub="meaningful conversations" />
            <KpiMid label="Avg Call Duration" value={mins(m.callsToday.avgDurationSeconds)} />
            <KpiMid label="Conversation Conversion" value={pct(m.conversionsToday.conversation, 1)} />
            <KpiMid label="Assigned Lead Conversion" value={pct(m.conversionsToday.assignedLead, 1)} />
          </div>
        </div>
      </section>

      {/* 4a — studio availability (own FULL-width band, global-layout-spec TODAY order:
          availability before the compact leads block — never a stretch pair) */}
      <section aria-label="Studio availability">
        <div className="card card-dense">
          <p className="section-heading">Studio Availability</p>
          <div className="mt-3">
            <DayCardStrip days={dayCards} />
          </div>
        </div>
      </section>

      {/* 4b — leads worked today (compact FULL/STRIP-class block) */}
      <section aria-label="Leads worked today">
        <div className="card">
          <p className="section-heading">Leads — worked today (work-date logic)</p>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
            <KpiMid label="Family Leads Today" value={m.leads.today.family} />
            <KpiMid label="Animalia Leads Today" value={m.leads.today.animalia} />
            <div>
              <p className="kpi-label">Total Leads Today</p>
              <p className="kpi-value mt-2">{m.leads.today.total}</p>
            </div>
            <KpiMid label="Weekly Leads" value={m.leads.weekly.total} sub={`budget ${m.leads.weeklyBudget}`} />
            <BudgetTile
              label="% Lead Budget Used"
              value={pct(m.leads.percentUsed, 1)}
              sub={
                m.paceWeekend
                  ? `${m.leads.remaining} remaining — team is off, pace resumes Monday`
                  : `${m.leads.remaining} remaining · ${m.leads.dailyNeeded}/day needed`
              }
              percentUsed={m.leads.percentUsed}
            />
          </div>
        </div>
      </section>

      {/* 5 — management attention */}
      <AttentionPanel notes={notes} />

      {/* 6 — rep performance (weekly, management-first list — owner directive
          2026-09-27). Combined Goal Progress per active rep; pooled (never
          arithmetic-average) team benchmarks; secondary metrics expand per
          row; whole row opens that rep on the Reps page with the week kept. */}
      <section aria-label="Rep performance">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="section-heading">Rep Performance — this week</p>
          <p className="text-xs font-normal text-(--text-muted)">
            Team benchmarks are pooled (sum ÷ sum) over other active reps — never averages of percentages ·
            rule-based, no scores
          </p>
        </div>
        <div className="card mt-3 overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="data-table min-w-[900px] [&_tbody_tr]:scroll-mt-24 [&_td]:py-2.5">
              <thead>
                <tr>
                  {th("name", "Rep", { left: true })}
                  {th("totalBookings", "Bookings / Goal", { left: true })}
                  {th("callsOverThreshold", "Calls >2 Min")}
                  {th("conversationConversion", "Conv. Conversion")}
                  {th("assignedLeadConversion", "Assigned Lead Conv.")}
                  {th("avgCallDurationSeconds", "Avg Call", { hideBelowMd: true })}
                  <th scope="col" aria-hidden="true" className="w-8" />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const p = pooled.get(r.repId);
                  const chip = chipFor(r, p?.conv.rate ?? null, weekElapsed);
                  const gp = goalProgressView(r.actual, r.goal, r.operatingState);
                  const expanded = expandedRepId === r.repId;
                  const open = () => navigate({ to: repPerfLink(m.weekStart, r.repId) });
                  const convDelta = pooledPtsDelta(r.conversationConversion, p?.conv.rate ?? null);
                  const assignedDelta = pooledPtsDelta(r.assignedLeadConversion, p?.assigned.rate ?? null);
                  return (
                    [
                      <tr
                        key={r.repId}
                        onClick={open}
                        className={"cursor-pointer " + (expanded ? "bg-(--surface-selected)" : "")}
                      >
                        <td className="text-left align-top">
                          <a
                            href={repPerfLink(m.weekStart, r.repId)}
                            onClick={(e) => {
                              e.preventDefault();
                              open();
                            }}
                            onKeyDown={(e) => {
                              if (e.key === " ") {
                                e.preventDefault();
                                open();
                              }
                            }}
                            className="font-medium text-(--text-primary) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                            aria-label={`Open ${r.name} on the Reps page, week of ${formatDateHuman(m.weekStart)}`}
                          >
                            {r.name}
                          </a>
                          {chip && <span className="ml-2 inline-block align-middle"><StatusChip kind={chip.kind} label={chip.label} /></span>}
                        </td>
                        <td className="text-left align-top">
                          <GoalProgressCell view={gp} />
                        </td>
                        <td className="text-right align-top">
                          <span className={r.callsOverThreshold === 0 ? "text-(--text-faint)" : "font-semibold text-(--text-primary)"}>
                            {r.callsOverThreshold}
                          </span>
                        </td>
                        <td className="text-right align-top">
                          {num(pct(r.conversationConversion, 1))}
                          <PooledLine rep={r.conversationConversion} pooled={p?.conv} delta={convDelta} />
                        </td>
                        <td className="text-right align-top">
                          {num(pct(r.assignedLeadConversion, 1))}
                          <PooledLine rep={r.assignedLeadConversion} pooled={p?.assigned} delta={assignedDelta} />
                        </td>
                        <td className="hidden text-right align-top md:table-cell">
                          <span className={r.avgCallDurationSeconds == null ? "text-(--text-faint)" : "text-(--text-caption)"}>
                            {mins(r.avgCallDurationSeconds)}
                          </span>
                        </td>
                        <td className="text-right align-top">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedRepId(expanded ? null : r.repId);
                            }}
                            aria-expanded={expanded}
                            aria-label={expanded ? `Hide details for ${r.name}` : `Show details for ${r.name}`}
                            className="relative z-[1] rounded-md px-1.5 py-1 text-[11px] text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                          >
                            <span aria-hidden="true">{expanded ? "▲" : "▼"}</span>
                          </button>
                        </td>
                      </tr>,
                      expanded && (
                        <tr key={`${r.repId}-detail`} className="bg-(--surface-subtle)">
                          <td colSpan={7} className="border-b border-(--table-border-weak) px-1 pb-4 pt-1">
                            <RepDetailPanel row={r} conv={p?.conv} assigned={p?.assigned} />
                          </td>
                        </tr>
                      ),
                    ]
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * OWNER DIRECTIVE (2026-09-27) — ONE combined Goal Progress component
 * ("8 / 10 · [bar] · 80%" + "2 below goal"), replacing the old unrelated
 * Goal % and Actual/Goal columns and the raw-bookings vs-team deltas.
 * Same theme tokens as GoalProgress.tsx (bar track/fill, hit → emerald).
 */
function GoalProgressCell({ view }: { view: GoalProgressView }) {
  if (view.state === "inactive") {
    return <span className="text-(--text-faint)">—</span>;
  }
  if (view.state === "no-goal") {
    return (
      <span className="text-[13px] text-(--text-muted)">
        No goal set <span className="text-(--text-faint)">—</span>
      </span>
    );
  }
  return (
    <span className="block w-full max-w-[150px]">
      <span className="flex items-center gap-2">
        <span className="whitespace-nowrap text-[13px] font-semibold tabular-nums text-(--text-primary)">
          {view.actual} <span className="font-normal text-xs text-(--text-muted)">/ {view.goal}</span>
        </span>
        <span className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
          <span
            className={"block h-full rounded-full " + (view.hit ? "bg-(--bar-fill-hit)" : "bg-(--bar-fill)")}
            style={{ width: `${view.barPct}%` }}
          />
        </span>
        <span className="whitespace-nowrap text-[11px] tabular-nums text-(--text-caption)">{view.pctText}</span>
      </span>
      {view.diffText && (
        <span className="mt-0.5 block text-[11px] text-(--text-muted)">{view.diffText}</span>
      )}
    </span>
  );
}

/**
 * Pooled-benchmark sub-line: "Team 42.7% · −33.0 pts". Pooled denominator 0 →
 * "Team —" with NO pts delta (owner directive: never a 0% fiction). No color —
 * the sign carries direction (same restraint as DeltaLine).
 */
function PooledLine({
  rep,
  pooled,
  delta,
}: {
  rep: number | null;
  pooled: PooledRate | undefined;
  delta: number | null;
}) {
  if (!pooled || pooled.reps === 0) return null;
  const parts = [`Team ${pooled.rate == null ? "—" : (pooled.rate * 100).toFixed(1)}%`];
  if (rep != null && delta != null) {
    const d = formatPtsDelta(delta);
    if (d != null) parts.push(d);
  }
  return <span className="delta-line mt-0.5 block text-right">{parts.join(" · ")}</span>;
}

/**
 * Expandable per-row detail panel (owner directive): the secondary metrics
 * moved out of the primary list — Total Calls, Bookings From Calls >2 Minutes,
 * assigned lead count, start date, the pooled benchmark numerators/denominators
 * (auditable to the sum), and the rep's call-audit records (Audit page, filtered
 * to this rep — that is where per-rep audit rows live; the Today payload does
 * not carry an override history, and none is fabricated here).
 */
function RepDetailPanel({
  row,
  conv,
  assigned,
}: {
  row: RepPerformanceRow;
  conv: PooledRate | undefined;
  assigned: PooledRate | undefined;
}) {
  const detailCell = (label: string, value: string) => (
    <div>
      <p className="kpi-label">{label}</p>
      <p className="mt-1 text-[15px] font-semibold tabular-nums text-(--text-primary)">{value}</p>
    </div>
  );
  const benchLine = (label: string, p: PooledRate | undefined, numLabel: string, denLabel: string) => {
    if (!p || p.reps === 0) return `${label}: no qualifying data among other active reps`;
    return p.rate == null
      ? `${label}: — — pooled denominator 0 (${p.numerator} ${numLabel} ÷ 0 ${denLabel}) across ${p.reps} other active rep${p.reps === 1 ? "" : "s"}`
      : `${label}: ${(p.rate * 100).toFixed(1)}% — ${p.numerator} ${numLabel} ÷ ${p.denominator} ${denLabel} across ${p.reps} other active rep${p.reps === 1 ? "" : "s"}`;
  };
  return (
    <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {detailCell("Total Calls", String(row.totalCalls))}
        {detailCell("Bookings From >2 Min", String(row.bookingsFromOverThreshold))}
        {detailCell("Assigned Leads", String(row.assignedLeads))}
        {detailCell("Start Date", row.callStartDate ? formatDateHuman(row.callStartDate) : "—")}
      </div>
      <div className="space-y-1.5 text-[12px] leading-relaxed text-(--text-muted)">
        {/* Goal basis (owner directive 2026-09-27): resolveRepGoal's note,
            verbatim — where this week's goal came from. Omitted when the row
            carries no resolution metadata (never invented here). */}
        {row.goalNote && <p>Goal basis: {row.goalNote}</p>}
        <p>
          {benchLine("Conversation benchmark", conv, "bookings from >120s calls", "calls >120s")}
          {" · this rep: "}
          {row.bookingsFromOverThreshold} ÷ {row.callsOverThreshold}.
        </p>
        <p>
          {benchLine("Assigned-lead benchmark", assigned, "bookings", "assigned leads")}
          {" · this rep: "}
          {row.totalBookings} ÷ {row.assignedLeads}.
        </p>
        <p>
          <a
            href={`/audit?rep=${row.repId}`}
            className="font-medium text-(--text-body) underline decoration-(--table-border-strong) underline-offset-2 hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
          >
            Call audit records for {row.name} →
          </a>
          {" · attribution assignment history: Audit page."}
        </p>
      </div>
    </div>
  );
}

/** Hero KPI cell (spec §3.1): label → 5xl number → subtext, pace dot beside the label. */
function KpiHero({
  label,
  value,
  sub,
  pace,
}: {
  label: string;
  value: string | number;
  sub?: string;
  pace?: "on" | "off";
}) {
  return (
    <div className="px-5 py-4">
      <p className="kpi-label flex items-center gap-1.5">
        {pace && (
          <span
            className={`h-1.5 w-1.5 rounded-full ${pace === "on" ? "bg-(--dot-positive)" : "bg-(--dot-caution)"}`}
            title={pace === "on" ? "On pace for the weekly goal" : "Behind weekly pace"}
            aria-hidden="true"
          />
        )}
        {label}
      </p>
      <p className="kpi-hero mt-2">{num(String(value))}</p>
      {sub && <p className="kpi-sub mt-1.5">{sub}</p>}
    </div>
  );
}

/** Secondary KPI cell (spec §3.2): same stack at text-3xl. No comparisons. */
function KpiMid({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div>
      <p className="kpi-label">{label}</p>
      <p className="kpi-mid mt-2">{num(String(value))}</p>
      {sub && <p className="kpi-sub mt-1.5">{sub}</p>}
    </div>
  );
}

/** % Lead Budget Used tile with the 4px utilization meter + over-budget dot (spec §3.3). */
function BudgetTile({
  label,
  value,
  sub,
  percentUsed,
}: {
  label: string;
  value: string;
  sub: string;
  percentUsed: number | null;
}) {
  const over = percentUsed != null && percentUsed > 1;
  return (
    <div>
      <p className="kpi-label flex items-center gap-1.5">
        {over && <span className="h-1.5 w-1.5 rounded-full bg-(--dot-caution)" aria-hidden="true" />}
        {label}
      </p>
      <p className="kpi-mid mt-2">{num(value)}</p>
      {percentUsed != null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
          <div
            className={`h-1 rounded-full ${over ? "bg-(--dot-caution)" : "bg-(--bar-fill)"}`}
            style={{ width: `${Math.min(percentUsed, 1) * 100}%` }}
          />
        </div>
      )}
      <p className="kpi-sub mt-1.5">{sub}</p>
    </div>
  );
}
