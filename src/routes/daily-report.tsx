import { createFileRoute } from "@tanstack/react-router";
import { WarningList } from "~/components/warnings";
import { useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { getDailyReportData, saveDailyPriorities } from "~/server/queries";
import { formatDateHuman } from "~/server/date-logic";
import { formatInt, formatPercent, anchorDayPhrase, bookingsAnchorLabel } from "~/server/metrics/report-text";
import { InfoTip } from "~/components/InfoTip";
import { CopyButton } from "~/components/CopyButton";

export const Route = createFileRoute("/daily-report")({
  loader: () => getDailyReportData(),
  component: DailyReportPage,
});

/* ---------------------------------------------------------------------------
   COMMAND-CENTER COMPOSITION (owner redesign spec 2026-10-01 — presentation
   only; every number below renders through the SAME server formatters as
   before, so all values are identical to the previous page):
     1. compact page header (title + context; timezone lives in metadata)
     2. DAILY PERFORMANCE HERO   — primary booking performance + supporting pace
     3. LEAD HEALTH              — weekly budget relationship + today's mix
     4. TODAY'S BIG 3            — commitment rows (inputs only while editing)
     5. report actions + preview — one compact action area, nothing scattered
   Surfaces: LEVEL 2 panels on the LEVEL 1 canvas, hairline internal dividers,
   LEVEL 3 for inputs/hover — depth from tone + spacing, not borders.
--------------------------------------------------------------------------- */

/** LEVEL 2 content panel — the shared section surface for the management pages. */
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={"rounded-xl border border-(--card-border) bg-(--card-bg) " + className}>{children}</div>;
}

/** True eyebrow label (the only uppercase on the page). */
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="kpi-label">{children}</p>;
}

/**
 * Clean progress visualization under a ratio metric. Presentation-only
 * geometry: the SAME ratio the adjacent text shows, clamped to the track;
 * null renders an empty track (missing data stays missing — never plausible).
 */
function RatioBar({ ratio, height = "h-1.5", max = "max-w-xl" }: { ratio: number | null; height?: string; max?: string }) {
  const width = ratio == null || !Number.isFinite(ratio) ? 0 : Math.min(100, Math.max(0, ratio * 100));
  return (
    <div className={`${height} w-full ${max} overflow-hidden rounded-full bg-(--bar-track)`} aria-hidden="true">
      <div className="h-full rounded-full bg-(--bar-fill)" style={{ width: `${width}%` }} />
    </div>
  );
}

function DailyReportPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const m = data.metrics;
  const [p1, setP1] = useState(data.priorities.priority1 ?? "");
  const [p2, setP2] = useState(data.priorities.priority2 ?? "");
  const [p3, setP3] = useState(data.priorities.priority3 ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Big 3 view/edit states: saved priorities render as clean numbered
  // commitment rows; inputs appear only while editing. Start in edit mode
  // only when nothing is saved yet (the empty state invites action).
  const [editing, setEditing] = useState(
    !data.priorities.priority1 && !data.priorities.priority2 && !data.priorities.priority3,
  );

  const save = async () => {
    setSaveState("saving");
    try {
      await saveDailyPriorities({ data: { p1, p2, p3 } });
      setSaveState("saved");
      await router.invalidate();
      setEditing(false);
      setTimeout(() => setSaveState("idle"), 2500);
    } catch {
      setSaveState("error");
    }
  };

  const cancel = () => {
    setP1(data.priorities.priority1 ?? "");
    setP2(data.priorities.priority2 ?? "");
    setP3(data.priorities.priority3 ?? "");
    setSaveState("idle");
    setEditing(false);
  };

  // Today's mix bar geometry (presentation-only proportions from the two
  // payload counts; the legend text always shows the raw values).
  const mixTotal = m.leadsToday > 0 ? m.leadsToday : 0;
  const animaliaPct = mixTotal > 0 ? Math.min(100, (m.animaliaLeadsToday / mixTotal) * 100) : 0;
  const familyPct = mixTotal > 0 ? Math.min(100, (m.familyLeadsToday / mixTotal) * 100) : 0;

  const priorities: [string, string, (v: string) => void][] = [
    ["1", p1, setP1],
    ["2", p2, setP2],
    ["3", p3, setP3],
  ];

  return (
    <div className="space-y-5">
      {/* 1 — compact header: title + context; no floating dead space. The
             timezone lives in metadata + the cohort tooltip. */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-tight">Daily Report</h1>
            {/* live-state indicator (owner hard rule): the report is always the live week */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-(--chip-positive-bg) bg-(--chip-positive-bg) px-2 py-0.5 text-xs font-semibold text-(--pos-text)">
              <span className="h-1.5 w-1.5 rounded-full bg-(--dot-positive)" aria-hidden="true" />
              Current Week
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-(--text-muted)">
            <span className="tabular-nums">
              {formatDateHuman(m.reportDate)} · {formatDateHuman(m.anchorDate)} performance · week of{" "}
              {formatDateHuman(m.weekStart)}
            </span>
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

      {/* 2 — DAILY PERFORMANCE HERO: booking performance (primary) + pace (supporting) */}
      <section aria-label="Daily performance">
        <Panel className="overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)] lg:divide-x lg:divide-(--table-border-weak)">
            {/* left / primary — the weekly goal is the visual anchor */}
            <div className="p-5 sm:p-6">
              <Eyebrow>Booking Performance</Eyebrow>
              <div className="mt-4 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
                <div className="min-w-0">
                  <p className="kpi-label">Bookings WTD / Weekly Booking Goal</p>
                  <p className="mt-2 flex items-baseline gap-2.5 tabular-nums">
                    <span className="text-6xl font-semibold leading-none tracking-tight text-(--text-primary)">
                      {formatInt(m.bookingsWtd)}
                    </span>
                    <span className="text-3xl font-medium text-(--text-muted)">/ {formatInt(m.weeklyBookingGoal)}</span>
                  </p>
                </div>
                <div className="min-w-0">
                  {/* OWNER ANCHOR RULE: the performance figure covers the anchor day
                      (most recent complete operating day), so the label names it. */}
                  <p className="kpi-label">{bookingsAnchorLabel(m.anchorDate, m.reportDate)}</p>
                  <p className="mt-2 text-4xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                    {formatInt(m.bookingsAnchorDay)}
                  </p>
                </div>
              </div>
              <div className="mt-6">
                <RatioBar ratio={m.goalAchievement} />
                <p className="kpi-sub mt-2 tabular-nums">
                  {formatPercent(m.goalAchievement)} of goal · {formatInt(m.bookingsLeft)} remaining
                </p>
              </div>
            </div>
            {/* right / supporting — pace is secondary to the goal */}
            <div className="border-t border-(--table-border-weak) p-5 lg:border-t-0">
              <Eyebrow>Today's Pace</Eyebrow>
              <dl className="mt-4 space-y-4">
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Daily Bookings Needed</dt>
                  <dd className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {formatInt(m.dailyBookingsNeeded)}
                    </span>
                    <span className="kpi-sub">{m.paceWeekend ? "team is off — pace resumes Monday" : "pace to goal"}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Conversation Conversion</dt>
                  <dd className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {formatPercent(m.conversationConversion)}
                    </span>
                    <span className="kpi-sub">{anchorDayPhrase(m.anchorDate, m.reportDate)}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Assigned Lead Conversion</dt>
                  <dd className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {formatPercent(m.assignedLeadConversion)}
                    </span>
                    <span className="kpi-sub">{anchorDayPhrase(m.anchorDate, m.reportDate)}</span>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </Panel>
      </section>

      {/* 3 — LEAD HEALTH: one budget relationship + today's mix as one visual system */}
      <section aria-label="Lead health">
        <Panel className="overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:divide-x lg:divide-(--table-border-weak)">
            {/* left / primary — weekly leads against the budget */}
            <div className="p-5 sm:p-6">
              <h2 className="kpi-label flex items-center gap-1.5">
                Lead Health
                <InfoTip tip={`${data.cohortNote} (America/New_York)`} label="How today's lead counts are dated" />
              </h2>
              <p className="kpi-label mt-5">Weekly Leads / Weekly Lead Budget</p>
              <p className="mt-2 flex items-baseline gap-2.5 tabular-nums">
                <span className="text-5xl font-semibold leading-none tracking-tight text-(--text-primary)">
                  {formatInt(m.weeklyLeads)}
                </span>
                <span className="text-2xl font-medium text-(--text-muted)">/ {formatInt(m.weeklyLeadBudget)}</span>
                <span className="text-sm text-(--text-muted)">leads</span>
              </p>
              <div className="mt-5">
                <RatioBar ratio={m.leadBudgetUsedPct} />
                <p className="kpi-sub mt-2 tabular-nums">
                  {formatPercent(m.leadBudgetUsedPct)} used · {formatInt(m.leadsRemaining)} remaining
                </p>
              </div>
            </div>
            {/* right — today's cohort: one mix bar, one legend, the needed pace */}
            <div className="border-t border-(--table-border-weak) p-5 lg:border-t-0">
              <p className="kpi-label">Leads Today</p>
              <p className="mt-2 flex items-baseline gap-2">
                <span className="text-4xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                  {formatInt(m.leadsToday)}
                </span>
                <span className="kpi-sub">work-date cohort</span>
              </p>
              <div
                className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-(--bar-track)"
                aria-hidden="true"
              >
                <div style={{ width: `${animaliaPct}%`, background: "var(--bar-fill)" }} />
                <div style={{ width: `${familyPct}%`, background: "var(--text-muted)" }} />
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-(--text-body)">
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--bar-fill)" }} aria-hidden="true" />
                  <span className="tabular-nums">{formatInt(m.animaliaLeadsToday)}</span> Animalia
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--text-muted)" }} aria-hidden="true" />
                  <span className="tabular-nums">{formatInt(m.familyLeadsToday)}</span> Family
                </li>
              </ul>
              <div className="mt-4 border-t border-(--table-border-weak) pt-3">
                <p className="text-[13px] font-medium text-(--text-body)">Daily Leads Needed</p>
                <p className="mt-0.5 flex items-baseline gap-2">
                  <span className="text-xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                    {formatInt(m.dailyLeadsNeeded)}
                  </span>
                  <span className="kpi-sub">{m.paceWeekend ? "team is off — pace resumes Monday" : "pace to budget"}</span>
                </p>
              </div>
            </div>
          </div>
        </Panel>
      </section>

      {/* 4 — TODAY'S BIG 3: commitment rows; inputs only while editing */}
      <section aria-label="Today's Big 3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <Eyebrow>Today's Big 3</Eyebrow>
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={save}
                  disabled={saveState === "saving"}
                  className="rounded-lg bg-(--accent-solid) px-4 py-2 text-[13px] font-medium text-(--accent-solid-fg) transition-colors hover:bg-(--accent-hover) disabled:opacity-50"
                >
                  {saveState === "saving" ? "Saving…" : "Save Big 3"}
                </button>
                <button type="button" onClick={cancel} className="btn-secondary">
                  Cancel
                </button>
                {saveState === "error" && <span className="text-xs text-(--neg-text)">Save failed — try again.</span>}
              </>
            ) : (
              <>
                <button type="button" onClick={() => setEditing(true)} className="btn-secondary">
                  Edit
                </button>
                {saveState === "saved" && (
                  <span className="text-xs font-medium text-(--pos-text)">Saved ✓</span>
                )}
              </>
            )}
            <span className="text-xs text-(--text-muted)">Saved per date · shows in the copied report</span>
          </div>
        </div>
        <Panel className="max-w-2xl overflow-hidden">
          <ol className="divide-y divide-(--table-border-weak)">
            {priorities.map(([n, value, set], i) => (
              <li key={n} className="flex items-center gap-4 px-5 py-3">
                <span className="w-6 shrink-0 text-[13px] font-semibold tabular-nums text-(--text-muted)">
                  {`0${i + 1}`}
                </span>
                {editing ? (
                  <input
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    placeholder={`Priority ${n}`}
                    className="input-field w-full"
                  />
                ) : (
                  <span className="text-[15px] leading-relaxed text-(--text-primary)">
                    {value || <span className="text-(--text-faint)">—</span>}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Panel>
      </section>

      {/* 5 — report actions: one compact area; COPY REPORT is the primary
             action, email/slack stay restrained. Preview collapsed by default. */}
      <section aria-label="Daily report actions">
        <div className="flex flex-wrap items-center gap-2.5">
          <CopyButton label="COPY REPORT" text={data.reportText} />
          <CopyButton label="COPY FOR EMAIL" text={data.emailText} variant="secondary" />
          <CopyButton label="COPY FOR SLACK" text={data.slackText} variant="secondary" />
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
            {data.reportText}
          </pre>
        </details>
      </section>
    </div>
  );
}
