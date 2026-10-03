import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
// Harmonization Wave 1: Panel/Eyebrow live ONCE in the shared page-primitives
// module (same markup they replaced here).
import { Eyebrow, Panel } from "~/components/page-panel";
import { getCommissionValidationData } from "~/server/queries";
import { WarningList } from "~/components/warnings";
import { InfoTip } from "~/components/InfoTip";
import { CommissionsShell, CommissionChip } from "~/components/commission-shell";
import { CommissionWeeklyDrawer } from "~/components/commission-drawer";
import { GhostButton } from "~/components/performance-shell";
import {
  cycleChip,
  cycleIdentityLine,
  employmentAbbr,
  provenanceHeadline,
  shortRange,
} from "~/components/commission-views";
import { formatInt, formatMoney } from "~/server/metrics/report-text";
import { etDateStrFromInstant, formatDateHumanFull } from "~/server/date-logic";
import type { CommissionWeeklyRow } from "~/server/store/types";

export const Route = createFileRoute("/commissions-validation")({
  loader: () => getCommissionValidationData(),
  component: CommissionsValidationPage,
});

/* ---------------------------------------------------------------------------
   §26 HISTORICAL VALIDATION (Phase B — presentation only; spec §5). The
   acceptance test, presented: a READ-ONLY fresh recompute of the four
   validation weeks by the SAME pure path as the live Sunday close, reconciled
   field-by-field against whatever is stored. Divergences render, never
   average away; the provenance banner states written vs dry-run.
--------------------------------------------------------------------------- */

