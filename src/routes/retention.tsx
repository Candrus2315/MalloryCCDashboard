/**
 * RETENTION TAB — RESTRUCTURED (owner directive 2026-10-20, verbatim spec in
 * /home/team/shared/retention/UI-RESTRUCTURE-DIRECTIVE.md). Action-first:
 *
 *   RETENTION header → TODAY row (what needs doing) → NEEDS ATTENTION
 *   client-level work queue → THIS WEEK's Retention Performance → RETENTION
 *   IMPACT (no-show spoken/not-spoken comparison) → WEEKLY SCORECARD (all
 *   stage-3c behavior preserved, human copy) → DATA QUALITY strip (demoted
 *   system-health counts) → method footer.
 *
 * The queue reuses the drill-down loaders' row universes via
 * retentionNeedsAttention (ui-data.ts — ONE source of truth; it never
 * re-derives §16 math). Cancellation rows come from the written
 * ret_cancellations ledger through the same inCancellationUniverse predicate
 * the Active Cancellations card counts.
 *
 * Semantic color system (owner point 8): blue = excitement-call workflow ·
 * amber = client needs attention · green = saved/recovered · red =
 * lost/no-show · purple/gray = system review/data issue — via the --ret-*
 * tokens (route tripwire forbids raw palette classes here). Every card and
 * queue row is a Link into its drill-down (/retention-drill?kpi=…); exact
 * formulas live in InfoTips, human language on the surface (owner point 7).
 *
 * Management-only (the global passphrase gate in src/start.ts). Read-only:
 * nothing on this page writes.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { formatPercent } from "~/server/metrics/report-text";
import { formatDateHuman } from "~/server/date-logic";
import { getRetentionPageData } from "~/server/queries";
import { num, Panel, RatioBar, KpiMid } from "~/components/page-panel";
import { StatusChip } from "~/components/StatusChip";
import { InfoTip } from "~/components/InfoTip";
import { EmptyState } from "~/components/performance-shell";
import { WeekOfSelect } from "~/components/Segmented";
import {
  CANCELLATIONS_ENGINE_NOTE,
  RETENTION_KPIS,
  type RetentionKpiKey,
  type RetentionQueueRow,
} from "~/server/retention/ui-data";

export const Route = createFileRoute("/retention")({
  validateSearch: (search: Record<string, unknown>) => ({
    /** ?week=<monday of a stored scorecard week> — validated to the YYYY-MM-DD shape; unknown weeks fall back to the most recent stored week. */
    week: typeof search.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.week) ? search.week : undefined,
  }),
  loader: () => getRetentionPageData(),
  component: RetentionPage,
});

