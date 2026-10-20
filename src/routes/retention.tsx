/**
 * RETENTION TAB (stage 3b UI + stage 3c scorecard panel; owner spec rev 53 +
 * UI-DESIGN-SPEC.md §0/§2/§4).
 *
 * Management-only (the global passphrase gate in src/start.ts — no client
 * gate). Page order: header → 12-card KPI band ("as of now") → Weekly
 * Scorecard → method/honesty footer. Every card is a Link into its drill-down
 * (/retention-drill?kpi=…).
 *
 * Weekly Scorecard (stage 3c): renders the most recently STORED week
 * (default; ?week=<monday> selects among stored weeks via WeekOfSelect —
 * only stored weeks are listed, nothing is fabricated). Zone 1 = the owner's
 * primary question (Retention Owner OF THE SCORED WEEK interpolated from the
 * stored row — never hard-coded) + the spoke-with hero + BOTH §16 compliance
 * flavors (RatioBar on the appointment flavor only). Zone 2 = the compact
 * metric grid; cancellation-family / no-show / transfers cells render honest
 * "—" (no ledger writer yet), never 0. No stored scorecard → the EmptyState.
 *
 * Data: read-only over the ret_* tables via retention/ui-data.ts + the
 * ret_scorecards store methods (stage-3a compute + stage-3c Monday job
 * maintain them). Nothing on this page writes.
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
import { CANCELLATIONS_ENGINE_NOTE } from "~/server/retention/ui-data";

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

  // Stored weeks (week_start DESC from the store); the selected week is the
  // ?week= param when it names a STORED week, else the most recent one.
  const scorecards = data.scorecards;
  const scorecard = scorecards.find((r) => r.week_start === search.week) ?? scorecards[0] ?? null;
  const mondays = scorecards.map((r) => r.week_start);
  const scoreOwner = scorecard ? (scorecard.owner_name ?? scorecard.owner_initials ?? "the Retention Owner") : null;
  const pct = (r: number | null | undefined): string => (r == null ? "—" : formatPercent(r, 1));

  return (
    <div>
      {/* Page header — Performance-header anatomy: title, scope chip,
          management InfoTip, timezone meta. */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Retention</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[15px] text-(--text-caption)">
            <span className="text-(--text-primary)">Management workspace</span>
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

      {/* 2 — KPI band: ONE panel, hairline-divided 12 cells in the owner's
          exact order (funnel → cancellations → quality). Whole cell = Link. */}
      <section aria-label="Retention overview" className="mt-4">
        <Panel className="overflow-hidden">
          <p className="section-heading flex items-center gap-1.5 px-5 pt-5">
            Retention Overview
            <InfoTip
              label="What these cards count"
              tip={`As of now, per §16: cards summarize the current week's due cohort and all open queues. Every card opens its drill-down. Cancellations-family cards (Active Cancellations, Saves, Reschedules, Recovery Rate) read the cancellation ledger, which no stage writes yet — they render —, never 0. ${CANCELLATIONS_ENGINE_NOTE}`}
            />
          </p>
          <div className="mt-4 grid grid-cols-2 gap-y-5 pb-5 sm:grid-cols-4 xl:grid-cols-6 xl:gap-y-0 xl:divide-x xl:divide-(--table-border-weak)">
            {data.cards.map((card) => {
              const isPct = card.key === "compliance" || card.key === "recovery";
              const valueText =
                card.value == null && !isPct ? "—" : isPct ? (card.ratio == null ? "—" : formatPercent(card.ratio, 1)) : String(card.value);
              const zero = !card.attention && card.value === 0 && !isPct;
              return (
                <div key={card.key} className="px-5 py-1">
                  <Link
                    to="/retention-drill"
                    search={{ kpi: card.key }}
                    aria-label={`Open the ${card.label} drill-down`}
                    className="group block rounded-lg px-5 py-1 transition-colors hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                  >
                    <p className="kpi-label flex items-center gap-1.5">
                      {card.attention && (card.value ?? 0) > 0 && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
                      )}
                      {card.label}
                    </p>
                    <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {zero ? <span className="text-(--text-muted)">{valueText}</span> : num(valueText)}
                    </p>
                    {card.sub && <p className="kpi-sub mt-1.5">{card.sub}</p>}
                  </Link>
                </div>
              );
            })}
          </div>
        </Panel>
      </section>

      {/* 4 — Weekly Scorecard (§4). A STORED week renders the hero + grid;
          no stored week → the honest EmptyState (never a fabricated week). */}
      <section aria-label="Weekly scorecard" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
            <div>
              <p className="kpi-label flex flex-wrap items-center gap-2">
                {scorecard ? <>Weekly Scorecard — computed {formatStamp(scorecard.computed_at)} ET</> : <>Weekly Scorecard</>}
                {scorecard && <StatusChip kind="neutral" label={`week of ${formatShort(scorecard.week_start)}–${formatShort(scorecard.week_end)}`} />}
                {scorecard && <StatusChip kind="neutral" label="stored — past weeks never rewrite" />}
                <InfoTip
                  label="Scoring basis"
                  tip={`Auto-computes every Monday for the prior completed Mon–Sun ET week and is then stored — past weeks render byte-identically forever. The Retention Owner for each week resolves via retention_owner_history effective dates; a week is scored against whoever owned the role that week. Formulas are §16 verbatim. Cancellation-family cells (Cancellations worked, Saves, Reschedules, Recovery Rate), No-Shows and Transfers read ledgers no stage writes yet — they render —, never 0. ${CANCELLATIONS_ENGINE_NOTE}`}
                />
              </p>
              <p className="mt-2 text-[15px] font-medium text-(--text-body)">
                Of the prior week&rsquo;s clients, how many actually spoke with {scoreOwner ?? (data.ownerName ?? "the Retention Owner")} before
                their appointment?
              </p>
            </div>
            {scorecard && <WeekOfSelect mondays={mondays} value={scorecard.week_start} onChange={(m) => navigate({ to: "/retention", search: { week: m } })} />}
          </div>
          {scorecard ? (
            <div className="px-5 pb-5 pt-4">
              {/* Zone 1 — headline answer: spoke-with hero + BOTH compliance
                  flavors. One hero, one bar (the page's chart budget). */}
              <div className="flex flex-wrap items-end gap-x-10 gap-y-5">
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
                    {scorecard.called} of {scorecard.eligible} with ≥1 attempt
                  </p>
                </div>
              </div>

              {/* Zone 2 — compact metric grid, labels verbatim; null → "—". */}
              <div className="mt-6 grid grid-cols-2 gap-y-5 border-t border-(--table-border-weak) pt-5 sm:grid-cols-4 xl:grid-cols-6">
                <KpiMid label="Eligible appointments" value={scorecard.eligible} sub={`due = appt date − ${scorecard.due_days}`} />
                <KpiMid label="Called ≥1 attempt" value={scorecard.called} sub={`${pct(scorecard.compliance_attempt)} of eligible`} />
                <KpiMid label="Still unreached" value={scorecard.unreached} sub="no answer / unclear" />
                <KpiMid label="Cancellations worked" value="—" />
                <KpiMid label="Saves" value="—" />
                <KpiMid label="Reschedules" value="—" />
                <KpiMid label="Recoveries" value="—" />
                <KpiMid label="Recovery rate" value="—" />
                <KpiMid label="No-Shows" value="—" />
                <KpiMid label="Transfers" value="—" sub="excluded from owner compliance" />
                <KpiMid label="Needs Review" value={scorecard.needs_review} sub={scorecard.needs_review > 0 ? "evidence conflicts" : "all clear"} />
                <KpiMid
                  label="Data Match Exceptions"
                  value={scorecard.match_exceptions}
                  sub={scorecard.match_exceptions > 0 ? "match unresolved" : "all clear"}
                />
              </div>

              <p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--text-muted)">
                <span>computed {formatStamp(scorecard.computed_at)} ET</span>
                <span aria-hidden="true">·</span>
                <span>due = appointment ET date − {scorecard.due_days}</span>
                <span aria-hidden="true">·</span>
                <span>owner resolved via retention_owner_history effective dates</span>
              </p>
            </div>
          ) : (
            <div className="px-5 pb-5 pt-4">
              <EmptyState
                title="First scorecard computes Monday"
                hint="No stored week exists yet — the Monday compute writes the prior completed Mon–Sun ET week, then every past week stays byte-identical. Until then nothing is invented here."
              />
            </div>
          )}
        </Panel>
      </section>

      {/* Method/honesty footer — computed stamps + eligibility basis. */}
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-(--text-muted)">
        <span>
          {computedStamp ? <>Computed {computedStamp} ET</> : <>No compute run recorded yet</>}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Eligible = status &isin; qualifying statuses (Settings) &middot; due = appointment ET date &minus; {data.dueDays} &middot; Retention
          Owner: {data.ownerName ?? "—"}
        </span>
        <span aria-hidden="true">·</span>
        <InfoTip
          label="Where these numbers come from"
          tip={`Read-only aggregation over the ret_* tables the stage-3a compute job maintains (due cohort = qualifying appointments by contact-due date, ET). ${CANCELLATIONS_ENGINE_NOTE}`}
        />
      </p>
    </div>
  );
}