function CommissionsValidationPage() {
  const data = Route.useLoaderData();
  const provenance = provenanceHeadline(!data.dryRun, data.storedCount, data.rollup.calcVersions[0] ?? null);
  const allMatch = data.weeks.every((w) => w.matches);
  const deltas = data.weeks.flatMap((w) => w.reconcile.deltas.map((d) => ({ ...d, week: shortRange(w.weekStart, w.weekEnd) })));
  const cycleStatus = cycleChip(data.cycle?.status);
  // drawer: employee drill-in or team drill-in
  const [drawer, setDrawer] = useState<
    { variant: "employee"; record: CommissionWeeklyRow } | { variant: "team"; records: CommissionWeeklyRow[]; weekStart: string } | null
  >(null);
  const teamBookingsFor = (weekStart: string): number | null => {
    const mine = data.weeks.find((w) => w.weekStart === weekStart);
    return mine ? mine.computed.teamQualifyingBookings : null;
  };
  const storedForWeek = (weekStart: string): CommissionWeeklyRow[] =>
    data.weeks.find((w) => w.weekStart === weekStart)?.stored ?? [];

  const writtenDate =
    data.cycle?.updated_at && Number.isFinite(Date.parse(data.cycle.updated_at))
      ? formatDateHumanFull(etDateStrFromInstant(Date.parse(data.cycle.updated_at)))
      : null;

  return (
    <CommissionsShell path="/commissions-validation" title="Validation">
      <div className="space-y-5">
        {data.meta.mode === "memory" && (
          <p className="status-banner">
            <span className="font-medium">Demo data (in-memory).</span> Database not connected
            {data.meta.dbReason ? ` — ${data.meta.dbReason}` : ""}.
          </p>
        )}
        <WarningList items={data.warnings} />

        {/* §5.1 PROVENANCE BANNER */}
        <section aria-label="Provenance">
          <div className={"rounded-lg border px-4 py-3 " + (provenance.tone === "risk" ? "border-(--banner-border) bg-(--banner-bg)" : "border-(--card-border) bg-(--card-bg)")}>
            <p className={"text-[13px] " + (provenance.tone === "risk" ? "text-(--banner-fg)" : "text-(--text-body)")}>
              {provenance.tone === "risk" && <span aria-hidden="true">⚠ </span>}
              {provenance.headline}
              {provenance.tone === "neutral" && writtenDate && <span className="text-(--text-muted)"> · written {writtenDate}</span>}
            </p>
            <p className="mt-1 text-xs text-(--text-caption)">
              Computed from stored booking data by the same pure engine as the live Sunday close job — no second
              calculation engine.
            </p>
          </div>
        </section>

        {/* §5.2 RECONCILIATION STRIP — recompute vs stored */}
        <section aria-label="Reconciliation">
          <Panel className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <Eyebrow>Recompute vs stored</Eyebrow>
              <InfoTip
                label="What is compared"
                tip="Per employee-week: qualifying_bookings, total, pool_bonus, hole_bonus and the counted-booking id sets — fresh computation against the stored weekly records. A divergence is shown, never silently resolved."
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {data.weeks.map((w) => (
                <CommissionChip
                  key={w.weekStart}
                  view={
                    w.matches
                      ? { kind: "positive", label: `${shortRange(w.weekStart, w.weekEnd)} matches ✓` }
                      : { kind: "risk", label: `${shortRange(w.weekStart, w.weekEnd)} divergence — ${formatInt(w.reconcile.deltas.length)} rows differ` }
                  }
                />
              ))}
            </div>
            {allMatch ? (
              <p className="mt-3 text-[13px] font-medium text-(--pos-text)">
                All four weeks reproduce from stored data ✓
              </p>
            ) : (
              <div className="mt-3 rounded-lg border border-(--banner-border) bg-(--banner-bg) px-3 py-2">
                <ul className="space-y-0.5 text-[13px] tabular-nums text-(--banner-fg)">
                  {deltas.map((d, i) => (
                    <li key={i}>
                      {d.employee} · {d.week} · {d.field}: {d.stored} → {d.computed} (stored → recomputed)
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.dryRun && (
              <p className="mt-3 text-[13px] text-(--text-caption)">
                Stored comparison is against an empty store (dry-run) — run the backfill write after reviewing, then the
                chips reconcile against real records.
              </p>
            )}
          </Panel>
        </section>

        {/* §5.3 WEEK BLOCKS W1→W4 */}
        {data.weeks.map((w, wi) => {
          const teamBookings = w.computed.teamQualifyingBookings;
          const unlocked = teamBookings >= 79;
          const stored = storedForWeek(w.weekStart);
          const storedByUser = new Map(stored.map((r) => [r.user_id, r]));
          return (
            <section key={w.weekStart} aria-label={`Week ${wi + 1} validation`}>
              <Panel className="p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[15px] font-semibold tracking-tight text-(--text-primary)">
                      {`W${wi + 1}`} — {shortRange(w.weekStart, w.weekEnd)}
                    </p>
                    <CommissionChip
                      view={
                        w.matches
                          ? { kind: "positive", label: "Matches ✓" }
                          : { kind: "risk", label: `Divergence — ${formatInt(w.reconcile.deltas.length)}` }
                      }
                    />
                    <CommissionChip
                      view={unlocked ? { kind: "positive", label: "Pool Unlocked" } : { kind: "neutral", label: "Pool Locked" }}
                    />
                  </div>
                  <p className="text-[13px] tabular-nums text-(--text-muted)">
                    {formatInt(teamBookings)} team qualifying bookings
                  </p>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="data-table min-w-[720px]">
                    <thead>
                      <tr>
                        <th scope="col" className="text-left">Employee</th>
                        <th scope="col" className="text-left">Tier</th>
                        <th scope="col" className="text-right">Bookings</th>
                        <th scope="col" className="text-right">Base</th>
                        <th scope="col" className="text-right">Pool</th>
                        <th scope="col" className="text-right">Holes</th>
                        <th scope="col" className="text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.computed.employees.map((e) => {
                        const storedRecord = storedByUser.get(e.userId) ?? null;
                        return (
                          <tr key={e.userId}>
                            <td className="py-2 font-medium">{e.name}</td>
                            <td className="py-2">
                              <span className="chip chip-neutral">
                                <span className="h-1.5 w-1.5 rounded-full bg-(--dot-muted)" aria-hidden="true" />
                                {employmentAbbr(e.employmentType) ?? "—"} · T{formatInt(e.tier)}
                              </span>
                            </td>
                            <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">
                              {formatInt(e.qualifyingBookings)}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMoney((e.baseCents + e.additionalCents) / 100)}
                            </td>
                            <td className="py-2 text-right tabular-nums">{formatMoney(e.poolCents / 100)}</td>
                            <td className="py-2 text-right tabular-nums">{formatMoney(e.holeCents / 100)}</td>
                            <td className="py-2 text-right">
                              {storedRecord ? (
                                <button
                                  type="button"
                                  onClick={() => setDrawer({ variant: "employee", record: storedRecord })}
                                  aria-label={`${e.name} — week of ${shortRange(w.weekStart, w.weekEnd)} commission detail`}
                                  className="rounded-md px-2 py-1 text-right font-semibold tabular-nums text-(--text-primary) transition-colors hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                                >
                                  {formatMoney(e.totalCents / 100)}
                                </button>
                              ) : (
                                <span className="font-semibold tabular-nums text-(--text-primary)">
                                  {formatMoney(e.totalCents / 100)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[12px] tabular-nums text-(--text-muted)">
                  Slot-days: {w.computed.holeDays.map((d) => `${d.date.slice(5)} open ${d.openAtStart}/${d.capacity}${d.filledByRep ? ` · ${d.filledByRep} rep-filled` : ""}`).join(" · ") || "—"}
                </p>
                {stored.length > 0 ? (
                  <div className="mt-3">
                    <GhostButton
                      onClick={() =>
                        setDrawer({ variant: "team", records: stored, weekStart: w.weekStart })
                      }
                    >
                      Open week detail →
                    </GhostButton>
                  </div>
                ) : (
                  <p className="mt-3 text-[13px] text-(--text-caption)">
                    No stored record for this week (dry-run) — the drawer opens only on stored, auditable records.
                  </p>
                )}
              </Panel>
            </section>
          );
        })}

        {/* §5.4 CYCLE ROLLUP — the acceptance table */}
        <section aria-label="Cycle rollup">
          <Panel className="overflow-hidden">
            <div className="p-5 pb-0 sm:p-6 sm:pb-0">
              <Eyebrow>Cycle rollup — stored records</Eyebrow>
            </div>
            <div className="overflow-x-auto p-5 sm:p-6">
              <table className="data-table min-w-[1040px]">
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 z-[1] sticky-cell text-left">Employee</th>
                    <th scope="col" className="text-left">Assigned Tier</th>
                    {data.weeks.map((w, i) => (
                      <th key={w.weekStart} scope="col" className="text-left">{`W${i + 1}`}</th>
                    ))}
                    <th scope="col" className="text-right">Total Cycle Bookings</th>
                    <th scope="col" className="text-right">Total Base Commission</th>
                    <th scope="col" className="text-right">Total 79 Pool Bonus</th>
                    <th scope="col" className="text-right">Total Filled-Hole Bonus</th>
                    <th scope="col" className="text-right">Adjustments</th>
                    <th scope="col" className="text-right">Final Commission Bonus</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rollup.rows.map((row) => (
                    <tr key={row.userId}>
                      <td className="sticky left-0 z-[1] sticky-cell py-2 font-medium">{row.name}</td>
                      <td className="py-2">
                        <span className="chip chip-neutral">
                          <span className="h-1.5 w-1.5 rounded-full bg-(--dot-muted)" aria-hidden="true" />
                          {employmentAbbr(row.employmentType) ?? "—"} · T{formatInt(row.tier)}
                          {row.tierEffectiveDateUsed ? ` (eff. ${row.tierEffectiveDateUsed})` : ""}
                        </span>
                      </td>
                      {row.weeks.map((wk, i) => (
                        <td key={i} className="py-2">
                          {wk.bookings == null ? (
                            <span className="text-(--text-faint)">—</span>
                          ) : (
                            <>
                              <span className="block tabular-nums text-(--text-primary)">{formatInt(wk.bookings)}</span>
                              <span className="block text-xs tabular-nums text-(--text-muted)">{formatMoney(wk.total ?? 0)}</span>
                            </>
                          )}
                        </td>
                      ))}
                      <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(row.totalBookings ?? 0)}</td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(row.totalBase ?? 0)}</td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(row.totalPool ?? 0)}</td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(row.totalHoles ?? 0)}</td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(row.totalAdjustments ?? 0)}</td>
                      <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatMoney(row.total ?? 0)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-(--table-border-strong)">
                    <td className="sticky left-0 z-[1] sticky-cell py-2 font-semibold text-(--text-primary)">Team totals</td>
                    <td className="py-2" />
                    {data.weeks.map((w) => {
                      const stored = storedForWeek(w.weekStart);
                      const bookings = stored.reduce((s, r) => s + r.qualifying_bookings, 0);
                      const total = stored.reduce((s, r) => s + r.total, 0);
                      return (
                        <td key={w.weekStart} className="py-2">
                          {stored.length === 0 ? (
                            <span className="text-(--text-faint)">—</span>
                          ) : (
                            <>
                              <span className="block font-semibold tabular-nums text-(--text-primary)">{formatInt(bookings)}</span>
                              <span className="block text-xs tabular-nums text-(--text-muted)">{formatMoney(total)}</span>
                            </>
                          )}
                        </td>
                      );
                    })}
                    <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(data.rollup.teamBookings)}</td>
                    <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatMoney(data.rollup.teamBase)}</td>
                    <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatMoney(data.rollup.teamPool)}</td>
                    <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatMoney(data.rollup.teamHoles)}</td>
                    <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatMoney(data.rollup.teamAdjustments)}</td>
                    <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatMoney(data.rollup.teamTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-(--table-border-weak) p-5 sm:p-6">
              <p className="text-[13px] tabular-nums text-(--text-body)">{cycleIdentityLine(data.cycle)}</p>
              <CommissionChip view={cycleStatus} />
            </div>
          </Panel>
        </section>
      </div>

      {/* the shared weekly detail drawer (employee + team variants) */}
      <CommissionWeeklyDrawer
        open={drawer != null}
        onClose={() => setDrawer(null)}
        record={
          drawer == null
            ? null
            : drawer.variant === "employee"
              ? drawer.record
              : (drawer.records[0] ?? null)
        }
        cycleLabel={data.cycle?.label ?? null}
        teamBookings={drawer ? teamBookingsFor(drawer.variant === "employee" ? drawer.record.week_start : drawer.weekStart) : null}
        variant={drawer?.variant}
        teamRecords={drawer?.variant === "team" ? drawer.records : undefined}
      />
    </CommissionsShell>
  );
}
