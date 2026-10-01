import { createFileRoute } from "@tanstack/react-router";
import { getWeeklyData, saveWeeklyReportNotes } from "~/server/queries";
import { formatDateHuman, formatDateHumanFull, formatDateShort, weekdayName } from "~/server/date-logic";
import { formatInt, formatPercent } from "~/server/metrics/report-text";
import { monthKeyLabel, WEEKLY_CC_SECTIONS } from "~/server/metrics/weekly";
import { WarningList } from "~/components/warnings";
import { InfoTip } from "~/components/InfoTip";
import { CopyButton } from "~/components/CopyButton";
import { TrendCard, type TrendTooltipView } from "~/components/trend-chart";
import { useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/weekly")({
  loader: () => getWeeklyData(),
  component: WeeklyPage,
});

/* ---------------------------------------------------------------------------
   COMMAND-CENTER COMPOSITION (owner redesign spec 2026-10-01 §2 — presentation
   only; every number below renders through the SAME server formatters on the
   SAME payload, so all values are identical to the previous page):
     1. compact page header (title + scope chip; timezone demoted to metadata)
     2. WEEK RESULT HERO      — the week's outcome anchored on the goal + mix
     3. DAILY BOOKING RHYTHM  — one proportional Mon–Sun strip
     4. REP CONTRIBUTION      — ranked table | CONVERSION EFFICIENCY (one block)
     5. FUNNEL TREND (chart)  | LEAD COMPOSITION (compact)
     6. SECONDARY BAND        — calendar fill + Alliance/Auction/Website
     7. MONTH TO DATE         — quieter secondary analysis
     8. CC REPORT             — management action: narrative + COPY REPORT
   Surfaces: LEVEL 2 panels on the LEVEL 1 canvas (shared --surface-1/2/3
   tokens), hairline internal dividers, LEVEL 3 for inputs — depth from tone
   + spacing, not borders.
   HONESTY: no week selector exists (the loader is fixed to the last completed
   week) — the scope chip + caption state that; per-rep weekly goals are not
   part of this payload and render "—" (never invented goal math); Website
   keeps its "—" (no synced source); the copied report text is byte-identical.
--------------------------------------------------------------------------- */

/** Presentation sign helper (same convention as the payload's goalVsActual). */
function signedDelta(actual: number, goal: number): string {
  const diff = actual - goal;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  return `${sign}${Math.abs(diff)}`;
}

/** LEVEL 2 content panel — the shared section surface for the management pages. */
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={"rounded-xl border border-(--card-border) bg-(--card-bg) " + className}>{children}</div>;
}

/** True eyebrow label (the only uppercase on the page). */
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="kpi-label">{children}</p>;
}

/**
 * Clean progress visualization under a ratio metric (Daily Report's geometry).
 * Presentation-only: the SAME ratio the adjacent text shows, clamped to the
 * track; null renders an empty track (missing data stays missing).
 */
