/**
 * PIP EVIDENCE PANEL (designer refinement spec §3, 9/30) — read-only view of
 * the verified evidence payload computed by pipEvidenceCore. Presentation
 * ONLY: every number arrives through the ONE engine the issue path freezes —
 * no second calculation, no scoring, no labels. "—" means not verifiable,
 * never zero. Used in wizard Step 2 and reused read-only on the record.
 *
 * Reserved metric slots (calls / calls>2min / conversation conversion /
 * assigned-lead conversion / booking hours / bookings-per-hour) are OMITTED —
 * the engine doesn't supply them and the owner rule is never estimate.
 */
import type { PipEvidence } from "~/server/pip-evidence";
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

/** Just the per-week table — reused by wizard Step 3's live goal-met preview and the Step 6 preview. */
export function EvidenceWeekTable({ evidence }: { evidence: PipEvidence }) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full text-[12px]">
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
                  <span className="text-(--text-faint)">—</span>
                ) : (
                  <span title={w.dashboard_goal_note ?? undefined}>{w.dashboard_goal}</span>
                )}
              </td>
              <td className="py-2 text-right tabular-nums">{w.actual == null ? <span className="text-(--text-faint)">—</span> : w.actual}</td>
              <td className="py-2"><MetChip met={w.met} /></td>
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
