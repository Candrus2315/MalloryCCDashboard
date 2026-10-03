import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
// Harmonization Wave 1: Panel/Eyebrow/RatioBar live ONCE in the shared
// page-primitives module (same markup they replaced here).
import { Eyebrow, Panel, RatioBar } from "~/components/page-panel";
import {
  advanceCommissionCycle,
  applyCommissionCorrectionFn,
  assignCommissionWeeksFn,
  getCommissionData,
  submitCommissionCycleFn,
  unassignCommissionWeeksFn,
} from "~/server/queries";
import type { CommissionCycleStatus } from "~/server/commission/lifecycle";
import type { CommissionAdjustmentRow, CommissionCycleRow, CommissionWeeklyRow } from "~/server/store/types";
import { WarningList } from "~/components/warnings";
import { InfoTip } from "~/components/InfoTip";
import { CommissionsShell, CommissionChip } from "~/components/commission-shell";
import { CommissionWeeklyDrawer } from "~/components/commission-drawer";
import { EmptyState } from "~/components/performance-shell";
import {
  assignmentChip,
  buildPayrollEmail,
  compositionWeekCards,
  cycleChip,
  cycleContextLine,
  cycleWeekStarts,
  dateWithWeekday,
  gridRows,
  poolChip,
  rollupStoredCycle,
  shortRange,
} from "~/components/commission-views";
import { CopyButton } from "~/components/CopyButton";
import { formatInt, formatMoney } from "~/server/metrics/report-text";
import { addDays, weekdayName } from "~/server/date-logic";

export const Route = createFileRoute("/commissions")({
  loader: () => getCommissionData(),
  component: CommissionsPage,
});

/* ---------------------------------------------------------------------------
   COMMISSION CENTER (owner directive 2026-10-01; Phase B — presentation only;
   spec §3). Every number renders from STORED weekly records / the cycle row /
   the pure engine's estimate of the in-progress week — nothing recomputed on
   the client, no manual totals (§Q). Missing data renders "—", never 0; the
   in-progress week is labeled Estimated; demo mode shows the status-banner.
   Sections follow the shared page shell:
     1. title + context            4. cycle composition strip (RULING 4 visible)
     2. cycle overview strip       5. estimated in-progress week (§3.5)
     3. employee × week grid       6. payroll zone (Phase C placeholder)
                                   7. audit footer
--------------------------------------------------------------------------- */