function RatioBar({ ratio, height = "h-1.5", max = "max-w-xl" }: { ratio: number | null; height?: string; max?: string }) {
  const width = ratio == null || !Number.isFinite(ratio) ? 0 : Math.min(100, Math.max(0, ratio * 100));
  return (
    <div className={`${height} w-full ${max} overflow-hidden rounded-full bg-(--bar-track)`} aria-hidden="true">
      <div className="h-full rounded-full bg-(--bar-fill)" style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * DAILY BOOKING RHYTHM — one Mon–Sun strip, bottom-anchored proportional bars.
 * Bar heights are the presentation-only share of the week's strongest day; the
 * printed count is always the payload's exact number. Zero days read quiet
 * (a bare rail + a muted 0), never dominant.
 */
function RhythmStrip({ daily }: { daily: { date: string; count: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[560px] grid-cols-7 gap-3">
        {daily.map((d) => (
          <div key={d.date} className="min-w-0">
            <p className="text-[12px] font-medium uppercase tracking-wide text-(--text-caption)">
              {weekdayName(d.date, false)}
            </p>
            <p className="text-[12px] tabular-nums text-(--text-muted)">{formatDateShort(d.date)}</p>
            <div className="mt-2 flex h-14 items-end border-b border-(--table-border-weak)" aria-hidden="true">
              <div
                className="w-full rounded-t-sm bg-(--bar-fill)"
                style={{ height: `${Math.max(0, Math.min(100, (d.count / max) * 100))}%` }}
              />
            </div>
            <p
              className={
                "mt-1.5 text-lg font-semibold tracking-tight tabular-nums " +
                (d.count > 0 ? "text-(--text-primary)" : "text-(--text-muted)")
              }
            >
              {formatInt(d.count)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * REP CONTRIBUTION — ranked table (payload rows are already largest-first).
 * Share of team = rep wins ÷ team total (both payload numbers; presentation
 * ratio). Weekly goal / goal achievement: the weekly payload carries no
 * per-rep goals — honest "—" (owner directive: no new goal logic here).
 */
function RankedRepTable({ rows, unattributed, total }: {
  rows: { rep_id: string; rep_name: string; total: number; manual: number }[];
  unattributed: number;
  total: number;
}) {
  const share = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
            <th scope="col" className="w-8 py-1.5 pr-2 font-medium" aria-label="Rank" />
            <th scope="col" className="py-1.5 pr-3 font-medium">Rep</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Paid bookings</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Share of team</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              <span className="inline-flex items-center gap-1.5">
                Weekly goal
                <InfoTip
                  label="Why per-rep goal columns show —"
                  tip="The weekly report payload doesn't include per-rep weekly goals (those live on the Reps page). The columns stay as honest dashes rather than inventing goal math — owner directive: no new goal logic on this page."
                />
              </span>
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">Goal achievement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.rep_id} className="border-b border-(--table-border-weak) transition-colors hover:bg-(--surface-3)">
              <td className="py-2 pr-2 text-[12px] font-medium tabular-nums text-(--text-muted)">{`0${i + 1}`.slice(-2)}</td>
              <td className="py-2 pr-3 font-medium text-(--text-body)">
                {r.rep_name}
                {r.manual > 0 && (
                  <span className="ml-1.5 text-[12px] font-normal text-(--text-muted)">
                    ({r.manual} manual {r.manual === 1 ? "override" : "overrides"})
                  </span>
                )}
              </td>
              <td className="py-2 pr-3 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(r.total)}</td>
              <td className="py-2 pr-3">
                <span className="flex items-center gap-2">
                  <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
                    {share(r.total) != null && (
                      <span className="block h-full rounded-full bg-(--bar-fill)" style={{ width: `${share(r.total)}%` }} />
                    )}
                  </span>
                  <span className="tabular-nums text-(--text-body)">{share(r.total) == null ? "—" : formatPercent(r.total / total)}</span>
                </span>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-(--text-faint)">—</td>
              <td className="py-2 text-right tabular-nums text-(--text-faint)">—</td>
            </tr>
          ))}
          {unattributed > 0 && (
            <tr className="border-b border-(--table-border-weak)">
              <td className="py-2 pr-2" aria-label="Unattributed" />
              <td className="py-2 pr-3 text-(--text-muted)">Online / unattributed</td>
              <td className="py-2 pr-3 text-right tabular-nums text-(--text-muted)">{formatInt(unattributed)}</td>
              <td className="py-2 pr-3 tabular-nums text-(--text-muted)">{share(unattributed) == null ? "—" : formatPercent(unattributed / total)}</td>
              <td className="py-2 pr-3" />
              <td className="py-2" />
            </tr>
          )}
          <tr>
            <td className="py-2 pr-2" />
            <td className="py-2 pr-3 font-semibold text-(--text-primary)">Team total</td>
            <td className="py-2 pr-3 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(total)}</td>
            <td className="py-2 pr-3">
              <span className="flex items-center gap-2">
                <span className="h-1 w-14 shrink-0 rounded-full bg-(--bar-fill)" aria-hidden="true" />
                <span className="tabular-nums font-semibold text-(--text-primary)">{total > 0 ? "100.00%" : "—"}</span>
              </span>
            </td>
            <td className="py-2 pr-3" />
            <td className="py-2" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function WeeklyPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const b = data.bookings;
  const c = data.conversion;
  const f = data.funnel;
  const mtd = data.mtd;
  const cal = data.calendar;

  // CC Report narrative — stored note per section; the Celebrate line prefills
  // with the computed top performer (still editable like every other section).
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      WEEKLY_CC_SECTIONS.map((s) => [
        s.key,
        data.report.notes[s.key] ?? (s.key === "celebrate" ? (data.report.celebrateDefault ?? "") : ""),
      ]),
    ),
  );
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveNotes = async () => {
    setSaveState("saving");
    try {
      await saveWeeklyReportNotes({ data: { weekStart: data.week.start, notes } });
      setSaveState("saved");
      await router.invalidate();
      setTimeout(() => setSaveState("idle"), 2500);
    } catch {
      setSaveState("error");
    }
  };

  // ---- hero geometry (presentation-only ratios of payload numbers) ----
  const achievement = b.goal > 0 ? b.total / b.goal : null;
  const diff = b.total - b.goal;
  const deltaPhrase = diff < 0 ? `${formatInt(Math.abs(diff))} below goal` : diff > 0 ? `${formatInt(diff)} above goal` : "at goal";
  const mixSeg = (n: number) => (b.total > 0 ? Math.min(100, (n / b.total) * 100) : 0);

  // ---- funnel trend (§F): the 5 completed weeks, chart-standard scrubbing ----
  const funnelPoints = data.funnelSeries.map((w) => ({ label: formatDateShort(w.weekStart), value: w.pct }));
  const funnelTooltip = (i: number): TrendTooltipView | null => {
    const w = data.funnelSeries[i];
    if (!w) return null;
    const title = `${formatDateShort(w.weekStart)} – ${formatDateShort(w.weekEnd)}`;
    return {
      title,
      lines:
        w.pct == null
          ? ["No sheet leads this week", "(Sheets sync begins 2026-08-24)"]
          : [`${formatInt(w.wins)} bookings / ${formatInt(w.leads)} leads`, `${formatPercent(w.pct)} of leads`],
    };
  };

  // ---- lead composition mix bar (§E) ----
  const leadMixSeg = (n: number) => (data.leads.total > 0 ? Math.min(100, (n / data.leads.total) * 100) : 0);

  return (
    <div className="space-y-6">
      {/* 1 — compact header: title + scope; timezone demoted to metadata */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-tight">Weekly Report</h1>
            <span className="inline-flex items-center rounded-full border border-(--table-border-weak) bg-(--surface-3) px-2 py-0.5 text-xs font-semibold text-(--text-caption)">
              Completed Mon–Sun week
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-(--text-muted)">
            <span className="tabular-nums">{data.week.caption}</span>
            <span aria-hidden="true">·</span>
            <span>America/New_York</span>
          </p>
        </div>
        {data.meta.mode === "memory" && (
          <p className="status-banner">
            <span className="font-medium">Demo data (in-memory).</span> Database not connected
            {data.meta.dbReason ? ` — ${data.meta.dbReason}` : ""}.
          </p>
        )}
      </header>

      {/* missing-data warnings — never a plausible number */}
      <WarningList items={data.warnings} />

      {/* 2 — WEEK RESULT HERO: the week's outcome anchored on the goal + the mix */}
      <section aria-label="Week result">
        <Panel className="overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] lg:divide-x lg:divide-(--table-border-weak)">
            {/* left / primary — the goal is the visual anchor */}
            <div className="p-5 sm:p-6">
              <Eyebrow>
                Booking Result
                <InfoTip
                  label="How the weekly report counts bookings"
                  tip={
                    <>
                      Paid Bookings (Booking Wins): appointments whose required deposit was paid, counted on the ET date the
                      deposit was received — the same rule every page uses. Session type: "animalia" in the Acuity type name →
                      Animalia, everything else Family. Rep rows join stored attributions; owner manual overrides count as rep
                      bookings. Online / unattributed wins count toward the team total only — never a rep's row.
                    </>
                  }
                />
              </Eyebrow>
              <p className="kpi-label mt-5">Paid Bookings / Weekly Goal</p>
              <p className="mt-2 flex items-baseline gap-2.5 tabular-nums">
                <span className="text-6xl font-semibold leading-none tracking-tight text-(--text-primary)">
                  {formatInt(b.total)}
                </span>
                <span className="text-3xl font-medium text-(--text-muted)">/ {formatInt(b.goal)}</span>
              </p>
              <div className="mt-6">
                <RatioBar ratio={achievement} />
                <p className="kpi-sub mt-2 tabular-nums">
                  {formatPercent(achievement)} of goal · {deltaPhrase}
                </p>
              </div>
            </div>
            {/* right / supporting — the week's booking mix as one visual system.
                Session type covers EVERY win (family + animalia = total exactly);
                online/unattributed is an attribution property that overlaps the
                genres — so the bar splits by session type only, and the
                unattributed count is stated as INSIDE the total (never a third
                segment that would double-count it). */}
            <div className="border-t border-(--table-border-weak) p-5 lg:border-t-0">
              <p className="kpi-label">Booking Mix</p>
              <p className="mt-2 flex items-baseline gap-2">
                <span className="text-4xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                  {formatInt(b.total)}
                </span>
                <span className="kpi-sub">paid bookings</span>
              </p>
              <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
                <div className="bg-(--bar-fill)" style={{ width: `${mixSeg(b.animalia)}%` }} />
                <div className="bg-(--text-muted)" style={{ width: `${mixSeg(b.family)}%` }} />
              </div>
              <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-(--text-body)">
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--bar-fill)" aria-hidden="true" />
                  <span className="tabular-nums">{formatInt(b.animalia)}</span> Animalia
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--text-muted)" aria-hidden="true" />
                  <span className="tabular-nums">{formatInt(b.family)}</span> Family
                </li>
              </ul>
              <p className="kpi-sub mt-3 border-t border-(--table-border-weak) pt-3">
                {formatInt(b.unattributed)} online / unattributed (inside the {formatInt(b.total)}) — team total only, never a rep row.
              </p>
            </div>
          </div>
        </Panel>
      </section>

      {/* 3 — DAILY BOOKING RHYTHM: one proportional Mon–Sun strip */}
      <section aria-label="Daily booking rhythm">
        <Panel className="p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <Eyebrow>Daily Rhythm</Eyebrow>
            <p className="text-xs text-(--text-muted)">paid bookings per day · deposit-received ET date</p>
          </div>
          <div className="mt-4">
            <RhythmStrip daily={b.daily} />
          </div>
        </Panel>
      </section>

      {/* 4 — REP CONTRIBUTION (primary operational) + CONVERSION EFFICIENCY (one block) */}
      <section aria-label="Rep contribution and conversion">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
          <Panel className="overflow-hidden p-5 sm:p-6">
            <p className="kpi-label mb-4">By Rep — Attributed Paid Bookings</p>
            <RankedRepTable rows={b.repRows} unattributed={b.unattributed} total={b.total} />
          </Panel>

          <Panel className="p-5 sm:p-6">
            <Eyebrow>Conversion Efficiency</Eyebrow>
            {/* PRIMARY: assigned-lead conversion (owner definition) */}
            <p className="kpi-label mt-5 flex items-center gap-1.5">
              Assigned Lead Conversion
              <InfoTip
                label="How assigned-lead conversion is computed"
                tip={
                  <>
                    Numerator: paid bookings attributed to a rep that week (manual overrides included). Denominator:
                    leads with an assigned rep whose SHEET date (source_date) falls in the week — the cohorts the team
                    worked from the Family/Animalia sheets. Conversion is shown only when the denominator is nonzero.
                  </>
                }
              />
            </p>
            <p
              className={
                "mt-2 text-4xl font-semibold leading-none tracking-tight tabular-nums " +
                (c.overall != null ? "text-(--text-primary)" : "text-(--text-muted)")
              }
            >
              {formatPercent(c.overall)}
            </p>
            <p className="kpi-sub mt-2 tabular-nums">
              {formatInt(c.numerator.overall)}/{formatInt(c.denominator.overall)} leads
            </p>
            {/* the two genre splits of the SAME numerator/denominator definition */}
            <dl className="mt-4 space-y-2.5 border-t border-(--table-border-weak) pt-4">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[13px] font-medium text-(--text-body)">Family</dt>
                <dd className="tabular-nums text-[13px] text-(--text-body)">
                  <span className={c.family != null ? "font-semibold text-(--text-primary)" : "text-(--text-muted)"}>{formatPercent(c.family)}</span>
                  <span className="ml-2 text-(--text-muted)">
                    {formatInt(c.numerator.family)}/{formatInt(c.denominator.family)}
                  </span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[13px] font-medium text-(--text-body)">Animalia</dt>
                <dd className="tabular-nums text-[13px] text-(--text-body)">
                  <span className={c.animalia != null ? "font-semibold text-(--text-primary)" : "text-(--text-muted)"}>{formatPercent(c.animalia)}</span>
                  <span className="ml-2 text-(--text-muted)">
                    {formatInt(c.numerator.animalia)}/{formatInt(c.denominator.animalia)}
                  </span>
                </dd>
              </div>
            </dl>
            {/* clearly differentiated denominator: the overall funnel rate */}
            <div className="mt-4 border-t border-(--table-border-weak) pt-4">
              <p className="kpi-label flex items-center gap-1.5">
                Bookings from leads
                <InfoTip
                  label="How bookings from leads is computed"
                  tip={
                    <>
                      Numerator: ALL paid bookings of the week (booking wins — online/unattributed included).
                      Denominator: ALL sheet leads (Family + Animalia) whose SHEET date (source_date) falls in the
                      week. Caveat: some bookings never came from sheet leads — online bookings, repeat clients,
                      Alliance/Auction members — so this is the overall funnel rate, not a strict lead→booking
                      attribution.
                    </>
                  }
                />
              </p>
              <p
                className={
                  "mt-2 flex items-baseline gap-2 text-2xl font-semibold tracking-tight tabular-nums " +
                  (f.pct != null ? "text-(--text-primary)" : "text-(--text-muted)")
                }
              >
                {formatPercent(f.pct)}
              </p>
              <p className="kpi-sub mt-1 tabular-nums">
                {formatInt(f.wins)}/{formatInt(f.leads)} leads · overall funnel rate
              </p>
            </div>
          </Panel>
        </div>
      </section>

      {/* 5 — FUNNEL TREND (chart standard) + LEAD COMPOSITION (compact) */}
      <section aria-label="Recent-weeks trend and lead composition">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
          {/* BOOKINGS FROM LEADS — recent completed weeks (owner request 2026-09-29),
              now on the dashboard's interactive chart standard (trend-chart.tsx):
              hover scrub, snapped guide + active dot, exact tooltip. The
              in-progress week is never shown (its % is meaningless mid-week);
              zero-leads weeks leave an honest gap (Sheets sync begins 2026-08-24). */}
          <TrendCard
            wide
            title="Bookings from leads — recent weeks"
            points={funnelPoints}
            unit="pct"
            formatValue={formatPercent}
            info="The last 5 completed Mon–Sun weeks, oldest first — all paid bookings ÷ all sheet leads (the same counts as the conversion block). The in-progress week is excluded — its % would be meaningless mid-week. A week with zero sheet leads renders “—” (the Google Sheets sync begins 2026-08-24), never a fabricated 0%."
            tooltip={funnelTooltip}
          />
          <Panel className="overflow-hidden p-5 sm:p-6">
            <p className="kpi-label flex items-center gap-1.5">
              Leads
              <InfoTip
                label="How weekly leads are dated"
                tip="Sheet leads by the date they entered the sheet (source_date), Mon–Sun of the report week — family and animalia sheets, America/New_York."
              />
            </p>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="text-4xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                {formatInt(data.leads.total)}
              </span>
              <span className="kpi-sub">sheet leads in the week</span>
            </p>
            <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
              <div className="bg-(--bar-fill)" style={{ width: `${leadMixSeg(data.leads.animalia)}%` }} />
              <div className="bg-(--text-muted)" style={{ width: `${leadMixSeg(data.leads.family)}%` }} />
            </div>
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-(--text-body)">
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--bar-fill)" aria-hidden="true" />
                <span className="tabular-nums">{formatInt(data.leads.animalia)}</span> Animalia
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--text-muted)" aria-hidden="true" />
                <span className="tabular-nums">{formatInt(data.leads.family)}</span> Family
              </li>
            </ul>
          </Panel>
        </div>
      </section>

      {/* 6 — SECONDARY BAND: calendar fill + Alliance/Auction/Website (quieter) */}
      <section aria-label="Calendar fill and channels" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <Panel className="p-5 sm:p-6">
          <p className="kpi-label flex items-center gap-1.5">
            Calendar Fill
            <InfoTip
              label="How calendar fill is measured"
              tip={
                <>
                  Non-cancelled appointments grouped by their session date into Mon–Sun buckets, against the studio
                  capacity derived from the current schedule config (Settings → Studio Schedule — slots per day follow the
                  configured blocks, so capacity updates with the schedule). The first fully open day scans forward for the
                  first date with zero appointments and an open studio; sessions beyond next week still count there.
                </>
              }
            />
          </p>
          <div className="mt-4 space-y-4">
            {[
              { label: cal.thisWeek.label, start: cal.thisWeek.start, end: cal.thisWeek.end, appointments: cal.thisWeek.appointments, capacity: cal.thisWeek.capacity },
              { label: cal.nextWeek.label, start: cal.nextWeek.start, end: cal.nextWeek.end, appointments: cal.nextWeek.appointments, capacity: cal.nextWeek.capacity },
            ].map((row) => (
              <div key={row.label}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-[13px] font-medium text-(--text-body)">{row.label}</p>
                  <p className="text-[13px] tabular-nums text-(--text-muted)">
                    {formatDateHuman(row.start)} – {formatDateHuman(row.end)}
                  </p>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <p className="text-xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                    {formatInt(row.appointments)}
                    <span className="text-sm font-normal text-(--text-muted)"> / {row.capacity > 0 ? row.capacity : "—"}</span>
                  </p>
                  <p className="kpi-sub">
                    sessions vs studio capacity
                    {row.capacity > 0 && ` · ${Math.round((row.appointments / row.capacity) * 100)}% filled`}
                  </p>
                </div>
                <div className="mt-1.5">
                  <RatioBar ratio={row.capacity > 0 ? row.appointments / row.capacity : null} height="h-1" max="max-w-none" />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 border-t border-(--table-border-weak) pt-3 text-xs tabular-nums text-(--text-muted)">
            Beyond next week: {formatInt(cal.beyond)} sessions (they still count toward the first-open-day scan) ·
            First fully open day:{" "}
            {cal.firstFullyOpenDay ? (
              <span className="font-semibold text-(--text-body)">{formatDateHumanFull(cal.firstFullyOpenDay)}</span>
            ) : (
              "— (none within 120 days)"
            )}
          </p>
        </Panel>

        {/* PREVIOUS WEEK — Alliance / Auction / Website (owner CC Report template).
            Secondary by design: quieter type, narrower column. */}
        <Panel className="p-5 sm:p-6">
          <p className="kpi-label flex items-center gap-1.5">
            Alliance / Auction / Website — previous week
            <InfoTip
              label="How the channel split is computed"
              tip={
                <>
                  Bookings: paid wins of the week whose Acuity appointment type contains the channel name (case-insensitive)
                  — same deposit-paid rule as every other figure. Leads: HighLevel opportunities on the channel's pipeline
                  (Alliance / Alliance Booking Calls, Auction / Auction Booking Calls) whose created date falls in the week,
                  America/New_York — synced from GoHighLevel, every pipeline status counts (open, won, lost, abandoned).
                  Website shows "—" on both: no distinct Website booking type exists in Acuity and no Website lead source is
                  synced — nothing is invented meanwhile.
                </>
              }
            />
          </p>
          <table className="mt-4 w-full max-w-sm text-[12px]">
            <thead>
              <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
                <th scope="col" className="py-1.5 pr-2 font-medium">Channel</th>
                <th scope="col" className="py-1.5 text-right font-medium">Leads</th>
                <th scope="col" className="py-1.5 text-right font-medium">Paid bookings</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: "Alliance", leads: data.channelLeads.alliance, bookings: data.channels.alliance },
                { name: "Auction", leads: data.channelLeads.auction, bookings: data.channels.auction },
                { name: "Website", leads: data.channelLeads.website, bookings: data.channels.website },
              ].map((r) => (
                <tr key={r.name} className="border-b border-(--table-border-weak)">
                  <td className="py-1.5 pr-2 text-(--text-body)">{r.name}</td>
                  <td className={"py-1.5 text-right tabular-nums " + (r.leads == null ? "text-(--text-muted)" : "font-medium text-(--text-body)")}>
                    {r.leads == null ? "—" : formatInt(r.leads)}
                  </td>
                  <td className={"py-1.5 text-right tabular-nums " + (r.bookings == null ? "text-(--text-muted)" : "font-medium text-(--text-body)")}>
                    {r.bookings == null ? "—" : formatInt(r.bookings)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </section>

      {/* 7 — MONTH TO DATE (secondary analysis) */}
      <section aria-label="Month to date">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <Eyebrow>
            Month to date —{" "}
            {new Date(`${data.month.start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}
          </Eyebrow>
          <InfoTip
            label="How month to date is counted"
            tip="Paid bookings whose deposit date falls in the current calendar month through today (ET). Rep rows use the same attribution join as the weekly section; online/unattributed wins stay team-total only."
          />
        </div>
        <Panel className="overflow-hidden">
          <div className="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,280px)] sm:divide-x sm:divide-(--table-border-weak)">
            <div className="p-5">
              <p className="kpi-label">Paid bookings MTD</p>
              <p className="mt-2 flex items-baseline gap-2.5 tabular-nums">
                <span className="text-4xl font-semibold leading-none tracking-tight text-(--text-primary)">
                  {formatInt(mtd.total)}
                </span>
                {mtd.goal != null && <span className="text-xl font-medium text-(--text-muted)">/ {formatInt(mtd.goal)}</span>}
              </p>
              <div className="mt-3 max-w-md">
                <RatioBar ratio={mtd.goal != null && mtd.goal > 0 ? mtd.total / mtd.goal : null} height="h-1" max="max-w-none" />
              </div>
              <p className="kpi-sub mt-2 tabular-nums">
                {mtd.goal != null ? `${signedDelta(mtd.total, mtd.goal)} vs goal · ` : ""}
                {data.month.start} – {data.month.end}
              </p>
            </div>
            <div className="border-t border-(--table-border-weak) p-5 sm:border-t-0">
              {/* MONTHLY GOAL (owner-approved 2026-09-29): stored for THIS month's
                  exact key; otherwise the honest "—" — months never inherit. */}
              <p className="kpi-label flex items-center gap-1.5">
                Monthly goal
                <InfoTip
                  label="About the monthly goal"
                  tip={
                    mtd.goal != null
                      ? `Stored in Settings → Monthly Booking Goal for ${monthKeyLabel(data.month.key)} (per-month goals never carry over).`
                      : "No monthly goal is set for this month — add one in Settings → Monthly Booking Goal. Goals are stored per month (current + next), so a month never inherits another month's number."
                  }
                />
              </p>
              <p className={"mt-2 text-2xl font-semibold tracking-tight tabular-nums " + (mtd.goal != null ? "text-(--text-primary)" : "text-(--text-muted)")}>
                {mtd.goal != null ? formatInt(mtd.goal) : "—"}
              </p>
              {mtd.goal != null && <p className="kpi-sub mt-1">set for {monthKeyLabel(data.month.key)}</p>}
              <div className="mt-4 border-t border-(--table-border-weak) pt-4">
                <p className="kpi-label">Top performer</p>
                {mtd.topPerformer ? (
                  <p className="mt-2 flex items-baseline gap-2">
                    <span className="inline-flex items-center rounded-full bg-(--chip-positive-bg) px-2.5 py-0.5 text-sm font-semibold text-(--pos-text)">
                      {mtd.topPerformer.repName}
                    </span>
                    <span className="text-xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {formatInt(mtd.topPerformer.total)}
                    </span>
                  </p>
                ) : (
                  <p className="mt-2 text-2xl font-semibold tracking-tight text-(--text-muted)">—</p>
                )}
                {mtd.topPerformer && <p className="kpi-sub mt-1">paid bookings MTD</p>}
              </div>
            </div>
          </div>
        </Panel>
        <Panel className="mt-6 max-w-2xl overflow-hidden p-5 sm:p-6">
          <p className="kpi-label mb-3">By Rep — month to date</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
                  <th scope="col" className="py-1.5 pr-3 font-medium">Rep</th>
                  <th scope="col" className="py-1.5 text-right font-medium">Paid bookings</th>
                </tr>
              </thead>
              <tbody>
                {mtd.repRows.map((r) => (
                  <tr key={r.rep_id} className="border-b border-(--table-border-weak) transition-colors hover:bg-(--surface-3)">
                    <td className="py-2 pr-3 text-(--text-body)">
                      {r.rep_name}
                      {r.manual > 0 && (
                        <span className="ml-1.5 text-[12px] text-(--text-muted)">
                          ({r.manual} manual {r.manual === 1 ? "override" : "overrides"})
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums text-(--text-body)">{formatInt(r.total)}</td>
                  </tr>
                ))}
                {mtd.unattributed > 0 && (
                  <tr className="border-b border-(--table-border-weak)">
                    <td className="py-2 pr-3 text-(--text-muted)">Online / unattributed</td>
                    <td className="py-2 text-right tabular-nums text-(--text-muted)">{formatInt(mtd.unattributed)}</td>
                  </tr>
                )}
                <tr>
                  <td className="py-2 pr-3 font-semibold text-(--text-primary)">Team total</td>
                  <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(mtd.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </section>

      {/* 8 — CC REPORT: management action — narrative + COPY REPORT (byte-identical text) */}
      <section aria-label="CC Report">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <Eyebrow>CC Report</Eyebrow>
          <InfoTip
            label="About the CC Report"
            tip={
              <>
                The Monday leadership report, assembled from this page's figures plus your narrative below. Every section
                is saved per week (the report week above) and audited. "Celebrate / Top Performer" prefills with the
                computed top performer — edit freely. COPY REPORT puts the full text on your clipboard; placeholder lines
                (Empty appointments, Holes, 1st Call Completed) stay blank until the owner defines them — no numbers are
                invented for them.
              </>
            }
          />
        </div>

        <Panel className="max-w-3xl overflow-hidden p-5 sm:p-6">
          <div className="space-y-4">
            {WEEKLY_CC_SECTIONS.map((s) => (
              <div key={s.key}>
                <label htmlFor={`cc-${s.key}`} className="kpi-label">
                  {s.label}
                  {s.key === "celebrate" && <span className="ml-2 font-normal text-[12px] normal-case text-(--text-muted)">auto-filled from the computed top performer — editable</span>}
                </label>
                <textarea
                  id={`cc-${s.key}`}
                  rows={s.key === "big3" || s.key === "big3_followup" ? 3 : 2}
                  value={notes[s.key] ?? ""}
                  onChange={(e) => setNotes({ ...notes, [s.key]: e.target.value })}
                  placeholder={s.key === "celebrate" ? "e.g. Allison Wittner — 47 paid bookings" : ""}
                  className="mt-1 w-full rounded-lg border border-(--card-border) bg-(--surface-3) px-3 py-2 text-sm text-(--text-primary) outline-none transition-colors focus:border-(--input-focus-border)"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3 border-t border-(--table-border-weak) pt-4">
            <button
              type="button"
              onClick={saveNotes}
              disabled={saveState === "saving"}
              className="rounded-lg bg-(--accent-solid) px-4 py-2 text-[13px] font-medium text-(--accent-solid-fg) transition-colors hover:bg-(--accent-hover) disabled:opacity-50"
            >
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Save CC Report narrative"}
            </button>
            {saveState === "error" && <span className="text-xs text-(--neg-text)">Save failed — try again.</span>}
            <span className="text-xs text-(--text-muted)">Saved per report week · changes are audited · shows in the copied report</span>
          </div>
        </Panel>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <CopyButton label="COPY REPORT" text={data.report.reportText} />
        </div>
        <details className="group mt-4">
          <summary className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[13px] text-(--text-caption) transition-colors hover:text-(--text-primary)">
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="transition-transform group-open:rotate-90"
              aria-hidden="true"
            >
              <path d="M4 2.5L8 6L4 9.5" />
            </svg>
            Report preview — exactly what COPY REPORT puts on your clipboard
          </summary>
          <pre className="mt-3 max-w-3xl overflow-x-auto whitespace-pre-wrap rounded-lg bg-(--surface-3) p-4 font-mono text-xs leading-relaxed text-(--text-body)">
            {data.report.reportText}
          </pre>
        </details>
      </section>
    </div>
  );
}
