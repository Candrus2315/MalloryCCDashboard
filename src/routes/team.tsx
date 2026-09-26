import { createFileRoute } from "@tanstack/react-router";
import { WarningList } from "~/components/warnings";
import { Link, useRouter } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { getTeamData } from "~/server/queries";
import {
  RANGE_LABELS,
  RANGE_MODES,
  formatDateHumanFull,
  type RangeMode,
} from "~/server/date-logic";
import { TREND_MIN_DENOMINATOR, type TrendPoint } from "~/server/metrics/compute";
import {
  formatCount,
  formatDuration,
  formatInt,
  formatPercent,
} from "~/server/metrics/report-text";
import { TrendCard } from "~/components/trend-chart";
import { Segmented } from "~/components/Segmented";
import { StatusChip } from "~/components/StatusChip";
import { AttentionPanel } from "~/components/AttentionPanel";
import { attentionNotes, leadPacing, paceSummary, repChips } from "~/components/team-views";

export const Route = createFileRoute("/team")({
  validateSearch: (search: Record<string, unknown>) => ({
    range: typeof search.range === "string" ? search.range : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
  }),
  loaderDeps: ({ search }) => ({
    range: search.range,
    from: search.from,
    to: search.to,
  }),
  loader: ({ deps }) => getTeamData({ data: deps }),
  component: TeamPage,
});

