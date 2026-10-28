import { createFileRoute } from "@tanstack/react-router";
import { getWeeklyData, saveWeeklyReportNotes } from "~/server/queries";
import { formatDateHuman, formatDateHumanFull, formatDateShort, weekdayName } from "~/server/date-logic";
import { formatInt, formatPercent } from "~/server/metrics/report-text";
import { monthKeyLabel, WEEKLY_CC_SECTIONS } from "~/server/metrics/weekly";
import { WarningList } from "~/components/warnings";
import { InfoTip } from "~/components/InfoTip";
import { CopyButton } from "~/components/CopyButton";
// Harmonization Wave 1: Panel/Eyebrow/RatioBar live ONCE in the shared
// page-primitives module (same markup they replaced here).
import { Eyebrow, Panel, RatioBar } from "~/components/page-panel";
import { useState } from "react";
import { useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/weekly")({
  loader: () => getWeeklyData(),
  component: WeeklyPage,
});

/* ---------------------------------------------------------------------------
   COMMAND-CENTER COMPOSITION (owner redesign spec 2026-10-01 §2; Final Booking
   Logic revision 2026-10-28 — presentation only; every number below renders
   through the SAME server formatters on the SAME payload):
     1. compact page header (title + scope chip; timezone demoted to metadata)
     2. WEEK RESULT HERO      — GROSS / CANCELLATIONS / NET on the produced
                                (created-in-week) basis, anchored on the goal
     3. DAILY BOOKING RHYTHM  — one proportional Mon–Sun strip (active-wins
                                basis, deposit dates — labeled)
     4. REP CONTRIBUTION      — ranked table | CONVERSION EFFICIENCY (one block)
     5. LEAD COMPOSITION      — the work-date cohort (Leads-only)
     6. SECONDARY BAND        — calendar fill + Alliance/Auction/Website
     7. MONTH TO DATE         — GROSS basis tracker
     8. CC REPORT             — management action: narrative + COPY REPORT
   OWNER'S FOUR OPERATIONAL QUESTIONS (Final Booking Logic 10/28): Weekly
   Leads (work-date cohort) · Gross Bookings · Cancellations · Net Bookings.
   Gross = qualifying (paid-deposit) bookings ORIGINALLY CREATED in the
   Mon–Sun week, identity-deduped, cancellations INCLUDED (Oct 19–25 = 84,
   audit-79v84); Cancellations = true cancellations among that gross (= 5);
   Net = Gross − Cancellations (= 79). Reschedules never move a booking
   between weeks and never count as cancellations. The cohort-produced
   "Bookings from leads" panel and the per-source Bookings / Conversion %
   columns LEAVE the page (owner §6); rep-level detail (By-Rep table,
   per-day grid, channel splits) stays on the protected active-wins/
   attribution basis, labeled so it cannot be mistaken for the headline.
   Surfaces: LEVEL 2 panels on the LEVEL 1 canvas (shared --surface-1/2/3
   tokens), hairline internal dividers, LEVEL 3 for inputs — depth from tone
   + spacing, not borders.
   HONESTY: no week selector exists (the loader is fixed to the last completed
   week) — the scope chip + caption state that; per-rep weekly goals are not
   part of this payload and render "—" (never invented goal math); Website
   keeps its "—" (no synced source); the copied report text carries the same
   four-number view (tab ↔ report digit identity).
--------------------------------------------------------------------------- */

