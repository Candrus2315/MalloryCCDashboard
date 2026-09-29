import { createFileRoute } from "@tanstack/react-router";
import { getWeeklyData } from "~/server/queries";
import { formatDateHuman, formatDateHumanFull, formatDateShort, weekdayName } from "~/server/date-logic";
import { formatInt, formatPercent } from "~/server/metrics/report-text";
import { WarningList } from "~/components/warnings";
import { InfoTip } from "~/components/InfoTip";

export const Route = createFileRoute("/weekly")({
  loader: () => getWeeklyData(),
  component: WeeklyPage,
});

/** Presentation sign for the KPI subline (same convention as goalVsActual). */
function signedDelta(actual: number, goal: number): string {
  const diff = actual - goal;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  return `${sign}${Math.abs(diff)}`;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="kpi-label">{label}</p>
      <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{value}</p>
      {sub && <p className="kpi-sub mt-1">{sub}</p>}
    </div>
  );
}

/**
 * One Mon–Sun calendar-fill card: sessions vs derived studio capacity.
 * Fill % renders only when capacity > 0 — never a fabricated 0%.
 */
function FillCard({ label, range, appointments, capacity }: { label: string; range: string; appointments: number; capacity: number }) {
  return (
    <div className="card">
      <p className="kpi-label">{label}</p>
      <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
        {formatInt(appointments)}
        <span className="text-lg font-normal text-(--text-muted)"> / {capacity > 0 ? capacity : "—"}</span>
      </p>
      <p className="kpi-sub mt-1">
        sessions vs studio capacity
        {capacity > 0 && ` · ${Math.round((appointments / capacity) * 100)}% filled`} · {range}
      </p>
    </div>
  );
}

