import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { demoAwarenessLine, dismissPendingPayment, getTodayData } from "~/server/queries";
import { formatDateHuman } from "~/server/date-logic";
import { AttentionPanel } from "~/components/AttentionPanel";
import { DayCardStrip, type DayCardData } from "~/components/DayCardStrip";
import { InfoTip } from "~/components/InfoTip";
import { cycleChip, dateWithWeekday, poolChip } from "~/components/commission-views";
import { StatusChip } from "~/components/StatusChip";
// Harmonization Wave 1: Today composes the SAME page primitives as Daily
// Report / Weekly / Commission Center (Panel / Eyebrow / RatioBar).
import { Eyebrow, Panel, RatioBar } from "~/components/page-panel";
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

/** One row of the Pending Payments drill-down (unpaid booking — never counted). */
export interface PendingPaymentRow {
  appointment_id: string;
  acuity_appointment_id: string | null;
  client_name: string | null;
  appointment_type: string;
  amount: number | null;
  amountPaid: number | null;
  rep_id: string | null;
  rep_name: string | null;
  created_business_date: string | null;
  created_at: string;
  appointment_datetime: string;
}

/**
 * Clickable Pending Payments drill-down (owner directive, rev 12): lists
 * unpaid bookings with rep + amount. Deposits not yet received — these hold
 * availability and are visible here, but count toward NO performance number
 * until paid.
 */
function PendingPaymentsDrillDown({ rows }: { rows: PendingPaymentRow[] }) {
  // QA 2026-10-08: the established currency style is $X,XXX.00 (commission
  // card, payroll email) — the drill-down previously printed a bare "200".
  const fmtAmount = (n: number | null) =>
    n == null
      ? "—"
      : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // OWNER REQUEST 9/30 (✕ dismiss): each pending row carries a ✕ that removes
  // it from this list immediately and permanently — optimistic removal, no
  // confirm dialog ("as i see fit"). On a server error the card snaps back
  // and the message surfaces inline. The dismissal is server-persisted, so
  // it survives syncs/restarts; a later-paid appointment still counts as a
  // Booking Win everywhere.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const visible = rows.filter((r) => !dismissedIds.has(r.appointment_id));
  const dismiss = async (appointmentId: string) => {
    setError(null);
    setBusyId(appointmentId);
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(appointmentId);
      return next;
    });
    try {
      await dismissPendingPayment({ data: { appointmentId } });
    } catch (e) {
      setDismissedIds((prev) => {
        const next = new Set(prev);
        next.delete(appointmentId);
        return next;
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };
  return (
    <details className="card card-dense mt-3">
      <summary className="cursor-pointer select-none">
        <span className="section-heading inline-flex items-center gap-2">
          Pending Payments ({visible.length})
          <span className="text-xs font-normal text-(--text-muted)">— awaiting deposit · not counted</span>
        </span>
      </summary>
      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-(--chip-risk-fg)">
          Could not dismiss: {error}
        </p>
      )}
      {visible.length === 0 ? (
        <p className="mt-3 text-xs text-(--text-muted)">All pending payments dismissed — nothing awaiting deposit.</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="data-table min-w-[560px]">
              <thead>
                <tr>
                  <th scope="col" className="text-left">Client</th>
                  <th scope="col" className="text-right">Amount Due</th>
                  <th scope="col" className="text-left">Rep</th>
                  <th scope="col" className="text-left">Session Type</th>
                  <th scope="col" className="text-left">Booked On</th>
                  <th scope="col" className="w-8">
                    <span className="sr-only">Dismiss</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.appointment_id}>
                    <td className="text-left font-medium text-(--text-primary)">{r.client_name ?? "—"}</td>
                    <td className="text-right tabular-nums">{fmtAmount(r.amount)}</td>
                    <td className="text-left">
                      {r.rep_name ?? <span className="text-(--text-faint)">Unattributed</span>}
                    </td>
                    <td className="text-left text-(--text-caption)">{r.appointment_type || "—"}</td>
                    <td className="text-left text-(--text-caption)">
                      {r.created_business_date ? formatDateHuman(r.created_business_date) : "—"}
                    </td>
                    <td className="text-right align-middle">
                      <button
                        type="button"
                        onClick={() => void dismiss(r.appointment_id)}
                        disabled={busyId === r.appointment_id}
                        aria-label={`Dismiss from pending payments: ${r.client_name ?? r.appointment_type ?? "unknown client"}`}
                        title="Dismiss from pending payments (the appointment is kept — it only leaves this list)"
                        className="rounded-md px-1.5 py-0.5 text-xs leading-none text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:opacity-40"
                      >
                        <span aria-hidden="true">✕</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-(--text-muted)">
            Deposit not yet received (Acuity paid = no). These bookings hold studio availability and stay visible here, but count toward no bookings, conversion, or goal number until the deposit is paid. ✕ removes an item from this list permanently — if the deposit arrives later, the booking still counts as a Booking Win.
          </p>
        </>
      )}
    </details>
  );
}

function TodayPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const m = data.metrics;
  // PENDING PAYMENTS drill-down (rev 12): unpaid bookings — visible, never counted.
  const pendingPayments: PendingPaymentRow[] = data.pendingPayments ?? [];
  const pendingCount = pendingPayments.length;
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

  // Lead-band presentation values (Wave 1, Daily Report §3 geometry): the mix
  // bar widths are shares of TODAY'S total — the legend always prints the
  // payload's raw counts, so no new metric is created. `leadBudgetOver` is the
  // existing over-budget test (was BudgetTile's `over`).
  const leadBudgetOver = m.leads.percentUsed != null && m.leads.percentUsed > 1;
  const todayMixTotal = m.leads.today.total;
  const animaliaPct = todayMixTotal > 0 ? Math.min(100, (m.leads.today.animalia / todayMixTotal) * 100) : 0;
  const familyPct = todayMixTotal > 0 ? Math.min(100, (m.leads.today.family / todayMixTotal) * 100) : 0;

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
  // Mobile shell header is 68px tall — sticky offsets pair via top-[68px]
  // md:top-14. The rep column is sticky LEFT too (opaque bg, team.tsx pattern)
  // so horizontal scroll on phones never loses row identity (stickyLeft on the
  // FIRST column only; `left` remains pure text alignment).
  const th = (key: SortKey, label: string, opts?: { left?: boolean; hideBelowMd?: boolean; stickyLeft?: boolean }) => {
    const active = sortKey === key;
    const caret = active ? (sortAsc ? "↑" : "↓") : key === "name" ? "↑" : "↓";
    return (
      <th
        scope="col"
        aria-sort={active ? (sortAsc ? "ascending" : "descending") : undefined}
        className={`sticky top-[68px] z-[2] md:top-14 ${opts?.stickyLeft ? "left-0 z-[3] bg-(--card-bg)" : "bg-(--sticky-header-bg) backdrop-blur-sm"} ${opts?.left ? "text-left" : "text-right"} ${opts?.hideBelowMd ? "hidden md:table-cell" : ""}`}
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
      {/* 1 — compact header (Daily Report anatomy): title + live-state chip on
          line 1; date · week · timezone demoted to a meta line. The cohort
          definition stays behind the Leads section's InfoTip (unchanged copy). */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-(--text-primary)">Today</h1>
            {/* live-state indicator (owner hard rule): Today is always the live week */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-(--chip-positive-bg) bg-(--chip-positive-bg) px-2 py-0.5 text-xs font-semibold text-(--pos-text)">
              <span className="h-1.5 w-1.5 rounded-full bg-(--dot-positive)" aria-hidden="true" />
              Current Week
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-(--text-muted)">
            <span className="tabular-nums">
              {formatDateHuman(m.date)} · week of {formatDateHuman(m.weekStart)}
            </span>
            <span aria-hidden="true">·</span>
            <span>America/New_York</span>
          </p>
        </div>
        {bannerMessages.length > 0 && (
          <p className="status-banner" role="status">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
            <span className="min-w-0 truncate" title={bannerMessages.join(" · ")}>
              {bannerMessages.join(" · ")}
            </span>
          </p>
        )}
      </header>

      {/* 2 — WEEKLY BOOKING PACE hero (the 10-second answer). The six booking
          KPIs recomposed into the Daily-Report hero anatomy: the weekly goal is
          the anchor (primary, left), today's activity supports (right). Every
          number renders through the SAME expressions as before — presentation
          only. REV 12 semantics kept: "Bookings" = PAID Bookings (Booking Wins)
          — pending bookings stay visible and count toward nothing. */}
      <section aria-label="Bookings and pace">
        <Panel className="overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] lg:divide-x lg:divide-(--table-border-weak)">
            {/* left / primary — the weekly goal is the visual anchor */}
            <div className="p-5 sm:p-6">
              <Eyebrow>Booking Performance</Eyebrow>
              <p className="kpi-label mt-5 flex items-center gap-1.5">
                {paceState && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${paceState === "on" ? "bg-(--dot-positive)" : "bg-(--dot-caution)"}`}
                    title={paceState === "on" ? "On pace for the weekly goal" : "Behind weekly pace"}
                    aria-hidden="true"
                  />
                )}
                Bookings WTD
              </p>
              <p className="mt-2 flex items-baseline gap-2.5 tabular-nums">
                <span className="text-6xl font-semibold leading-none tracking-tight text-(--text-primary)">
                  {m.bookings.wtd}
                </span>
                <span className="text-3xl font-medium text-(--text-muted)">/ {m.bookings.weeklyGoal} goal</span>
              </p>
              {pendingCount > 0 && (
                <p className="kpi-sub mt-1.5">
                  {pendingCount} pending · of {m.bookings.weeklyGoal} goal
                </p>
              )}
              <div className="mt-5">
                <RatioBar ratio={m.bookings.goalAchievement} />
              </div>
              <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
                <div>
                  <p className="kpi-label flex items-center gap-1.5">
                    {paceState && (
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${paceState === "on" ? "bg-(--dot-positive)" : "bg-(--dot-caution)"}`}
                        title={paceState === "on" ? "On pace for the weekly goal" : "Behind weekly pace"}
                        aria-hidden="true"
                      />
                    )}
                    Goal Achievement
                  </p>
                  <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                    {pct(m.bookings.goalAchievement, 1)}
                  </p>
                  <p className="kpi-sub mt-0.5">of weekly goal</p>
                </div>
                <div>
                  <p className="kpi-label">Remaining</p>
                  <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                    {m.bookings.remaining}
                  </p>
                  <p className="kpi-sub mt-0.5">bookings left</p>
                </div>
              </div>
            </div>
            {/* right / supporting — today's pace and activity, secondary to the goal */}
            <div className="border-t border-(--table-border-weak) p-5 lg:border-t-0">
              <Eyebrow>Today's Pace</Eyebrow>
              <dl className="mt-4 space-y-4">
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Daily Pace Needed</dt>
                  <dd className="mt-0.5 flex flex-wrap items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {m.bookings.paceNeeded}
                    </span>
                    <span className="kpi-sub">{m.paceWeekend ? "team is off — pace resumes Monday" : "to hit goal"}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Yesterday's Bookings</dt>
                  <dd className="mt-0.5">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {m.bookings.yesterday}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Bookings Today</dt>
                  <dd className="mt-0.5 flex flex-wrap items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {m.bookings.today}
                    </span>
                    <span className="kpi-sub">
                      {pendingCount > 0
                        ? `${pendingCount} pending payment${pendingCount === 1 ? "" : "s"} excluded`
                        : "paid bookings"}
                    </span>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </Panel>
        {pendingCount > 0 && <PendingPaymentsDrillDown rows={pendingPayments} />}
      </section>

      {/* 3 — calls & conversions (secondary to the goal): one hairline-divided
          strip, five labeled cells, no comparisons (none exist in the payload). */}
      <section aria-label="Calls and conversions">
        <Panel className="overflow-hidden">
          <p className="section-heading px-5 pt-5">Calls &amp; Conversions (today)</p>
          <div className="mt-4 grid grid-cols-2 gap-y-5 pb-5 sm:grid-cols-3 xl:grid-cols-5 xl:gap-y-0 xl:divide-x xl:divide-(--table-border-weak)">
            <div className="px-5 py-1">
              <KpiMid label="Total Calls" value={m.callsToday.total} />
            </div>
            <div className="px-5 py-1">
              <KpiMid label="Calls Over 2 Min" value={m.callsToday.overThreshold} sub="meaningful conversations" />
            </div>
            <div className="px-5 py-1">
              <KpiMid label="Avg Call Duration" value={mins(m.callsToday.avgDurationSeconds)} />
            </div>
            <div className="px-5 py-1">
              <KpiMid label="Conversation Conversion" value={pct(m.conversionsToday.conversation, 1)} />
            </div>
            <div className="px-5 py-1">
              <KpiMid label="Assigned Lead Conversion" value={pct(m.conversionsToday.assignedLead, 1)} />
            </div>
          </div>
        </Panel>
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

      {/* 4b — leads worked today (Lead-Health composition, same anatomy as
              Daily Report §3: weekly budget relationship primary, today's
              work-date cohort mix supporting). The work-date cohort definition
              lives behind the shared InfoTip. */}
      <section aria-label="Leads worked today">
        <Panel className="overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:divide-x lg:divide-(--table-border-weak)">
            {/* left / primary — weekly leads against the budget */}
            <div className="p-5 sm:p-6">
              <p className="section-heading flex flex-wrap items-center gap-x-2 gap-y-1">
                Leads — worked today
                <InfoTip tip={`${data.cohortNote} (America/New_York)`} label="How today's lead counts are dated" />
              </p>
              <p className="kpi-label mt-5">Weekly Leads</p>
              <p className="mt-2 flex items-baseline gap-2.5 tabular-nums">
                <span className="text-5xl font-semibold leading-none tracking-tight text-(--text-primary)">
                  {m.leads.weekly.total}
                </span>
                <span className="text-2xl font-medium text-(--text-muted)">/ {m.leads.weeklyBudget}</span>
                <span className="text-sm text-(--text-muted)">budget</span>
              </p>
              <div className="mt-6">
                <p className="kpi-label flex items-center gap-1.5">
                  {leadBudgetOver && <span className="h-1.5 w-1.5 rounded-full bg-(--dot-caution)" aria-hidden="true" />}
                  % Lead Budget Used
                </p>
                <div className="mt-2 h-1.5 w-full max-w-xl overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
                  <div
                    className={"h-full rounded-full " + (leadBudgetOver ? "bg-(--dot-caution)" : "bg-(--bar-fill)")}
                    style={{ width: `${Math.min(m.leads.percentUsed ?? 0, 1) * 100}%` }}
                  />
                </div>
                <p className="kpi-sub mt-2 tabular-nums">
                  {pct(m.leads.percentUsed, 1)} used ·{" "}
                  {m.paceWeekend
                    ? `${m.leads.remaining} remaining — team is off, pace resumes Monday`
                    : `${m.leads.remaining} remaining · ${m.leads.dailyNeeded}/day needed`}
                </p>
              </div>
            </div>
            {/* right — today's work-date cohort: one mix bar, one legend */}
            <div className="border-t border-(--table-border-weak) p-5 lg:border-t-0">
              <p className="kpi-label">Total Leads Today</p>
              <p className="mt-2 text-4xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                {m.leads.today.total}
              </p>
              <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
                <div style={{ width: `${animaliaPct}%`, background: "var(--bar-fill)" }} />
                <div style={{ width: `${familyPct}%`, background: "var(--text-muted)" }} />
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-(--text-body)">
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--bar-fill)" }} aria-hidden="true" />
                  <span className="tabular-nums">{m.leads.today.animalia}</span> Animalia Leads Today
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--text-muted)" }} aria-hidden="true" />
                  <span className="tabular-nums">{m.leads.today.family}</span> Family Leads Today
                </li>
              </ul>
            </div>
          </div>
        </Panel>
      </section>

      {/* 4c — commission card (§21 dashboard card, Phase C): live estimate for the
          in-progress week from the SAME pure engine as the close job + the next
          stored submission date. Estimates only until the Sunday cutoff. */}
      {data.commission && (
        <section aria-label="Commission this week">
          <div className="card">
            <p className="section-heading flex flex-wrap items-center gap-x-2 gap-y-1">
              Commission — this week
              <span className="chip chip-risk">
                <span className="h-1.5 w-1.5 rounded-full bg-(--dot-caution)" aria-hidden="true" />
                Estimated
              </span>
              <InfoTip
                tip="The in-progress week's estimate comes from the same pure commission engine the Sunday close job uses (identical inputs — no second math); the next submission date reads the stored commission cycle. Numbers move until the cutoff. Full detail: Commission Center."
                label="How the commission card works"
              />
            </p>
            {data.commission.estimate ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
                  <div>
                    <p className="kpi-label">Team Bookings</p>
                    <p className="kpi-value mt-2">
                      {data.commission.estimate.teamBookings}
                      <span className="text-lg font-medium text-(--text-faint)"> / 79</span>
                    </p>
                    <div className="mt-1.5">
                      <StatusChip
                        kind={poolChip(data.commission.estimate.poolUnlocked, data.commission.estimate.teamBookings).kind}
                        label={poolChip(data.commission.estimate.poolUnlocked, data.commission.estimate.teamBookings).label}
                      />
                    </div>
                  </div>
                  <div>
                    <p className="kpi-label">Next Commission Submission</p>
                    {data.commission.nextSubmission ? (
                      <>
                        <p className="kpi-value mt-2">{dateWithWeekday(data.commission.nextSubmission.submissionDate)}</p>
                        <p className="kpi-sub mt-1 flex flex-wrap items-center gap-1.5">
                          {data.commission.nextSubmission.label}
                          <StatusChip
                            kind={cycleChip(data.commission.nextSubmission.status).kind}
                            label={cycleChip(data.commission.nextSubmission.status).label}
                          />
                        </p>
                      </>
                    ) : (
                      <p className="kpi-sub mt-2">No upcoming commission submission stored yet.</p>
                    )}
                  </div>
                </div>
                <div className="mt-4 divide-y divide-(--table-border-weak)">
                  {data.commission.estimate.employees.map((e) => (
                    <div key={e.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                      <span className="text-[13px] font-medium text-(--text-body)">{e.name}</span>
                      <span className="flex items-baseline gap-3 text-[13px] tabular-nums">
                        <span className="font-semibold text-(--text-primary)">{e.bookings}</span>
                        <span className="text-(--text-muted)">Est. bonus {e.bonusMoney ?? "—"}</span>
                      </span>
                    </div>
                  ))}
                  <p className="py-2 text-[12px] text-(--text-caption)">
                    Estimates during the active week — after the Sunday ET cutoff these become Final Weekly Commission.
                    Full payroll view on the{" "}
                    <a href="/commissions" className="underline underline-offset-2 hover:text-(--text-primary)">
                      Commission Center
                    </a>
                    .
                  </p>
                </div>
              </>
            ) : (
              <p className="mt-3 text-[13px] text-(--text-muted)">
                — commission estimate unavailable
                {data.commission.estimateError ? ` (${data.commission.estimateError})` : ""} — no estimate is shown
                rather than a plausible number.
              </p>
            )}
          </div>
        </section>
      )}

      {/* 5 — management attention */}
      <AttentionPanel notes={notes} />

      {/* 6 — rep performance (weekly, management-first list — owner directive
          2026-09-27). Combined Goal Progress per active rep; pooled (never
          arithmetic-average) team benchmarks; secondary metrics expand per
          row; whole row opens that rep on the Reps page with the week kept. */}
      <section aria-label="Rep performance">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <p className="section-heading">Rep Performance — this week</p>
            <InfoTip
              tip="Team benchmarks are pooled (sum ÷ sum) over other active reps — never averages of percentages · rule-based, no scores"
              label="How rep performance and benchmarks work"
            />
          </span>
        </div>
        <div className="card mt-3 overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="data-table min-w-[760px] md:min-w-[900px] [&_tbody_tr]:scroll-mt-24 [&_td]:py-2.5">
              <thead>
                <tr>
                  {th("name", "Rep", { left: true, stickyLeft: true })}
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
                        className={"group cursor-pointer " + (expanded ? "bg-(--surface-selected)" : "")}
                      >
                        <td className="sticky left-0 z-[1] bg-(--card-bg) text-left align-top group-hover:bg-(--surface-hover)">
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
                            className="relative z-[1] rounded-md px-1.5 py-1 text-xs text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
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
        <span className="whitespace-nowrap text-xs tabular-nums text-(--text-caption)">{view.pctText}</span>
      </span>
      {view.diffText && (
        <span className="mt-0.5 block text-xs text-(--text-muted)">{view.diffText}</span>
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
