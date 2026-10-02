/**
 * Commission weekly detail drawer (spec §4/§10 — the audit surface).
 *
 * Presentation-only composition inside the shared DetailDrawer (width="lg",
 * the PIP Manage drawer precedent): rate math from the stored record (counts ×
 * rates annotated via the pure engine, money ALWAYS the stored dollars), the
 * 79-pool block, the RULING 3 per-bonus hole audit, the §16 counted-records
 * reconciliation, and the Estimated/Final treatment (§22).
 *
 * Two variants share the shell:
 *  - "employee" (§4): opened from the grid — ONE stored record, full audit.
 *  - "team" (§4.9): opened from the §26 validation blocks — the WEEK's records
 *    (per-employee commission rows, pooled hole audit with rep leads, counted
 *    bookings grouped by rep, count reconciled to the team total).
 *
 * No drawer ever opens on an in-progress week in Phase B — there is no stored
 * record to audit, and opening one would imply finality.
 */
import type { ReactNode } from "react";
import { DetailDrawer } from "./DetailDrawer";
import { CommissionChip } from "./commission-shell";
import {
  countedBookingViews,
  drawerTitle,
  holeAuditViews,
  poolBlockView,
  poolChip,
  rateMathLines,
  rateMathView,
  teamDrawerTitle,
  teamEmployeeViews,
  tierChipLabel,
} from "./commission-views";
import { formatInt, formatMoney } from "~/server/metrics/report-text";
import { etDateStrFromInstant, formatDateHumanFull } from "~/server/date-logic";
import { POOL_THRESHOLD } from "~/server/commission/engine";
import type { CommissionWeeklyRow } from "~/server/store/types";

function MoneyRow({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={muted ? "text-(--text-muted)" : "text-(--text-body)"}>{label}</span>
      <span className="tabular-nums text-(--text-body)">{value}</span>
    </div>
  );
}

function DrawerSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="section-heading">{heading}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function CommissionWeeklyDrawer(props: {
  open: boolean;
  onClose(): void;
  /** The employee-week record (employee variant), or ONE of the week's records (team variant). */
  record: CommissionWeeklyRow | null;
  /** The owning cycle's label ("Aug 31 – Sep 27, 2026"). */
  cycleLabel: string | null;
  /** The week's team qualifying bookings (week context; same for every employee of the week). */
  teamBookings: number | null;
  /** "employee" (grid drill-in) | "team" (validation drill-in). */
  variant?: "employee" | "team";
  /** Team variant: ALL of the week's stored records. */
  teamRecords?: CommissionWeeklyRow[];
}) {
  const { open, onClose, record, cycleLabel, teamBookings, variant = "employee", teamRecords } = props;
  if (!record) return null;
  const isTeam = variant === "team";
  const weekRecords = isTeam ? (teamRecords ?? [record]) : [record];
  const title = isTeam ? teamDrawerTitle(record) : drawerTitle(record);
  const tier = tierChipLabel(record.employment_type, record.tier);
  const math = rateMathView(record);
  const pool = poolBlockView(record, teamBookings);
  const employeeRows = isTeam ? teamEmployeeViews(weekRecords, record.week_start) : [];
  const holeRows = isTeam ? weekRecords.flatMap((r) => holeAuditViews(r)) : holeAuditViews(record);
  const holeMoney = isTeam
    ? weekRecords.reduce((s, r) => s + (r.hole_bonus ?? 0), 0)
    : (record.hole_bonus ?? 0);
  const countedRows = isTeam ? weekRecords.flatMap((r) => countedBookingViews(r)) : countedBookingViews(record);
  const countedTotal = isTeam
    ? weekRecords.reduce((s, r) => s + (r.counted_bookings?.length ?? 0), 0)
    : (record.counted_bookings?.length ?? 0);
  const qualifyingTotal = isTeam
    ? weekRecords.reduce((s, r) => s + r.qualifying_bookings, 0)
    : record.qualifying_bookings;
  // §16 reconciliation: the drawer's record count vs the qualifying total.
  const recon =
    countedTotal === qualifyingTotal
      ? { ok: true, text: `${formatInt(countedTotal)} counted records — matches ${formatInt(qualifyingTotal)} qualifying bookings.` }
      : {
          ok: false,
          text: `Counted records (${formatInt(countedTotal)}) ≠ qualifying bookings (${formatInt(qualifyingTotal)}) — investigate before trusting this view.`,
        };
  const totalParts = [
    `base ${formatMoney(record.base_commission)}`,
    `additional ${formatMoney(record.additional_commission)}`,
    `pool ${formatMoney(record.pool_bonus)}`,
    `holes ${formatMoney(record.hole_bonus)}`,
    `adjustments ${formatMoney(record.manual_adjustment)}`,
  ];
  const calcDate =
    record.calc_date && Number.isFinite(Date.parse(record.calc_date))
      ? formatDateHumanFull(etDateStrFromInstant(Date.parse(record.calc_date)))
      : "—";
  const contextLines = isTeam
    ? [
        cycleLabel ? `Cycle: ${cycleLabel}` : "Cycle: —",
        `${formatInt(teamBookings ?? 0)} team bookings (rep-attributed) · pool ${pool.unlocked ? "Unlocked" : "Locked"} · ${formatInt(employeeRows.length)} employees with records`,
        `Final · calculated ${calcDate} · calc v${formatInt(record.calc_version)}`,
      ]
    : [
        cycleLabel ? `Cycle: ${cycleLabel}` : "Cycle: —",
        `Tier held that week: ${tier ?? "—"}${record.tier_effective_date_used ? ` (effective ${record.tier_effective_date_used})` : ""}`,
        `${formatInt(record.qualifying_bookings)} qualifying bookings · ${formatInt(record.counted_bookings.length)} counted records`,
        `Final · calculated ${calcDate} · calc v${formatInt(record.calc_version)}`,
      ];

  return (
    <DetailDrawer open={open} onClose={onClose} title={title} contextLines={contextLines} width="lg">
      {/* rate math (employee variant) / per-employee commission (team variant) */}
      {isTeam ? (
        <DrawerSection heading="Booking commission by employee">
          {employeeRows.length === 0 ? (
            <p className="text-[13px] text-(--text-muted)">No employee records for this week.</p>
          ) : (
            <div className="divide-y divide-(--table-border-weak)">
              {employeeRows.map((e) => (
                <div key={e.name} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="text-[13px] font-medium text-(--text-primary)">{e.name}</span>
                  <span className="text-[13px] tabular-nums text-(--text-body)">
                    {formatInt(e.bookings)} bookings · {formatMoney(e.baseAdditional)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </DrawerSection>
      ) : (
        <DrawerSection heading="Booking commission">
          {math ? (
            <>
              <div className="space-y-0.5">
                {rateMathLines(math).map((line) => (
                  <p key={line} className="text-[13px] tabular-nums text-(--text-body)">
                    {line}
                  </p>
                ))}
              </div>
              <div className="mt-2 border-t border-(--table-border-weak) pt-2">
                <MoneyRow label="Base + additional" value={math.subtotalMoney} />
              </div>
              {!math.engineMatchesStored && (
                <p className="status-banner mt-2">
                  <span className="font-medium">Divergence:</span> the rate formula reproduces {formatMoney(math.engineMoney)} —
                  the stored record says {math.subtotalMoney}. Investigate before trusting this drawer.
                </p>
              )}
            </>
          ) : (
            <p className="text-[13px] text-(--text-muted)">
              Tier formula unavailable for this stored profile — the stored amounts stand; investigate the record.
            </p>
          )}
        </DrawerSection>
      )}

      {/* 79 pool */}
      <DrawerSection heading="79 pool">
        <div className="flex flex-wrap items-center gap-2">
          <CommissionChip view={poolChip(pool.unlocked, teamBookings)} />
          <span className="text-[13px] tabular-nums text-(--text-body)">
            {formatInt(teamBookings ?? 0)} / {formatInt(POOL_THRESHOLD)} team bookings
          </span>
        </div>
        {pool.unlocked ? (
          pool.shareLine && <p className="mt-1.5 text-[13px] tabular-nums text-(--text-caption)">{pool.shareLine}</p>
        ) : (
          <p className="mt-1.5 text-[13px] text-(--text-caption)">Pool Locked — $0.00.</p>
        )}
      </DrawerSection>

      {/* filled holes + per-bonus audit (all seven RULING-3 fields) */}
      <DrawerSection heading="Filled holes">
        <MoneyRow label={`${formatInt(holeRows.length)} holes × $10.00`} value={formatMoney(holeMoney)} />
        {holeRows.length === 0 && holeMoney === 0 ? (
          <p className="mt-1 text-[13px] text-(--text-caption)">
            No filled holes this week — $0.00 hole bonus. Slots already filled when the week began were never holes of
            that week.
          </p>
        ) : holeRows.length === 0 ? (
          <p className="status-banner mt-2">
            <span className="font-medium">Divergence:</span> the record carries hole bonus with NO per-bonus audit rows —
            investigate before trusting this money.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-(--card-border)">
            <table className="data-table min-w-[560px]">
              <thead>
                <tr>
                  {isTeam && <th scope="col" className="text-left">Rep</th>}
                  <th scope="col" className="text-left">When</th>
                  <th scope="col" className="text-left">Slot</th>
                  <th scope="col" className="text-left">Filled by</th>
                  <th scope="col" className="text-left">Qualifying win</th>
                  <th scope="col" className="text-right">Amount</th>
                  <th scope="col" className="text-left">Week</th>
                </tr>
              </thead>
              <tbody>
                {holeRows.map((h, i) => (
                  <tr key={i}>
                    {isTeam && <td className="py-2">{h.rep}</td>}
                    <td className="py-2">{h.when}</td>
                    <td className="py-2">{h.slot}</td>
                    <td className="py-2">{h.filledBy}</td>
                    <td className="py-2">{h.win}</td>
                    <td className="py-2 text-right">{h.amount}</td>
                    <td className="py-2">{h.week}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DrawerSection>

      {/* adjustments (employee variant) */}
      {!isTeam && (
        <DrawerSection heading="Adjustments">
          <MoneyRow
            label="Manual adjustment"
            value={formatMoney(record.manual_adjustment)}
            muted={record.manual_adjustment === 0}
          />
          {record.manual_adjustment === 0 && (
            <p className="text-[13px] text-(--text-caption)">None — corrections (reason-required, audited) arrive with Phase C.</p>
          )}
        </DrawerSection>
      )}

      {/* total — the drawer's visual anchor */}
      <div className="mt-6 border-t border-(--table-border-strong) pt-4">
        <p className="kpi-label">{isTeam ? "Team Weekly Bonus" : "Total Weekly Bonus"}</p>
        <p className="mt-1.5 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
          {formatMoney(isTeam ? weekRecords.reduce((s, r) => s + r.total, 0) : record.total)}
        </p>
        <p className="kpi-sub mt-1.5 tabular-nums">
          {isTeam
            ? `${formatInt(employeeRows.length)} employee records · Σ stored weekly totals`
            : totalParts.join(" + ")}
        </p>
      </div>

      {/* counted bookings — the EXACT records (§16 reconciliation) */}
      <DrawerSection heading={`Counted bookings (${formatInt(countedTotal)})`}>
        <p className={recon.ok ? "text-[13px] text-(--text-caption)" : "status-banner"}>{recon.text}</p>
        {countedRows.length === 0 ? (
          <p className="mt-2 rounded-lg border border-(--card-border) bg-(--card-bg) px-4 py-3 text-[13px] text-(--text-caption)">
            No qualifying bookings this week — $0.00 commission. The weekly record still saves (no minimum to earn, §5).
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-(--table-border-weak)">
            {countedRows.map((c) => (
              <li key={c.key} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {isTeam && (
                    <span className="text-[13px] font-semibold text-(--text-primary)">{c.rep}</span>
                  )}
                  <span className="text-[13px] font-medium text-(--text-primary)">{c.client}</span>
                  <span className="text-[13px] text-(--text-muted)">{c.type}</span>
                  {c.manual && (
                    <span className="chip chip-neutral">
                      <span className="h-1.5 w-1.5 rounded-full bg-(--dot-muted)" aria-hidden="true" />
                      manual
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[12px] tabular-nums text-(--text-caption)">{c.sub}</p>
              </li>
            ))}
          </ul>
        )}
      </DrawerSection>
    </DetailDrawer>
  );
}
