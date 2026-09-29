import { createFileRoute } from "@tanstack/react-router";
import { useAppearance } from "~/components/appearance";
import { Segmented } from "~/components/Segmented";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { StatusChip } from "~/components/StatusChip";
import { WarningList } from "~/components/warnings";
import {
  NO_REP_REASON_LABELS,
  PASSPHRASE_WARNING_LEAD,
  PASSPHRASE_WARNING_REST,
  QUEUE_STATE_LABELS,
  SETTINGS_SECTIONS,
  connectionStatusView,
  passphraseStatus,
  providerLabel,
  queueReasonBreakdown,
  queueRowState,
  sectionMeta,
  sectionNumber,
  unassignable,
} from "~/components/settings-views";
import { bookingSplitLine } from "~/components/team-views";
import { InfoTip } from "~/components/InfoTip";
import { formatInt } from "~/server/metrics/report-text";
import {
  addBlockedTime,
  assignAttribution,
  getSettingsData,
  removeBlockedTime,
  saveAcuityScope,
  saveMonthlyGoals,
  saveRecurringBlocks,
  saveRepGoals,
  saveRepMappings,
  saveRepStartDates,
  saveSettings,
  saveSheetMapping,
  saveStudioRules,
  saveWeekGoal,
  setLeadCount,
  setLeadWorkDate,
  syncNow,
  unassignAttribution,
} from "~/server/queries";

export const Route = createFileRoute("/settings")({
  loader: () => getSettingsData(),
  component: SettingsPage,
});

import { SHEET_MODE_LABELS, type SheetMappingMode } from "~/server/sync/sheets-mapping";
import { DEFAULT_COLUMN_MAPPING, DEFAULT_COLUMN_MAPPING_DAY_COUNT } from "~/server/store/types";

type SettingsData = ReturnType<typeof Route.useLoaderData>;