/** Presentation sign helper (same convention as the payload's goalVsActual). */
function signedDelta(actual: number, goal: number): string {
  const diff = actual - goal;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  return `${sign}${Math.abs(diff)}`;
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
      {/* P1-8 (mobile): the 7-col strip scrolls past MON–THU at 390 — phones get
          the same cells wrapped 4+3 (7 items in grid-cols-4). Same bars, same
          numbers, same labels; ≥768 keeps the single-row strip byte-identical. */}
      <div className="grid min-w-[560px] grid-cols-7 gap-3 max-md:min-w-0 max-md:grid-cols-4">
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
 * PER-DAY × PER-REP WINS GRID (owner request 2026-10-19) — one row per rep,
 * one column per Mon–Sun ET calendar day (Sat/Sun always shown), plus the
 * online/unattributed line (team total only) and the Team total row.
 * Bucket = booking_win_business_date, the DEPOSIT-paid ET date (Ruling 1/1a):
 * a session HELD Monday whose deposit PAID Saturday shows under Saturday, so
 * weekend deposit activity is visible instead of hiding in the weekly sum.
 * Same wins, same ownership rule as the By-Rep table (rep rows + unattributed);
 * zeros render 0 — a zero day is a computed fact, never blank. Dashboard-only:
 * the copied CC Report text carries none of this.
 */
function DayByRepGrid({ grid }: {
  grid: {
    dates: string[];
    reps: { rep_id: string; rep_name: string; counts: number[]; total: number }[];
    unattributed: number[];
    team: number[];
  };
}) {
  const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
  const unattrTotal = sum(grid.unattributed);
  const cell = (n: number, key: string) => (
    <td
      key={key}
      className={
        "py-2 pr-3 text-right tabular-nums " + (n > 0 ? "text-(--text-primary)" : "text-(--text-muted)")
      }
    >
      {formatInt(n)}
    </td>
  );
  return (
    <div>
      <div className="overflow-x-auto">
        {/* Phone: the grid keeps every day column (that IS the feature) and
            scrolls horizontally — same overflow pattern as the RhythmStrip. */}
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
              <th scope="col" className="py-1.5 pr-3 font-medium">Rep</th>
              {grid.dates.map((d) => (
                <th key={d} scope="col" className="py-1.5 pr-3 text-right font-medium">
                  <span className="block uppercase tracking-wide">{weekdayName(d, false)}</span>
                  <span className="block font-normal tabular-nums text-(--text-muted)">{formatDateShort(d)}</span>
                </th>
              ))}
              <th scope="col" className="py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.reps.map((r) => (
              <tr key={r.rep_id} className="border-b border-(--table-border-weak) transition-colors hover:bg-(--surface-3)">
                <td className="py-2 pr-3 font-medium text-(--text-body)">{r.rep_name}</td>
                {r.counts.map((n, i) => cell(n, `${r.rep_id}-${grid.dates[i]}`))}
                <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(r.total)}</td>
              </tr>
            ))}
            {unattrTotal > 0 && (
              <tr className="border-b border-(--table-border-weak)">
                <td className="py-2 pr-3 text-(--text-muted)">Online / unattributed</td>
                {grid.unattributed.map((n, i) => cell(n, `unattr-${grid.dates[i]}`))}
                <td className="py-2 text-right tabular-nums text-(--text-muted)">{formatInt(unattrTotal)}</td>
              </tr>
            )}
            <tr>
              <td className="py-2 pr-3 font-semibold text-(--text-primary)">Team total</td>
              {grid.team.map((n, i) => cell(n, `team-${grid.dates[i]}`))}
              <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(sum(grid.team))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-xs text-(--text-muted)">
        Sat/Sun counts are wins whose deposit was PAID that day — the session itself may have been held any earlier day.
      </p>
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
      {/* P1-6 (mobile): rank + the two all-dash goal columns hide on phones and
          the table drops its 560px floor, so Rep | Paid bookings | Share fits
          390 without the mid-word clip. The dash columns carry no data ("—"
          only — no per-rep goals in this payload); ≥768 keeps all six columns. */}
      <table className="w-full min-w-[560px] text-sm max-md:min-w-0">
        <thead>
          <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
            <th scope="col" className="w-8 py-1.5 pr-2 font-medium max-md:hidden" aria-label="Rank" />
            <th scope="col" className="py-1.5 pr-3 font-medium">Rep</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Paid bookings</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Share of team</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium max-md:hidden">
              <span className="inline-flex items-center gap-1.5">
                Weekly goal
                <InfoTip
                  label="Why per-rep goal columns show —"
                  tip="The weekly report payload doesn't include per-rep weekly goals (those live on the Reps page). The columns stay as honest dashes rather than inventing goal math — owner directive: no new goal logic on this page."
                />
              </span>
            </th>
            <th scope="col" className="py-1.5 text-right font-medium max-md:hidden">Goal achievement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.rep_id} className="border-b border-(--table-border-weak) transition-colors hover:bg-(--surface-3)">
              <td className="py-2 pr-2 text-[12px] font-medium tabular-nums text-(--text-muted) max-md:hidden">{`0${i + 1}`.slice(-2)}</td>
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
              <td className="py-2 pr-3 text-right tabular-nums text-(--text-faint) max-md:hidden">—</td>
              <td className="py-2 text-right tabular-nums text-(--text-faint) max-md:hidden">—</td>
            </tr>
          ))}
          {unattributed > 0 && (
            <tr className="border-b border-(--table-border-weak)">
              <td className="py-2 pr-2 max-md:hidden" aria-label="Unattributed" />
              <td className="py-2 pr-3 text-(--text-muted)">Online / unattributed</td>
              <td className="py-2 pr-3 text-right tabular-nums text-(--text-muted)">{formatInt(unattributed)}</td>
              <td className="py-2 pr-3 tabular-nums text-(--text-muted)">{share(unattributed) == null ? "—" : formatPercent(unattributed / total)}</td>
              <td className="py-2 pr-3 max-md:hidden" />
              <td className="py-2 max-md:hidden" />
            </tr>
          )}
          <tr>
            <td className="py-2 pr-2 max-md:hidden" />
            <td className="py-2 pr-3 font-semibold text-(--text-primary)">Team total</td>
            <td className="py-2 pr-3 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(total)}</td>
            <td className="py-2 pr-3">
              <span className="flex items-center gap-2">
                <span className="h-1 w-14 shrink-0 rounded-full bg-(--bar-fill)" aria-hidden="true" />
                <span className="tabular-nums font-semibold text-(--text-primary)">{total > 0 ? "100.00%" : "—"}</span>
              </span>
            </td>
            <td className="py-2 pr-3 max-md:hidden" />
            <td className="py-2 max-md:hidden" />
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
  // GROSS basis (owner Final Booking Logic 10/28): the hero tracks the
  // production block — Gross / Cancellations / Net; the mix segments are
  // shares of the gross. `b.total` (paid-AND-active wins) remains the basis
  // of the rep-level detail below (By-Rep table, per-day grid, MTD reps).
  const achievement = b.goal > 0 ? b.production.gross / b.goal : null;
  const diff = b.production.gross - b.goal;
  const deltaPhrase = diff < 0 ? `${formatInt(Math.abs(diff))} below goal` : diff > 0 ? `${formatInt(diff)} above goal` : "at goal";
  const mixSeg = (n: number) => (b.production.gross > 0 ? Math.min(100, (n / b.production.gross) * 100) : 0);

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

      {/* 2 — WEEK RESULT HERO (owner Final Booking Logic 10/28): GROSS /
          CANCELLATIONS / NET on the produced basis, anchored on the goal.
          Gross = qualifying (paid-deposit) bookings ORIGINALLY CREATED in the
          Mon–Sun week — identity-deduped, cancellations INCLUDED (Oct 19–25 =
          84, audit-79v84); the mix column splits the SAME gross rows. The
          superseded "Bookings Produced (Mon–Sun)" additive figure is gone —
          gross IS that figure. Rep-level detail below stays on the protected
          active-wins/attribution basis, labeled. */}
      <section aria-label="Week result">
        <Panel className="overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] lg:divide-x lg:divide-(--table-border-weak)">
            {/* left / primary — the goal is the visual anchor */}
            <div className="p-5 sm:p-6">
              <Eyebrow>
                Booking Result
                <InfoTip
                  label="How Gross Bookings, Cancellations and Net are counted"
                  tip={
                    <>
                      Gross Bookings: qualifying (paid-deposit) appointments ORIGINALLY CREATED in the Mon–Sun report week
                      (ET creation business date), identity-deduped per client (a cancel-and-rebook counts once),
                      cancellations INCLUDED — Oct 19–25 = 84 (record-level audit, audit-79v84). Credit is permanently tied
                      to the original creation date: a reschedule never moves a booking between weeks and never counts as a
                      cancellation. Cancellations: true cancellations among that gross (cancelled bookings with no active
                      rebook in the week) — Oct 19–25 = 5. Net = Gross − Cancellations — Oct 19–25 = 79. The session-type mix
                      splits the same gross rows; the rep-level detail below counts attributed ACTIVE paid wins
                      (attribution basis) and is labeled as such.
                    </>
                  }
                />
              </Eyebrow>
              <p className="kpi-label mt-5">Gross Bookings / Weekly Goal</p>
              <p className="mt-2 flex items-baseline gap-2.5 tabular-nums">
                <span className="text-6xl font-semibold leading-none tracking-tight text-(--text-primary)">
                  {formatInt(b.production.gross)}
                </span>
                <span className="text-3xl font-medium text-(--text-muted)">/ {formatInt(b.goal)}</span>
              </p>
              <div className="mt-6">
                <RatioBar ratio={achievement} />
                <p className="kpi-sub mt-2 tabular-nums">
                  {formatPercent(achievement)} of goal · {deltaPhrase}
                </p>
              </div>
              {/* owner §4 layout: Cancellations + Net directly underneath */}
              <div className="mt-6 flex gap-10 border-t border-(--table-border-weak) pt-4">
                <div>
                  <p className="kpi-label">Cancellations</p>
                  <p className="mt-1.5 text-3xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                    {formatInt(b.production.cancellations)}
                  </p>
                </div>
                <div>
                  <p className="kpi-label">Net Bookings</p>
                  <p className="mt-1.5 text-3xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                    {formatInt(b.production.net)}
                  </p>
                  <p className="kpi-sub mt-1 tabular-nums">gross − cancellations</p>
                </div>
              </div>
              <p className="mt-4 border-t border-(--table-border-weak) pt-3 text-xs leading-snug text-(--text-muted)">
                Gross = qualifying paid bookings originally created Mon–Sun of the report week (identity-deduped per client;
                cancellations included). Reschedules never move a booking between weeks and never count as cancellations —
                credit stays on the original booking week. Cancellations are shown separately; the goal line tracks Gross.
              </p>
            </div>
            {/* right / supporting — the week's GROSS booking mix as one visual system.
                Session type covers EVERY gross row (family + animalia = gross exactly);
                online/unattributed is an attribution property that overlaps the
                genres — so the bar splits by session type only, and the
                unattributed count is stated as INSIDE the gross (never a third
                segment that would double-count it). */}
            <div className="border-t border-(--table-border-weak) p-5 lg:border-t-0">
              <p className="kpi-label">Booking Mix</p>
              <p className="mt-2 flex items-baseline gap-2">
                <span className="text-4xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                  {formatInt(b.production.gross)}
                </span>
                <span className="kpi-sub">gross bookings</span>
              </p>
              <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
                <div className="bg-(--bar-fill)" style={{ width: `${mixSeg(b.grossMix.animalia)}%` }} />
                <div className="bg-(--text-muted)" style={{ width: `${mixSeg(b.grossMix.family)}%` }} />
                <div className="bg-(--genre-fairyland)" style={{ width: `${mixSeg(b.grossMix.fairyland)}%` }} />
              </div>
              <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-(--text-body)">
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--bar-fill)" aria-hidden="true" />
                  <span className="tabular-nums">{formatInt(b.grossMix.animalia)}</span> Animalia
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--text-muted)" aria-hidden="true" />
                  <span className="tabular-nums">{formatInt(b.grossMix.family)}</span> Family
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--genre-fairyland)" aria-hidden="true" />
                  <span className="tabular-nums">{formatInt(b.grossMix.fairyland)}</span> Fairyland
                </li>
              </ul>
              <p className="kpi-sub mt-3 border-t border-(--table-border-weak) pt-3">
                {formatInt(b.grossUnattributed)} online / unattributed (inside the {formatInt(b.production.gross)}) — team total only, never a rep row.
              </p>
            </div>
          </div>
        </Panel>
      </section>

      {/* 3 — DAILY BOOKING RHYTHM: one proportional Mon–Sun strip + the
          PER-DAY × PER-REP grid (owner request 2026-10-19): same wins bucketed
          by deposit-paid ET date × attributed rep — Sat/Sun deposit activity
          visible, not buried in the weekly sum. Dashboard-only (not copied). */}
      <section aria-label="Daily booking rhythm">
        <Panel className="p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <Eyebrow>Daily Rhythm</Eyebrow>
            <p className="text-xs text-(--text-muted)">paid bookings per day · deposit-received ET date</p>
          </div>
          <div className="mt-4">
            <RhythmStrip daily={b.daily} />
          </div>
          <div className="mt-6 border-t border-(--table-border-weak) pt-5">
            <p className="kpi-label flex items-center gap-1.5">
              Per-day wins by rep
              <InfoTip
                label="How the per-day grid buckets wins"
                tip={
                  <>
                    The week's paid bookings split by the ET calendar day the DEPOSIT was received
                    (booking_win_business_date) and the attributed rep — the same win set and the same
                    attribution join as the By-Rep table. A session held Monday whose deposit paid Saturday
                    counts under Saturday. Online / unattributed wins stay team-total only. This counts
                    active paid wins (attribution basis); later cancellations excluded — the production block
                    above shows Gross/Net.
                  </>
                }
              />
            </p>
            <div className="mt-4">
              <DayByRepGrid grid={b.dayByRep} />
            </div>
          </div>
        </Panel>
      </section>

      {/* 4 — REP CONTRIBUTION (primary operational) + CONVERSION EFFICIENCY (one block) */}
      <section aria-label="Rep contribution and conversion">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
          <Panel className="overflow-hidden p-5 sm:p-6">
            <p className="kpi-label mb-4 flex items-center gap-1.5">
              By Rep — Attributed Paid Bookings
              <InfoTip
                label="Why rep rows may not sum to Gross"
                tip="Counts active paid wins (attribution basis); later cancellations excluded — the production block above shows Gross/Net. Rep rows join stored attributions; owner manual overrides count as rep bookings; online/unattributed wins stay team-total only."
              />
            </p>
            <RankedRepTable rows={b.repRows} unattributed={b.unattributed} total={b.total} />
          </Panel>

          <Panel className="p-5 sm:p-6">
            <Eyebrow>Conversion Efficiency</Eyebrow>
            {/* PRIMARY: assigned-lead cohort conversion (work-date, cohort-to-date) */}
            <p className="kpi-label mt-5 flex items-center gap-1.5">
              Assigned Lead Conversion
              <InfoTip
                label="How assigned-lead conversion is computed"
                tip={
                  <>
                    Numerator: the week's assigned work-date cohort leads that have produced a qualifying paid booking,
                    COUNTED TO DATE and credited by lead assignment (whichever rep or channel later worked the booking).
                    Denominator: the same week's assigned work-date cohort (leads with an assigned rep worked into the
                    week, Family/Animalia/Fairyland sheets — form-source leads are team totals, never rep metrics).
                    Numerator and denominator are the same cohort; a booking made weeks later still counts toward its
                    original week. Conversion is shown only when the denominator is nonzero. Rep-cohort doctrine —
                    distinct from the production block, which reports Gross/Cancellations/Net on the created-in-week basis.
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
              {formatInt(c.numerator.overall)}/{formatInt(c.denominator.overall)} cohort leads produced · to date
            </p>
            {/* the three genre splits of the SAME numerator/denominator definition */}
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
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[13px] font-medium text-(--text-body)">Fairyland</dt>
                <dd className="tabular-nums text-[13px] text-(--text-body)">
                  <span className={c.fairyland != null ? "font-semibold text-(--text-primary)" : "text-(--text-muted)"}>{formatPercent(c.fairyland)}</span>
                  <span className="ml-2 text-(--text-muted)">
                    {formatInt(c.numerator.fairyland)}/{formatInt(c.denominator.fairyland)}
                  </span>
                </dd>
              </div>
            </dl>
            {/* "Bookings from leads" (the overall cohort funnel block) REMOVED —
                owner Final Booking Logic 10/28 §6: cohort-produced bookings are
                no longer displayed on the Weekly UI; production reports as
                Gross / Cancellations / Net in the hero. The cohort machinery
                stays internal (payload `funnel` field + builders unchanged). */}
          </Panel>
        </div>
      </section>

      {/* 5 — LEAD COMPOSITION (compact; full width). The "Bookings from leads —
          recent weeks" cohort funnel chart REMOVED — owner Final Booking Logic
          10/28 §6: cohort-produced bookings are no longer displayed on the
          Weekly UI (the week-by-week series plotted cohort-to-date produced ÷
          cohort leads). The cohort machinery stays internal — the payload's
          funnelSeries field and the weekCohortFunnelRows builder are untouched;
          only this rendering left the page. */}
      <section aria-label="Lead composition">
        <Panel className="overflow-hidden p-5 sm:p-6">
            <p className="kpi-label flex items-center gap-1.5">
              Leads
              <InfoTip
                label="How weekly leads are dated"
                tip="Leads received for this WORK week — the work-date cohort (getWorkDate maps each sheet's date column to the day the team works it: Fri/Sat/Sun sheet dates land on Monday, Mon–Thu on the next day), so the week labeled Mon 10/19 holds sheet dates Fri 10/16–Thu 10/22. The SAME cohort Team trends, the Reps page and Today use. Seven sources: the Family / Animalia / Fairyland sheets plus the four Forms Data tabs (Auction certificates, Google Ads leads, Alliance certificates, Website applications). Per-source counts below; a person appearing in two sheets counts in each source, duplicates within one sheet collapse."
              />
            </p>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="text-4xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                {formatInt(data.leads.total)}
              </span>
              <span className="kpi-sub">leads received (work-date cohort) · 7 sources — 3 genre sheets + 4 Forms Data tabs</span>
            </p>
            <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
              <div className="bg-(--bar-fill)" style={{ width: `${leadMixSeg(data.leads.animalia)}%` }} />
              <div className="bg-(--text-muted)" style={{ width: `${leadMixSeg(data.leads.family)}%` }} />
              <div className="bg-(--genre-fairyland)" style={{ width: `${leadMixSeg(data.leads.fairyland)}%` }} />
              <div className="bg-(--src-auction)" style={{ width: `${leadMixSeg(data.leads.auction_register_certificate)}%` }} />
              <div className="bg-(--src-ads)" style={{ width: `${leadMixSeg(data.leads.google_ads_leads)}%` }} />
              <div className="bg-(--src-alliance)" style={{ width: `${leadMixSeg(data.leads.alliance_activate_certificate)}%` }} />
              <div className="bg-(--src-website)" style={{ width: `${leadMixSeg(data.leads.website_applications)}%` }} />
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
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--genre-fairyland)" aria-hidden="true" />
                <span className="tabular-nums">{formatInt(data.leads.fairyland)}</span> Fairyland
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--src-auction)" aria-hidden="true" />
                <span className="tabular-nums">{formatInt(data.leads.auction_register_certificate)}</span> Auction Certificates
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--src-ads)" aria-hidden="true" />
                <span className="tabular-nums">{formatInt(data.leads.google_ads_leads)}</span> Google Ads
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--src-alliance)" aria-hidden="true" />
                <span className="tabular-nums">{formatInt(data.leads.alliance_activate_certificate)}</span> Alliance Certificates
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--src-website)" aria-hidden="true" />
                <span className="tabular-nums">{formatInt(data.leads.website_applications)}</span> Website Applications
              </li>
            </ul>
        </Panel>
      </section>

      {/* 5b — LEAD SOURCE PERFORMANCE (owner directive 2026-10-27, SIMPLIFIED;
          Final Booking Logic 10/28): Leads-only — the table answers ONE
          question: how many leads did each source contribute to this WORK
          week's cohort (the same definition Team trends / Reps / Today use).
          The cohort-produced Bookings / Conversion % columns LEAVE the table
          (owner §6: cohort-produced bookings no longer displayed; production
          reports as Gross / Cancellations / Net in the hero). The booking-period
          three-category audit (prior-period, no-link, later-period, coverage,
          win-week view) lives unchanged in the collapsed Attribution detail,
          relabeled audit-only. */}
      <section aria-label="Lead source performance">
        <Panel className="p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="kpi-label flex items-center gap-1.5">
              Lead Source Performance
              <InfoTip
                label="What the per-source counts mean"
                tip={
                  <>
                    Leads Received = the source's leads in the week's WORK-DATE cohort (sheet dates the team
                    works Mon–Fri of the report week — Fri/Sat/Sun sheet dates land on Monday; the same cohort
                    Team trends, the Reps page and Today use). The Leads column classifies exactly like the
                    Lead Composition panel (genre sheets by lead type, Forms Data tabs by sheet). The former
                    cohort-produced Bookings / Conversion % columns left this table (owner Final Booking
                    Logic 10/28 §6: cohort-produced bookings are no longer displayed — production reports as
                    Gross / Cancellations / Net in the hero). Attribution detail below keeps the booking-period
                    audit untouched, relabeled audit-only: the week's WINS by the nearest-lead source rule
                    (prior-period matches kept under their source, never a numerator; Truly Unattributed = no
                    reliable sheet-lead link — the only meaning of "Unattributed" anywhere in the app;
                    later-period; coverage).
                  </>
                }
              />
            </p>
            <p className="kpi-sub">report week · audit detail below</p>
          </div>
          {/* PRIMARY TABLE (owner directive 10/27 simplified; Final Booking Logic
              10/28): exactly Lead Source | Leads Received — one row per
              production source + Total, straight from the work-date cohort
              (computeLeadCohortOutcomes). The cohort-produced Bookings /
              Conversion % columns left with the "Bookings from leads" panel
              (owner §6); the booking-period audit (Truly Unattributed,
              prior/later, coverage) lives in the Attribution detail below.
              "Other sheet" renders only when nonzero (never merged away). */}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-(--table-border) text-left text-(--text-caption)">
                  <th scope="col" className="py-1.5 pr-3 font-medium">Lead Source</th>
                  <th scope="col" className="py-1.5 pl-3 text-right font-medium">Leads Received</th>
                </tr>
              </thead>
              <tbody>
                {data.sourcePerformance.cohort
                  .map((r) => (
                    <tr key={r.source} className={r.source === "total" ? "border-t border-(--table-border) font-semibold text-(--text-primary)" : "border-t border-(--table-border-weak)"}>
                      <td className="py-1.5 pr-3 text-(--text-body)">{r.label}</td>
                      <td className="py-1.5 pl-3 text-right tabular-nums text-(--text-body)">{formatInt(r.leads)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 space-y-1 text-xs leading-snug text-(--text-muted)">
            <p>
              Leads Received = the week's work-date cohort (all seven sources). Production — Gross /
              Cancellations / Net — is the hero block above; this table carries leads only. The
              booking-period audit (active paid wins, prior-period, no-link, coverage) is in the
              Attribution detail below.
            </p>
          </div>
          {/* The additive "Bookings Produced (Mon–Sun)" figure REMOVED — superseded
              by the hero: gross IS that produced figure, now the page's primary
              number with Cancellations/Net underneath. */}
          {/* ATTRIBUTION DETAIL (audit view — the owner directive keeps this
              out of the primary table but never deletes it; relabeled audit-only
              per Final Booking Logic 10/28 item 7): the full
              three-category BOOKING-PERIOD table (wins won in the week by the
              nearest-lead source — untouched data) plus best/worst and the
              honest no-link count and coverage. The work-date cohort table
              itself is the primary table above. */}
          <details className="group/atd mt-4">
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-xs text-(--text-caption) transition-colors hover:text-(--text-primary)">
              <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className="transition-transform group-open/atd:rotate-90"
                aria-hidden="true"
              >
                <path d="M4 2.5L8 6L4 9.5" />
              </svg>
              Attribution detail — booking-period audit: prior-period, no-link, coverage
            </summary>
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              {/* (b) booking-period flavor: wins of the week by source —
                  THREE-CATEGORY semantics (owner directive 10/27,
                  post-validation): current-period matches feed the conversion
                  numerators; prior-period matches keep their resolved source
                  (never Unattributed); only no-link wins are Truly Unattributed. */}
              <div>
                <p className="text-[13px] font-medium text-(--text-body)">Bookings won this week — by lead source (full breakdown)</p>
                <p className="kpi-sub mt-0.5">
                  {formatInt(data.sourcePerformance.table.totalBookings)} active paid wins — audit view (excludes later
                  cancellations; production = Gross/Net above) · cohort conversion = current-period bookings ÷ that
                  source's leads this week
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-(--table-border) text-left text-(--text-caption)">
                        <th scope="col" className="py-1.5 pr-3 font-medium">Source</th>
                        <th scope="col" className="py-1.5 pl-3 text-right font-medium">Leads</th>
                        <th scope="col" className="py-1.5 pl-3 text-right font-medium">Current-period</th>
                        <th scope="col" className="py-1.5 pl-3 text-right font-medium">Prior-period</th>
                        {data.sourcePerformance.table.totalLaterBookings > 0 && (
                          <th scope="col" className="py-1.5 pl-3 text-right font-medium">Later-period</th>
                        )}
                        <th scope="col" className="py-1.5 pl-3 text-right font-medium">No link</th>
                        <th scope="col" className="py-1.5 pl-3 text-right font-medium">Cohort conv %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sourcePerformance.table.rows.map((r) => (
                        <tr key={r.source} className={r.source === "total" ? "border-t border-(--table-border) font-semibold text-(--text-primary)" : "border-t border-(--table-border-weak)"}>
                          <td className="py-1.5 pr-3 text-(--text-body)">{r.label}</td>
                          <td className="py-1.5 pl-3 text-right tabular-nums text-(--text-body)">{formatInt(r.leads)}</td>
                          {/* The Truly Unattributed row is not a current/prior count — its
                              no-link total lives in the No-link column. */}
                          <td className="py-1.5 pl-3 text-right tabular-nums text-(--text-body)">
                            {r.source === "unattributed" ? "—" : formatInt(r.bookings)}
                          </td>
                          <td className="py-1.5 pl-3 text-right tabular-nums text-(--text-body)">
                            {r.source === "unattributed" ? "—" : formatInt(r.priorBookings)}
                          </td>
                          {data.sourcePerformance.table.totalLaterBookings > 0 && (
                            <td className="py-1.5 pl-3 text-right tabular-nums text-(--text-body)">
                              {r.source === "unattributed" ? "—" : formatInt(r.laterBookings)}
                            </td>
                          )}
                          <td className="py-1.5 pl-3 text-right tabular-nums text-(--text-body)">
                            {r.source === "unattributed" ? formatInt(data.sourcePerformance.table.trulyUnattributedBookings) : r.source === "total" ? formatInt(data.sourcePerformance.table.trulyUnattributedBookings) : "—"}
                          </td>
                          <td className={"py-1.5 pl-3 text-right tabular-nums " + (r.conv == null ? "text-(--text-faint)" : "text-(--text-primary)")}>
                            {r.conv == null ? "—" : formatPercent(r.conv, 1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 space-y-1 text-xs leading-snug text-(--text-muted)">
                  <p>
                    Truly Unattributed = no reliable sheet-lead link. Prior-period = the booking's matched lead
                    predates the report week — it stays under its source and NEVER enters a conversion numerator.
                    {data.sourcePerformance.table.totalLaterBookings > 0 &&
                      ` ${formatInt(data.sourcePerformance.table.totalLaterBookings)} booking(s) resolved to a lead with a sheet date AFTER the report week — shown as Later-period, not merged.`}
                  </p>
                  {data.sourcePerformance.table.coverage != null && (
                    <p>
                      Source-resolved {formatInt(data.sourcePerformance.table.sourceResolvedBookings)}/
                      {formatInt(data.sourcePerformance.table.totalBookings)} paid bookings (
                      {formatPercent(data.sourcePerformance.table.coverage, 2)} attribution coverage).
                    </p>
                  )}
                  <p>
                    Total conv % here is the audit table's own cohort figure (current-period bookings ÷ that source's
                    sheet-date leads this week); the primary table above is the WORK-DATE cohort counted to date — a
                    deliberately different, auditable view.
                  </p>
                </div>
              </div>
            </div>
            {/* Best/worst (same week's table, computed in page-data): audit-only
                since the simplified report — never a fabricated label. */}
            <p className="mt-4 text-xs leading-snug text-(--text-muted)">
              Best source: {data.report.sourcePerformance.best ?? "—"} · Worst source: {data.report.sourcePerformance.worst ?? "—"}
            </p>
          </details>
          <p className="mt-3 text-xs text-(--text-muted)">{data.sourcePerformance.overlap.note}</p>
        </Panel>
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
                  configured blocks, so capacity updates with the schedule). Fill counts DISTINCT slots occupied (owner
                  report 10/6, calendar-fill accuracy): a double-booked slot fills ONE slot, so the fill never exceeds
                  capacity — the raw session count is shown alongside and the difference is the extra sessions sharing
                  booked slots. The first fully open day scans forward for the first date with zero appointments and an
                  open studio; sessions beyond next week still count there.
                </>
              }
            />
          </p>
          <div className="mt-4 space-y-4">
            {[
              { label: cal.thisWeek.label, start: cal.thisWeek.start, end: cal.thisWeek.end, appointments: cal.thisWeek.appointments, slotsOccupied: cal.thisWeek.slotsOccupied, capacity: cal.thisWeek.capacity, holes: cal.thisWeek.holes },
              { label: cal.nextWeek.label, start: cal.nextWeek.start, end: cal.nextWeek.end, appointments: cal.nextWeek.appointments, slotsOccupied: cal.nextWeek.slotsOccupied, capacity: cal.nextWeek.capacity, holes: cal.nextWeek.holes },
            ].map((row) => (
              <div key={row.label}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-[13px] font-medium text-(--text-body)">{row.label}</p>
                  <p className="text-[13px] tabular-nums text-(--text-muted)">
                    {formatDateHuman(row.start)} – {formatDateHuman(row.end)}
                  </p>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {/* P1-20 (mobile): the flex row squeezed the number so
                      "55 / 69" stacked into 3 fragments — phones keep the
                      pair on one line and the caption wraps instead. */}
                  <p className="text-xl font-semibold tracking-tight tabular-nums text-(--text-primary) max-md:whitespace-nowrap">
                    {formatInt(row.slotsOccupied)}
                    <span className="text-sm font-normal text-(--text-muted)"> / {row.capacity > 0 ? row.capacity : "—"}</span>
                  </p>
                  <p className="kpi-sub">
                    distinct slots occupied vs studio capacity
                    {row.capacity > 0 && ` · ${Math.round((row.slotsOccupied / row.capacity) * 100)}% filled`}
                    {row.appointments !== row.slotsOccupied &&
                      ` · ${formatInt(row.appointments)} sessions (+${formatInt(row.appointments - row.slotsOccupied)} over slots)`}
                  </p>
                </div>
                <div className="mt-1.5">
                  <RatioBar ratio={row.capacity > 0 ? row.slotsOccupied / row.capacity : null} height="h-1" max="max-w-none" />
                </div>
                {/* OWNER HOLES (9/30) — the empty-slot complement of the fill
                    above, computed by the SAME derivation the copied report
                    uses; per-day breakdown expandable. "—" when not defined. */}
                <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-[13px] tabular-nums text-(--text-body)">
                    Holes (empty slots):{" "}
                    {row.holes == null ? (
                      <span className="text-(--text-muted)">—</span>
                    ) : (
                      <span className="font-semibold text-(--text-primary)">{formatInt(row.holes.holes)}</span>
                    )}
                    <InfoTip
                      label="How holes are computed"
                      tip={
                        <>
                          Owner ruling (10/11): holes = OPEN SLOTS in the same Mon–Sun working week — derived studio
                          capacity (10 slots/day, 9 on Tuesday) minus the DISTINCT slots occupied per ET day, summed
                          Mon–Sun. A double-booked slot fills one slot; its extra sessions stay visible in the sessions
                          figure. Cancelled appointments book no session; a pending-payment booking does NOT occupy
                          its slot either — it counts open (owner ruling 10/11: pending clients usually don't pay and
                          the agents take them off the schedule), while the session itself stays in the sessions
                          figure. For the in-progress week this is open-so-far (it shrinks as the
                          week fills); for next week it is open slots. The copied CC Report carries the last COMPLETED
                          week's holes.
                        </>
                      }
                    />
                  </p>
                  {row.holes != null && (
                    <details className="group/pd">
                      <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-xs text-(--text-caption) transition-colors hover:text-(--text-primary)">
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          className="transition-transform group-open/pd:rotate-90"
                          aria-hidden="true"
                        >
                          <path d="M4 2.5L8 6L4 9.5" />
                        </svg>
                        Per-day
                      </summary>
                      <div className="overflow-x-auto">
                        <table className="mt-2 w-full max-w-md text-xs">
                          <thead>
                            <tr className="border-b border-(--card-border) text-left text-(--text-caption)">
                              <th scope="col" className="py-1 pr-2 font-medium" />
                              {row.holes.days.map((d) => (
                                <th scope="col" key={d.date} className="py-1 text-right font-medium tabular-nums">
                                  {weekdayName(d.date, false).slice(0, 3)}
                                  <span className="ml-1 font-normal text-(--text-muted)">{formatDateShort(d.date)}</span>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="tabular-nums text-(--text-body)">
                            {[
                              { label: "Capacity", pick: (d: { capacity: number }) => d.capacity },
                              { label: "Booked", pick: (d: { booked: number }) => d.booked },
                              { label: "Holes", pick: (d: { holes: number }) => d.holes },
                            ].map((r) => (
                              <tr key={r.label} className="border-b border-(--table-border-weak)">
                                <th scope="row" className="py-1 pr-2 text-left font-medium text-(--text-caption)">{r.label}</th>
                                {row.holes!.days.map((d) => (
                                  <td key={d.date} className={"py-1 text-right " + (r.label === "Holes" && d.holes > 0 ? "font-semibold text-(--text-primary)" : "")}>
                                    {formatInt(r.pick(d))}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
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
                  synced — nothing is invented meanwhile. Bookings here count active paid wins (attribution basis); later
                  cancellations excluded — the production block above shows Gross/Net.
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

      {/* 7 — MONTH TO DATE (secondary analysis; GROSS basis — owner Final
          Booking Logic 10/28: one production basis page-wide). The rep rows and
          Top performer stay on the protected active-wins/attribution basis,
          labeled in the InfoTip. */}
      <section aria-label="Month to date">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <Eyebrow>
            Month to date —{" "}
            {new Date(`${data.month.start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}
          </Eyebrow>
          <InfoTip
            label="How month to date is counted"
            tip="Gross bookings MTD: qualifying (paid-deposit) bookings ORIGINALLY CREATED in the current calendar month through today (ET) — identity-deduped per client, cancellations included; reschedules never move credit. Same produced basis as the hero's Gross. Rep rows and Top performer count active paid wins (attribution basis); later cancellations excluded."
          />
        </div>
        <Panel className="overflow-hidden">
          <div className="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,280px)] sm:divide-x sm:divide-(--table-border-weak)">
            <div className="p-5">
              <p className="kpi-label">Gross bookings MTD</p>
              <p className="mt-2 flex items-baseline gap-2.5 tabular-nums">
                <span className="text-4xl font-semibold leading-none tracking-tight text-(--text-primary)">
                  {formatInt(mtd.gross)}
                </span>
                {mtd.goal != null && <span className="text-xl font-medium text-(--text-muted)">/ {formatInt(mtd.goal)}</span>}
              </p>
              <div className="mt-3 max-w-md">
                <RatioBar ratio={mtd.goal != null && mtd.goal > 0 ? mtd.gross / mtd.goal : null} height="h-1" max="max-w-none" />
              </div>
              <p className="kpi-sub mt-2 tabular-nums">
                {mtd.goal != null ? `${signedDelta(mtd.gross, mtd.goal)} vs goal · ` : ""}
                {formatDateHuman(data.month.start)} – {formatDateHuman(data.month.end)}
              </p>
              <p className="mt-1 text-xs leading-snug text-(--text-muted)">
                Gross = qualifying paid bookings originally created {formatDateHuman(data.month.start)} –{" "}
                {formatDateHuman(data.month.end)} (identity-deduped; cancellations included). Cancellations MTD:{" "}
                {formatInt(mtd.cancellations)} · Net MTD: {formatInt(mtd.net)}.
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
                {mtd.topPerformer && <p className="kpi-sub mt-1">active paid wins MTD (attribution basis)</p>}
              </div>
            </div>
          </div>
        </Panel>
        <Panel className="mt-6 max-w-2xl overflow-hidden p-5 sm:p-6">
          <p className="kpi-label mb-3">By Rep — month to date</p>
          {/* P1-7 (mobile): the 420px floor pushed the right-aligned numbers
              off-screen at 390 — phones drop the floor so Rep | Paid bookings
              fits (names wrap); ≥768 keeps the exact table. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm max-md:min-w-0">
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
                computed top performer — edit freely. COPY REPORT puts the full text on your clipboard; the Holes line is
                computed from the owner's definition (empty slots = derived capacity − booked sessions, 9/30), while
                Empty appointments and 1st Call Completed stay blank until the owner defines them — no numbers are
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
                  {s.key === "celebrate" && <span className="ml-2 font-normal text-[12px] normal-case text-(--text-muted)">auto-filled with this week's computed top performer — editable</span>}
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
          {/* P1-9 (mobile): the Save CTA went 3-lines tall squeezed beside the
              hint — phones give it the full row (global rules already give
              every button ≥44px height); the hint wraps below. ≥768 unchanged. */}
          <div className="mt-4 flex items-center gap-3 border-t border-(--table-border-weak) pt-4 max-md:flex-wrap">
            <button
              type="button"
              onClick={saveNotes}
              disabled={saveState === "saving"}
              className="btn-primary max-md:w-full"
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