function CommissionsPage() {
  const data = Route.useLoaderData();
  const weeks = cycleWeekStarts(data.cycle);
  const rollup = rollupStoredCycle(data.records, weeks);
  const cards = compositionWeekCards(data.records, weeks);
  const cycleStatus = cycleChip(data.cycle?.status);
  const grid = gridRows(data.roster, data.records, weeks);
  // drawer state: one drawer, the employee-week record it was opened from
  const [drawerRecord, setDrawerRecord] = useState<CommissionWeeklyRow | null>(null);
  // per-week team bookings (stored sums; the drawer's pool block needs the week context)
  const teamBookingsFor = (weekStart: string): number | null => {
    const mine = data.records.filter((r) => r.week_start === weekStart);
    return mine.length > 0 ? mine.reduce((s, r) => s + r.qualifying_bookings, 0) : null;
  };

  // deadline phrase — real date math only, never alarm styling (§3.2)
  const submissionPhrase = (() => {
    if (!data.cycle) return null;
    const diff = Math.round((Date.parse(data.cycle.submission_date) - Date.parse(data.today)) / 86_400_000);
    if (diff < 0) return "past due";
    if (diff === 0) return "due today";
    return `in ${formatInt(diff)} day${diff === 1 ? "" : "s"}`;
  })();

  const weeksCompleted = weeks.filter((w) => data.records.some((r) => r.week_start === w)).length;
  // Riding boundary weeks come STRAIGHT from the loader — page-data.ts already
  // applied RULING 4's default-assembly filter (unassignedRidingNextCycle);
  // the page never re-derives assembly (one rule, one implementation).
  const ridingWeeks = data.unassignedRiding;
  const ridingWeekStarts = [...new Set(ridingWeeks.map((r) => r.week_start))];

  const calcVersionsLabel =
    rollup.calcVersions.length === 0
      ? "—"
      : rollup.calcVersions.length === 1
        ? `calc version ${rollup.calcVersions[0]}`
        : `calc versions ${rollup.calcVersions.join(", ")}`;

  return (
    <CommissionsShell
      path="/commissions"
      title="Commission Center"
      // §6.1: the cycle chip beside the h1 only when a cycle exists — no
      // invented status before the backfill writes the first cycle row.
      statusChip={data.cycle ? cycleStatus : undefined}
    >
      <div className="space-y-5">
        {/* §3.1 context line — the stored cycle row's own values, never hardcoded */}
        {data.cycle && (
          <p className="text-[13px] tabular-nums text-(--text-muted)">{cycleContextLine(data.cycle)}</p>
        )}
        {/* demo mode + missing-data warnings — mandatory slots (spec §2) */}
        {data.meta.mode === "memory" && (
          <p className="status-banner">
            <span className="font-medium">Demo data (in-memory).</span> Database not connected
            {data.meta.dbReason ? ` — ${data.meta.dbReason}` : ""}.
          </p>
        )}
        <WarningList items={data.warnings} />

        {!data.cycle ? (
          <EmptyState
            title="No commission cycle stored yet"
            hint="The historical backfill writes the first cycle after its dry-run is reviewed — numbers are never typed manually (§Q)."
          />
        ) : (
          <>
            {/* 2 — CYCLE OVERVIEW STRIP: deadline anchor | money strip */}
            <section aria-label="Cycle overview">
              <Panel className="overflow-hidden">
                <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:divide-x lg:divide-(--table-border-weak)">
                  {/* left / primary — the cycle + deadline is the visual anchor */}
                  <div className="p-5 sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                      <Eyebrow>
                        <span className="inline-flex items-center gap-1.5">
                          Current Commission Cycle
                          <InfoTip
                            label="What a commission cycle is"
                            tip="Commission cycles are built from completed Mon–Sun weeks, not calendar months (owner ruling 10/1). The grid keeps the owner's Monthly column wording; the cycle label carries the date truth."
                          />
                        </span>
                      </Eyebrow>
                      <CommissionChip view={cycleStatus} />
                    </div>
                    <p className="mt-3 text-5xl font-semibold leading-none tracking-tight text-(--text-primary)">
                      {data.cycle.label}
                    </p>
                    <p className="mt-2 text-[13px] tabular-nums text-(--text-muted)">
                      {weeksCompleted} of {formatInt(weeks.length)} weeks with records
                    </p>
                    <div className="mt-3">
                      <RatioBar ratio={weeks.length > 0 ? weeksCompleted / weeks.length : null} max="max-w-md" />
                    </div>
                    <dl className="mt-5 space-y-3 border-t border-(--table-border-weak) pt-4 sm:flex sm:flex-wrap sm:gap-x-10 sm:space-y-0">
                      <div>
                        <dt className="text-[13px] font-medium text-(--text-body)">Next Submission</dt>
                        <dd className="mt-0.5 flex items-baseline gap-2">
                          <span className="text-[15px] font-semibold tabular-nums text-(--text-primary)">
                            {dateWithWeekday(data.cycle.submission_date)}
                          </span>
                          {submissionPhrase && <span className="kpi-sub">{submissionPhrase}</span>}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[13px] font-medium text-(--text-body)">Payroll Date</dt>
                        <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-(--text-primary)">
                          {dateWithWeekday(data.cycle.payroll_date)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  {/* right / supporting — the cycle's money strip (stored sums) */}
                  <div className="border-t border-(--table-border-weak) p-5 lg:border-t-0">
                    <Eyebrow>Cycle Totals</Eyebrow>
                    <div className="mt-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-[13px] font-medium text-(--text-body)">
                          <span className="inline-flex items-center gap-1.5">
                            Total Team Bookings
                            <InfoTip
                              label="What counts as a team booking for commissions"
                              tip="Rep-attributed CC Booking Wins only — online, unattributed, ambiguous and non-CC bookings never count toward 79, never fund the pool, and never receive allocation (owner ruling 10/1)."
                            />
                          </span>
                        </p>
                        <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                          {rollup.teamBookings > 0 || data.records.length > 0 ? formatInt(rollup.teamBookings) : "—"}
                        </span>
                      </div>
                      <p className="kpi-sub mt-1">rep-attributed qualifying wins</p>
                      <div className="mt-1.5">
                        <CommissionChip
                          view={poolChip(
                            data.records.length > 0 ? rollup.teamBookings >= 79 : null,
                            data.records.length > 0 ? rollup.teamBookings : null,
                          )}
                        />
                      </div>
                    </div>
                    <dl className="mt-4 space-y-3 border-t border-(--table-border-weak) pt-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-[13px] font-medium text-(--text-body)">Total Commission Accrued</dt>
                        <dd className="text-xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                          {data.records.length > 0 ? formatMoney(rollup.teamTotal) : "—"}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-[13px] font-medium text-(--text-body)">79 Pool Payouts</dt>
                        <dd className="text-xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                          {data.records.length > 0 ? formatMoney(rollup.teamPool) : "—"}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-[13px] font-medium text-(--text-body)">Hole Bonuses</dt>
                        <dd className="text-xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                          {data.records.length > 0 ? formatMoney(rollup.teamHoles) : "—"}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-[13px] font-medium text-(--text-body)">Adjustments</dt>
                        <dd className="text-xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                          {data.records.length > 0 ? formatMoney(rollup.teamAdjustments) : "—"}
                        </dd>
                      </div>
                    </dl>
                    {data.records.length === 0 && (
                      <p className="kpi-sub mt-3">No stored weekly records in this cycle yet.</p>
                    )}
                  </div>
                </div>
              </Panel>
            </section>

            {/* 3 — EMPLOYEE × WEEK GRID (dynamic week columns; cells open the drawer) */}
            <section aria-label="Employee weekly commissions">
              <Panel className="overflow-hidden">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 p-5 pb-0 sm:p-6 sm:pb-0">
                  <Eyebrow>Employee × Week</Eyebrow>
                  <p className="text-xs text-(--text-muted)">
                    click any cell for the exact counted records · bookings / weekly bonus
                  </p>
                </div>
                <div className="overflow-x-auto p-5 sm:p-6">
                  <table className="data-table min-w-[960px]">
                    <thead>
                      <tr>
                        <th scope="col" className="sticky left-0 z-[1] sticky-cell text-left">Employee</th>
                        <th scope="col" className="text-left">Tier</th>
                        {weeks.map((w, i) => (
                          <th key={w} scope="col" className="text-left">
                            <span className="inline-flex items-center gap-1 normal-case">
                              {`W${i + 1}`} · {shortRange(w, addDays(w, 6))}
                              <InfoTip
                                label={`Full dates of week ${i + 1}`}
                                tip={`${weekdayName(w, true)} ${w} – ${weekdayName(addDays(w, 6), true)} ${addDays(w, 6)} (Mon–Sun, ET)`}
                              />
                            </span>
                          </th>
                        ))}
                        <th scope="col" className="text-right">Monthly Bookings</th>
                        <th scope="col" className="text-right">Monthly Bonus</th>
                        <th scope="col" className="text-left">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grid.map((row) => (
                        <tr key={row.userId} className={row.eligible ? undefined : "text-(--text-caption)"}>
                          <td className={"sticky left-0 z-[1] sticky-cell py-2 font-medium " + (row.eligible ? "" : "text-(--text-caption)")}>
                            {row.name}
                          </td>
                          <td className="py-2">
                            {row.eligible && row.tierLabel ? (
                              <span className="chip chip-neutral">
                                <span className="h-1.5 w-1.5 rounded-full bg-(--dot-muted)" aria-hidden="true" />
                                {row.tierLabel}
                              </span>
                            ) : (
                              <span className="chip chip-neutral">
                                <span className="h-1.5 w-1.5 rounded-full bg-(--dot-muted)" aria-hidden="true" />
                                No tier · Ineligible
                              </span>
                            )}
                          </td>
                          {row.cells.map((cell, i) => {
                            const weekStart = weeks[i];
                            const record = cell
                              ? (data.records.find((r) => r.user_id === row.userId && r.week_start === weekStart) ?? null)
                              : null;
                            return (
                              <td key={weekStart} className="py-1.5">
                                {record ? (
                                  <button
                                    type="button"
                                    onClick={() => setDrawerRecord(record)}
                                    aria-label={`${row.name} — week of ${shortRange(weekStart, addDays(weekStart, 6))} commission detail`}
                                    className="block w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                                  >
                                    <span className="block text-[15px] font-semibold tabular-nums text-(--text-primary)">
                                      {cell!.bookings}
                                    </span>
                                    <span className="block text-xs tabular-nums text-(--text-muted)">{cell!.money}</span>
                                    {cell!.holesLine && (
                                      <span className="mt-0.5 block text-[11px] tabular-nums text-(--text-caption)">
                                        {cell!.holesLine}
                                      </span>
                                    )}
                                  </button>
                                ) : row.eligible ? (
                                  <span className="px-2 text-[15px] text-(--text-faint)">—</span>
                                ) : (
                                  <span className="px-2 text-[15px] text-(--text-faint)">—</span>
                                )}
                              </td>
                            );
                          })}
                          <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">
                            {row.monthlyBookings == null ? "—" : formatInt(row.monthlyBookings)}
                          </td>
                          <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">
                            {row.monthlyBonus == null ? "—" : formatMoney(row.monthlyBonus)}
                          </td>
                          <td className="py-2">
                            <CommissionChip view={row.status} />
                          </td>
                        </tr>
                      ))}
                      {/* team totals footer — same stored records, same sums as the header strip */}
                      <tr className="border-t border-(--table-border-strong)">
                        <td className="sticky left-0 z-[1] sticky-cell py-2 font-semibold text-(--text-primary)">Team totals</td>
                        <td className="py-2" />
                        {cards.map((card) => (
                          <td key={card.weekStart} className="py-2">
                            {card.teamBookings == null ? (
                              <span className="text-(--text-faint)">—</span>
                            ) : (
                              <>
                                <span className="block text-[15px] font-semibold tabular-nums text-(--text-primary)">
                                  {formatInt(card.teamBookings)}
                                </span>
                                <span className="block text-xs tabular-nums text-(--text-muted)">
                                  {formatMoney(card.bonusSum ?? 0)}
                                </span>
                              </>
                            )}
                          </td>
                        ))}
                        <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">
                          {data.records.length > 0 ? formatInt(rollup.teamBookings) : "—"}
                        </td>
                        <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">
                          {data.records.length > 0 ? formatMoney(rollup.teamTotal) : "—"}
                        </td>
                        <td className="py-2" />
                      </tr>
                    </tbody>
                  </table>
                  <p className="mt-3 text-[13px] text-(--text-caption)">
                    Dan McKillop has no commission tier assigned (rostered Sep 28) — excluded from commission calculations.
                  </p>
                </div>
              </Panel>
            </section>

            {/* 4 — CYCLE COMPOSITION STRIP: RULING 4 assembly made visible */}
            <section aria-label="Cycle composition">
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <Eyebrow>Cycle Composition</Eyebrow>
                <InfoTip
                  label="How the cycle assembles"
                  tip="Cycles are built from completed Mon–Sun weeks — not calendar months (owner ruling 10/1). A completed unassigned week joins this cycle when its Sunday close ended at least 7 days before the submission Monday."
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {cards.map((card) => (
                  <div key={card.weekStart} className="rounded-xl border border-(--card-border) bg-(--card-bg) p-4">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <p className="text-[13px] font-semibold text-(--text-primary)">{card.label}</p>
                      <CommissionChip view={card.assignment} />
                    </div>
                    <p className="mt-2 text-[13px] tabular-nums text-(--text-body)">
                      {card.teamBookings == null ? (
                        <span className="text-(--text-faint)">—</span>
                      ) : (
                        <>
                          {formatInt(card.teamBookings)} team bookings ·{" "}
                          {card.poolUnlocked ? (
                            <>
                              pool unlocked {card.poolMoney && `(${card.poolMoney})`}
                            </>
                          ) : (
                            "pool locked"
                          )}
                        </>
                      )}
                    </p>
                    <p className="mt-1 text-[13px] tabular-nums text-(--text-muted)">
                      Σ employee bonus {card.bonusSum == null ? "—" : formatMoney(card.bonusSum)} ·{" "}
                      {formatInt(card.employeesWithRecords)} {card.employeesWithRecords === 1 ? "employee" : "employees"} with records
                    </p>
                  </div>
                ))}
              </div>
              {ridingWeekStarts.length > 0 && (
                <div className="mt-3 space-y-1">
                  {ridingWeekStarts.map((weekStart) => (
                    <p key={weekStart} className="text-[13px] text-(--text-caption)">
                      Week {shortRange(weekStart, addDays(weekStart, 6))} closes {weekdayName(addDays(weekStart, 6), true)}{" "}
                      11:59 PM ET and rides the NEXT cycle (owner ruling: the just-closed week never rides the submission
                      Monday's cycle).
                    </p>
                  ))}
                  <p className="text-xs text-(--text-muted) tabular-nums">
                    {formatInt(ridingWeekStarts.length)} unassigned boundary {ridingWeekStarts.length === 1 ? "week" : "weeks"} ·{" "}
                    {formatInt(ridingWeeks.length)} stored records
                  </p>
                </div>
              )}
            </section>
          </>
        )}

        {/* 5 — ESTIMATED IN-PROGRESS WEEK (§3.5): amber Estimated chip; no drawer */}
        {data.estimated && (
          <section aria-label="Current week estimate">
            <Panel className="p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Eyebrow>Week of {shortRange(data.estimated.weekStart, addDays(data.estimated.weekStart, 6))} — In Progress</Eyebrow>
                  <span className="chip chip-risk">
                    <span className="h-1.5 w-1.5 rounded-full bg-(--dot-caution)" aria-hidden="true" />
                    Estimated
                  </span>
                  <InfoTip
                    label="Why these numbers are Estimated"
                    tip="During the active week everything is Estimated; after the Sunday cutoff the weekly record is Final (§22). Nothing here opens a drawer — no stored record exists yet, so there is nothing to audit."
                  />
                </div>
                <p className="kpi-sub">
                  closes {weekdayName(addDays(data.estimated.weekStart, 6), true)} 11:59 PM ET · numbers move until cutoff
                </p>
              </div>
              <div className="mt-4 divide-y divide-(--table-border-weak)">
                {data.estimated.view ? (
                  <>
                    {data.estimated.view.employees.map((e) => (
                      <div key={e.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                        <span className="text-[13px] font-medium text-(--text-body)">{e.name}</span>
                        <span className="flex items-baseline gap-3 text-[13px] tabular-nums">
                          <span className="font-semibold text-(--text-primary)">{formatInt(e.bookings)}</span>
                          <span className="text-(--text-muted)">{e.bonusMoney ?? "—"}</span>
                          <CommissionChip view={e.poolStatus} />
                        </span>
                      </div>
                    ))}
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                      <span className="text-[13px] font-semibold text-(--text-primary)">Team</span>
                      <span className="flex items-baseline gap-3 text-[13px] tabular-nums">
                        <span className="font-semibold text-(--text-primary)">
                          {formatInt(data.estimated.view.teamBookings)}/79
                        </span>
                        <CommissionChip
                          view={poolChip(data.estimated.view.poolUnlocked, data.estimated.view.teamBookings)}
                        />
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="py-2 text-[13px] text-(--text-muted)">
                    — in-progress computation unavailable
                    {data.estimated.error ? ` (${data.estimated.error})` : ""} — no estimate is shown rather than a
                    plausible number.
                  </p>
                )}
              </div>
            </Panel>
          </section>
        )}

        {/* 6 — PAYROLL SUBMISSION ZONE (Phase C): approval workflow, Copy Payroll
            Email, week membership, reason-required corrections — all audited. */}
        {data.cycle && (
          <PayrollZone
            cycle={data.cycle}
            cycleBound={data.records.filter((r) => r.cycle_id === data.cycle!.id)}
            weeks={weeks}
            ridingWeekStarts={ridingWeekStarts}
            adjustments={data.adjustments}
          />
        )}

        {/* 7 — AUDIT FOOTER */}
        <p className="text-[13px] text-(--text-caption)">
          Weekly records are frozen at the Sunday cutoff · {calcVersionsLabel} · corrections are reason-required and
          audited · submitted cycles lock forever (stored payroll never rewritten).
        </p>
      </div>

      {/* the ONE weekly detail drawer (§4) */}
      <CommissionWeeklyDrawer
        open={drawerRecord != null}
        onClose={() => setDrawerRecord(null)}
        record={drawerRecord}
        cycleLabel={data.cycle?.label ?? null}
        teamBookings={drawerRecord ? teamBookingsFor(drawerRecord.week_start) : null}
      />
    </CommissionsShell>
  );
}



/* ---------------------------------------------------------------------------
   PHASE C — PAYROLL SUBMISSION ZONE
   §N approval workflow (In Progress → Ready for Review → Approved →
   Submitted; forward-only, manager-only, every step audited), §14/§16 Copy
   Payroll Email (stored numbers only, one block), §S week membership
   (assign/unassign with no-double-count guards), §O/§20 reason-required
   corrections, and the full cycle audit trail. No auto-submission exists.
--------------------------------------------------------------------------- */

/** Small solid action button (CopyButton's primary look, non-copy actions). */
function ActionButton({
  label, onClick, busy, tone = "primary",
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
  tone?: "primary" | "danger";
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={
        "rounded-lg px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-50 " +
        (tone === "danger"
          ? "border border-(--chip-risk-fg)/30 text-(--chip-risk-fg) hover:bg-(--chip-risk-bg)"
          : "bg-(--accent-solid) text-(--accent-solid-fg) hover:bg-(--accent-hover)")
      }
    >
      {label}
    </button>
  );
}

/** §N workflow stepper — four states, the reached/current one lit. */
const WORKFLOW_STEPS: Array<{ status: CommissionCycleStatus; label: string }> = [
  { status: "in_progress", label: "In Progress" },
  { status: "ready_for_review", label: "Ready for Review" },
  { status: "approved", label: "Approved" },
  { status: "submitted", label: "Submitted" },
];

const STEP_ORDER: Record<CommissionCycleStatus, number> = {
  in_progress: 0,
  ready_for_review: 1,
  approved: 2,
  submitted: 3,
};

function PayrollZone({
  cycle,
  cycleBound,
  weeks,
  ridingWeekStarts,
  adjustments,
}: {
  cycle: CommissionCycleRow;
  cycleBound: CommissionWeeklyRow[];
  weeks: string[];
  ridingWeekStarts: string[];
  adjustments: CommissionAdjustmentRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      await fn();
      await router.invalidate();
      setMessage(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const status = cycle.status;
  const current = STEP_ORDER[status] ?? 0;
  const emailText = buildPayrollEmail(cycleBound);
  const teamBookings = cycleBound.reduce((s, r) => s + r.qualifying_bookings, 0);
  const teamBonus = Math.round(cycleBound.reduce((s, r) => s + r.total, 0) * 100) / 100;
  const advance = (to: CommissionCycleStatus, ok: string) =>
    act(() => advanceCommissionCycle({ data: { cycleId: cycle.id, to } }), ok);

  return (
    <section aria-label="Payroll submission">
      <Panel className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <Eyebrow>Payroll Submission</Eyebrow>
          <div className="flex flex-wrap items-center gap-1.5">
            {WORKFLOW_STEPS.map((step, i) => {
              const reached = i <= current;
              return (
                <span
                  key={step.status}
                  className={
                    "chip " + (i === current ? "chip-positive" : reached ? "chip-neutral" : "chip-neutral opacity-50")
                  }
                >
                  <span
                    className={
                      "h-1.5 w-1.5 rounded-full " +
                      (i === current ? "bg-(--dot-positive)" : reached ? "bg-(--dot-muted)" : "bg-(--dot-muted) opacity-40")
                    }
                    aria-hidden="true"
                  />
                  {step.label}
                </span>
              );
            })}
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[13px] font-medium text-(--chip-risk-fg)">
            {error}
          </p>
        )}
        {message && !error && (
          <p role="status" className="mt-3 text-[13px] font-medium text-(--chip-positive-fg)">
            {message}
          </p>
        )}

        <div className="mt-4 space-y-4">
          {status === "in_progress" && (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <p className="text-[13px] text-(--text-body)">
                The cycle is being assembled. When its numbers look right, mark it ready for review.
              </p>
              <ActionButton
                busy={busy}
                label="Mark Ready for Review"
                onClick={() => advance("ready_for_review", "Cycle marked Ready for Review.")}
              />
            </div>
          )}
          {status === "ready_for_review" && (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <p className="text-[13px] text-(--text-body)">
                Under review — verify the grid and the validation screen before approving.
              </p>
              <ActionButton
                busy={busy}
                label="Approve cycle"
                onClick={() => advance("approved", "Cycle approved — Copy Payroll Email is available.")}
              />
            </div>
          )}
          {(status === "approved" || status === "submitted") && (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              <div>
                <p className="text-[13px] font-medium text-(--text-body)">
                  Payroll email — all commission employees in one block (stored numbers only)
                </p>
                <p className="kpi-sub mt-1">
                  {cycleBound.length} stored records · {teamBookings} bookings · {formatMoney(teamBonus)} total bonus
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton label="Copy Payroll Email" text={emailText} />
                {status === "approved" && (
                  <ActionButton
                    busy={busy}
                    tone="danger"
                    label="Submit cycle — locks forever"
                    onClick={() =>
                      act(async () => {
                        await submitCommissionCycleFn({ data: { cycleId: cycle.id } });
                      }, "Cycle submitted — all records locked (assignment: previously submitted).")
                    }
                  />
                )}
              </div>
            </div>
          )}
          {status === "submitted" && (
            <p className="text-[13px] text-(--text-caption)">
              Submitted {cycle.submitted_date}
              {cycle.submitted_by ? ` by ${cycle.submitted_by}` : ""} — this cycle is LOCKED: no tier/rate/setting
              change can ever rewrite its stored records or payroll totals (spec §19). Corrections remain possible and
              are audited below.
            </p>
          )}
        </div>

        {status !== "submitted" && (
          <details className="mt-5 rounded-lg border border-(--card-border) p-4">
            <summary className="cursor-pointer select-none text-[13px] font-medium text-(--text-body)">
              Week membership — unassigned / current / submitted (no double counting)
            </summary>
            <div className="mt-3 space-y-2">
              {weeks.map((w) => {
                const mine = cycleBound.filter((r) => r.week_start === w);
                const chip = assignmentChip(mine[0]?.assignment ?? null);
                return (
                  <div key={w} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <span className="text-[13px] tabular-nums text-(--text-body)">
                      {shortRange(w, addDays(w, 6))}
                    </span>
                    <span className="flex items-center gap-2">
                      <CommissionChip view={chip} />
                      <ActionButton
                        busy={busy}
                        tone="danger"
                        label="Release"
                        onClick={() =>
                          act(async () => {
                            await unassignCommissionWeeksFn({ data: { cycleId: cycle.id, weekStarts: [w] } });
                          }, `Week ${w} released to Unassigned.`)
                        }
                      />
                    </span>
                  </div>
                );
              })}
              {ridingWeekStarts.map((w) => (
                <div key={w} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <span className="text-[13px] tabular-nums text-(--text-muted)">
                    {shortRange(w, addDays(w, 6))} · unassigned (rides the next cycle)
                  </span>
                  <span className="flex items-center gap-2">
                    <ActionButton
                      busy={busy}
                      label="Assign to this cycle"
                      onClick={() =>
                        act(async () => {
                          await assignCommissionWeeksFn({ data: { cycleId: cycle.id, weekStarts: [w] } });
                        }, `Week ${w} assigned to this cycle.`)
                      }
                    />
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}

        <CorrectionForm cycleId={cycle.id} cycleBound={cycleBound} weeks={weeks} busy={busy} setBusy={setBusy} onError={setError} onDone={(m) => { setMessage(m); void router.invalidate(); }} />

        <AuditTrail adjustments={adjustments} />
      </Panel>
    </section>
  );
}

/** §O/§20: the ONE way stored money moves after approval — reason required, audited. */
function CorrectionForm({
  cycleId,
  cycleBound,
  weeks,
  busy,
  setBusy,
  onError,
  onDone,
}: {
  cycleId: string;
  cycleBound: CommissionWeeklyRow[];
  weeks: string[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onError: (m: string | null) => void;
  onDone: (m: string) => void;
}) {
  const employees = [...new Map(cycleBound.map((r) => [r.user_id, { userId: r.user_id, name: r.rep_name }])).values()];
  const [userId, setUserId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<string>("");
  const [kind, setKind] = useState<"manual_adjustment" | "exclude_booking" | "restore_booking" | "hole_bonus">("manual_adjustment");
  const [delta, setDelta] = useState<string>("");
  const [appointmentId, setAppointmentId] = useState<string>("");
  const [holeCount, setHoleCount] = useState<string>("1");
  const [reason, setReason] = useState<string>("");
  const employeeWeeks = [...new Set(cycleBound.filter((r) => !userId || r.user_id === userId).map((r) => r.week_start))]
    .filter((w) => weeks.includes(w) || weeks.length === 0)
    .sort();
  const record = cycleBound.find((r) => r.user_id === userId && r.week_start === weekStart) ?? null;

  const submit = async () => {
    onError(null);
    if (!userId || !weekStart) {
      onError("Pick the employee and week to correct.");
      return;
    }
    if (!reason.trim()) {
      onError("A reason is REQUIRED for every correction (who/what/old/new/reason/when).");
      return;
    }
    setBusy(true);
    try {
      const res = await applyCommissionCorrectionFn({
        data: {
          cycleId,
          userId,
          weekStart,
          kind,
          deltaDollars: kind === "manual_adjustment" ? Number(delta) : undefined,
          appointmentId: kind === "exclude_booking" || kind === "restore_booking" ? appointmentId : undefined,
          holeCount: kind === "hole_bonus" ? Number(holeCount) || 1 : undefined,
          reason: reason.trim(),
        },
      });
      setReason("");
      setDelta("");
      onDone(`Correction applied: ${res.what} (${res.deltaDollars >= 0 ? "+" : ""}$${res.deltaDollars.toFixed(2)}) — audited.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-4 rounded-lg border border-(--card-border) p-4">
      <summary className="cursor-pointer select-none text-[13px] font-medium text-(--text-body)">
        Corrections — add adjustment · exclude/restore booking · missing hole bonus (reason REQUIRED, audited)
      </summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-[13px] text-(--text-body)">
          Employee
          <select
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              setWeekStart("");
              setAppointmentId("");
            }}
            className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--surface-3) px-3 py-2 text-[13px] text-(--text-primary)"
          >
            <option value="">— pick —</option>
            {employees.map((e) => (
              <option key={e.userId} value={e.userId}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[13px] text-(--text-body)">
          Week
          <select
            value={weekStart}
            onChange={(e) => {
              setWeekStart(e.target.value);
              setAppointmentId("");
            }}
            className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--surface-3) px-3 py-2 text-[13px] text-(--text-primary)"
          >
            <option value="">— pick —</option>
            {employeeWeeks.map((w) => (
              <option key={w} value={w}>
                {shortRange(w, addDays(w, 6))}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[13px] text-(--text-body)">
          Correction
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--surface-3) px-3 py-2 text-[13px] text-(--text-primary)"
          >
            <option value="manual_adjustment">Manual adjustment (+/− dollars)</option>
            <option value="exclude_booking">Exclude a counted booking (− its tier value)</option>
            <option value="restore_booking">Restore a previously excluded booking</option>
            <option value="hole_bonus">Add missing filled-hole bonus ($10 each)</option>
          </select>
        </label>
        {kind === "manual_adjustment" && (
          <label className="text-[13px] text-(--text-body)">
            Dollars (use − for subtract)
            <input
              type="number"
              step="0.01"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--surface-3) px-3 py-2 text-[13px] tabular-nums text-(--text-primary)"
              placeholder="e.g. -25 or 130"
            />
          </label>
        )}
        {kind === "hole_bonus" && (
          <label className="text-[13px] text-(--text-body)">
            Filled holes to add ($10 each)
            <input
              type="number"
              min="1"
              step="1"
              value={holeCount}
              onChange={(e) => setHoleCount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--surface-3) px-3 py-2 text-[13px] tabular-nums text-(--text-primary)"
            />
          </label>
        )}
        {(kind === "exclude_booking" || kind === "restore_booking") && (
          <label className="text-[13px] text-(--text-body)">
            {kind === "exclude_booking" ? "Counted booking to exclude" : "Previously excluded booking to restore"}
            <select
              value={appointmentId}
              onChange={(e) => setAppointmentId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--surface-3) px-3 py-2 text-[13px] text-(--text-primary)"
            >
              <option value="">— pick —</option>
              {(record?.counted_bookings ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.acuity_appointment_id ?? c.id} {c.client_name ?? "(client unavailable)"} · win {c.win_date}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-[13px] text-(--text-body) sm:col-span-2">
          Reason (REQUIRED — recorded with who/what/old/new/when)
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--surface-3) px-3 py-2 text-[13px] text-(--text-primary)"
            placeholder="e.g. Deposit refunded after submission — excluding booking #4821 (owner directive 10/3)"
          />
        </label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[12px] text-(--text-caption)">
          The auto-calculated fields (base, pool, holes, counted bookings) never change — corrections land as audited
          manual adjustments.
        </p>
        <ActionButton busy={busy} label="Apply correction" onClick={submit} />
      </div>
    </details>
  );
}

/** The cycle's full audit trail (state transitions, submissions, corrections, blocked rewrites). */
function AuditTrail({ adjustments }: { adjustments: CommissionAdjustmentRow[] }) {
  if (adjustments.length === 0) {
    return (
      <details className="mt-4 rounded-lg border border-(--card-border) p-4">
        <summary className="cursor-pointer select-none text-[13px] font-medium text-(--text-body)">
          Audit trail
        </summary>
        <p className="mt-3 text-[13px] text-(--text-caption)">
          No audit rows yet for this cycle — transitions, submissions and corrections will appear here.
        </p>
      </details>
    );
  }
  return (
    <details className="mt-4 rounded-lg border border-(--card-border) p-4">
      <summary className="cursor-pointer select-none text-[13px] font-medium text-(--text-body)">
        Audit trail ({adjustments.length} {adjustments.length === 1 ? "entry" : "entries"})
      </summary>
      <div className="mt-3 overflow-x-auto">
        <table className="data-table min-w-[720px]">
          <thead>
            <tr>
              <th scope="col" className="text-left">When</th>
              <th scope="col" className="text-left">Who</th>
              <th scope="col" className="text-left">What</th>
              <th scope="col" className="text-left">Old → New</th>
              <th scope="col" className="text-left">Reason</th>
            </tr>
          </thead>
          <tbody>
            {adjustments.map((a) => (
              <tr key={a.id}>
                <td className="text-left text-(--text-caption) tabular-nums">
                  {a.changed_at.slice(0, 16).replace("T", " ")}
                </td>
                <td className="text-left">{a.changed_by}</td>
                <td className="text-left">
                  <span className="chip chip-neutral">{a.field}</span>
                </td>
                <td className="text-left text-(--text-caption) tabular-nums">
                  {a.old_value ?? "—"} → {a.new_value ?? "—"}
                </td>
                <td className="text-left text-(--text-body)">{a.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