const COLUMN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const SHEET_FIELDS_LEAD: { key: string; label: string }[] = [
  { key: "source_date", label: "Date" },
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "lead_type", label: "Lead Type (optional)" },
];
const SHEET_FIELDS_DAY: { key: string; label: string }[] = [
  { key: "source_date", label: "Date" },
  { key: "count", label: "Lead count" },
  { key: "lead_type", label: "Lead Type (optional)" },
];
const SHEET_MODE_OPTIONS: { value: SheetMappingMode; label: string; hint: string }[] = [
  { value: "row_per_day_count", label: SHEET_MODE_LABELS.row_per_day_count, hint: "one row per day, a count column says how many leads" },
  { value: "row_per_lead", label: SHEET_MODE_LABELS.row_per_lead, hint: "one row per lead, with phone/email" },
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function SettingsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setFlash(null);
    try {
      await fn();
      setFlash(label);
      await router.invalidate();
    } catch (e) {
      setFlash(e instanceof Error ? `Error: ${e.message}` : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-sm text-(--text-muted)">Manage goals, rules, integrations, sync health, and manual corrections — every change persists and is audited.</p>
      </div>

      {/* 0 — Appearance (P5, DECISION ④: STANDALONE block — own anchor, NOT in
          SETTINGS_SECTIONS, so the 02–09 IA numbering and settings-views pins
          are untouched). Client-only preference; no loader involvement. */}
      <AppearanceSection />
      <SubNav />

      {flash && (
        <p role="status" className="text-sm font-medium text-(--pos-text)">
          {flash}
        </p>
      )}

      {/* 1 — Security & Status (spec §1: compact strip replacing the stacked banners) */}
      <SecuritySection data={data} />

      {/* 2 — Goals (spec §2: weekly grid + rep goals + rep start dates) */}
      <section id="goals" className="scroll-mt-28 space-y-8 border-t border-(--card-border) pt-8">
        <SectionHeader id="goals" />
        <div className="space-y-3">
          <h3 className="section-heading">Weekly Booking Goal &amp; Lead Budget</h3>
          <p className="text-[13px] text-(--text-caption)">Edit any week — past weeks keep history, future weeks are the plan. Changes are audited.</p>
          <div className="overflow-x-auto">
            <table className="data-table min-w-[720px]">
              <thead>
                <tr>
                  <th className="sticky left-0 z-[1] bg-(--card-bg) text-left">Week</th>
                  <th className="text-right">Booking goal</th>
                  <th className="text-right">Lead budget</th>
                  <th className="text-left"></th>
                </tr>
              </thead>
              <tbody>
                {data.editorWeeks.map((w) => (
                  <WeekGoalRow key={w.weekStart} week={w} busy={busy} onSave={(goal, budget) => run(`Goal saved for week of ${w.weekStart}`, () => saveWeekGoal({ data: { weekStart: w.weekStart, bookingGoal: goal, leadBudget: budget } }))} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <MonthlyGoalsSection data={data} busy={busy} onSave={(goals) => run("Monthly booking goals saved", () => saveMonthlyGoals({ data: { goals } }))} />
        <RepGoalsSection data={data} busy={busy} onSave={(weekStart, goals) => run(`Rep goals saved for ${weekStart}`, () => saveRepGoals({ data: { weekStart, goals } }))} />
        {/* Rep config sits beside rep goals (start date drives "Not Yet Active") */}
        <RepStartDatesSection data={data} busy={busy} onSave={(entries) => run("Rep start dates saved", () => saveRepStartDates({ data: { entries } }))} />
      </section>

      {/* 3 — Operational Rules (spec §3: compact, feel important) */}
      <section id="rules" className="scroll-mt-28 space-y-4 border-t border-(--card-border) pt-8">
        <SectionHeader id="rules" />
        <CoreOpsCard data={data} busy={busy} onSave={(thresholdSeconds, windowHours) => run("Operational settings saved", () => saveSettings({ data: { thresholdSeconds, windowHours } }))} />
      </section>

      {/* 4 — Acuity scope + availability rules (spec §4, one major section) */}
      <section id="acuity" className="scroll-mt-28 space-y-6 border-t border-(--card-border) pt-8">
        <SectionHeader id="acuity" />
        <div className="space-y-3">
          <h3 className="section-heading">Acuity Reporting Scope</h3>
          <AcuityScopeCard data={data} busy={busy} onSave={(calendars, types) => run("Acuity scope saved", () => saveAcuityScope({ data: { calendars, types } }))} />
        </div>
        <div className="space-y-3">
          <h3 className="section-heading">Studio Hours &amp; Slot Rules</h3>
          <StudioRulesCard data={data} busy={busy} onSave={(payload) => run("Studio rules saved", () => saveStudioRules({ data: payload }))} />
        </div>
        <Collapsible label="Recurring Blocks" hint={`${data.settings.studio.recurring_blocks.length} configured — weekly pattern`}>
          <RecurringBlocksCard data={data} busy={busy} onSave={(blocks) => run("Recurring blocks saved", () => saveRecurringBlocks({ data: { blocks } }))} />
        </Collapsible>
        <Collapsible label="One-off Blocks" hint={`${data.blockedTimes.length} in the next 30 days`}>
          <BlockedTimesCard data={data} busy={busy} onAdd={(payload) => run("Blocked time added", () => addBlockedTime({ data: payload }))} onRemove={(id, label) => run("Blocked time removed", () => removeBlockedTime({ data: { id, label } }))} />
        </Collapsible>
      </section>

      {/* 5 — Google Sheets mapping (spec: "Advanced Mapping" collapsible) */}
      <details id="sheets" className="group scroll-mt-28 rounded-xl border border-(--card-border) bg-(--card-bg)">
        <summary className="flex cursor-pointer list-none select-none items-center justify-between gap-3 px-5 py-4 hover:bg-(--surface-hover) [&::-webkit-details-marker]:hidden">
          <span className="flex items-baseline gap-3">
            <span className="text-xs font-medium tabular-nums text-(--text-faint)" aria-hidden="true">
              {sectionNumber("sheets")}
            </span>
            <span>
              <span className="block text-[15px] font-semibold tracking-tight text-(--text-primary)">Google Sheets Mapping</span>
              <span className="mt-0.5 block text-[13px] text-(--text-caption)">Where the Family + Animalia lead counts come from and how each column is read.</span>
            </span>
          </span>
          <span className="flex items-center gap-3">
            <span className="hidden text-xs text-(--text-muted) sm:inline">{(["family", "animalia"] as const).map((s) => data.settings.sheets[s].mode === "row_per_lead" ? `${s} row-per-lead` : `${s} day+count`).join(" · ")}</span>
            <span className="text-(--text-muted) transition-transform group-open:rotate-180" aria-hidden="true">
              ▾
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-(--table-border-weak) p-5">
          <p className="text-[13px] text-(--text-caption)">Which columns of the Family / Animalia sheets hold each field, and whether each row is a day+count or a single lead. Test mapping fetches a REAL sample row from Google Sheets and parses it with the same code a live sync uses.</p>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {(["family", "animalia"] as const).map((sheet) => (
              <SheetMappingCard key={sheet} sheet={sheet} columns={data.settings.sheets[sheet].columns} mode={data.settings.sheets[sheet].mode} sheetId={data.settings.sheets[sheet].sheet_id} busy={busy} onSave={(columns, mode) => run(`${sheet} mapping saved`, () => saveSheetMapping({ data: { sheet, columns, mode } }))} />
            ))}
          </div>
        </div>
      </details>

      {/* 6 — Sync Center (spec: operations panel, default expanded) */}
      <section id="sync" className="scroll-mt-28 space-y-4 border-t border-(--card-border) pt-8">
        <SectionHeader id="sync" />
        <SyncCenter data={data} onSync={async () => {
          const res = await syncNow();
          await router.invalidate();
          return `Sync complete (${res.mode}): ${res.providers.map((p) => `${p.provider} ${p.count}`).join(", ")}`;
        }} />
      </section>

      {/* 7 — Manual overrides & roster (spec §7; roster mapping = ownership correction) */}
      <section id="overrides" className="scroll-mt-28 space-y-8 border-t border-(--card-border) pt-8">
        <div className="space-y-2">
          <SectionHeader id="overrides" />
          <p className="text-[13px] text-(--text-caption)">Corrections Christopher makes by hand — every one is written to the audit trail below with previous value, new value, who and when.</p>
        </div>
        {/* (a) Roster mapping — eligibility correction, folded in as the first subsection */}
        <RosterMappingSection data={data} busy={busy} onSave={(mappings) => run("Roster mappings saved", () => saveRepMappings({ data: { mappings } }))} />
        {/* (b) Manual-assignment queue — THREE-WAY ATTRIBUTION SPLIT (owner
            directive 2026-09-27, S5b): the split line shows the three mutually
            exclusive states over the in-scope bookings; Ambiguous is its OWN
            state, never folded into Unattributed. The queue itself (assign /
            unassign) behaves exactly as before. */}
        <div className="space-y-3">
          <h3 className="section-heading">Unattributed Bookings</h3>
          <div className="card space-y-2">
            <p className="kpi-label" data-testid="booking-attribution-split">
              {bookingSplitLine(data.attributionSplit)}
              <span className="text-(--text-muted)"> · {formatInt(data.attributionSplit.total)} in-scope bookings</span>
            </p>
            <p className="text-[12px] text-(--text-muted)">
              {formatInt(data.unattributed.length)} booking{data.unattributed.length === 1 ? "" : "s"} need a manual decision — Ambiguous stays Ambiguous until assigned by hand.
            </p>
            {/* S4b: grouped count summary — one bucket per honest no-rep
                category (booking_attributions.reason_code), Ambiguous shown as
                its own identity-conflict group, never folded in. */}
            {data.unattributed.length > 0 && (
              <p className="kpi-label" data-testid="queue-reason-breakdown">
                {queueReasonBreakdown(data.unattributed)
                  .map((b) => `${b.label}: ${formatInt(b.count)}`)
                  .join(" · ")}
              </p>
            )}
            {data.unattributed.length === 0 ? (
              <p className="text-[13px] text-(--text-muted)">Every active booking is attributed.</p>
            ) : (
              <>
                {/* Phones: one decision card per booking — the 8-column table
                    is unreadable at 375px, so every field and control stacks
                    full-width with the same wording and the same handlers. */}
                <div className="space-y-3 md:hidden">
                  {data.unattributed.slice(0, 12).map((u) => (
                    <UnattributedCard key={u.appointment_id} row={u} users={data.users} busy={busy} onAssign={(appointmentId, repId, callId) => run("Booking attributed", () => assignAttribution({ data: { appointmentId, repId, callId } }))} onUnassign={(appointmentId) => run("Booking unassigned — returns to engine attribution", () => unassignAttribution({ data: { appointmentId } }))} />
                  ))}
                </div>
                {/* md+: the compact sortable-adjacent queue table (unchanged) */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="data-table min-w-[980px]">
                    <thead>
                      <tr>
                        <th className="text-left">Client</th>
                        <th className="text-left">Type</th>
                        <th className="text-left">Session</th>
                        <th className="text-left">State · why unattributed</th>
                        <th className="text-left">Suggested</th>
                        <th className="text-left">Call</th>
                        <th className="text-left">Assign to</th>
                        <th className="text-left"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.unattributed.slice(0, 12).map((u) => (
                        <UnattributedRow key={u.appointment_id} row={u} users={data.users} busy={busy} onAssign={(appointmentId, repId, callId) => run("Booking attributed", () => assignAttribution({ data: { appointmentId, repId, callId } }))} onUnassign={(appointmentId) => run("Booking unassigned — returns to engine attribution", () => unassignAttribution({ data: { appointmentId } }))} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
        {/* (c) Lead corrections */}
        <div className="space-y-3">
          <h3 className="section-heading">Corrections</h3>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <LeadWorkDateCard data={data} busy={busy} onSave={(leadId, workDate, previousWorkDate, reason) => run("Lead work date corrected", () => setLeadWorkDate({ data: { leadId, workDate, previousWorkDate, reason } }))} />
            <LeadCountCard data={data} busy={busy} onSave={(date, sheet, count, reason) => run("Lead count corrected", () => setLeadCount({ data: { date, sheet, count, reason } }))} />
          </div>
        </div>
      </section>

      {/* 8 — Audit trail (spec §8: history tool, collapsible, bottom of page) */}
      <details id="audit" className="group scroll-mt-28 rounded-xl border border-(--card-border) bg-(--card-bg)">
        <summary className="flex cursor-pointer list-none select-none items-center justify-between gap-3 px-5 py-4 hover:bg-(--surface-hover) [&::-webkit-details-marker]:hidden">
          <span className="flex items-baseline gap-3">
            <span className="text-xs font-medium tabular-nums text-(--text-faint)" aria-hidden="true">
              {sectionNumber("audit")}
            </span>
            <span>
              <span className="block text-[15px] font-semibold tracking-tight text-(--text-primary)">Audit History</span>
              <span className="mt-0.5 block text-[13px] text-(--text-caption)">Every settings change and manual override — what changed, previous value, new value, who, when.</span>
            </span>
          </span>
          <span className="flex items-center gap-3">
            <span className="text-xs tabular-nums text-(--text-muted)">{data.overrides.length} entries</span>
            <span className="text-(--text-muted) transition-transform group-open:rotate-180" aria-hidden="true">
              ▾
            </span>
          </span>
        </summary>
        <div className="border-t border-(--table-border-weak) p-5">
          <div className="overflow-x-auto">
            <table className="data-table min-w-[820px]">
              <thead>
                <tr>
                  <th className="text-left">When</th>
                  <th className="text-left">Entity</th>
                  <th className="text-left">Field</th>
                  <th className="text-left">Previous</th>
                  <th className="text-left">New</th>
                  <th className="text-left">Who</th>
                </tr>
              </thead>
              <tbody>
                {data.overrides.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-(--text-muted)">
                      No overrides recorded yet.
                    </td>
                  </tr>
                )}
                {data.overrides.map((o) => (
                  <tr key={o.id}>
                    <td>{new Date(o.changed_at).toLocaleString("en-US")}</td>
                    <td className="font-medium text-(--text-primary)">
                      {o.entity_type} <span className="text-(--text-muted)">{o.entity_id.slice(0, 18)}</span>
                    </td>
                    <td>{o.field}</td>
                    <td className="text-(--text-muted)">{o.previous_value ?? "—"}</td>
                    <td>{o.new_value}</td>
                    <td>{o.changed_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
}

/* ================= sub-nav + section scaffolding ================= */

/** Sticky sub-nav — same trick as Today's sticky table header (offsets pair
 * with the shell header: top-[68px] on phones, md:top-14 on desktop; negative
 * margins match main's responsive padding so the bar spans edge-to-edge). */
function SubNav() {
  return (
    <nav aria-label="Settings sections" className="sticky top-[68px] z-[1] -mx-4 border-b border-(--card-border) bg-(--sticky-header-bg) px-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:top-14">
      <div className="flex items-center gap-1 overflow-x-auto py-2">
        {SETTINGS_SECTIONS.map((s, i) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="whitespace-nowrap rounded-md px-2.5 py-2 text-[13px] font-medium text-(--text-caption) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
          >
            <span className="mr-1.5 text-xs tabular-nums text-(--text-faint)">{String(i + 1).padStart(2, "0")}</span>
            {s.nav}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** Numbered section header — kicker + title + one-line description, from the IA constant. */
function SectionHeader({ id }: { id: string }) {
  const meta = sectionMeta(id);
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs font-medium tabular-nums text-(--text-faint)" aria-hidden="true">
        {sectionNumber(id)}
      </span>
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-(--text-primary)">{meta.title}</h2>
        <p className="mt-0.5 text-[13px] text-(--text-caption)">{meta.description}</p>
      </div>
    </div>
  );
}

/** Collapsible subsection card (native <details>, no JS state — collapsed where the spec says). */
function Collapsible({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-(--card-border) bg-(--card-bg)">
      <summary className="flex cursor-pointer list-none select-none items-center justify-between gap-3 px-5 py-3.5 hover:bg-(--surface-hover) [&::-webkit-details-marker]:hidden">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="section-heading">{label}</span>
          {hint && <span className="text-xs text-(--text-muted)">{hint}</span>}
        </span>
        <span className="text-(--text-muted) transition-transform group-open:rotate-180" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="border-t border-(--table-border-weak) p-5">{children}</div>
    </details>
  );
}

/* ================= 1 — security & status ================= */

function SecuritySection({ data }: { data: SettingsData }) {
  // Hydration-safe clock: ages render after mount (SSR shows chips without ages).
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => setNowMs(Date.now()), []);
  const pass = passphraseStatus(data.passphraseConfigured);
  const conns = data.connections.map((c) => connectionStatusView(c, nowMs));
  const demo = data.meta.mode === "memory";
  return (
    <section id="security" className="scroll-mt-28 space-y-3">
      <SectionHeader id="security" />
      <div className="card card-dense space-y-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <StatusChip kind={pass.tone} label={pass.label} />
          {conns.map((c) => (
            <span key={c.provider} className="flex items-center gap-2 text-[13px]">
              <span className="font-medium text-(--text-body)">{providerLabel(c.provider)}</span>
              <StatusChip kind={c.tone} label={c.label} />
              {c.lastSync && <span className="text-xs text-(--text-muted)">{c.lastSync}</span>}
              {c.error && (
                <span className="max-w-[220px] truncate text-xs text-(--neg-text)" title={c.error}>
                  {c.error}
                </span>
              )}
            </span>
          ))}
          {conns.length === 0 && <span className="text-[13px] text-(--text-muted)">No connections recorded yet — press SYNC NOW.</span>}
        </div>
        {pass.detail && (
          <p className="status-banner">
            <span className="font-medium">{PASSPHRASE_WARNING_LEAD}</span> {PASSPHRASE_WARNING_REST}
          </p>
        )}
        {demo && (
          <p className="status-banner">
            <span className="font-medium">Running on in-memory demo data</span>
            {data.meta.dbReason ? ` — ${data.meta.dbReason}` : ""}. Edits persist for this server session only.
          </p>
        )}
        <WarningList items={data.staleWarnings} />
      </div>
    </section>
  );
}

/* ================= 2 — weekly goals ================= */

interface EditorWeek {
  weekStart: string;
  isCurrent: boolean;
  label: string;
  goal: number | null;
  leadBudget: number | null;
}

function WeekGoalRow({ week, busy, onSave }: { week: EditorWeek; busy: boolean; onSave: (goal: number, budget: number) => void }) {
  const [goal, setGoal] = useState(String(week.goal ?? 79));
  const [budget, setBudget] = useState(String(week.leadBudget ?? 700));
  return (
    <tr className={week.isCurrent ? "bg-(--row-highlight)" : ""}>
      <td className="sticky left-0 bg-(--card-bg)">
        <span className="font-medium text-(--text-primary)">{week.label}</span>
        {week.isCurrent && <span className="ml-2 rounded-full bg-(--chip-current-bg) px-2 py-0.5 text-xs font-medium text-(--chip-current-fg)">current</span>}
        <span className="ml-2 text-xs text-(--text-muted)">{week.weekStart}</span>
      </td>
      <td className="text-right">
        <input type="number" className="w-24 rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-right text-[13px] outline-none focus:border-(--input-focus-border)" value={goal} onChange={(e) => setGoal(e.target.value)} />
      </td>
      <td className="text-right">
        <input type="number" className="w-24 rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-right text-[13px] outline-none focus:border-(--input-focus-border)" value={budget} onChange={(e) => setBudget(e.target.value)} />
      </td>
      <td className="text-right">
        <button className="rounded-lg border border-(--input-border) px-3 py-1 text-xs font-medium text-(--text-body) hover:bg-(--surface-subtle) disabled:opacity-50" disabled={busy} onClick={() => onSave(Number(goal), Number(budget))}>
          Save
        </button>
      </td>
    </tr>
  );
}

/* ================= 1b — monthly booking goal ================= */

/**
 * MONTHLY BOOKING GOAL (owner-approved 2026-09-29): one goal per calendar
 * month, current + next (rep_goals precedent at month grain). Empty → unset —
 * the Weekly report renders an honest "—" until a goal exists; a month NEVER
 * inherits another month's number.
 */
function MonthlyGoalsSection({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (goals: { month: string; goal: number | null }[]) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.monthlyGoals.map((g) => [g.month, g.goal != null ? String(g.goal) : ""])),
  );
  return (
    <div className="space-y-3">
      <div>
        <h3 className="section-heading">Monthly Booking Goal</h3>
        <p className="mt-1 text-[13px] text-(--text-caption)">
          One booking goal per calendar month (America/New_York) — the Weekly report compares month-to-date paid
          bookings against this month's goal. A month never inherits another month's goal. Clear a field to unset it.
          Changes are audited.
        </p>
      </div>
      <div className="card space-y-1 p-0">
        {data.monthlyGoals.map((g) => (
          <div key={g.month} className="flex items-center justify-between gap-4 border-b border-(--table-border-weak) px-5 py-2.5 last:border-0">
            <span className="text-[13px] font-medium text-(--text-body)">
              {g.label}
              {g.isCurrent && <span className="ml-2 rounded-full bg-(--chip-current-bg) px-2 py-0.5 text-xs font-medium text-(--chip-current-fg)">current</span>}
              <span className="ml-2 text-xs text-(--text-muted)">{g.month}</span>
            </span>
            <input
              type="number"
              placeholder="not set"
              aria-label={`Booking goal for ${g.label}`}
              className="w-28 rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-right text-[13px] outline-none focus:border-(--input-focus-border)"
              value={draft[g.month] ?? ""}
              onChange={(e) => setDraft({ ...draft, [g.month]: e.target.value })}
            />
          </div>
        ))}
        <div className="flex justify-end px-5 py-3">
          <button
            className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50"
            disabled={busy}
            onClick={() => onSave(data.monthlyGoals.map((g) => ({ month: g.month, goal: (draft[g.month] ?? "").trim() === "" ? null : Number(draft[g.month]) })))}
          >
            Save monthly goals
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= 2 — rep goals ================= */

function RepGoalsSection({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (weekStart: string, goals: { repId: string; goal: number | null }[]) => void;
}) {
  const [week, setWeek] = useState(data.weekStart);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(data.users.map((u) => [u.id, String(data.repGoalsByWeek[data.weekStart]?.find((g) => g.rep_id === u.id)?.goal ?? "")])));
  const weekRow = data.editorWeeks.find((w) => w.weekStart === week);
  const teamGoal = weekRow?.goal ?? 79;
  const teamShare = data.repCount > 0 ? teamGoal / data.repCount : null;

  const switchWeek = (w: string) => {
    setWeek(w);
    setDraft(Object.fromEntries(data.users.map((u) => [u.id, String(data.repGoalsByWeek[w]?.find((g) => g.rep_id === u.id)?.goal ?? "")])));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="section-heading">Rep Goals</h3>
          <p className="mt-1 text-[13px] text-(--text-caption)">
            Leave blank to use the team share: {teamGoal} ÷ {data.repCount || "—"} = {teamShare != null ? (Math.round(teamShare * 100) / 100).toFixed(2) : "—"} bookings per rep (labeled on rep pages). Week of {week}.
          </p>
        </div>
        <select aria-label="Rep goals week" className="rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1.5 text-[13px]" value={week} onChange={(e) => switchWeek(e.target.value)}>
          {data.editorWeeks.map((w) => (
            <option key={w.weekStart} value={w.weekStart}>
              {w.label}
              {w.isCurrent ? " (current)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="card space-y-1 p-0">
        {data.users.length === 0 && <p className="p-5 text-sm text-(--text-muted)">No reps found — sync HighLevel first.</p>}
        {data.users.map((u) => {
          const val = draft[u.id] ?? "";
          return (
            <div key={u.id} className="flex items-center justify-between gap-4 border-b border-(--table-border-weak) px-5 py-2.5 last:border-0">
              <span className="text-[13px] font-medium text-(--text-body)">{u.name}</span>
              <div className="flex items-center gap-3">
                {val.trim() === "" ? (
                  <span className="text-xs font-medium uppercase tracking-wide text-(--banner-fg)">team share ≈ {teamShare != null ? (Math.round(teamShare * 100) / 100).toFixed(2) : "—"}</span>
                ) : (
                  <span className="text-xs text-(--text-muted)">own goal</span>
                )}
                <input
                  type="number"
                  placeholder="team share"
                  className="w-24 rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-right text-[13px] outline-none focus:border-(--input-focus-border)"
                  value={val}
                  onChange={(e) => setDraft({ ...draft, [u.id]: e.target.value })}
                />
              </div>
            </div>
          );
        })}
        <div className="flex justify-end px-5 py-3">
          <button
            className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50"
            disabled={busy || data.users.length === 0}
            onClick={() => onSave(week, data.users.map((u) => ({ repId: u.id, goal: (draft[u.id] ?? "").trim() === "" ? null : Number(draft[u.id]) })))}
          >
            Save rep goals
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= 2 — rep start dates (call_start_date) ================= */

function RepStartDatesSection({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (entries: { repId: string; date: string | null }[]) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.users.map((u) => [u.id, u.call_start_date ?? ""])),
  );
  const dirty = data.users.some((u) => (draft[u.id] ?? "") !== (u.call_start_date ?? ""));
  return (
    <div className="space-y-3">
      <div>
        <h3 className="section-heading">Rep Start Dates</h3>
        <p className="mt-1 text-[13px] text-(--text-caption)">
          A rep with a future start date stays visible in the roster as <b>Not Yet Active</b>: zero calls expected, no
          coaching flags, no zero-activity alerts, no negative messaging. Normal performance monitoring begins ON the
          start date. Clear a date to monitor the rep from whenever their records begin.
        </p>
      </div>
      <div className="card space-y-1 p-0">
        {data.users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-4 border-b border-(--table-border-weak) px-5 py-2.5 last:border-0">
            <span className="text-[13px] font-medium text-(--text-body)">{u.name}</span>
            <input
              type="date"
              aria-label={`Call start date for ${u.name}`}
              className="rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-[13px]"
              value={draft[u.id] ?? ""}
              onChange={(e) => setDraft({ ...draft, [u.id]: e.target.value })}
            />
          </div>
        ))}
        <div className="flex justify-end px-5 py-3">
          <button
            className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50"
            disabled={busy || !dirty}
            onClick={() => onSave(data.users.map((u) => ({ repId: u.id, date: (draft[u.id] ?? "").trim() === "" ? null : draft[u.id] })))}
          >
            Save rep start dates
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= 3 — operational rules ================= */

function CoreOpsCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (thresholdSeconds: number, windowHours: number) => void;
}) {
  const [threshold, setThreshold] = useState(String(data.settings.meaningful_call_threshold_seconds));
  const [windowHours, setWindowHours] = useState(String(data.settings.attribution_window_hours));
  return (
    <div className="card card-dense space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumberField label="Meaningful Call Threshold (seconds)" value={threshold} onChange={setThreshold} />
        <NumberField label="Booking Attribution Window (hours)" value={windowHours} onChange={setWindowHours} />
        <div>
          <span className="kpi-label flex items-center gap-1.5">
            Operational Time Zone
            <InfoTip tip="Fixed because work_date and reporting are stored in ET." label="Why the time zone is fixed" />
          </span>
          <p className="mt-1 text-sm font-medium text-(--text-primary)">{data.settings.timezone}</p>
        </div>
      </div>
      <div className="flex justify-end">
        <button className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50" disabled={busy} onClick={() => onSave(Number(threshold), Number(windowHours))}>
          Save operational settings
        </button>
      </div>
    </div>
  );
}

/* ================= 4 — acuity scope ================= */

function AcuityScopeCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (calendars: string[], types: string[]) => void;
}) {
  // The catalog comes from the (demo) adapter; once Acuity credentials arrive
  // this card lists the real calendars/types without UI changes.
  const [calendars, setCalendars] = useState<string[]>(data.settings.acuity.calendars_included);
  const [types, setTypes] = useState<string[]>(data.settings.acuity.types_included);
  const catalogCalendars: { id: string; name: string }[] = [
    { id: "Family Studio", name: "Family Studio" },
    { id: "Animalia Studio", name: "Animalia Studio" },
  ];
  const catalogTypes = [
    "Family Portrait Session",
    "Family Mini Session",
    "Holiday Family Session",
    "Animalia Signature Session",
    "Animalia Pet Portrait",
    "Animalia Companion Session",
  ];
  const toggle = (list: string[], v: string, set: (l: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="card card-dense space-y-4">
      <p className="text-xs text-(--text-muted)">
        Only selected calendars and types count toward CC reporting (demo catalog until Acuity connects).{" "}
        <span className="font-medium text-(--banner-fg)">Empty selection = everything counts.</span>
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <p className="kpi-label mb-1">Calendars</p>
          <div className="space-y-1">
            {catalogCalendars.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-[13px] text-(--text-body)">
                <input type="checkbox" checked={calendars.length === 0 || calendars.includes(c.id)} disabled={calendars.length === 0} onChange={() => toggle(calendars, c.id, setCalendars)} />
                {c.name}
              </label>
            ))}
            {calendars.length === 0 && <p className="text-xs text-(--banner-fg)">No calendars selected — all are included.</p>}
          </div>
        </div>
        <div>
          <p className="kpi-label mb-1">Appointment types</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {catalogTypes.map((t) => (
              <label key={t} className="flex items-center gap-2 text-[13px] text-(--text-body)">
                <input type="checkbox" checked={types.length === 0 || types.includes(t)} disabled={types.length === 0} onChange={() => toggle(types, t, setTypes)} />
                <span className="truncate">{t}</span>
              </label>
            ))}
          </div>
          {types.length === 0 && <p className="text-xs text-(--banner-fg)">No types selected — all are included.</p>}
        </div>
      </div>
      <div className="flex justify-end">
        <button className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50" disabled={busy} onClick={() => onSave(calendars, types)}>
          Save Acuity scope
        </button>
      </div>
    </div>
  );
}

/* ================= 4 — studio ================= */

/**
 * TWO-BLOCK DAILY SCHEDULE (owner directive 2026-09-27): every weekday carries
 * a morning AND an afternoon hour-block, each with its own active toggle. The
 * stored shape stays a flat AvailabilityRule[] (the engine runs EVERY active
 * rule for the weekday); the editor pairs the two blocks per weekday —
 * canonical order weekday asc, morning (earlier open) first. Blocks missing
 * from a legacy single-rule config appear inactive with the owner's canonical
 * times prefilled — nothing is activated without the owner's toggle.
 */
interface StudioBlockVM {
  active: boolean;
  open: string;
  close: string;
}

const STUDIO_DEFAULT_MORNING = { open: "09:00", close: "13:00" };
const STUDIO_DEFAULT_AFTERNOON = { open: "13:30", close: "18:30" };

function studioHoursToTwoBlockDays(
  stored: { weekday: number; open_time: string; close_time: string; active: boolean }[],
): StudioBlockVM[][] {
  const byDay = new Map<number, { open: string; close: string; active: boolean }[]>();
  for (const r of stored) {
    const list = byDay.get(r.weekday) ?? [];
    list.push({ open: r.open_time, close: r.close_time, active: r.active });
    byDay.set(r.weekday, list);
  }
  return Array.from({ length: 7 }, (_, wd) => {
    const list = (byDay.get(wd) ?? []).sort((a, b) => a.open.localeCompare(b.open));
    const morning = list[0];
    const afternoon = list[1];
    return [
      {
        active: morning?.active ?? false,
        open: morning?.open ?? STUDIO_DEFAULT_MORNING.open,
        close: morning?.close ?? STUDIO_DEFAULT_MORNING.close,
      },
      {
        active: afternoon?.active ?? false,
        open: afternoon?.open ?? STUDIO_DEFAULT_AFTERNOON.open,
        close: afternoon?.close ?? STUDIO_DEFAULT_AFTERNOON.close,
      },
    ];
  });
}

function studioTwoBlockDaysToHours(days: StudioBlockVM[][]): { weekday: number; open_time: string; close_time: string; active: boolean }[] {
  return days.flatMap((blocks, wd) =>
    blocks.map((b) => ({ weekday: wd, open_time: b.open, close_time: b.close, active: b.active })),
  );
}

function StudioRulesCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (payload: { durationMin?: number; slotIntervalMin?: number; paddingMin?: number; hours?: { weekday: number; open_time: string; close_time: string; active: boolean }[] }) => void;
}) {
  const [duration, setDuration] = useState(String(data.settings.studio.appointment_duration_min));
  const [interval, setIntervalMin] = useState(String(data.settings.studio.slot_interval_min));
  const [padding, setPadding] = useState(String(data.settings.studio.padding_min));
  const [days, setDays] = useState<StudioBlockVM[][]>(() => studioHoursToTwoBlockDays(data.settings.studio.hours));
  const activeCount = days.flat().filter((b) => b.active).length;
  return (
    <div className="card card-dense space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Duration (min)" value={duration} onChange={setDuration} />
        <NumberField label="Slot interval (min)" value={interval} onChange={setIntervalMin} />
        <NumberField label="Padding (min)" value={padding} onChange={setPadding} />
      </div>
      <div className="space-y-1 border-t border-(--table-border-weak) pt-3">
        {/* Column legend only where the three columns actually fit (sm+); on
            phones each day stacks vertically with per-block labels. */}
        <div className="hidden items-center gap-2 text-xs font-medium uppercase tracking-wide text-(--text-faint) sm:flex">
          <span className="w-20 shrink-0">Day</span>
          <span className="w-58 shrink-0">Morning block</span>
          <span className="w-58 shrink-0">Afternoon block</span>
        </div>
        {days.map((blocks, wd) => (
          <div key={wd} className="flex flex-col gap-2 border-b border-(--table-border-weak) py-2 last:border-0 text-[13px] sm:flex-row sm:items-center sm:gap-2 sm:border-0 sm:py-0">
            <span className="w-20 shrink-0 font-medium text-(--text-body)">{WEEKDAYS[wd]}</span>
            <StudioBlockEditor day={WEEKDAYS[wd]} which="Morning" block={blocks[0]} onChange={(b) => setDays(days.map((x, j) => (j === wd ? [b, x[1]] : x)))} />
            <StudioBlockEditor day={WEEKDAYS[wd]} which="Afternoon" block={blocks[1]} onChange={(b) => setDays(days.map((x, j) => (j === wd ? [x[0], b] : x)))} />
          </div>
        ))}
        <p className="pt-1 text-xs text-(--text-muted)">
          Each active block contributes its own hourly slots; {activeCount} active block{activeCount === 1 ? "" : "s"} across the week.
        </p>
      </div>
      <div className="flex justify-end border-t border-(--table-border-weak) pt-3">
        <button className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50" disabled={busy} onClick={() => onSave({ durationMin: Number(duration), slotIntervalMin: Number(interval), paddingMin: Number(padding), hours: studioTwoBlockDaysToHours(days) })}>
          Save studio rules
        </button>
      </div>
    </div>
  );
}

function StudioBlockEditor({ day, which, block, onChange }: {
  day: string;
  which: "Morning" | "Afternoon";
  block: StudioBlockVM;
  onChange: (b: StudioBlockVM) => void;
}) {
  return (
    <span className="flex w-full items-center gap-1.5 sm:w-58 sm:shrink-0">
      <span className="w-[74px] shrink-0 text-xs font-medium uppercase tracking-wide text-(--text-muted) sm:hidden">
        {which}
      </span>
      <input
        type="checkbox"
        aria-label={`${which} block active on ${day}`}
        checked={block.active}
        onChange={(e) => onChange({ ...block, active: e.target.checked })}
      />
      <input
        type="time"
        aria-label={`${which} open time on ${day}`}
        className="min-w-0 flex-1 rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-[13px] disabled:opacity-50 sm:flex-none"
        value={block.open}
        disabled={!block.active}
        onChange={(e) => onChange({ ...block, open: e.target.value })}
      />
      <span className="shrink-0 text-(--text-muted)">–</span>
      <input
        type="time"
        aria-label={`${which} close time on ${day}`}
        className="min-w-0 flex-1 rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-[13px] disabled:opacity-50 sm:flex-none"
        value={block.close}
        disabled={!block.active}
        onChange={(e) => onChange({ ...block, close: e.target.value })}
      />
    </span>
  );
}

function RecurringBlocksCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (blocks: { id: string; weekday: number; start_time: string; end_time: string; reason: string | null; active: boolean }[]) => void;
}) {
  const [blocks, setBlocks] = useState(data.settings.studio.recurring_blocks.map((b) => ({ ...b })));
  return (
    <div className="space-y-3">
      <p className="text-xs text-(--text-muted)">Repeat every week on the chosen weekday — e.g. a standing lunch block. Feeds the same open-slot engine as one-off blocks.</p>
      {blocks.map((b, i) => (
        <div key={b.id} className="flex flex-wrap items-center gap-2 text-[13px]">
          <select className="rounded-lg border border-(--input-border) px-2 py-1" value={b.weekday} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}>
            {WEEKDAYS.map((d, wd) => (
              <option key={d} value={wd}>
                {d}
              </option>
            ))}
          </select>
          <input type="time" className="rounded-lg border border-(--input-border) px-2 py-1" value={b.start_time} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)))} />
          <span className="text-(--text-muted)">–</span>
          <input type="time" className="rounded-lg border border-(--input-border) px-2 py-1" value={b.end_time} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)))} />
          <input type="text" placeholder="Reason" className="w-36 rounded-lg border border-(--input-border) px-2 py-1" value={b.reason ?? ""} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} />
          <label className="flex items-center gap-1 text-(--chip-neutral-fg)">
            <input type="checkbox" checked={b.active} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))} />
            active
          </label>
          <button className="text-xs text-(--neg-text) hover:underline" onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}>
            remove
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button className="rounded-lg border border-(--input-border) px-3 py-1.5 text-xs font-medium text-(--text-body) hover:bg-(--surface-subtle)" onClick={() => setBlocks([...blocks, { id: `rb-${Date.now()}`, weekday: 5, start_time: "12:00", end_time: "13:00", reason: "", active: true }])}>
          Add block
        </button>
        <button className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50" disabled={busy} onClick={() => onSave(blocks)}>
          Save recurring blocks
        </button>
      </div>
    </div>
  );
}