/** "Oct 12" from a YYYY-MM-DD ET calendar string. */
function formatShort(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
/** "Mon, Oct 19, 6:00 AM" from a computed_at ISO instant, in ET. */
function formatStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The §16 formula string for a kpi key (verbatim from the UI data layer). */
function formulaOf(key: RetentionKpiKey): string {
  return RETENTION_KPIS.find((k) => k.key === key)?.formula ?? "";
}

/** Semantic accent per queue segment (owner color map, point 8). */
const SEGMENT_TONE: Record<RetentionQueueRow["segment"], { dot: string; chip: string }> = {
  "call-due": { dot: "bg-(--ret-blue-dot)", chip: "bg-(--ret-blue-bg) text-(--ret-blue-fg)" },
  unreached: { dot: "bg-(--ret-amber-dot)", chip: "bg-(--ret-amber-bg) text-(--ret-amber-fg)" },
  "window-missed": { dot: "bg-(--ret-amber-dot)", chip: "bg-(--ret-amber-bg) text-(--ret-amber-fg)" },
  "needs-review": { dot: "bg-(--ret-purple-dot)", chip: "bg-(--ret-purple-bg) text-(--ret-purple-fg)" },
  cancellation: { dot: "bg-(--ret-amber-dot)", chip: "bg-(--ret-amber-bg) text-(--ret-amber-fg)" }, // a client needs attention: save the session
};
const SEGMENT_REASON: Record<RetentionQueueRow["segment"], string> = {
  "call-due": "Excitement call due",
  unreached: "Still unreached",
  "window-missed": "Missed call window",
  "needs-review": "Needs review",
  cancellation: "Cancellation",
};

function RetentionPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const computedStamp = data.computedAtIso
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(data.computedAtIso))
    : null;

  const byKey = Object.fromEntries(data.cards.map((c) => [c.key, c]));
  const due = byKey["clients-due"]!;
  const unreached = byKey["unreached"]!;
  const spoken = byKey["spoken-with"]!;
  const compliance = byKey["compliance"]!;
  const cancellations = byKey["active-cancellations"]!;
  const saves = byKey["saves"]!;
  const reschedules = byKey["reschedules"]!;
  const recovery = byKey["recovery"]!;
  const noShows = byKey["no-shows"]!;
  const matchExceptions = byKey["match-exceptions"]!;
  const needsReview = byKey["needs-review"]!;

  const queue = data.queue;
  const pct = (r: number | null | undefined): string => (r == null ? "—" : formatPercent(r, 1));

  // Stored weeks (week_start DESC from the store); the selected week is the
  // ?week= param when it names a STORED week, else the most recent one.
  const scorecards = data.scorecards;
  const scorecard = scorecards.find((r) => r.week_start === search.week) ?? scorecards[0] ?? null;
  const mondays = scorecards.map((r) => r.week_start);
  const scoreOwner = scorecard ? (scorecard.owner_name ?? scorecard.owner_initials ?? "the Retention Owner") : null;

  return (
    <div>
      {/* RETENTION header — owner order §0: mission line, scope chip,
          management InfoTip, timezone meta. */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Retention</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[15px] text-(--text-caption)">
            <span className="text-(--text-primary)">Protect booked appointments. Recover cancellations. Reduce no-shows.</span>
            <StatusChip kind="neutral" label={`Week of ${formatDateHuman(data.weekStartEt).replace(/^(\w+), /, "")}–${formatDateHuman(data.weekEndEt).replace(/^(\w+), /, "")}`} />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5 pt-0.5">
          <InfoTip
            align="right"
            tip="Management only — contact and cancellation tracking computed from existing Acuity appointments and GHL call activity. Laura keeps working in Acuity and GHL exactly as today; the software observes and computes."
          />
        </div>
      </div>
      <p className="mt-1 flex items-center gap-2 text-xs text-(--text-caption)">
        <span aria-hidden="true" className="inline-block h-1 w-1 rounded-full bg-(--dot-muted)" />
        America/New_York
      </p>

      {/* TODAY — the action row (owner point 1): the four numbers that imply
          work is waiting. Whole card = Link into its drill-down. */}
      <section aria-label="Today" className="mt-4">
        <Panel className="overflow-hidden">
          <p className="section-heading flex items-center gap-1.5 px-5 pt-5">
            Today
            <InfoTip
              label="What Today counts"
              tip={`The workload waiting right now. Exact counting: ${formulaOf("clients-due")} · ${formulaOf("unreached")} · ${formulaOf("active-cancellations")} · ${formulaOf("needs-review")}. ${CANCELLATIONS_ENGINE_NOTE}`}
            />
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-4">
            {/* Clients Due — blue: the excitement-call workflow. */}
            <Link
              to="/retention-drill"
              search={{ kpi: "clients-due" }}
              aria-label={`Open the Clients Due drill-down`}
              className="group block rounded-lg border border-(--ret-blue-border) bg-(--ret-blue-bg) px-4 py-3 transition-colors hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
            >
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-blue-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-blue-dot)" aria-hidden="true" />
                Clients Due
              </p>
              <p className="mt-1.5 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{num(String(due.value ?? 0))}</p>
              <p className="kpi-sub mt-1">Appointments requiring an excitement call this week</p>
            </Link>
            {/* Still Unreached — amber: a client is waiting on us (owner point 3). */}
            <Link
              to="/retention-drill"
              search={{ kpi: "unreached" }}
              aria-label={`Open the Still Unreached drill-down — those ${unreached.value ?? 0} people`}
              className="group block rounded-lg border border-(--ret-amber-border) bg-(--ret-amber-bg) px-4 py-3 transition-colors hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
            >
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-amber-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-amber-dot)" aria-hidden="true" />
                Clients Still Need Contact
              </p>
              <p className="mt-1.5 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{num(String(unreached.value ?? 0))}</p>
              <p className="kpi-sub mt-1">
                {unreached.split ? `${unreached.split.open} still within call window · ${unreached.split.missed} missed call window` : unreached.sub}
              </p>
            </Link>
            {/* Active Cancellations — amber; a written-ledger 0 is a fact (the
                stage-4a engine counts the ret_cancellations ledger). */}
            <Link
              to="/retention-drill"
              search={{ kpi: "active-cancellations" }}
              aria-label={`Open the Active Cancellations drill-down`}
              className="group block rounded-lg border border-(--ret-amber-border) bg-(--ret-amber-bg) px-4 py-3 transition-colors hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
            >
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-amber-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-amber-dot)" aria-hidden="true" />
                Active Cancellations
              </p>
              <p className="mt-1.5 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                {cancellations.value == null ? num("—") : num(String(cancellations.value))}
              </p>
              <p className="kpi-sub mt-1">{(cancellations.value ?? 0) > 0 ? "Awaiting outcome — these clients can still be saved" : "No cancellations awaiting outcome"}</p>
            </Link>
            {/* Needs Review — purple/gray: system review, not client work. */}
            <Link
              to="/retention-drill"
              search={{ kpi: "needs-review" }}
              aria-label={`Open the Needs Review drill-down`}
              className="group block rounded-lg border border-(--ret-purple-border) bg-(--ret-purple-bg) px-4 py-3 transition-colors hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
            >
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-purple-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-purple-dot)" aria-hidden="true" />
                Needs Review
              </p>
              <p className="mt-1.5 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{num(String(needsReview.value ?? 0))}</p>
              <p className="kpi-sub mt-1">{(needsReview.value ?? 0) > 0 ? "Records with conflicting evidence" : "All clear — no conflicting evidence"}</p>
            </Link>
          </div>
        </Panel>
      </section>

      {/* NEEDS ATTENTION — the client-level work queue (owner point 1).
          Same loader data the drill-downs use; cancellation rows appear when
          the cancellations stage lands (the slot renders nothing until then). */}
      <section aria-label="Needs Attention" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
            <p className="section-heading flex items-center gap-1.5">
              Needs Attention
              <InfoTip
                label="How this queue is built"
                tip={`Client rows the engine can prove need action: excitement calls due, clients still unreached (within their call window or past it), records with conflicting evidence, and cancellations still awaiting an outcome (the save window is open). Each row opens the drill-down pre-filtered to that list. ${CANCELLATIONS_ENGINE_NOTE}`}
              />
            </p>
            <StatusChip
              kind={queue.rows.length > 0 ? "risk" : "positive"}
              label={queue.rows.length > 0 ? `${queue.rows.length} client${queue.rows.length === 1 ? "" : "s"} waiting` : "nothing waiting"}
            />
          </div>
          {queue.rows.length === 0 ? (
            <p className="px-5 pb-5 pt-4 text-[15px] text-(--text-body)">Nothing is waiting — every due client has been reached and no record needs review.</p>
          ) : (
            <>
              {/* Desktop table (spec's five columns, verbatim). */}
              <div className="hidden px-0 pb-3 md:block">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-(--table-border-strong) text-xs uppercase tracking-wide text-(--text-caption)">
                      <th className="px-5 py-2 font-medium">Client</th>
                      <th className="px-3 py-2 font-medium">Appointment</th>
                      <th className="px-3 py-2 font-medium">Reason</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-5 py-2 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.rows.map((row) => (
                      <QueueRow key={row.appointmentId} row={row} compact={false} />
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Phones — the card list pairing. */}
              <div className="space-y-2 px-5 pb-5 pt-3 md:hidden">
                {queue.rows.map((row) => (
                  <QueueRow key={row.appointmentId} row={row} compact={true} />
                ))}
              </div>
            </>
          )}
        </Panel>
      </section>

      {/* THIS WEEK — performance numbers, their own section (owner point 2).
          Cancellation-family cells stay honest "—" until that stage lands. */}
      <section aria-label="This Week's Retention Performance" className="mt-4">
        <Panel className="overflow-hidden">
          <p className="section-heading flex items-center gap-1.5 px-5 pt-5">
            This Week&rsquo;s Retention Performance
            <InfoTip
              label="How these are computed"
              tip={`Contact Compliance = spoke with ÷ clients due. Clients Reached = the clients due who have a verified conversation. The cancellation family (Saves, Reschedules, Recovery Rate) reads the cancellations ledger. Exact formulas: ${formulaOf("compliance")} · ${formulaOf("spoken-with")} · ${formulaOf("saves")} · ${formulaOf("reschedules")} · ${formulaOf("recovery")}. ${CANCELLATIONS_ENGINE_NOTE}`}
            />
          </p>
          <div className="mt-4 grid grid-cols-2 gap-y-5 pb-5 sm:grid-cols-3 xl:grid-cols-5 xl:divide-x xl:divide-(--table-border-weak)">
            <div className="px-5 py-1">
              <p className="kpi-label flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-blue-dot)" aria-hidden="true" />
                Contact Compliance
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{compliance.ratio == null ? num("—") : pct(compliance.ratio)}</p>
              <p className="kpi-sub mt-1.5">Spoke with ÷ clients due</p>
            </div>
            <div className="px-5 py-1">
              <p className="kpi-label flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-blue-dot)" aria-hidden="true" />
                Clients Reached
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                {num(String(spoken.value ?? 0))} <span className="text-xl font-medium text-(--text-caption)">/ {due.value ?? 0}</span>
              </p>
              <p className="kpi-sub mt-1.5">Had a real conversation before their appointment</p>
            </div>
            <div className="px-5 py-1">
              <p className="kpi-label flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-green-dot)" aria-hidden="true" />
                Cancellation Saves
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{saves.value == null ? num("—") : num(String(saves.value))}</p>
              <p className="kpi-sub mt-1.5">Original appointment kept</p>
            </div>
            <div className="px-5 py-1">
              <p className="kpi-label flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-green-dot)" aria-hidden="true" />
                Successful Reschedules
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{reschedules.value == null ? num("—") : num(String(reschedules.value))}</p>
              <p className="kpi-sub mt-1.5">Rebooked within the window</p>
            </div>
            <div className="px-5 py-1">
              <p className="kpi-label flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-green-dot)" aria-hidden="true" />
                Recovery Rate
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{recovery.ratio == null ? num("—") : pct(recovery.ratio)}</p>
              <p className="kpi-sub mt-1.5">Eligible cancellations saved or rescheduled</p>
            </div>
          </div>
        </Panel>
      </section>

      {/* RETENTION IMPACT — no-shows as the spoken/not-spoken comparison the
          owner asked for (point 4); red = lost/no-show. */}
      <section aria-label="Retention Impact" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
            <p className="section-heading flex items-center gap-1.5">
              Retention Impact
              <InfoTip
                label="How No-Shows are counted"
                tip={`No-Shows = sessions whose appointment time has passed while still marked scheduled (the same counting as the drill-down). Exact formula: ${formulaOf("no-shows")}. The spoken comparison answers the long-term question: do excitement calls actually reduce no-shows?`}
              />
            </p>
            <Link to="/retention-drill" search={{ kpi: "no-shows" }} className="text-xs font-medium text-(--text-caption) underline-offset-2 hover:underline">
              Compare in the drill-down →
            </Link>
          </div>
          <div className="px-5 pb-5 pt-3">
            <p className="kpi-label flex items-center gap-1.5 text-(--ret-red-fg)">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-red-dot)" aria-hidden="true" />
              No-Shows
            </p>
            <p className="mt-1.5 text-5xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{num(String(noShows.value ?? 0))}</p>
            <div className="mt-3 flex flex-col gap-1.5 text-[15px] text-(--text-body)">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-(--ret-green-dot)" aria-hidden="true" />
                <span>
                  <span className="font-semibold tabular-nums">{noShows.spokenSplit?.spoken ?? 0}</span> had spoken with {(data.ownerName ?? "the Retention Owner").split(" ")[0]}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-(--ret-amber-dot)" aria-hidden="true" />
                <span>
                  <span className="font-semibold tabular-nums">{noShows.spokenSplit?.notSpoken ?? 0}</span> had not spoken with {(data.ownerName ?? "the Retention Owner").split(" ")[0]}
                </span>
              </span>
            </div>
            <p className="kpi-sub mt-3">Over time this answers: do excitement calls actually reduce no-shows?</p>
          </div>
        </Panel>
      </section>

      {/* WEEKLY SCORECARD — stage-3c behavior preserved in full (stored weeks,
          WeekOfSelect, ?week=, honest "—" cells); human copy per point 6. */}
      <section aria-label="Weekly scorecard" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
            <div>
              <p className="kpi-label flex flex-wrap items-center gap-2">
                Weekly Scorecard
                <StatusChip kind="neutral" label="Results lock each Monday for the previous week" />
                <InfoTip
                  label="Scoring basis"
                  tip={`Auto-computes every Monday for the prior completed Mon–Sun ET week and is then stored — past weeks render byte-identically forever. The Retention Owner for each week resolves via retention_owner_history effective dates; a week is scored against whoever owned the role that week. Formulas are §16 verbatim. Cancellation-family cells (Cancellations worked, Saves, Reschedules, Recovery Rate), No-Shows and Transfers read ledgers no stage writes yet — they render —, never 0. ${CANCELLATIONS_ENGINE_NOTE}`}
                />
              </p>
              {scorecard && (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-[15px] font-medium text-(--text-body)">
                  <span>Computed {formatStamp(scorecard.computed_at)} ET</span>
                  <StatusChip kind="neutral" label={`week of ${formatShort(scorecard.week_start)}–${formatShort(scorecard.week_end)}`} />
                  <StatusChip kind="neutral" label="stored — past weeks never rewrite" />
                </p>
              )}
            </div>
            {scorecard && <WeekOfSelect mondays={mondays} value={scorecard.week_start} onChange={(m) => navigate({ to: "/retention", search: { week: m } })} />}
          </div>
          {scorecard ? (
            <div className="px-5 pb-5 pt-4">
              {/* Zone 1 — headline answer: spoke-with hero + BOTH compliance
                  flavors. One hero, one bar (the page's chart budget). */}
              <p className="text-[15px] font-medium text-(--text-body)">
                Of the prior week&rsquo;s clients, how many actually spoke with {scoreOwner ?? (data.ownerName ?? "the Retention Owner")} before their appointment?
              </p>
              <div className="mt-4 flex flex-wrap items-end gap-x-10 gap-y-5">
                <div>
                  <p className="kpi-label">Clients Spoken With</p>
                  <p className="mt-1 flex items-baseline gap-2">
                    <span className="text-6xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{scorecard.spoken_with}</span>
                    <span className="text-2xl font-medium tabular-nums text-(--text-caption)">/ {scorecard.eligible} clients</span>
                  </p>
                </div>
                <div className="min-w-56 flex-1 sm:max-w-sm">
                  <p className="kpi-label">Contact Compliance % — Spoke With</p>
                  <p className="kpi-mid mt-1">{pct(scorecard.compliance_appointment)}</p>
                  <div className="mt-1.5">
                    <RatioBar ratio={scorecard.compliance_appointment} max="max-w-sm" />
                  </div>
                </div>
                <div className="min-w-40">
                  <p className="kpi-label">— Attempted</p>
                  <p className="kpi-mid mt-1">{pct(scorecard.compliance_attempt)}</p>
                  <p className="kpi-sub mt-1.5">
                    {scorecard.called} of {scorecard.eligible} with at least one attempt
                  </p>
                </div>
              </div>

              {/* Zone 2 — compact metric grid; null → "—"; human subs (formulas in the panel InfoTip). */}
              <div className="mt-6 grid grid-cols-2 gap-y-5 border-t border-(--table-border-weak) pt-5 sm:grid-cols-4 xl:grid-cols-6">
                <KpiMid label="Eligible appointments" value={scorecard.eligible} sub="The week's due clients" />
                <KpiMid label="Called ≥1 attempt" value={scorecard.called} sub={`${pct(scorecard.compliance_attempt)} of eligible`} />
                <KpiMid label="Still unreached" value={scorecard.unreached} sub="No answer / unclear" />
                <KpiMid label="Cancellations worked" value="—" />
                <KpiMid label="Saves" value="—" />
                <KpiMid label="Reschedules" value="—" />
                <KpiMid label="Recoveries" value="—" />
                <KpiMid label="Recovery rate" value="—" />
                <KpiMid label="No-Shows" value="—" />
                <KpiMid label="Transfers" value="—" sub="Excluded from owner compliance" />
                <KpiMid label="Needs Review" value={scorecard.needs_review} sub={scorecard.needs_review > 0 ? "Conflicting evidence" : "All clear"} />
                <KpiMid
                  label="Data Match Exceptions"
                  value={scorecard.match_exceptions}
                  sub={scorecard.match_exceptions > 0 ? "Match unresolved" : "All clear"}
                />
              </div>
            </div>
          ) : (
            <div className="px-5 pb-5 pt-4">
              <EmptyState
                title="Your first completed weekly scorecard will appear Monday"
                hint="Nothing is invented in the meantime — the panel stays empty until the first week locks."
              />
            </div>
          )}
        </Panel>
      </section>

      {/* DATA QUALITY — demoted system-health strip (owner point 5): fixing
          data is NOT as prominent as contacting clients. Purple/gray. */}
      <section aria-label="Data Quality" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
            <p className="kpi-label flex items-center gap-1.5 text-(--text-caption)">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-purple-dot)" aria-hidden="true" />
              Data Quality
              <InfoTip
                label="About Data Quality"
                tip={`System-health counts, not client work: unmatched records are contacts the identity chain could not tie to a client (they resolve in the exceptions workspace); records requiring review have conflicting contact evidence. ${formulaOf("match-exceptions")} · ${formulaOf("needs-review")}`}
              />
            </p>
            <Link to="/retention-drill" search={{ kpi: "match-exceptions" }} className="text-sm text-(--text-body) underline-offset-2 hover:underline">
              <span className="font-semibold tabular-nums text-(--text-primary)">{matchExceptions.value ?? 0}</span> unmatched records
            </Link>
            <Link to="/retention-drill" search={{ kpi: "needs-review" }} className="text-sm text-(--text-body) underline-offset-2 hover:underline">
              <span className="font-semibold tabular-nums text-(--text-primary)">{needsReview.value ?? 0}</span> records requiring review
            </Link>
          </div>
        </Panel>
      </section>

      {/* Method footer — computed stamp + who owns the role; exact formulas
          behind the InfoTip (owner point 7: human language on the surface). */}
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-(--text-muted)">
        <span>{computedStamp ? <>Computed {computedStamp} ET</> : <>No compute run recorded yet</>}</span>
        <span aria-hidden="true">·</span>
        <span>Retention Owner: {data.ownerName ?? "—"}</span>
        <span aria-hidden="true">·</span>
        <InfoTip
          label="Where these numbers come from"
          tip={`Read-only aggregation over the ret_* tables the compute job maintains. Eligibility: ${formulaOf("clients-due")} — eligible = appointment status is a qualifying status (Settings) · due = appointment ET date − ${data.dueDays} · contact-due windows use calendar days. ${CANCELLATIONS_ENGINE_NOTE}`}
        />
      </p>
    </div>
  );
}

