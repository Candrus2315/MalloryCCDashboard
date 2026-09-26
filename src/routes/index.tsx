import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { demoAwarenessLine, getTodayData } from "~/server/queries";
import { formatDateHuman } from "~/server/date-logic";
import { AttentionPanel } from "~/components/AttentionPanel";
import { DayCardStrip, type DayCardData } from "~/components/DayCardStrip";
import { DeltaLine } from "~/components/DeltaLine";
import { StatusChip } from "~/components/StatusChip";
import {
  attentionNotes,
  availabilityStatusView,
  chipFor,
  studioClosedOn,
  teamMeansExcluding,
  weekElapsedFraction,
  type TeamColumnMeans,
} from "~/components/today-views";

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
  return v === "—" ? <span className="text-stone-300">—</span> : v;
}

type SortKey =
  | "name"
  | "totalCalls"
  | "callsOverThreshold"
  | "bookingsFromOverThreshold"
  | "totalBookings"
  | "conversationConversion"
  | "assignedLeadConversion"
  | "avgCallDurationSeconds"
  | "goalPercent"
  | "actual";

function TodayPage() {
  const data = Route.useLoaderData();
  const m = data.metrics;
  const [sortKey, setSortKey] = useState<SortKey>("totalBookings");
  const [sortAsc, setSortAsc] = useState(false);

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

  // Per-rep team means (self excluded, buildTeamAverages semantics) for chips + deltas.
  const teamMeans = useMemo(() => {
    const map = new Map<string, TeamColumnMeans>();
    for (const r of m.repRows) map.set(r.repId, teamMeansExcluding(m.repRows, r.repId));
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
        className={`sticky top-14 z-[1] bg-white/95 backdrop-blur-sm ${opts?.left ? "text-left" : "text-right"} ${opts?.hideBelowMd ? "hidden md:table-cell" : ""}`}
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

  return (
    <div className="space-y-5">
      {/* 1 — header & context */}
      <header>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className="text-xl font-semibold tracking-tight text-stone-900">Today</h1>
          <span className="text-[15px] font-medium text-stone-300" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-stone-500">{formatDateHuman(m.date)}</span>
          <span className="text-[15px] font-medium text-stone-300" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-stone-500">
            Week of {formatDateHuman(m.weekStart)}
          </span>
          {/* live-state indicator (owner hard rule): Today is always the live week */}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            Current Week
          </span>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-stone-500">
          <span className="h-1 w-1 shrink-0 rounded-full bg-stone-300" aria-hidden="true" />
          <span>
            {data.cohortNote} (America/New_York)
          </span>
        </p>
        {bannerMessages.length > 0 && (
          <div className="status-banner mt-2" role="status">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
            <span className="min-w-0 truncate" title={bannerMessages.join(" · ")}>
              {bannerMessages.join(" · ")}
            </span>
          </div>
        )}
      </header>

      {/* 2 — primary performance KPI row (the 10-second answer) */}
      <section aria-label="Bookings and pace">
        <div className="card grid grid-cols-2 gap-y-6 p-0 sm:grid-cols-3 xl:grid-cols-6 xl:gap-y-0 xl:divide-x xl:divide-stone-100">
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

      {/* 4 — lead load + studio availability */}
      <section className="grid gap-4 lg:grid-cols-5" aria-label="Leads and availability">
        <div className="card lg:col-span-3">
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
        <div className="card card-dense lg:col-span-2">
          <p className="section-heading">Studio Availability</p>
          <div className="mt-3">
            <DayCardStrip days={dayCards} />
          </div>
        </div>
      </section>

      {/* 5 — management attention */}
      <AttentionPanel notes={notes} />

      {/* 6 — rep performance (weekly, sortable) */}
      <section aria-label="Rep performance">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="section-heading">Rep Performance — this week</p>
          <p className="text-xs font-normal text-stone-400">
            Team averages exclude each rep's own row · rule-based, no scores
          </p>
        </div>
        <div className="card mt-3 overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="data-table min-w-[960px] [&_td]:py-2.5 [&_tbody_tr:hover]:bg-stone-50">
              <thead>
                <tr>
                  {th("name", "Rep", { left: true })}
                  {th("totalBookings", "Total Bookings")}
                  {th("conversationConversion", "Conv. Conversion")}
                  {th("assignedLeadConversion", "Assigned Lead Conv.")}
                  {th("goalPercent", "Goal %")}
                  {th("actual", "Actual / Goal")}
                  {th("totalCalls", "Total Calls", { hideBelowMd: true })}
                  {th("callsOverThreshold", "Calls >2 Min", { hideBelowMd: true })}
                  {th("bookingsFromOverThreshold", "Bookings from >2 Min", { hideBelowMd: true })}
                  {th("avgCallDurationSeconds", "Avg Call", { hideBelowMd: true })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const tm = teamMeans.get(r.repId);
                  const chip = chipFor(r, tm?.conversationConversion ?? null, weekElapsed);
                  return (
                    <tr key={r.repId}>
                      <td className="text-left align-top">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-stone-900">{r.name}</span>
                          {chip && <StatusChip kind={chip.kind} label={chip.label} />}
                        </span>
                      </td>
                      <td className="text-right align-top">
                        <span className="font-semibold text-stone-900 tabular-nums">{r.totalBookings}</span>
                        <DeltaLine rep={r.totalBookings} team={tm?.totalBookings ?? null} unit="pct" />
                      </td>
                      <td className="text-right align-top">
                        {num(pct(r.conversationConversion, 1))}
                        <DeltaLine rep={r.conversationConversion} team={tm?.conversationConversion ?? null} unit="pts" />
                      </td>
                      <td className="text-right align-top">
                        {num(pct(r.assignedLeadConversion, 1))}
                        <DeltaLine rep={r.assignedLeadConversion} team={tm?.assignedLeadConversion ?? null} unit="pts" />
                      </td>
                      <td className="text-right align-top">{num(pct(r.goalPercent, 0))}</td>
                      <td className="text-right align-top">
                        <span className="font-semibold text-stone-900 tabular-nums">{r.actual}</span>
                        <span className="text-stone-400"> / {r.goal > 0 ? r.goal : "—"}</span>
                      </td>
                      <td className="hidden text-right align-top md:table-cell">
                        <span className={r.totalCalls === 0 ? "text-stone-300" : "text-stone-500"}>{r.totalCalls}</span>
                      </td>
                      <td className="hidden text-right align-top md:table-cell">
                        <span className={r.callsOverThreshold === 0 ? "text-stone-300" : "text-stone-500"}>
                          {r.callsOverThreshold}
                        </span>
                      </td>
                      <td className="hidden text-right align-top md:table-cell">
                        <span className={r.bookingsFromOverThreshold === 0 ? "text-stone-300" : "text-stone-500"}>
                          {r.bookingsFromOverThreshold}
                        </span>
                      </td>
                      <td className="hidden text-right align-top md:table-cell">
                        <span className={r.avgCallDurationSeconds == null ? "text-stone-300" : "text-stone-500"}>
                          {mins(r.avgCallDurationSeconds)}
                        </span>
                      </td>
                    </tr>
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
            className={`h-1.5 w-1.5 rounded-full ${pace === "on" ? "bg-emerald-600" : "bg-amber-500"}`}
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
        {over && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />}
        {label}
      </p>
      <p className="kpi-mid mt-2">{num(value)}</p>
      {percentUsed != null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-stone-200" aria-hidden="true">
          <div
            className={`h-1 rounded-full ${over ? "bg-amber-500" : "bg-stone-900"}`}
            style={{ width: `${Math.min(percentUsed, 1) * 100}%` }}
          />
        </div>
      )}
      <p className="kpi-sub mt-1.5">{sub}</p>
    </div>
  );
}