function BlockedTimesCard({ data, busy, onAdd, onRemove }: {
  data: SettingsData;
  busy: boolean;
  onAdd: (payload: { date: string; startHHMM: string; endHHMM: string; reason?: string }) => void;
  onRemove: (id: string, label: string) => void;
}) {
  const [date, setDate] = useState(data.today);
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("13:00");
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-xs text-(--text-muted)">Concrete availability blocks (manual corrections or imported). Removing one also writes the audit trail.</p>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <input type="date" className="rounded-lg border border-(--input-border) px-2 py-1" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" className="rounded-lg border border-(--input-border) px-2 py-1" value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="text-(--text-muted)">–</span>
        <input type="time" className="rounded-lg border border-(--input-border) px-2 py-1" value={end} onChange={(e) => setEnd(e.target.value)} />
        <input type="text" placeholder="Reason" className="w-40 rounded-lg border border-(--input-border) px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="rounded-lg bg-(--accent-solid) px-3 py-1.5 text-xs font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50" disabled={busy} onClick={() => onAdd({ date, startHHMM: start, endHHMM: end, reason })}>
          Add block
        </button>
      </div>
      <div className="space-y-1">
        {data.blockedTimes.length === 0 && <p className="text-xs text-(--text-muted)">No blocked times in the next 30 days.</p>}
        {data.blockedTimes.map((b) => (
          <div key={b.id} className="flex items-center justify-between gap-3 border-b border-(--table-border-weak) pb-1 text-[13px] last:border-0">
            <span>
              {new Date(b.start_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} –{" "}
              {new Date(b.end_at).toLocaleTimeString("en-US", { timeStyle: "short" })}
              {b.reason ? <span className="ml-2 text-(--text-muted)">{b.reason}</span> : null}
            </span>
            <button className="text-xs text-(--neg-text) hover:underline disabled:opacity-50" disabled={busy} onClick={() => onRemove(b.id, `${new Date(b.start_at).toLocaleString("en-US")}${b.reason ? ` (${b.reason})` : ""}`)}>
              remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= 5 — sheet mapping ================= */

function SheetMappingCard({ sheet, columns, mode: initialMode, sheetId, busy, onSave }: {
  sheet: "family" | "animalia";
  columns: Record<string, string>;
  mode: SheetMappingMode;
  sheetId: string;
  busy: boolean;
  onSave: (columns: Record<string, string>, mode: SheetMappingMode) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({ ...columns });
  const [mode, setMode] = useState<SheetMappingMode>(initialMode);
  const [test, setTest] = useState<{
    sample: { header: string[]; rows: string[][]; tab?: string; notice?: string | null };
    result: { parsed: Record<string, string | null>; warnings: string[] };
    workDate: string | null;
    sourceDate: string | null;
    source: "live" | "demo-fallback";
    liveError: string | null;
    mode: SheetMappingMode;
  } | null>(null);
  const fields = mode === "row_per_day_count" ? SHEET_FIELDS_DAY : SHEET_FIELDS_LEAD;
  // The out-of-the-box mapping for the current shape — shown so the default is
  // discoverable without digging through code (owner-corrected: date = Q).
  const defaultColumns = mode === "row_per_day_count" ? DEFAULT_COLUMN_MAPPING_DAY_COUNT : DEFAULT_COLUMN_MAPPING;
  const defaultNote = fields
    .map((f) => `${f.label.replace(" (optional)", "")} ${defaultColumns[f.key] ?? "—"}`)
    .join(" · ");
  return (
    <div className="card card-dense space-y-3">
      <div>
        <p className="section-title">{sheet === "family" ? "Family sheet" : "Animalia sheet"}</p>
        <p className="mt-1 truncate text-xs text-(--text-muted)">Sheet ID {sheetId}</p>
        <p className="mt-0.5 text-xs text-(--text-muted)">
          Default mapping: {defaultNote} (editable below)
        </p>
      </div>
      <div className="space-y-1">
        <span className="kpi-label">Sheet shape</span>
        {SHEET_MODE_OPTIONS.map((m) => (
          <label key={m.value} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-(--surface-hover)">
            <input type="radio" name={`${sheet}-mode`} className="mt-0.5" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span className="text-[13px]">
              <span className="font-medium text-(--text-body)">{m.label}</span>
              <span className="block text-xs text-(--text-muted)">{m.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="kpi-label">{f.label}</span>
            <select className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1.5 text-[13px]" value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
              {COLUMN_LETTERS.map((l) => (
                <option key={l} value={l}>
                  Column {l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="rounded-lg border border-(--input-border) px-3 py-1.5 text-xs font-medium text-(--text-body) hover:bg-(--surface-subtle) disabled:opacity-50" disabled={busy} onClick={() => onSave(draft, mode)}>
          Save mapping
        </button>
        <button
          className="rounded-lg border border-(--input-border) px-3 py-1.5 text-xs font-medium text-(--text-body) hover:bg-(--surface-subtle) disabled:opacity-50"
          disabled={busy}
          onClick={async () => {
            const { testSheetMapping } = await import("~/server/queries");
            const res = await testSheetMapping({ data: { sheet, columns: draft, mode } });
            setTest(res as typeof test);
          }}
        >
          Test mapping (live)
        </button>
      </div>
      {test && (
        <div className="rounded-lg bg-(--surface-inset) p-3 text-xs text-(--chip-neutral-fg)">
          <p className="mb-1">
            <span className={"rounded-full px-2 py-0.5 text-xs font-medium " + (test.source === "live" ? "bg-(--chip-good-bg) text-(--chip-good-fg)" : "bg-(--chip-current-bg) text-(--chip-current-fg)")}>
              {test.source === "live" ? "live sample from Google Sheets" : "demo sample — Sheets API not reachable yet"}
            </span>
            {test.source === "live" && test.sample.tab ? <span className="ml-2 text-(--text-muted)">tab “{test.sample.tab}”</span> : null}
          </p>
          {test.liveError && <p className="mt-1 text-(--neg-text)">{test.liveError}</p>}
          {test.sample.notice && <p className="mt-1 text-(--banner-fg)">{test.sample.notice}</p>}
          <p className="kpi-label mt-2 mb-1">Sample row (header: {test.sample.header.join(" | ") || "—"})</p>
          <p className="mb-2 font-mono text-xs">{test.sample.rows[0]?.join("  |  ")}</p>
          <p className="kpi-label mb-1">Parsed ({test.mode === "row_per_day_count" ? "row-per-day + count" : "row-per-lead"})</p>
          <ul className="space-y-0.5">
            {Object.entries(test.result.parsed).map(([k, v]) => (
              <li key={k}>
                <span className="text-(--text-muted)">{k}:</span> <span className={v ? "font-medium text-(--text-body)" : "text-(--neg-text)"}>{v || "missing"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1">
            <span className="text-(--text-muted)">source_date (normalized):</span> <span className="font-medium text-(--text-body)">{test.sourceDate ?? "—"}</span>
            <span className="text-(--text-muted)"> · work_date:</span> <span className="font-medium text-(--text-body)">{test.workDate ?? "—"}</span>
          </p>
          {test.result.warnings.length > 0 && <p className="mt-1 text-(--banner-fg)">{test.result.warnings.join(" · ")}</p>}
        </div>
      )}
    </div>
  );
}

/* ================= 6 — sync center ================= */

function SyncCenter({ data, onSync }: { data: SettingsData; onSync: () => Promise<string> }) {
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-(--text-caption)">Background syncs are duplicate-safe; cancellations update in place. Google Sheets syncs live when its access is granted; HighLevel and Acuity run on demo adapters until their credentials arrive.</p>
        <button
          className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            setMsg(null);
            try {
              setMsg(await onSync());
            } catch (e) {
              setMsg(e instanceof Error ? e.message : "Sync failed");
            } finally {
              setSyncing(false);
            }
          }}
        >
          {syncing ? "Syncing…" : "SYNC NOW"}
        </button>
      </div>
      {msg && <p className="text-xs text-(--text-caption)">{msg}</p>}
      <div className="overflow-x-auto">
        <table className="data-table min-w-[760px]">
          <thead>
            <tr>
              <th className="text-left">Provider</th>
              <th className="text-left">Status</th>
              <th className="text-left">Last Sync</th>
              <th className="text-left">Last Successful</th>
              <th className="text-left">Sync Errors</th>
            </tr>
          </thead>
          <tbody>
            {data.connections.length === 0 && (
              <tr>
                <td colSpan={5} className="text-(--text-muted)">
                  No syncs recorded yet — press SYNC NOW.
                </td>
              </tr>
            )}
            {data.connections.map((c) => (
              <tr key={c.provider}>
                <td className="font-medium capitalize text-(--text-primary)">{c.provider.replace("_", " ")}</td>
                <td>
                  <span className={"rounded-full px-2 py-0.5 text-xs font-medium " + (c.is_demo ? "bg-(--chip-current-bg) text-(--chip-current-fg)" : c.status === "connected" ? "bg-(--chip-good-bg) text-(--chip-good-fg)" : c.status === "error" ? "bg-(--chip-bad-bg) text-(--chip-bad-fg)" : "bg-(--bar-track) text-(--chip-neutral-fg)")}>
                    {c.is_demo ? "demo" : c.status}
                  </span>
                </td>
                <td>{c.last_sync_at ? new Date(c.last_sync_at).toLocaleString("en-US") : "—"}</td>
                <td>{c.last_successful_sync_at ? new Date(c.last_successful_sync_at).toLocaleString("en-US") : "—"}</td>
                <td className="text-(--neg-text)">{c.last_error ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <p className="section-title mb-2">Recent sync runs</p>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th className="text-left">Provider</th>
                <th className="text-left">Status</th>
                <th className="text-left">Started</th>
                <th className="text-right">Records upserted</th>
                <th className="text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {data.syncRuns.map((r) => (
                <tr key={r.id}>
                  <td>{r.provider}</td>
                  <td className={r.status === "error" ? "text-(--neg-text)" : ""}>{r.status}</td>
                  <td>{new Date(r.started_at).toLocaleString("en-US")}</td>
                  <td className="text-right">{r.records_upserted}</td>
                  <td className="text-(--neg-text)">{r.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ================= 7 — roster mapping (owner rule: mapping drives eligibility) ================= */

function RosterMappingSection({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (mappings: { external_user_id: string; rep_id: string }[]) => void;
}) {
  // draft rep choice per non-roster HL user (prefilled with any existing mapping)
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.nonRosterUsers.filter((u) => u.mappedTo).map((u) => [u.externalId, u.mappedTo!])),
  );
  const currentByExternal = new Map(data.repMappings.map((m) => [m.external_user_id, m.rep_id]));
  // the payload to save: every current mapping kept (unless changed below) + new drafts
  const nextMappings = () => {
    const merged = new Map<string, string>();
    for (const m of data.repMappings) merged.set(m.external_user_id, m.rep_id);
    for (const [ext, repId] of Object.entries(draft)) {
      if (repId) merged.set(ext, repId);
      else merged.delete(ext);
    }
    return [...merged.entries()].map(([external_user_id, rep_id]) => ({ external_user_id, rep_id }));
  };
  const dirty = [...currentByExternal.entries()].some(([ext, rep]) => (draft[ext] ?? rep) !== rep) ||
    Object.entries(draft).some(([ext, rep]) => rep && !currentByExternal.has(ext));

  return (
    <div className="space-y-3">
      <h3 className="section-heading">Roster Mapping</h3>
      <p className="text-[13px] text-(--text-caption)">
        Map a non-roster HighLevel user to a CC rep. From then on ALL historical calls under that HighLevel user id
        count for the rep&apos;s performance and the team totals — computed from the mapping at query time. Source
        records are never rewritten: the original HL user id, message ids and timestamps stay untouched, and removing
        a mapping returns the calls to Non Roster.
      </p>
      <div className="card space-y-1 p-0">
        {data.nonRosterUsers.length === 0 && (
          <p className="p-5 text-sm text-(--text-muted)">No non-roster HighLevel users seen in calls yet.</p>
        )}
        {data.nonRosterUsers.map((u) => {
          const val = draft[u.externalId] ?? "";
          return (
            <div key={u.externalId} className="flex flex-wrap items-center justify-between gap-4 border-b border-(--table-border-weak) px-5 py-2.5 last:border-0">
              <span className="text-[13px] font-medium text-(--text-body)">
                {u.name || u.externalId}
                <span className="ml-2 font-mono text-xs text-(--text-muted)">{u.externalId}</span>
              </span>
              <div className="flex items-center gap-3">
                <span className="text-xs tabular-nums text-(--text-muted)">
                  {u.callCount > 0 ? `${u.callCount} calls in last 30 days` : "no calls in last 30 days"}
                </span>
                <select
                  aria-label={`Map ${u.name || u.externalId} to`}
                  className="rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-[13px]"
                  value={val}
                  onChange={(e) => setDraft({ ...draft, [u.externalId]: e.target.value })}
                >
                  <option value="">Non Roster (excluded)</option>
                  {data.users.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
        <div className="flex justify-end px-5 py-3">
          <button
            className="rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50"
            disabled={busy || !dirty}
            onClick={() => onSave(nextMappings())}
          >
            Save roster mappings
          </button>
        </div>
      </div>
      {data.repMappings.length > 0 && (
        <p className="text-xs text-(--text-muted)">
          Active mappings: {data.repMappings.map((m) => `${m.external_user_id} → ${data.users.find((u) => u.id === m.rep_id)?.name ?? m.rep_id}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

/* ================= 7 — unattributed queue + corrections ================= */

/** Owner vocabulary for the engine's unattributed reasons (never guessed here). */
const UNATTRIBUTED_REASON_LABELS: Record<string, string> = {
  "no-qualifying-call": "No qualifying call in window",
  "no-contact-identity": "No contact identity",
  ambiguous: "Unclear match — decide who",
  "bad-datetime": "Unreadable booking time",
  "manually-assigned": "Manually assigned",
};

function UnattributedRow({ row, users, busy, onAssign, onUnassign }: {
  row: { appointment_id: string; client_name: string | null; client_phone: string | null; client_email: string | null; appointment_type: string; calendar_name: string | null; appointment_datetime: string; created_at: string; reason: string | null; reason_code: string | null; suggested_rep_id: string | null; candidate_calls: { call_id: string; rep_id: string | null; started_at: string; duration_seconds: number }[] };
  users: { id: string; name: string }[];
  busy: boolean;
  onAssign: (appointmentId: string, repId: string, callId?: string | null) => void;
  onUnassign: (appointmentId: string) => void;
}) {
  const [repId, setRepId] = useState(row.suggested_rep_id ?? row.candidate_calls[0]?.rep_id ?? "");
  const [callId, setCallId] = useState(row.candidate_calls[0]?.call_id ?? "");
  // S4b: the refined no-rep category (reason_code) is the primary label — the
  // legacy coarse reason is the fallback for rows predating the classification.
  const reasonLabel = row.reason
    ? NO_REP_REASON_LABELS[row.reason_code ?? ""] ?? UNATTRIBUTED_REASON_LABELS[row.reason] ?? row.reason
    : "—";
  return (
    <tr>
      <td className="font-medium text-(--text-primary)">
        {row.client_name ?? "Unknown"}
        <span className="block text-xs font-normal text-(--text-muted)">{row.client_phone ?? ""}</span>
        <span className="block text-xs font-normal text-(--text-muted)">{row.client_email ?? ""}</span>
      </td>
      <td>
        {row.appointment_type}
        <span className="block text-xs text-(--text-muted)">{row.calendar_name ?? ""}</span>
      </td>
      <td>
        {new Date(row.appointment_datetime).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}
        <span className="block text-xs text-(--text-muted)">booked {new Date(row.created_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</span>
      </td>
      <td>
        <StatusChip kind={queueRowState(row.reason) === "ambiguous" ? "risk" : "neutral"} label={QUEUE_STATE_LABELS[queueRowState(row.reason)]} />
        <span className="mt-1 block text-[12px] text-(--chip-neutral-fg)" title={row.reason_code ?? row.reason ?? ""}>
          {reasonLabel}
        </span>
      </td>
      <td>{users.find((u) => u.id === row.suggested_rep_id)?.name ?? "—"}</td>
      <td>
        {row.candidate_calls.length > 0 ? (
          <select className="rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-[13px]" value={callId} onChange={(e) => setCallId(e.target.value)}>
            {row.candidate_calls.map((c) => (
              <option key={c.call_id} value={c.call_id}>
                {new Date(c.started_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })} · {Math.round(c.duration_seconds / 60)}m · {users.find((u) => u.id === c.rep_id)?.name ?? "non-roster"}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-(--text-muted)">—</span>
        )}
      </td>
      <td>
        <select className="rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1 text-[13px]" value={repId} onChange={(e) => setRepId(e.target.value)}>
          <option value="">Choose rep…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <div className="flex flex-col items-start gap-1.5">
          <button className="rounded-lg border border-(--input-border) px-3 py-1 text-xs font-medium text-(--text-body) hover:bg-(--surface-subtle) disabled:opacity-50" disabled={busy || !repId} onClick={() => onAssign(row.appointment_id, repId, callId || null)}>
            Assign
          </button>
          {unassignable(row.reason) && (
            <button className="text-xs text-(--neg-text) hover:underline disabled:opacity-50" disabled={busy} onClick={() => onUnassign(row.appointment_id)}>
              Unassign
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Mobile stacked decision card for the manual-assignment queue (md:hidden
 * twin of UnattributedRow). Same row data, same reason labels, same assign/
 * unassign handlers and controls — laid out vertically with full-width
 * selects so the decision is readable and tappable at 375px.
 */
function UnattributedCard({ row, users, busy, onAssign, onUnassign }: {
  row: { appointment_id: string; client_name: string | null; client_phone: string | null; client_email: string | null; appointment_type: string; calendar_name: string | null; appointment_datetime: string; created_at: string; reason: string | null; reason_code: string | null; suggested_rep_id: string | null; candidate_calls: { call_id: string; rep_id: string | null; started_at: string; duration_seconds: number }[] };
  users: { id: string; name: string }[];
  busy: boolean;
  onAssign: (appointmentId: string, repId: string, callId?: string | null) => void;
  onUnassign: (appointmentId: string) => void;
}) {
  const [repId, setRepId] = useState(row.suggested_rep_id ?? row.candidate_calls[0]?.rep_id ?? "");
  const [callId, setCallId] = useState(row.candidate_calls[0]?.call_id ?? "");
  const reasonLabel = row.reason
    ? NO_REP_REASON_LABELS[row.reason_code ?? ""] ?? UNATTRIBUTED_REASON_LABELS[row.reason] ?? row.reason
    : "—";
  return (
    <div className="rounded-lg border border-(--card-border) bg-(--card-bg) p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-(--text-primary)">{row.client_name ?? "Unknown"}</p>
          {(row.client_phone || row.client_email) && (
            <p className="mt-0.5 break-all text-xs text-(--text-muted)">
              {[row.client_phone, row.client_email].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <StatusChip kind={queueRowState(row.reason) === "ambiguous" ? "risk" : "neutral"} label={QUEUE_STATE_LABELS[queueRowState(row.reason)]} />
      </div>
      <p className="mt-2 text-[12px] text-(--chip-neutral-fg)">
        {row.appointment_type}
        {row.calendar_name ? ` · ${row.calendar_name}` : ""}
      </p>
      <p className="mt-0.5 text-[12px] tabular-nums text-(--text-caption)">
        {new Date(row.appointment_datetime).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}
        <span className="text-(--text-muted)"> · booked {new Date(row.created_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</span>
      </p>
      <p className="mt-1 text-[12px] text-(--chip-neutral-fg)" title={row.reason_code ?? row.reason ?? ""}>
        {reasonLabel}
      </p>
      <p className="mt-1 text-[12px] text-(--text-caption)">
        Suggested: <span className="font-medium text-(--text-body)">{users.find((u) => u.id === row.suggested_rep_id)?.name ?? "—"}</span>
      </p>
      {row.candidate_calls.length > 0 && (
        <label className="mt-3 block">
          <span className="kpi-label">Call</span>
          <select className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1.5 text-[13px]" value={callId} onChange={(e) => setCallId(e.target.value)}>
            {row.candidate_calls.map((c) => (
              <option key={c.call_id} value={c.call_id}>
                {new Date(c.started_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })} · {Math.round(c.duration_seconds / 60)}m · {users.find((u) => u.id === c.rep_id)?.name ?? "non-roster"}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="mt-2 block">
        <span className="kpi-label">Assign to</span>
        <select className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1.5 text-[13px]" value={repId} onChange={(e) => setRepId(e.target.value)}>
          <option value="">Choose rep…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button className="rounded-lg border border-(--input-border) px-4 py-1.5 text-xs font-medium text-(--text-body) hover:bg-(--surface-subtle) disabled:opacity-50" disabled={busy || !repId} onClick={() => onAssign(row.appointment_id, repId, callId || null)}>
          Assign
        </button>
        {unassignable(row.reason) && (
          <button className="text-xs text-(--neg-text) hover:underline disabled:opacity-50" disabled={busy} onClick={() => onUnassign(row.appointment_id)}>
            Unassign
          </button>
        )}
      </div>
    </div>
  );
}

function LeadWorkDateCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (leadId: string, workDate: string, previousWorkDate: string, reason?: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const [workDate, setWorkDate] = useState(data.today);
  const [reason, setReason] = useState("");
  const lead = data.recentLeads.find((l) => l.id === selected);
  return (
    <div className="card card-dense space-y-3">
      <p className="section-title">Correct a lead&apos;s work date</p>
      <select className="w-full rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1.5 text-[13px]" value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">Choose a lead (recent cohorts)…</option>
        {data.recentLeads.slice(0, 80).map((l) => (
          <option key={l.id} value={l.id}>
            {l.source_date} · {l.lead_type} · {l.source_sheet} (works {l.work_date})
          </option>
        ))}
      </select>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-(--text-caption)">Move to</span>
        <input type="date" className="rounded-lg border border-(--input-border) px-2 py-1" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        <input type="text" placeholder="Reason (optional)" className="w-full rounded-lg border border-(--input-border) px-2 py-1 sm:w-40" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button className="w-fit rounded-lg bg-(--accent-solid) px-4 py-2 text-sm font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50" disabled={busy || !selected || !lead} onClick={() => selected && lead && onSave(selected, workDate, lead.work_date, reason)}>
        Save work date
      </button>
      <p className="text-xs text-(--text-muted)">Operational reporting counts this lead under its work date (Mon folds Fri–Sun) — moving it moves every &quot;leads today&quot; number that includes it.</p>
    </div>
  );
}

function LeadCountCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (date: string, sheet: string, count: number, reason?: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = (d: string, s: string) => `${d}:${s}`;
  const currentWeekRows = data.observedCounts.filter((r) => r.observed > 0 || r.adjustedDelta != null);
  return (
    <div className="card card-dense space-y-3">
      <p className="section-title">Correct a day&apos;s lead count</p>
      {currentWeekRows.length === 0 && <p className="text-[13px] text-(--text-muted)">No leads observed this week yet.</p>}
      <div className="space-y-1">
        {currentWeekRows.map((r) => {
          const effective = r.observed + (r.adjustedDelta ?? 0);
          const val = drafts[key(r.date, r.sheet)] ?? String(effective);
          return (
            <div key={key(r.date, r.sheet)} className="flex items-center justify-between gap-2 border-b border-(--table-border-weak) pb-1 text-[13px] last:border-0">
              <span>
                {r.date} · <span className="capitalize">{r.sheet}</span>
                <span className="ml-2 text-xs text-(--text-muted)">
                  synced {r.observed}
                  {r.adjustedDelta ? ` ${r.adjustedDelta > 0 ? "+" : ""}${r.adjustedDelta}` : ""}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="w-20 rounded-lg border border-(--input-border) px-2 py-1 text-right text-[13px]"
                  value={val}
                  onChange={(e) => setDrafts({ ...drafts, [key(r.date, r.sheet)]: e.target.value })}
                />
                <button
                  className="rounded-lg border border-(--input-border) px-2 py-1 text-xs font-medium text-(--text-body) hover:bg-(--surface-subtle) disabled:opacity-50"
                  disabled={busy || Number(val) === effective}
                  onClick={() => onSave(r.date, r.sheet, Number(val), `corrected from ${effective}`)}
                >
                  Save
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-(--text-muted)">Adjustments are deltas vs the synced rows and flow through the metrics layer, so Today, Daily Report and Team agree.</p>
    </div>
  );
}

/* ================= shared field ================= */

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="kpi-label">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--input-bg) px-3 py-2 text-sm text-(--text-primary) outline-none focus:border-(--input-focus-border)"
      />
    </label>
  );
}

/**
 * Appearance (P5): System / Light / Dark via the existing Segmented control.
 * Prefers-color-scheme live-tracking happens inside useAppearance while
 * pref === "system"; manual modes unsubscribe. Writes localStorage
 * mallory-appearance and toggles the <html> class immediately — no reload.
 */
function AppearanceSection() {
  const { pref, setPref } = useAppearance();
  return (
    <div id="appearance" className="scroll-mt-28">
      <p className="kpi-label">Appearance</p>
      <div className="mt-2">
        <Segmented
          ariaLabel="Appearance"
          value={pref}
          onChange={setPref}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </div>
      <p className="mt-1.5 text-xs text-(--text-muted)">System / Uses your device appearance automatically.</p>
    </div>
  );
}
