import { createFileRoute } from "@tanstack/react-router";
import { WarningList } from "~/components/warnings";
import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { getDailyReportData, saveDailyPriorities } from "~/server/queries";
import { formatDateHuman } from "~/server/date-logic";
import { formatInt, formatPercent } from "~/server/metrics/report-text";
import { InfoTip } from "~/components/InfoTip";

export const Route = createFileRoute("/daily-report")({
  loader: () => getDailyReportData(),
  component: DailyReportPage,
});

function Kpi({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div>
      <p className="kpi-label">{label}</p>
      <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{value}</p>
      {sub && <p className="kpi-sub mt-1">{sub}</p>}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API unavailable (permissions/HTTP): select-and-copy fallback
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "copied" : "failed");
        setTimeout(() => setState("idle"), 2500);
      }}
      className={
        "rounded-lg px-4 py-2 text-[13px] font-medium transition-colors " +
        (state === "copied"
          ? "bg-(--btn-success) text-white"
          : "bg-(--accent-solid) text-(--accent-solid-fg) hover:bg-(--accent-hover)")
      }
    >
      {state === "copied" ? "Copied ✓" : state === "failed" ? "Copy failed — select the text below" : label}
    </button>
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

  const save = async () => {
    setSaveState("saving");
    try {
      await saveDailyPriorities({ data: { p1, p2, p3 } });
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
          <h1 className="text-2xl font-semibold tracking-tight">Daily Report</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-(--text-muted)">
            <span>
              {formatDateHuman(m.reportDate)} · yesterday's performance + week of {formatDateHuman(m.weekStart)}
            </span>
            {/* live-state indicator (owner hard rule): the report is always the live week */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-(--chip-positive-bg) bg-(--chip-positive-bg) px-2 py-0.5 text-xs font-semibold text-(--pos-text)">
              <span className="h-1.5 w-1.5 rounded-full bg-(--dot-positive)" aria-hidden="true" />
              Current Week
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

      {/* SECTION 1 — bookings */}
      <section>
        <p className="section-title mb-4">Bookings</p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
          <Kpi label="Bookings Yesterday" value={formatInt(m.bookingsYesterday)} />
          <Kpi label="Bookings WTD" value={formatInt(m.bookingsWtd)} />
          <Kpi label="Weekly Booking Goal" value={formatInt(m.weeklyBookingGoal)} />
          <Kpi label="Bookings Left" value={formatInt(m.bookingsLeft)} sub="to reach goal" />
          <Kpi
            label="Daily Bookings Needed"
            value={formatInt(m.dailyBookingsNeeded)}
            sub={m.paceWeekend ? "team is off — pace resumes Monday" : "pace to goal"}
          />
          <Kpi label="Conversation Conversion" value={formatPercent(m.conversationConversion)} sub="yesterday" />
          <Kpi label="Assigned Lead Conversion" value={formatPercent(m.assignedLeadConversion)} sub="yesterday" />
          <Kpi label="Goal Achievement" value={formatPercent(m.goalAchievement)} sub="week to date" />
        </div>
      </section>

      <hr className="border-(--card-border)" />

      {/* SECTION 2 — leads */}
      <section>
        <p className="section-title mb-4 flex items-center gap-1.5">
          Leads
          <InfoTip tip={`${data.cohortNote} (America/New_York)`} label="How today's lead counts are dated" />
        </p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
          <Kpi label="Weekly Lead Budget" value={formatInt(m.weeklyLeadBudget)} />
          <Kpi label="Leads Today" value={formatInt(m.leadsToday)} sub="work-date cohort" />
          <Kpi label="Family Leads Today" value={formatInt(m.familyLeadsToday)} />
          <Kpi label="Animalia Leads Today" value={formatInt(m.animaliaLeadsToday)} />
          <Kpi label="Weekly Leads" value={formatInt(m.weeklyLeads)} />
          <Kpi label="% Lead Budget Used" value={formatPercent(m.leadBudgetUsedPct)} />
          <Kpi label="Leads Remaining" value={formatInt(m.leadsRemaining)} sub={`of ${formatInt(m.weeklyLeadBudget)} budget`} />
          <Kpi
            label="Daily Leads Needed"
            value={formatInt(m.dailyLeadsNeeded)}
            sub={m.paceWeekend ? "team is off — pace resumes Monday" : "pace to budget"}
          />
        </div>
      </section>

      <hr className="border-(--card-border)" />

      {/* SECTION 3 — Big 3 */}
      <section>
        <p className="section-title mb-4">Big 3 — today's priorities</p>
        <div className="card max-w-xl">
          <div className="space-y-3">
            {(
              [
                ["1", p1, setP1],
                ["2", p2, setP2],
                ["3", p3, setP3],
              ] as const
            ).map(([n, value, set]) => (
              <div key={n} className="flex items-center gap-3">
                <span className="w-5 text-sm font-semibold text-(--text-muted)">{n}.</span>
                <input
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  placeholder={`Priority ${n}`}
                  className="w-full rounded-lg border border-(--card-border) bg-(--card-bg) px-3 py-2 text-sm text-(--text-primary) outline-none focus:border-(--input-focus-border)"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saveState === "saving"}
              className="rounded-lg bg-(--accent-solid) px-4 py-2 text-[13px] font-medium text-(--accent-solid-fg) transition-colors hover:bg-(--accent-hover) disabled:opacity-50"
            >
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Save Big 3"}
            </button>
            {saveState === "error" && <span className="text-xs text-(--neg-text)">Save failed — try again.</span>}
            <span className="text-xs text-(--text-muted)">Saved per date · shows in the copied report</span>
          </div>
        </div>
      </section>

      <hr className="border-(--card-border)" />

      {/* copy actions + preview */}
      <section>
        <div className="flex flex-wrap items-center gap-3">
          <CopyButton label="COPY REPORT" text={data.reportText} />
          <CopyButton label="COPY FOR EMAIL" text={data.emailText} />
          <CopyButton label="COPY FOR SLACK" text={data.slackText} />
        </div>
        <div className="card mt-5">
          <p className="kpi-label">Report preview — exactly what COPY REPORT puts on your clipboard</p>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-(--text-body)">
            {data.reportText}
          </pre>
        </div>
      </section>
    </div>
  );
}
