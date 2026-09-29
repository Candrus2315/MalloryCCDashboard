import { createFileRoute } from "@tanstack/react-router";
import { getWeeklyData, saveWeeklyReportNotes } from "~/server/queries";
import { formatDateHuman, formatDateHumanFull, formatDateShort, weekdayName } from "~/server/date-logic";
import { formatInt, formatPercent } from "~/server/metrics/report-text";
import { monthKeyLabel, WEEKLY_CC_SECTIONS } from "~/server/metrics/weekly";
import { WarningList } from "~/components/warnings";
import { InfoTip } from "~/components/InfoTip";
import { CopyButton } from "~/components/CopyButton";
import { useState } from "react";
import { useRouter } from "@tanstack/react-router";

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

/**
 * Previous week's Alliance / Auction / Website split (owner CC Report
 * template). Bookings are computed from Acuity type names; LEADS are not
 * synced (the dashboard's leads come only from the Family/Animalia sheets) —
 * shown as an explicit not-synced note, never an invented number. Website
 * bookings render "—": Acuity has no distinct "Website" booking type.
 */
function ChannelTable({ channels }: { channels: { alliance: number; auction: number; website: number | null } }) {
  const rows = [
    { name: "Alliance", bookings: formatInt(channels.alliance) },
    { name: "Auction", bookings: formatInt(channels.auction) },
    { name: "Website", bookings: channels.website == null ? "—" : formatInt(channels.website) },
  ];
  return (
    <table className="w-full max-w-xl text-[12px]">
      <thead>
        <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
          <th scope="col" className="py-1.5 pr-2 font-medium">Channel</th>
          <th scope="col" className="py-1.5 text-right font-medium">Leads</th>
          <th scope="col" className="py-1.5 text-right font-medium">Paid bookings</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-b border-(--table-border-weak)">
            <td className="py-1.5 pr-2 text-(--text-body)">{r.name}</td>
            <td className="py-1.5 text-right text-(--text-muted)">not synced</td>
            <td className="py-1.5 text-right font-medium tabular-nums text-(--text-body)">{r.bookings}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
                <Kpi label="Overall" value={formatPercent(c.overall)} sub={`${c.numerator.overall}/${c.denominator.overall} leads`} />
                <Kpi label="Family" value={formatPercent(c.family)} sub={`${c.numerator.family}/${c.denominator.family} leads`} />
                <Kpi label="Animalia" value={formatPercent(c.animalia)} sub={`${c.numerator.animalia}/${c.denominator.animalia} leads`} />
                {/* BOOKINGS FROM LEADS (owner funnel, 2026-09-29) — the overall
                    funnel rate next to the assigned-lead conversion cards. */}
                <div>
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
                      "mt-1 text-4xl font-semibold tracking-tight tabular-nums " +
                      (f.pct != null ? "text-(--text-primary)" : "text-(--text-muted)")
                    }
                  >
                    {formatPercent(f.pct)}
                  </p>
                  <p className="kpi-sub mt-1">
                    {formatInt(f.wins)}/{formatInt(f.leads)} leads · overall funnel rate
                  </p>
                </div>
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

        {/* BOOKINGS FROM LEADS — recent completed weeks strip (owner request 2026-09-29):
            the last 5 COMPLETED Mon–Sun weeks, oldest first. The in-progress week is
            never shown (its % is meaningless mid-week); zero-leads weeks render "—"
            (the Sheets sync begins 2026-08-24). Same counts as the card above. */}
        <div className="mt-6">
          <p className="kpi-label mb-3 flex items-center gap-1.5">
            Bookings from leads — recent weeks
            <InfoTip
              label="About the recent-weeks strip"
              tip="The last 5 completed Mon–Sun weeks, oldest first, all paid bookings ÷ all sheet leads (the same counts as the card above). The in-progress week is excluded — its % would be meaningless mid-week. A week with zero sheet leads renders “—” (the Google Sheets sync begins 2026-08-24), never a fabricated 0%."
            />
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {data.funnelSeries.map((w) => (
              <div key={w.weekStart} className="rounded-lg border border-(--card-border) px-3 py-2">
                <p className="text-[12px] font-medium uppercase tracking-wide text-(--text-caption)">
                  {formatDateShort(w.weekStart)} – {formatDateShort(w.weekEnd)}
                </p>
                <p
                  className={
                    "mt-0.5 text-2xl font-semibold tracking-tight tabular-nums " +
                    (w.pct != null ? "text-(--text-primary)" : "text-(--text-muted)")
                  }
                >
                  {formatPercent(w.pct)}
                </p>
                <p className="text-[12px] text-(--text-muted)">
                  {formatInt(w.leads)} leads · {formatInt(w.wins)} wins
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* previous week — Alliance / Auction / Website (owner CC Report template) */}
        <div className="card mt-6 max-w-xl">
          <p className="kpi-label mb-3 flex items-center gap-1.5">
            Alliance / Auction / Website — previous week
            <InfoTip
              label="How the channel split is computed"
              tip={
                <>
                  Bookings: paid wins of the week whose Acuity appointment type contains the channel name (case-insensitive)
                  — same deposit-paid rule as every other figure. Website shows "—": Acuity has no distinct "Website"
                  booking type. Leads for these three channels are NOT synced — the dashboard's leads come only from the
                  Family/Animalia sheets. Connect a source and this card will show them; nothing is invented meanwhile.
                </>
              }
            />
          </p>
          <ChannelTable channels={data.channels} />
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
          {/* MONTHLY GOAL (owner-approved 2026-09-29): "X/Goal (±N)" when a goal
              is stored for THIS month's exact key; otherwise the honest count
              and a "—" goal — months never inherit another month's goal. */}
          <Kpi
            label="Paid bookings MTD"
            value={mtd.goal != null ? `${formatInt(mtd.total)}/${formatInt(mtd.goal)}` : formatInt(mtd.total)}
            sub={`${mtd.goal != null ? `${signedDelta(mtd.total, mtd.goal)} vs goal · ` : ""}${data.month.start} – ${data.month.end}`}
          />
          <div>
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
            <p className={"mt-1 text-4xl font-semibold tracking-tight tabular-nums " + (mtd.goal != null ? "text-(--text-primary)" : "text-(--text-muted)")}>
              {mtd.goal != null ? formatInt(mtd.goal) : "—"}
            </p>
            {mtd.goal != null && <p className="kpi-sub mt-1">set for {monthKeyLabel(data.month.key)}</p>}
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

      <hr className="border-(--card-border)" />

      {/* SECTION 3 — CC REPORT narrative + copy (owner template, 2026-09-29) */}
      <section>
        <p className="section-title mb-4 flex items-center gap-1.5">
          CC Report
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
        </p>

        <div className="card max-w-3xl">
          <div className="space-y-4">
            {WEEKLY_CC_SECTIONS.map((s) => (
              <div key={s.key}>
                <label htmlFor={`cc-${s.key}`} className="kpi-label">
                  {s.label}
                  {s.key === "celebrate" && <span className="ml-2 font-normal text-[12px] text-(--text-muted)">auto-filled from the computed top performer — editable</span>}
                </label>
                <textarea
                  id={`cc-${s.key}`}
                  rows={s.key === "big3" || s.key === "big3_followup" ? 3 : 2}
                  value={notes[s.key] ?? ""}
                  onChange={(e) => setNotes({ ...notes, [s.key]: e.target.value })}
                  placeholder={s.key === "celebrate" ? "e.g. Allison Wittner — 47 paid bookings" : ""}
                  className="mt-1 w-full rounded-lg border border-(--card-border) bg-(--card-bg) px-3 py-2 text-sm text-(--text-primary) outline-none focus:border-(--input-focus-border)"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={saveNotes}
              disabled={saveState === "saving"}
              className="rounded-lg bg-(--accent-solid) px-4 py-2 text-[13px] font-medium text-(--accent-solid-fg) transition-colors hover:bg-(--accent-hover) disabled:opacity-50"
            >
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Save CC Report narrative"}
            </button>
            {saveState === "error" && <span className="text-xs text-(--neg-text)">Save failed — try again.</span>}
            <span className="text-[12px] text-(--text-muted)">Saved per report week · changes are audited · shows in the copied report</span>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <CopyButton label="COPY REPORT" text={data.report.reportText} />
        </div>
        <div className="card mt-5">
          <p className="kpi-label">Report preview — exactly what COPY REPORT puts on your clipboard</p>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-(--text-body)">
            {data.report.reportText}
          </pre>
        </div>
      </section>
    </div>
  );
}
