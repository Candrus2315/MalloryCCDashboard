/**
 * PIP EVIDENCE PANEL (designer refinement spec §3, 9/30) — read-only view of
 * the verified evidence payload computed by pipEvidenceCore. Presentation
 * ONLY: every number arrives through the ONE engine the issue path freezes —
 * no second calculation, no scoring, no labels. "—" means not verifiable,
 * never zero. Used in wizard Step 2 and reused read-only on the record.
 *
 * Activity row-group (metrics audit 10/1): Calls · Calls over 2 min ·
 * Conversation conversion · Assigned-lead conversion (WORK-DATE cohort,
 * labeled) come through repRangeSummaries — the same per-rep aggregate the
 * Reps page uses, windowed per week. Booking hours + bookings-per-hour stay
 * OMITTED: no such aggregation exists anywhere in the metrics layer (owner
 * rule = never estimate, and never a new calculation to fill a slot).
 */
import type { PipEvidence, PipActivitySummary } from "~/server/pip-evidence";
import { formatPercent } from "~/server/metrics/report-text";
import { InfoTip } from "./InfoTip";
import { WarningList } from "./warnings";

function etLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.parse(iso));
}

function weekLabel(w: { week_start: string; week_end: string }): string {
  const fmt = (d: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(
      new Date(Date.parse(`${d}T12:00:00Z`)),
    );
  return `${fmt(w.week_start)} – ${fmt(w.week_end)}`;
}

function MetChip({ met }: { met: boolean | null }) {
  if (met === null) return <span className="text-(--text-faint)">—</span>;
  return met ? <span className="chip chip-positive">Yes</span> : <span className="chip chip-risk">No</span>;
}

function Dash() {
  return <span className="text-(--text-faint)">—</span>;
}

/** Per-week activity cells (audit 10/1): null fields only for future weeks. */
function ActivityCells({ a }: { a: PipActivitySummary | null }) {
  if (a == null) {
    return (
      <>
        <td className="py-2 text-right tabular-nums"><Dash /></td>
        <td className="py-2 text-right tabular-nums"><Dash /></td>
        <td className="py-2 text-right tabular-nums"><Dash /></td>
        <td className="py-2 text-right tabular-nums"><Dash /></td>
      </>
    );
  }
  return (
    <>
      <td className="py-2 text-right tabular-nums">{a.calls}</td>
      <td className="py-2 text-right tabular-nums">{a.calls_over_2min}</td>
      <td className="py-2 text-right tabular-nums">{a.conversation_conversion == null ? <Dash /> : formatPercent(a.conversation_conversion, 1)}</td>
      <td className="py-2 text-right tabular-nums">{a.assigned_leads}</td>
    </>
  );
}

/** Just the per-week table — reused by wizard Step 3's live goal-met preview and the Step 6 preview. */
export function EvidenceWeekTable({ evidence }: { evidence: PipEvidence }) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full min-w-[640px] text-[12px]">
        <thead>
          <tr>
            <th scope="col" className="text-left">Week</th>
            <th scope="col" className="text-right">
              <span className="inline-flex items-center gap-1">
                Dashboard goal
                <InfoTip tip="From rep_goals, or the team-share fallback when no rep goal exists for the week." />
              </span>
            </th>
            <th scope="col" className="text-right">Actual</th>
            <th scope="col" className="text-left">Met</th>
            <th scope="col" className="text-right">
              <span className="inline-flex items-center gap-1">
                Calls
                <InfoTip tip="All call attempts in the week, including voicemail and no-answer — the same “Calls” the Reps and Team pages show." />
              </span>
            </th>
            <th scope="col" className="text-right">
              <span className="inline-flex items-center gap-1">
                Calls &gt; 2 min
                <InfoTip tip={`Calls longer than the meaningful-call threshold (${evidence.call_threshold_seconds}s, Settings).`} />
              </span>
            </th>
            <th scope="col" className="text-right">
              <span className="inline-flex items-center gap-1">
                Conv %
                <InfoTip tip="Conversation conversion: paid bookings that came from a call over the threshold, as a share of calls over the threshold. “—” when the week had no over-threshold calls." />
              </span>
            </th>
            <th scope="col" className="text-right">
              <span className="inline-flex items-center gap-1">
                Assigned leads
                <InfoTip tip="Leads assigned to this employee with a WORK DATE in the week — the work-date cohort the operational pages use." />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {evidence.weekly.map((w) => (
            <tr key={w.week_start}>
              <td className="whitespace-nowrap py-2">
                {weekLabel(w)}
                {w.state === "in_progress" && (
                  <span className="ml-2 rounded-full bg-(--chip-current-bg) px-2 py-0.5 text-[11px] font-medium text-(--chip-current-fg)">in progress</span>
                )}
                {w.state === "future" && <span className="ml-2 text-[11px] text-(--text-muted)">upcoming</span>}
              </td>
              <td className="py-2 text-right tabular-nums">
                {w.dashboard_goal == null ? (
                  <Dash />
                ) : (
                  <span title={w.dashboard_goal_note ?? undefined}>{w.dashboard_goal}</span>
                )}
              </td>
              <td className="py-2 text-right tabular-nums">{w.actual == null ? <Dash /> : w.actual}</td>
              <td className="py-2"><MetChip met={w.met} /></td>
              <ActivityCells a={w.activity} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvidencePanel({
  evidence,
  statements,
}: {
  evidence: PipEvidence;
  statements: { key: string; text: string }[];
}) {
  const kpis: { label: string; value: string }[] = [
    { label: "Weeks completed", value: String(evidence.weeks_completed) },
    { label: "Weeks goal met", value: String(evidence.weeks_goal_met) },
    { label: "Goal hit rate", value: evidence.goal_hit_rate_pct == null ? "—" : `${evidence.goal_hit_rate_pct}%` },
    { label: "Paid bookings (completed weeks)", value: String(evidence.total_wins_completed_weeks) },
  ];
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="section-heading flex items-center gap-1.5">
          Verified performance evidence
          <InfoTip tip="Computed by the same functions the dashboard pages use — one engine, no PIP-specific rules. “—” means not verifiable, never zero." />
        </p>
        <p className="text-[12px] text-(--text-caption)">Computed {etLabel(evidence.computed_at)} ET</p>
      </div>

      {evidence.warnings.length > 0 && (
        <div className="mt-2">
          <WarningList items={evidence.warnings} />
        </div>
      )}

      {/* KPI row — numbers stay charcoal; the dashboard goal provenance lives in the table */}
      <div className="card mt-3 overflow-hidden p-0">
        <div className="grid grid-cols-2 md:grid-cols-4 md:divide-x divide-(--table-border-weak)">
          {kpis.map((k, i) => (
            <div key={k.label} className={"px-5 py-4 " + (i >= 2 ? "border-t border-(--table-border-weak) md:border-t-0" : "")}>
              <p className="kpi-label">{k.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-(--text-primary)">{k.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Week table — dashboard goal carries its provenance (rep goal > team share) */}
      <div className="mt-3">
        <EvidenceWeekTable evidence={evidence} />
      </div>

      {/* Activity row-group (metrics audit 10/1): the four owner-requested call/lead
          metrics over the review period — same repRangeSummaries chain, no new math.
          Booking hours + bookings-per-hour stay omitted (no such verified metric). */}
      <div className="card mt-3 overflow-hidden p-0">
        <div className="grid grid-cols-2 md:grid-cols-4 md:divide-x divide-(--table-border-weak)">
          <div className="px-5 py-4 border-t border-(--table-border-weak) md:border-t-0">
            <p className="kpi-label">
              <span className="inline-flex items-center gap-1">
                Calls
                <InfoTip tip="All call attempts in the review window, including voicemail and no-answer." />
              </span>
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-(--text-primary)">{evidence.activity.calls}</p>
          </div>
          <div className="px-5 py-4 border-t border-(--table-border-weak) md:border-t-0">
            <p className="kpi-label">
              <span className="inline-flex items-center gap-1">
                Calls over 2 min
                <InfoTip tip={`Calls longer than the meaningful-call threshold (${evidence.call_threshold_seconds}s — Settings).`} />
              </span>
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-(--text-primary)">{evidence.activity.calls_over_2min}</p>
          </div>
          <div className="px-5 py-4 border-t border-(--table-border-weak)">
            <p className="kpi-label">
              <span className="inline-flex items-center gap-1">
                Conversation conversion
                <InfoTip tip="Paid bookings that came from a call over the threshold, as a share of calls over the threshold. “—” when there were none." />
              </span>
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-(--text-primary)">
              {evidence.activity.conversation_conversion == null ? "—" : formatPercent(evidence.activity.conversation_conversion, 1)}
            </p>
          </div>
          <div className="px-5 py-4 border-t border-(--table-border-weak)">
            <p className="kpi-label">
              <span className="inline-flex items-center gap-1">
                Assigned-lead conversion
                <InfoTip tip="Paid bookings as a share of leads assigned to this employee with a work date in the window (work-date cohort — the operational pages' standard). “—” when there were no assigned leads." />
              </span>
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-(--text-primary)">
              {evidence.activity.assigned_lead_conversion == null ? "—" : formatPercent(evidence.activity.assigned_lead_conversion, 1)}
            </p>
          </div>
        </div>
      </div>

      {/* Fixed factual statements — frozen verbatim at issue */}
      <div className="mt-3">
        <p className="text-[12px] text-(--text-caption)">Generated from verified dashboard data — reviewed by you before issue.</p>
        {statements.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {statements.map((s) => (
              <li key={s.key} className="rounded-md bg-(--surface-inset) px-3 py-2 text-[13px] leading-relaxed text-(--text-body)">
                {s.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[13px] text-(--text-muted)">
            {evidence.weekly[0]?.pip_goal == null
              ? "Enter the weekly goal to generate the factual statements."
              : "No completed weeks in this review period yet — no weekly evidence statements."}
          </p>
        )}
      </div>
    </div>
  );
}
