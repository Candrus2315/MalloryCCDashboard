import { createFileRoute } from "@tanstack/react-router";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_SHEETS } from "../components/lead-sources";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  queueReasonBreakdown,
  sectionNumber,
  splitRowsByMarker,
  unattributedHiddenBannerLabel,
} from "~/components/settings-views";
import { bookingSplitLine } from "~/components/team-views";
import { InfoTip } from "~/components/InfoTip";
import { Panel } from "~/components/page-panel";
import { formatInt } from "~/server/metrics/report-text";
import { DEFAULT_RETENTION_SETTINGS } from "~/server/store/types";
// Decomposition plan step 2: the settings section components moved verbatim to
// components/settings/ — this route keeps Route + composition + save handlers.
// RetentionRulesCard stays here: retention-settings.test.ts pins its owner
// rules' surface text to this route file.
import { AppearanceSection } from "~/components/settings/AppearanceSection";
import { SubNav } from "~/components/settings/SubNav";
import { SectionHeader } from "~/components/settings/SectionHeader";
import { SecuritySection } from "~/components/settings/SecuritySection";
import { WeekGoalRow } from "~/components/settings/WeekGoalRow";
import { MonthlyGoalsSection } from "~/components/settings/MonthlyGoalsSection";
import { RepGoalsSection } from "~/components/settings/RepGoalsSection";
import { RepStartDatesSection } from "~/components/settings/RepStartDatesSection";
import { CoreOpsCard } from "~/components/settings/CoreOpsCard";
import { AcuityScopeCard } from "~/components/settings/AcuityScopeCard";
import { StudioRulesCard } from "~/components/settings/StudioRulesCard";
import { RecurringBlocksCard } from "~/components/settings/RecurringBlocksCard";
import { BlockedTimesCard } from "~/components/settings/BlockedTimesCard";
import { SheetMappingCard } from "~/components/settings/SheetMappingCard";
import { SyncCenter } from "~/components/settings/SyncCenter";
import { RosterMappingSection } from "~/components/settings/RosterMappingSection";
import { UnattributedCard, UnattributedRow, EvidenceCreditedCard, EvidenceCreditedRow } from "~/components/settings/UnattributedQueueRows";
import { LeadWorkDateCard } from "~/components/settings/LeadWorkDateCard";
import { LeadCountCard } from "~/components/settings/LeadCountCard";
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
  saveRetentionSettings,
  saveSettings,
  saveSheetMapping,
  saveStudioRules,
  saveWeekGoal,
  setLeadCount,
  setLeadWorkDate,
  setUnattributedQueueDismissal,
  syncNow,
  designateOnlineBooking,
  unassignAttribution,
} from "~/server/queries";

export const Route = createFileRoute("/settings")({
  loader: () => getSettingsData(),
  component: SettingsPage,
});

export type SettingsData = ReturnType<typeof Route.useLoaderData>;

function SettingsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Unattributed-queue declutter (owner request 2026-10-21): Show-all is a
  // CLIENT-LOCAL toggle (like the Roster Mapping show-all) — the server always
  // sends the full queue; the marker alone decides the default view.
  const [queueShowAll, setQueueShowAll] = useState(false);

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

  // UNATTRIBUTED QUEUE DECLUTTER (owner request 2026-10-21): the persisted
  // marker splits the queue's DISPLAY only. The payload always carries every
  // row; queueReasonBreakdown below keeps reading ALL rows (truthful backlog —
  // never the filtered view). Show all is the client-local escape hatch; Undo
  // resets the persisted marker via the audited server action.
  const queueMarker = data.unattributedQueueDismissedBefore ?? null;
  const queueSplit = splitRowsByMarker(data.unattributed, queueMarker);
  const queueRows = (queueShowAll ? data.unattributed : queueSplit.visible).slice(0, 12);

  return (
    <div className="space-y-4">
      {/* header — wave-2 anatomy: title on line 1, the scope line as meta beneath */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-(--text-primary)">Settings</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-(--text-muted)">
            <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
            <span>Manage goals, rules, integrations, sync health, and manual corrections — every change persists and is audited.</span>
          </p>
        </div>
      </header>

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

      {/* 2 — Goals (spec §2: weekly grid + rep goals + rep start dates).
          Mobile Phase 3a (P1-16): on phones each numbered section collapses
          into an accordion — the input/label/body wrappers are desktop-inert
          (rules live in the max-width:767px app.css block); Goals (02) is the
          first numbered section and ships open. */}
      <section id="goals" className="scroll-mt-28">
        <Panel className="p-5 sm:p-6 m-acc">
          <input type="checkbox" id="macc-goals" className="m-acc-input" defaultChecked />
          <label htmlFor="macc-goals" className="m-acc-head">
            <SectionHeader id="goals" />
          </label>
          <div className="mt-5 space-y-6 m-acc-body">
            <div className="space-y-3">
              <h3 className="section-heading">Weekly Booking Goal &amp; Lead Budget</h3>
              <p className="text-[13px] text-(--text-caption)">Edit any week — past weeks keep history, future weeks are the plan. Changes are audited.</p>
              <div className="overflow-x-auto scroll-x">
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
          </div>
        </Panel>
      </section>

      {/* 3 — Operational Rules (spec §3: compact, feel important) */}
      <section id="rules" className="scroll-mt-28">
        <Panel className="p-5 sm:p-6 m-acc">
          <input type="checkbox" id="macc-rules" className="m-acc-input" />
          <label htmlFor="macc-rules" className="m-acc-head">
            <SectionHeader id="rules" />
          </label>
          <div className="mt-4 m-acc-body">
            <CoreOpsCard data={data} busy={busy} onSave={(thresholdSeconds, windowHours) => run("Operational settings saved", () => saveSettings({ data: { thresholdSeconds, windowHours } }))} />
          </div>
        </Panel>
      </section>

      {/* 4 — Retention Rules (owner build-order item after transfers): the
          data-start display boundary + the excitement-call window, saved
          through the audited settings path (manual_overrides). DISPLAY-SCOPE
          ONLY — a change never rewrites stored retention history. */}
      <section id="retention" className="scroll-mt-28">
        <Panel className="p-5 sm:p-6 m-acc">
          <input type="checkbox" id="macc-retention" className="m-acc-input" />
          <label htmlFor="macc-retention" className="m-acc-head">
            <SectionHeader id="retention" />
          </label>
          <div className="mt-4 m-acc-body">
            <RetentionRulesCard data={data} busy={busy} onSave={(dataStartWeekStart, excitementDays) => run("Retention rules saved", () => saveRetentionSettings({ data: { dataStartWeekStart, excitementDays } }))} />
          </div>
        </Panel>
      </section>
      {/* 5 — Acuity scope + availability rules (spec §4, one major section) */}
      <section id="acuity" className="scroll-mt-28">
        <Panel className="p-5 sm:p-6 m-acc">
          <input type="checkbox" id="macc-acuity" className="m-acc-input" />
          <label htmlFor="macc-acuity" className="m-acc-head">
            <SectionHeader id="acuity" />
          </label>
          <div className="mt-5 space-y-6 m-acc-body">
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
          </div>
        </Panel>
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
              <span className="mt-0.5 block text-[13px] text-(--text-caption)">Where the seven lead-source sheets (Family · Animalia · Fairyland + the four Forms Data workbook tabs) come from and how each column is read.</span>
            </span>
          </span>
          <span className="flex items-center gap-3">
            <span className="hidden text-xs text-(--text-muted) sm:inline">{LEAD_SOURCE_SHEETS.map((s) => `${LEAD_SOURCE_LABELS[s]} ${data.settings.sheets[s].mode === "row_per_lead" ? "row-per-lead" : "day+count"}`).join(" · ")}</span>
            <span className="text-(--text-muted) transition-transform group-open:rotate-180" aria-hidden="true">
              ▾
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-(--table-border-weak) p-5">
          <p className="text-[13px] text-(--text-caption)">Which columns of each of the seven lead-source sheets hold each field, and whether each row is a day+count or a single lead. The four Forms Data workbook tabs (Auction certificates · Google Ads leads · Alliance certificates · Website applications) each count as an INDEPENDENT source — the same person in two tabs counts in each. Test mapping fetches a REAL sample row from Google Sheets and parses it with the same code a live sync uses.</p>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {LEAD_SOURCE_SHEETS.map((sheet) => (
              <SheetMappingCard key={sheet} sheet={sheet} columns={data.settings.sheets[sheet].columns} mode={data.settings.sheets[sheet].mode} sheetId={data.settings.sheets[sheet].sheet_id} busy={busy} onSave={(columns, mode) => run(`${LEAD_SOURCE_LABELS[sheet]} mapping saved`, () => saveSheetMapping({ data: { sheet, columns, mode } }))} />
            ))}
          </div>
        </div>
      </details>

      {/* 6 — Sync Center (spec: operations panel, default expanded). Accordion
          wrapper (P1-16) — desktop-inert, see the Goals section note. */}
      <section id="sync" className="scroll-mt-28">
        <Panel className="p-5 sm:p-6 m-acc">
          <input type="checkbox" id="macc-sync" className="m-acc-input" />
          <label htmlFor="macc-sync" className="m-acc-head">
            <SectionHeader id="sync" />
          </label>
          <div className="mt-4 m-acc-body">
            <SyncCenter data={data} onSync={async () => {
              const res = await syncNow();
              await router.invalidate();
              return `Sync complete (${res.mode}): ${res.providers.map((p) => `${p.provider} ${p.count}`).join(", ")}`;
            }} />
          </div>
        </Panel>
      </section>

      {/* 7 — Manual overrides & roster (spec §7; roster mapping = ownership correction) */}
      <section id="overrides" className="scroll-mt-28">
        <Panel className="p-5 sm:p-6 m-acc">
          <input type="checkbox" id="macc-overrides" className="m-acc-input" />
          <label htmlFor="macc-overrides" className="m-acc-head">
            <SectionHeader id="overrides" />
          </label>
          <div className="m-acc-body">
          <p className="mt-3 text-[13px] text-(--text-caption)">Corrections Christopher makes by hand — every one is written to the audit trail below with previous value, new value, who and when.</p>
          <div className="mt-5 space-y-6">
            {/* (a) Roster mapping — eligibility correction, folded in as the first subsection */}
            <RosterMappingSection data={data} busy={busy} onSave={(mappings) => run("Roster mappings saved", () => saveRepMappings({ data: { mappings } }))} />
        {/* (b) Manual-assignment queue — THREE-WAY ATTRIBUTION SPLIT (owner
            directive 2026-09-27, S5b): the split line shows the three mutually
            exclusive states over the in-scope bookings; Ambiguous is its OWN
            state, never folded into Unattributed. The queue itself (assign /
            unassign) behaves exactly as before. */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h3 className="section-heading">Unattributed Bookings</h3>
            {/* Owner request 2026-10-21 — the declutter affordance: hide the
                backlog so only NEW arrivals show. Persisted marker (display
                layer only — nothing is deleted), audited like every action on
                this page. Hidden once a marker exists; the banner's Undo below
                is the reset. */}
            {data.unattributed.length > 0 && !queueMarker && (
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={busy}
                data-testid="queue-clear-old"
                onClick={() => run("Older entries hidden — every new booking will still appear here", () => setUnattributedQueueDismissal({ data: { dismissed: true } }))}
              >
                Clear old entries
              </button>
            )}
          </div>
          <div className="card card-nest space-y-2">
            <p className="kpi-label" data-testid="booking-attribution-split">
              {bookingSplitLine(data.attributionSplit)}
              <span className="text-(--text-muted)"> · {formatInt(data.attributionSplit.total)} in-scope bookings</span>
            </p>
            <p className="text-[12px] text-(--text-muted)">
              {formatInt(data.unattributed.length)} booking{data.unattributed.length === 1 ? "" : "s"} need a manual decision — Ambiguous stays Ambiguous until assigned by hand.
            </p>
            {/* S4b: grouped count summary — one bucket per honest no-rep
                category (booking_attributions.reason_code), Ambiguous shown as
                its own identity-conflict group, never folded in. Counts ALL
                rows — the declutter never filters the truth, only the list. */}
            {data.unattributed.length > 0 && (
              <p className="kpi-label" data-testid="queue-reason-breakdown">
                {queueReasonBreakdown(data.unattributed)
                  .map((b) => `${b.label}: ${formatInt(b.count)}`)
                  .join(" · ")}
              </p>
            )}
            {/* Collapsed history (marker set + at least one old row): the
                one-line banner. Show all / Hide is CLIENT-LOCAL (the server
                payload is always full); Undo clears the persisted marker. */}
            {queueSplit.collapsed && queueMarker && (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-lg border border-(--card-border) bg-(--surface-hover) px-3 py-2 text-[12px] text-(--text-muted)" data-testid="queue-cleared-banner">
                <span>
                  {unattributedHiddenBannerLabel(queueSplit.hiddenCount, queueMarker)} — the counts above still include everything; nothing is deleted.
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <button type="button" className="text-(--text-primary) underline underline-offset-2" data-testid="queue-show-all" onClick={() => setQueueShowAll((v) => !v)}>
                    {queueShowAll ? "Hide" : "Show all"}
                  </button>
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-(--text-primary)"
                    disabled={busy}
                    data-testid="queue-undo-clear"
                    onClick={() => run("Older entries restored to the queue", () => setUnattributedQueueDismissal({ data: { dismissed: false } }))}
                  >
                    Undo
                  </button>
                </span>
              </div>
            )}
            {data.unattributed.length === 0 ? (
              <p className="text-[13px] text-(--text-muted)">Every active booking is attributed.</p>
            ) : queueRows.length === 0 ? (
              // Marker set and every entry is old: the banner above names the
              // count — this line keeps the empty list honest instead of
              // silently rendering nothing.
              <p className="text-[13px] text-(--text-muted)">No new arrivals yet — new bookings appear here as they come in.</p>
            ) : (
              <>
                {/* Phones: one decision card per booking — the 8-column table
                    is unreadable at 375px, so every field and control stacks
                    full-width with the same wording and the same handlers. */}
                <div className="space-y-3 md:hidden">
                  {queueRows.map((u) => (
                    <UnattributedCard key={u.appointment_id} row={u} users={data.users} busy={busy} onAssign={(appointmentId, repId, callId) => run("Booking attributed", () => assignAttribution({ data: { appointmentId, repId, callId } }))} onUnassign={(appointmentId) => run("Booking unassigned — returns to engine attribution", () => unassignAttribution({ data: { appointmentId } }))} onDesignate={(appointmentId) => run("Booking designated as Online Booking — team-only credit; it leaves the queue", () => designateOnlineBooking({ data: { appointmentId } }))} />
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
                      {queueRows.map((u) => (
                        <UnattributedRow key={u.appointment_id} row={u} users={data.users} busy={busy} onAssign={(appointmentId, repId, callId) => run("Booking attributed", () => assignAttribution({ data: { appointmentId, repId, callId } }))} onUnassign={(appointmentId) => run("Booking unassigned — returns to engine attribution", () => unassignAttribution({ data: { appointmentId } }))} onDesignate={(appointmentId) => run("Booking designated as Online Booking — team-only credit; it leaves the queue", () => designateOnlineBooking({ data: { appointmentId } }))} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
        {/* (b2) EVIDENCE-CREDITED — SUPERSEDE (owner directive 2026-11-04, the
            Laurie Hendricks follow-up): a second designation surface UNDER the
            unattributed queue. Paid wins whose CURRENT attribution is an
            evidence-tier rep credit (window_interaction et al., not manual, not
            owner-rule) — bookings the designation control may now supersede.
            The row names the credited rep + method/confidence so the owner sees
            exactly what they replace; confirm explains the undo path. Only
            rendered when such rows exist. */}
        {data.evidenceCredited.length > 0 && (
          <div className="space-y-3">
            <h3 className="section-heading">Evidence-credited — designate Online Booking</h3>
            <div className="card card-nest space-y-2">
              <p className="text-[12px] text-(--text-muted)">
                {formatInt(data.evidenceCredited.length)} booking{data.evidenceCredited.length === 1 ? "" : "s"} credited to a rep by interaction evidence only — designating marks the booking client-created (team-only) and supersedes that credit, audited.
              </p>
              <div className="space-y-3 md:hidden">
                {data.evidenceCredited.map((r) => (
                  <EvidenceCreditedCard key={r.appointment_id} row={r} busy={busy} onDesignate={(appointmentId) => run("Booking designated as Online Booking — the evidence credit was superseded (audited)", () => designateOnlineBooking({ data: { appointmentId } }))} />
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="data-table min-w-[760px]">
                  <thead>
                    <tr>
                      <th className="text-left">Client</th>
                      <th className="text-left">Type</th>
                      <th className="text-left">Session</th>
                      <th className="text-left">Credited to</th>
                      <th className="text-left"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.evidenceCredited.map((r) => (
                      <EvidenceCreditedRow key={r.appointment_id} row={r} busy={busy} onDesignate={(appointmentId) => run("Booking designated as Online Booking — the evidence credit was superseded (audited)", () => designateOnlineBooking({ data: { appointmentId } }))} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        {/* (c) Lead corrections */}
        <div className="space-y-3">
          <h3 className="section-heading">Corrections</h3>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <LeadWorkDateCard data={data} busy={busy} onSave={(leadId, workDate, previousWorkDate, reason) => run("Lead work date corrected", () => setLeadWorkDate({ data: { leadId, workDate, previousWorkDate, reason } }))} />
            <LeadCountCard data={data} busy={busy} onSave={(date, sheet, count, reason) => run("Lead count corrected", () => setLeadCount({ data: { date, sheet, count, reason } }))} />
          </div>
        </div>
          </div>
          </div>
        </Panel>
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

/* ================= section scaffolding (composition-local) ================= */

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

/* ================= retention rules ================= */
function RetentionRulesCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (dataStartWeekStart: string, excitementDays: number) => void;
}) {
  // Defaults hold when the settings row predates the field (the store
  // normalizes on read — this fallback is belt-and-braces, never a guess).
  const retention = data.settings.retention ?? DEFAULT_RETENTION_SETTINGS;
  const [dataStart, setDataStart] = useState(String(retention.data_start_week_start));
  const [days, setDays] = useState(String(retention.due_days));
  // Client-side mirror of the server validation (the server re-validates —
  // the store is the honest gate; this only disables the button early).
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(dataStart.trim()) && Number.isFinite(Date.parse(dataStart.trim()));
  const daysNum = Number(days);
  const daysOk = Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 60;
  return (
    <div className="card card-nest card-dense space-y-4">
      <p className="text-xs text-(--text-muted)">
        Owner rules for the Retention tab.{" "}
        <span className="font-medium text-(--banner-fg)">
          Changes affect the tab's display scope going forward — stored history is never rewritten.
        </span>
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <span className="kpi-label flex items-center gap-1.5">
            Data-start week
            <InfoTip tip="Nothing from before this week shows on the Retention tab (owner directive 10/21: data from the week of Mon Oct 12, 2026 ET onward). Pick any date in the intended week — it is saved as that week's Monday. Stored records stay untouched; only what the tab displays changes." label="What the data-start week controls" />
          </span>
          <input
            type="date"
            value={dataStart}
            onChange={(e) => setDataStart(e.target.value)}
            className="input-field mt-1 w-full"
            aria-label="Retention data-start week"
          />
          <p className="mt-1 text-xs text-(--text-muted)">Saved as that week's Monday — any date in the intended week.</p>
        </div>
        <div>
          <span className="kpi-label flex items-center gap-1.5">
            Excitement-call window (days)
            <InfoTip tip="An appointment's excitement call is due this many days before the session. Changing it re-scopes what the Retention tab reports as due from now on." label="What the excitement-call window controls" />
          </span>
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="input-field mt-1 w-full"
            aria-label="Excitement-call window in days"
          />
          <p className="mt-1 text-xs text-(--text-muted)">Whole number, 1–60 (current default 7).</p>
        </div>
      </div>
      {!dateOk && <p className="text-xs font-medium text-(--banner-fg)">Pick a valid date for the data-start week.</p>}
      {dateOk && !daysOk && <p className="text-xs font-medium text-(--banner-fg)">Excitement-call days must be a whole number between 1 and 60.</p>}
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy || !dateOk || !daysOk} onClick={() => onSave(dataStart.trim(), daysNum)}>
          Save retention rules
        </button>
      </div>
    </div>
  );
}