/** Rep table shared by the Last-Week and MTD sections (12px floor, minimal borders). */
function RepTable({ rows, unattributed, total, totalLabel }: {
  rows: { rep_id: string; rep_name: string; total: number; manual: number }[];
  unattributed: number;
  total: number;
  totalLabel: string;
}) {
  return (
    <table className="w-full max-w-xl text-[12px]">
      <thead>
        <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
          <th scope="col" className="py-1.5 pr-2 font-medium">Rep</th>
          <th scope="col" className="py-1.5 text-right font-medium">Paid bookings</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.rep_id} className="border-b border-(--table-border-weak)">
            <td className="py-1.5 pr-2 text-(--text-body)">
              {r.rep_name}
              {r.manual > 0 && (
                <span className="ml-1.5 text-[12px] text-(--text-muted)">
                  ({r.manual} manual {r.manual === 1 ? "override" : "overrides"})
                </span>
              )}
            </td>
            <td className="py-1.5 text-right font-medium tabular-nums text-(--text-body)">{formatInt(r.total)}</td>
          </tr>
        ))}
        {unattributed > 0 && (
          <tr className="border-b border-(--table-border-weak)">
            <td className="py-1.5 pr-2 text-(--text-muted)">Online / unattributed</td>
            <td className="py-1.5 text-right tabular-nums text-(--text-muted)">{formatInt(unattributed)}</td>
          </tr>
        )}
        <tr>
          <td className="py-1.5 pr-2 font-semibold text-(--text-primary)">{totalLabel}</td>
          <td className="py-1.5 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function WeeklyPage() {
  const data = Route.useLoaderData();
  const b = data.bookings;
  const c = data.conversion;
  const mtd = data.mtd;
  const cal = data.calendar;

  return (
    <div className="space-y-8">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Weekly Report</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-(--text-muted)">
            <span>{data.week.caption} (America/New_York)</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-(--table-border-weak) bg-(--surface-subtle) px-2 py-0.5 text-xs font-semibold text-(--text-caption)">
              Completed Mon–Sun week
            </span>
          </p>
        </div>
        {data.meta.mode === "memory" && (
          <div className="rounded-lg border border-(--chip-risk-bg) bg-(--chip-risk-bg) px-3 py-2 text-xs text-(--banner-fg)">
            <span className="font-medium">Demo data (in-memory).</span> Database not connected
            {data.meta.dbReason ? ` — ${data.meta.dbReason}` : ""}.
          </div>
        )}
      </div>

      {/* missing-data warnings — never a plausible number */}
      <WarningList items={data.warnings} />

      {/* SECTION 1 — LAST WEEK */}
      <section>
        <p className="section-title mb-4 flex items-center gap-1.5">
          Last week
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
        </p>

        <div className="grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
          <Kpi
            label="Bookings vs goal"
            value={`${formatInt(b.total)}/${formatInt(b.goal)}`}
            sub={`${signedDelta(b.total, b.goal)} vs goal · ${formatInt(b.family)} family · ${formatInt(b.animalia)} animalia`}
          />
          <Kpi label="Family sessions" value={formatInt(b.family)} sub="of paid bookings" />
          <Kpi label="Animalia sessions" value={formatInt(b.animalia)} sub="of paid bookings" />
          <Kpi label="Online / unattributed" value={formatInt(b.unattributed)} sub="team total only — never a rep row" />
        </div>

        {/* daily strip — booking wins per day of the completed week */}
        <div className="mt-6 grid grid-cols-4 gap-2 sm:grid-cols-7">
          {b.daily.map((d) => (
            <div key={d.date} className="rounded-lg border border-(--card-border) px-3 py-2">
              <p className="text-[12px] font-medium uppercase tracking-wide text-(--text-caption)">{weekdayName(d.date, false)}</p>
              <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{formatInt(d.count)}</p>
              <p className="text-[12px] text-(--text-muted)">{formatDateShort(d.date)}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="card">
            <p className="kpi-label mb-3">By rep — attributed paid bookings</p>
            <RepTable rows={b.repRows} unattributed={b.unattributed} total={b.total} totalLabel="Team total" />
          </div>

          <div className="space-y-6">
            <div>
              <p className="kpi-label mb-3 flex items-center gap-1.5">
                Conversion of assigned leads
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
              <div className="grid grid-cols-3 gap-x-6">
                <Kpi label="Overall" value={formatPercent(c.overall)} sub={`${c.numerator.overall}/${c.denominator.overall} leads`} />
                <Kpi label="Family" value={formatPercent(c.family)} sub={`${c.numerator.family}/${c.denominator.family} leads`} />
                <Kpi label="Animalia" value={formatPercent(c.animalia)} sub={`${c.numerator.animalia}/${c.denominator.animalia} leads`} />
              </div>
            </div>

            <div>
              <p className="kpi-label mb-3 flex items-center gap-1.5">
                Leads
                <InfoTip
                  label="How weekly leads are dated"
                  tip="Sheet leads by the date they entered the sheet (source_date), Mon–Sun of the report week — family and animalia sheets, America/New_York."
                />
              </p>
              <div className="grid grid-cols-3 gap-x-6">
                <Kpi label="Family" value={formatInt(data.leads.family)} />
                <Kpi label="Animalia" value={formatInt(data.leads.animalia)} />
                <Kpi label="Total" value={formatInt(data.leads.total)} sub="sheet leads in the week" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <hr className="border-(--card-border)" />

      {/* calendar fill */}
      <section>
        <p className="section-title mb-4 flex items-center gap-1.5">
          Calendar fill
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
        <div className="grid gap-4 md:grid-cols-2">
          <FillCard label={cal.thisWeek.label} range={`${formatDateHuman(cal.thisWeek.start)} – ${formatDateHuman(cal.thisWeek.end)}`} appointments={cal.thisWeek.appointments} capacity={cal.thisWeek.capacity} />
          <FillCard label={cal.nextWeek.label} range={`${formatDateHuman(cal.nextWeek.start)} – ${formatDateHuman(cal.nextWeek.end)}`} appointments={cal.nextWeek.appointments} capacity={cal.nextWeek.capacity} />
        </div>
        <p className="mt-3 text-[12px] text-(--text-muted)">
          Beyond next week: {formatInt(cal.beyond)} sessions (they still count toward the first-open-day scan) ·
          First fully open day:{" "}
          {cal.firstFullyOpenDay ? (
            <span className="font-semibold text-(--text-body)">{formatDateHumanFull(cal.firstFullyOpenDay)}</span>
          ) : (
            "— (none within 120 days)"
          )}
        </p>
      </section>

      <hr className="border-(--card-border)" />

      {/* SECTION 2 — MTD */}
      <section>
        <p className="section-title mb-4 flex items-center gap-1.5">
          Month to date —{" "}
          {new Date(`${data.month.start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}
          <InfoTip
            label="How month to date is counted"
            tip="Paid bookings whose deposit date falls in the current calendar month through today (ET). Rep rows use the same attribution join as the weekly section; online/unattributed wins stay team-total only."
          />
        </p>

        <div className="grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
          <Kpi label="Paid bookings MTD" value={formatInt(mtd.total)} sub={`${data.month.start} – ${data.month.end}`} />
          <div>
            <p className="kpi-label flex items-center gap-1.5">
              Monthly goal
              <InfoTip
                label="About the monthly goal"
                tip="No monthly goal is configured — goals in Settings are weekly. When a monthly goal exists it will render here; none is invented in the meantime."
              />
            </p>
            <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-(--text-muted)">—</p>
          </div>
          <div>
            <p className="kpi-label">Top performer</p>
            {mtd.topPerformer ? (
              <>
                <p className="mt-1 inline-flex items-center gap-2 text-2xl font-semibold tracking-tight text-(--text-primary)">
                  <span className="rounded-full bg-(--chip-positive-bg) px-2.5 py-0.5 text-lg font-semibold text-(--pos-text)">
                    {mtd.topPerformer.repName}
                  </span>
                  <span className="tabular-nums">{formatInt(mtd.topPerformer.total)}</span>
                </p>
                <p className="kpi-sub mt-1">paid bookings MTD</p>
              </>
            ) : (
              <p className="mt-1 text-4xl font-semibold tracking-tight text-(--text-muted)">—</p>
            )}
          </div>
        </div>

        <div className="card mt-6">
          <p className="kpi-label mb-3">By rep — month to date</p>
          <RepTable rows={mtd.repRows} unattributed={mtd.unattributed} total={mtd.total} totalLabel="Team total" />
        </div>
      </section>
    </div>
  );
}