/** Null renders "—" in stone-300 (never 0) — same rule as the Today/Reps pages. */
function num(v: string) {
  return v === "—" ? <span className="text-stone-300">—</span> : v;
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
  const toneCls = tone === "pos" ? "text-emerald-700" : tone === "neg" ? "text-red-700" : "text-stone-900";
  return (
    <div>
      <p className="text-xs font-medium text-stone-500">{label}</p>
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

type SortKey = "rep" | "bookings" | "calls" | "conv";

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

  const setRange = (mode: RangeMode) => {
    router.navigate({
      to: "/team",
      search: () => ({
        range: mode,
        from: mode === "custom" ? (customFrom || undefined) : undefined,
        to: mode === "custom" ? (customTo || undefined) : undefined,
      }),
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

  // sortable by-rep rows (native, no deps; missing values sort last, never as zero)
  const sortedRepRows = useMemo(() => {
    const rows = [...data.repRows];
    rows.sort((a, b) => {
      if (sortKey === "rep") return a.name.localeCompare(b.name) * (sortAsc ? 1 : -1);
      const av = sortKey === "bookings" ? a.totalBookings : sortKey === "calls" ? a.callsOverThreshold : a.conversationConversion;
      const bv = sortKey === "bookings" ? b.totalBookings : sortKey === "calls" ? b.callsOverThreshold : b.conversationConversion;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * (sortAsc ? 1 : -1);
    });
    return rows;
  }, [data.repRows, sortKey, sortAsc]);

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(key === "rep");
    }
  };

  const th = (key: SortKey, label: string, opts?: { left?: boolean }) => {
    const active = sortKey === key;
    const caret = active ? (sortAsc ? "↑" : "↓") : key === "rep" ? "↑" : "↓";
    return (
      <th
        scope="col"
        aria-sort={active ? (sortAsc ? "ascending" : "descending") : undefined}
        className={"pb-2 " + (opts?.left ? "text-left" : "text-right")}
      >
        <button type="button" className="th-sort-btn normal-case tracking-normal text-xs text-stone-500" onClick={() => sortBy(key)}>
          {label}
          <span aria-hidden="true" className={active ? "text-stone-900" : "text-stone-400"}>
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
          <h1 className="text-xl font-semibold tracking-tight text-stone-900">Team</h1>
          <span className="text-[15px] font-medium text-stone-300" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-stone-500">Team Performance</span>
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

      {/* team performance summary + goal pacing — the above-the-fold story */}
      <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <section className="card" aria-label="Team performance summary">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="section-heading">Team Performance</p>
            <p className="text-xs text-stone-400">Meaningful call threshold: {data.thresholdSeconds}s</p>
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

          <hr className="my-5 border-stone-100" />

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
            <p className="mt-4 flex items-start gap-1.5 text-xs text-amber-800">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
              Assigned Lead Conversion unavailable for this range because no assigned leads were worked.
            </p>
          )}
        </section>

        {/* GOAL PACING — one unit: number line, bar, sentence (spec §2) */}
        <section className="card flex flex-col" aria-label="Goal pacing">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="section-heading">Goal Pacing</p>
            <p className="max-w-[240px] text-right text-[11px] leading-snug text-stone-400">{m.goal.note}</p>
          </div>
          <div className="mt-3">
            <p className="kpi-hero">
              {formatInt(ps.actual)}
              {ps.goalValue > 0 && (
                <span className="text-2xl font-medium text-stone-400"> / {formatCount(ps.goalValue)} bookings</span>
              )}
            </p>
            <p className="kpi-sub mt-1.5">bookings created in range</p>
          </div>
          {ps.barPct != null && (
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-stone-200" aria-hidden="true">
              <div
                className={"h-1.5 rounded-full " + (ps.hit ? "bg-emerald-600" : "bg-stone-900")}
                style={{ width: `${ps.barPct}%` }}
              />
            </div>
          )}
          {ps.achieved != null ? (
            <p className="mt-4 text-[13px] leading-relaxed text-stone-500">
              <span className={"font-semibold " + (ps.hit ? "text-emerald-700" : "text-stone-900")}>{ps.achieved}</span>{" "}
              achieved
              <span className="mx-1.5 text-stone-300">·</span>
              <span className="font-semibold text-stone-900">{ps.remaining}</span> remaining
              <span className="mx-1.5 text-stone-300">·</span>
              <span className="font-medium text-stone-700">{ps.paceClause}</span>
            </p>
          ) : (
            <p className="mt-4 text-[13px] text-stone-500">{ps.paceClause}</p>
          )}
          {ps.paceFootnote && <p className="kpi-sub mt-1.5">{ps.paceFootnote}</p>}
        </section>
      </div>

      {/* TRENDS — structured analytics grid, two labeled rows (spec §3) */}
      <section aria-label="Trends">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="section-heading">Trends</p>
          <p className="text-xs text-stone-400">{t.bucketNote}</p>
        </div>
        <p className="mt-3 text-xs font-semibold text-stone-500">Performance trends</p>
        <div className="mt-2 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <TrendCard title="Bookings" points={pointsOf(t.points, (p) => p.bookings)} unit="int" />
          <TrendCard title="Calls" points={pointsOf(t.points, (p) => p.calls)} unit="int" />
          <TrendCard
            title="Calls Over 2 Minutes"
            points={pointsOf(t.points, (p) => p.callsOverThreshold)}
            unit="int"
            note={`duration > ${data.thresholdSeconds}s`}
          />
          <TrendCard
            title="Conversation Conversion"
            points={pointsOf(t.points, (p) => p.conversationConversion)}
            unit="pct"
            note={sparseNote}
          />
        </div>
        <p className="mt-4 text-xs font-semibold text-stone-500">Lead &amp; efficiency trends</p>
        <div className="mt-2 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <TrendCard
            title="Assigned Lead Conversion"
            points={pointsOf(t.points, (p) => p.assignedLeadConversion)}
            unit="pct"
            note={sparseNote}
          />
          <TrendCard
            title="Average Call Duration"
            points={pointsOf(t.points, (p) => p.avgCallDurationSeconds)}
            unit="duration"
          />
        </div>
      </section>

      {/* LEAD VOLUME & BUDGET PACING — answers "are we getting enough leads?" (spec §4) */}
      <section aria-label="Lead volume and budget pacing">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="section-heading">Lead Volume &amp; Budget Pace</p>
          {lp.verdict ? (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] font-medium text-stone-700">
              <span
                className={
                  "h-1.5 w-1.5 shrink-0 rounded-full " +
                  (lp.verdict === "Below budget pace" ? "bg-amber-500" : "bg-emerald-600")
                }
                aria-hidden="true"
              />
              <span className={lp.verdict === "Below budget pace" ? "text-amber-800" : "text-emerald-700"}>
                {lp.verdict}
              </span>
              <span className="font-normal text-stone-500">
                · {formatInt(lp.leads)} leads in range · {lp.pct} of budget pace
                {lp.delta ? ` (${lp.delta})` : ""}
              </span>
            </p>
          ) : (
            <p className="text-[13px] text-stone-500">{formatInt(lp.leads)} leads in range</p>
          )}
        </div>
        <div className="mt-2">
          <TrendCard
            wide
            title="Leads by work date"
            points={pointsOf(t.points, (p) => p.leads)}
            unit="int"
            refLine={refLine}
            note={leadNote}
          />
        </div>
      </section>

      {/* BY REP — sortable, chips rule-based from real metrics (spec §5) */}
      <section aria-label="Team by rep">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="section-heading">By Rep</p>
          <p className="text-xs text-stone-400">Click a rep for their full detail on the Reps page</p>
        </div>
        <div className="card mt-2 overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="border-b border-stone-200">
                  {th("rep", "Rep", { left: true })}
                  {th("bookings", "Bookings")}
                  {th("calls", "Calls > 2 Min")}
                  {th("conv", "Conversation Conversion")}
                </tr>
              </thead>
              <tbody>
                {sortedRepRows.map((r) => {
                  const chip = chips.get(r.id);
                  return (
                    <tr key={r.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                      <td className="py-2.5 pr-4">
                        <Link
                          to="/reps"
                          search={{
                            rep: r.id,
                            range: data.range.mode,
                            from: data.range.mode === "custom" ? data.range.start : undefined,
                            to: data.range.mode === "custom" ? data.range.end : undefined,
                          }}
                          className="font-medium text-stone-900 hover:underline"
                        >
                          {r.name}
                        </Link>
                        {chip && (
                          <span className="ml-2 inline-flex align-middle">
                            <StatusChip kind={chip.kind} label={chip.label} />
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-medium tabular-nums text-stone-900">
                        {formatInt(r.totalBookings)}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-stone-900">
                        {formatInt(r.callsOverThreshold)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-stone-700">
                        {num(formatPercent(r.conversationConversion, 1))}
                      </td>
                    </tr>
                  );
                })}
                {data.repRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-stone-400">
                      No reps found — sync HighLevel users.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-stone-400">
          Chips are rule-based from these columns — top bookings, conversion above team average (≥
          {TREND_MIN_DENOMINATOR} reps with a value), calls but no bookings, or no recorded activity; no grades.
          Assigned Lead Conversion per rep lives on each rep's page.
        </p>
      </section>

      {/* TEAM ATTENTION — rule-based, 3–5 notes, no fake AI (spec §6) */}
      <AttentionPanel
        title="Team Attention"
        subtitle="Rule-based from this range's metrics — no scores."
        notes={notes}
      />

      <p className="text-[11px] leading-snug text-stone-400">
        Bookings counted by created_at (America/New_York) · leads by work_date · team goal = weekly goals summed over
        the range's weeks · Daily Pace Needed = bookings remaining ÷ working days left in the range's final week (never
        negative). Every figure comes from the same metrics layer as every other page.
      </p>
    </div>
  );
}
