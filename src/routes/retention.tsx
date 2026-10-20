/**
 * RETENTION TAB (stage 3b; owner spec rev 53 + UI-DESIGN-SPEC.md §0/§2/§4).
 *
 * Management-only (the global passphrase gate in src/start.ts — no client
 * gate). Page order: header → 12-card KPI band ("as of now") → Weekly
 * Scorecard → method/honesty footer. Every card is a Link into its drill-down
 * (/retention-drill?kpi=…). The scorecard renders its EmptyState until the
 * scorecard compute/storage delegation lands — never a fabricated week.
 *
 * Data: read-only over the ret_* tables via retention/ui-data.ts (stage-3a
 * compute maintains them). Cancellations-family cards render honest "—"
 * (their ledger has no writer yet), never 0.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { formatPercent } from "~/server/metrics/report-text";
import { formatDateHuman } from "~/server/date-logic";
import { getRetentionPageData } from "~/server/queries";
import { num, Panel } from "~/components/page-panel";
import { StatusChip } from "~/components/StatusChip";
import { InfoTip } from "~/components/InfoTip";
import { EmptyState } from "~/components/performance-shell";
import { CANCELLATIONS_ENGINE_NOTE } from "~/server/retention/ui-data";

export const Route = createFileRoute("/retention")({
  loader: () => getRetentionPageData(),
  component: RetentionPage,
});

function RetentionPage() {
  const data = Route.useLoaderData();
  const computedStamp = data.computedAtIso
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(data.computedAtIso))
    : null;
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

      {/* 4 — Weekly Scorecard. Zone 1 headline is the owner's primary
          question, verbatim. The compute/storage is a separate later
          delegation — until it exists the panel renders its EmptyState
          (never a fabricated week). */}
      <section aria-label="Weekly scorecard" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="px-5 pt-5">
            <p className="kpi-label flex flex-wrap items-center gap-2">
              Weekly Scorecard
              <StatusChip kind="neutral" label="stored — past weeks never rewrite" />
              <InfoTip
                label="Scoring basis"
                tip="Auto-computes every Monday for the prior completed Mon–Sun ET week and is then stored — past weeks render byte-identically forever. The Retention Owner for each week resolves via retention_owner_history effective dates; a week is scored against whoever owned the role that week."
              />
            </p>
            <p className="mt-2 text-[15px] font-medium text-(--text-body)">
              Of the prior week&rsquo;s clients, how many actually spoke with Laura before their appointment?
            </p>
          </div>
          <div className="px-5 pb-5 pt-4">
            <EmptyState
              title="First scorecard computes Monday"
              hint="No stored week exists yet — the Monday compute writes the prior completed Mon–Sun ET week, then every past week stays byte-identical. Until then nothing is invented here."
            />
          </div>
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