/** One queue row: a desktop <tr> or a phone card (md:hidden pairing). The
    Action cell is the row's link into the pre-filtered drill-down. */
function QueueRow({ row, compact }: { row: RetentionQueueRow; compact: boolean }) {
  const tone = SEGMENT_TONE[row.segment];
  const drillSearch =
    row.drillKpi === "clients-due"
      ? { kpi: "clients-due", range: "this-week" } as const
      : row.drillKpi === "unreached"
        ? { kpi: "unreached", range: "all" } as const
        : row.drillKpi === "active-cancellations"
          ? { kpi: "active-cancellations", range: "all" } as const
          : { kpi: "needs-review", range: "all", classification: "needs_review" } as const;
  const appointment = row.apptDateEt ? `${formatShort(row.apptDateEt)}${row.apptTimeEt ? ` · ${row.apptTimeEt}` : ""}` : "—";
  const client = row.clientName ?? "Unnamed client";
  if (compact) {
    return (
      <Link
        to="/retention-drill"
        search={drillSearch}
        className="block rounded-lg border border-(--card-border) bg-(--card-bg) px-4 py-3 transition-colors hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
      >
        <p className="flex items-center justify-between gap-2">
          <span className="font-medium text-(--text-primary)">{client}</span>
          <span className="text-xs text-(--text-caption)">{appointment}</span>
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`chip ${tone.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
            {SEGMENT_REASON[row.segment]}
          </span>
          <span className="text-sm text-(--text-body)">
            {row.statusLabel}
            {row.attemptsCount > 0 ? ` · ${row.attemptsCount} attempt${row.attemptsCount === 1 ? "" : "s"}` : ""}
          </span>
        </p>
        <p className="mt-2 text-xs font-medium text-(--text-primary)">{row.actionLabel} →</p>
      </Link>
    );
  }
  return (
    <tr className="border-b border-(--table-border-weak) last:border-b-0 hover:bg-(--hover-row)">
      <td className="px-5 py-2.5 font-medium text-(--text-primary)">{client}</td>
      <td className="px-3 py-2.5 tabular-nums text-(--text-body)">
        {appointment}
        <span className="block text-xs text-(--text-muted)">
          {row.segment === "cancellation"
            ? row.dueDate
              ? `cancelled ${formatShort(row.dueDate)}`
              : "cancelled —"
            : `due ${formatShort(row.dueDate)}`}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <span className={`chip ${tone.chip}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
          {SEGMENT_REASON[row.segment]}
        </span>
      </td>
      <td className="px-3 py-2.5 text-(--text-body)">
        {row.statusLabel}
        {row.attemptsCount > 0 ? <span className="block text-xs text-(--text-muted)">{row.attemptsCount} attempt{row.attemptsCount === 1 ? "" : "s"}</span> : null}
      </td>
      <td className="px-5 py-2.5 text-right">
        <Link
          to="/retention-drill"
          search={drillSearch}
          className="inline-flex items-center gap-1 rounded text-sm font-medium text-(--text-primary) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
        >
          {row.actionLabel}
          <span aria-hidden="true">→</span>
        </Link>
      </td>
    </tr>
  );
}
