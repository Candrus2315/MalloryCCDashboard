/**
 * RETENTION TAB — UX OVERHAUL (owner directive "Retention UX Overhaul —
 * Preserve Desktop Design Language"; spec: /home/team/shared/retention-ux-spec.md §5):
 *
 *   header → RETENTION OVERVIEW (the 4 primary cards + a demoted secondary
 *   row of supporting counts) → NEEDS ATTENTION (compact stage cards; their
 *   CTAs deep-link ?queue=) → TODAY'S RETENTION QUEUE (THE one unified list:
 *   ?queue= filter chips over the SAME loader rows, owner urgency order,
 *   last-contact + priority columns, completed affordances) → THIS WEEK'S
 *   RETENTION PERFORMANCE (span 7) beside RETENTION IMPACT (span 5) →
 *   WEEKLY SCORECARD (all stage-3c behavior intact; the cancellation-family
 *   cells now read the stored row) → DATA QUALITY strip (quiet) → method
 *   footer.
 *
 * READ-ONLY TRACKING (spec §0): every CTA navigates — a queue view, a
 * drill-down, or the exceptions workspace. The module's ONLY write path
 * stays the shipped exceptions resolve workspace; there are no Call / Save
 * Appointment / Mark-Reached buttons — the row verbs are LINK labels that
 * open the client's evidence. Every number traces to the loader
 * (retentionOverview / retentionNeedsAttention / listRetentionScorecards);
 * null renders "—" (num()), never a fabricated 0.
 *
 * No new visual system: Panel / KpiMid / num / RatioBar / StatusChip /
 * InfoTip / EmptyState / Segmented / chip / kpi-* and the --ret-* semantic
 * tokens only (the route tripwire enforces tokens-over-palette). Desktop is
 * a 12-col flow; mobile collapses to the existing card pairing.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { formatPercent } from "~/server/metrics/report-text";
import { formatDateHuman } from "~/server/date-logic";
import { getRetentionPageData } from "~/server/queries";
import { num, Panel, RatioBar, KpiMid } from "~/components/page-panel";
import { StatusChip } from "~/components/StatusChip";
import { InfoTip } from "~/components/InfoTip";
import { EmptyState } from "~/components/performance-shell";
import { Segmented, WeekOfSelect } from "~/components/Segmented";
import {
  CANCELLATIONS_ENGINE_NOTE,
  RETENTION_KPIS,
  RETENTION_PRIORITY_LABEL,
  type RetentionKpiKey,
  type RetentionQueueRow,
} from "~/server/retention/ui-data";

/** The ?queue= stage filters (§5.3). No-Shows / Reschedules are RESERVED
 * (D4/D5): they render only when their pipeline stages ship real segments —
 * a chip that filters to zero while no-shows exist would read as a false
 * "nothing to do". Transfers went ACTIVE with the stage-5 ledger (the
 * transfers engine writes ret_transfers; its rows carry a standing fact).
 * Unknown params fall back to all (validateSearch). */
export type QueueFilter = "all" | "excitement" | "unreached" | "cancellations" | "transfers" | "needs-review";
export const QUEUE_FILTERS: { value: QueueFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "excitement", label: "Excitement Calls" },
  { value: "unreached", label: "Still Unreached" },
  { value: "cancellations", label: "Cancellations" },
  { value: "transfers", label: "Transfers" },
  { value: "needs-review", label: "Needs Review" },
];

export const Route = createFileRoute("/retention")({
  validateSearch: (search: Record<string, unknown>) => ({
    /** ?week=<monday of a stored scorecard week> — validated to the YYYY-MM-DD shape; unknown weeks fall back to the most recent stored week. */
    week: typeof search.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.week) ? search.week : undefined,
    /** ?queue=<stage filter> — validated against the ACTIVE chips; unknown values (incl. the reserved stages) fall back to all. */
    queue: QUEUE_FILTERS.some((f) => f.value === search.queue) ? (search.queue as QueueFilter) : undefined,
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
/** "Oct 20" from an ISO instant, in ET (D1 — the Last Contact column). */
function formatDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(iso));
}
/** "Thu, 2:00 PM" from an ISO instant, in ET (D2 — window-closes line). */
function formatDayTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
/** "2:00 PM" from an ISO instant, in ET (D2 — the today-variant of the same line). */
function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
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
  transfer: { dot: "bg-(--ret-purple-dot)", chip: "bg-(--ret-purple-bg) text-(--ret-purple-fg)" }, // a standing fact for awareness (Records rank), not client work
};
const SEGMENT_REASON: Record<RetentionQueueRow["segment"], string> = {
  "call-due": "Excitement call due",
  unreached: "Still unreached",
  "window-missed": "Missed call window",
  "needs-review": "Needs review",
  cancellation: "Cancellation",
  transfer: "Transfer",
};

/** §5.3 — which loader segments each chip shows (client-side over the ONE
 * queue array; the queue is never re-derived or re-fetched). */
const SEGMENT_IN: Record<QueueFilter, (s: RetentionQueueRow["segment"]) => boolean> = {
  all: () => true,
  excitement: (s) => s === "call-due" || s === "unreached",
  unreached: (s) => s === "unreached" || s === "window-missed",
  cancellations: (s) => s === "cancellation",
  transfers: (s) => s === "transfer",
  "needs-review": (s) => s === "needs-review",
};

/** §4.3 — an empty queue under a chip says WHY (never a bare "nothing"). */
const QUEUE_EMPTY_WHY: Record<QueueFilter, string> = {
  all: "Nothing waiting — every due client has been reached and no record needs review.",
  excitement: "No excitement calls waiting — every client inside a call window has been reached.",
  unreached: "No unreached clients — everyone still inside a call window has been reached.",
  cancellations: "No cancellations awaiting outcome.",
  transfers: "No transfers — no client session has moved between calendars.",
  "needs-review": "No records with conflicting evidence — every classification is settled.",
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
  const callsAttempted = byKey["calls-attempted"]!;
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
  const ownerFirst = (data.ownerName ?? "the Retention Owner").split(" ")[0];

  // §5.3 — the ONE unified queue: filter the loader's rows client-side;
  // never re-derive §16 math, never re-fetch.
  const queueFilter: QueueFilter = search.queue ?? "all";
  const filteredRows = queue.rows.filter((r) => SEGMENT_IN[queueFilter](r.segment));

  const navigateQueue = (v: QueueFilter) =>
    navigate({
      to: "/retention",
      search: { ...(search.week ? { week: search.week } : {}), ...(v === "all" ? {} : { queue: v }) },
    });

  // Stored weeks (week_start DESC from the store); the selected week is the
  // ?week= param when it names a STORED week, else the most recent one.
  const scorecards = data.scorecards;
  const scorecard = scorecards.find((r) => r.week_start === search.week) ?? scorecards[0] ?? null;
  const mondays = scorecards.map((r) => r.week_start);
  const scoreOwner = scorecard ? (scorecard.owner_name ?? scorecard.owner_initials ?? "the Retention Owner") : null;

  return (
    <div>
      {/* §5.0 Header — unchanged: title, mission line, week chip, management
          InfoTip, timezone meta. */}
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

      {/* §5.1 RETENTION OVERVIEW — the four primary cards (each a Link into
          its drill-down) + the supporting counts demoted to one quiet text
          row under a hairline. No new card chrome down there: system-health
          numbers never out-shout client work. */}
      <section aria-label="Retention Overview" className="mt-4">
        <Panel className="overflow-hidden">
          <p className="section-heading flex items-center gap-1.5 px-5 pt-5">
            Retention Overview
            <InfoTip
              label="What the overview counts"
              tip={`The workload waiting right now, with the supporting counts demoted to the quiet row underneath. Exact counting: ${formulaOf("clients-due")} · ${formulaOf("unreached")} · ${formulaOf("active-cancellations")} · ${formulaOf("needs-review")}. ${CANCELLATIONS_ENGINE_NOTE}`}
            />
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-4">
            {/* Clients Due — blue: the excitement-call workflow. */}
            <Link
              to="/retention-drill"
              search={{ kpi: "clients-due" }}
              aria-label="Open the Clients Due drill-down"
              className="group block rounded-lg border border-(--ret-blue-border) bg-(--ret-blue-bg) px-4 py-3 transition-colors hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
            >
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-blue-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-blue-dot)" aria-hidden="true" />
                Clients Due
              </p>
              <p className="mt-1.5 text-4xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{num(String(due.value ?? 0))}</p>
              <p className="kpi-sub mt-1">Appointments requiring an excitement call this week</p>
            </Link>
            {/* Clients Still Need Contact — amber: a client is waiting on us.
                The card ALSO deep-links the unified queue pre-filtered to the
                unreached stage (§5.1; owner: the metric links into the work). */}
            <div className="rounded-lg border border-(--ret-amber-border) bg-(--ret-amber-bg) px-4 py-3 transition-colors hover:bg-(--surface-hover)">
              <Link
                to="/retention-drill"
                search={{ kpi: "unreached" }}
                aria-label="Open the Still Unreached drill-down"
                className="block rounded-lg focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
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
              <Link
                to="/retention"
                search={{ queue: "unreached" }}
                className="mt-2 inline-flex items-center gap-1 rounded text-xs font-semibold text-(--ret-amber-fg) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                Open the unreached queue <span aria-hidden="true">→</span>
              </Link>
            </div>
            {/* Active Cancellations — amber; a written-ledger 0 is a fact (the
                stage-4a engine counts the ret_cancellations ledger). */}
            <Link
              to="/retention-drill"
              search={{ kpi: "active-cancellations" }}
              aria-label="Open the Active Cancellations drill-down"
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
              aria-label="Open the Needs Review drill-down"
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
          {/* §5.1 Row B — the demotion: four quiet text cells, no cards. */}
          <div className="grid grid-cols-2 gap-y-4 border-t border-(--table-border-weak) px-5 py-4 sm:grid-cols-4">
            <SecondaryCount label="Calls Attempted" value={callsAttempted.value} kpi="calls-attempted" />
            <SecondaryCount label="Clients Spoken With" value={spoken.value} kpi="spoken-with" />
            <SecondaryCount label="No-Shows" value={noShows.value} kpi="no-shows" />
            <SecondaryCount label="Data Match Exceptions" value={matchExceptions.value} kpi="match-exceptions" />
          </div>
        </Panel>
      </section>

      {/* §5.2 NEEDS ATTENTION — compact stage cards; this is where client
          names STOP (no names until a queue is opened). CTAs navigate to the
          unified queue pre-filtered. */}
      <section aria-label="Needs Attention" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
            <p className="section-heading flex items-center gap-1.5">
              Needs Attention
              <InfoTip
                label="How this queue is built"
                tip={`Client rows the engine can prove need action: excitement calls due, clients still unreached (within their call window or past it), records with conflicting evidence, and cancellations still awaiting an outcome (the save window is open). The Transfers card tracks the stage-5 transfers ledger — clients whose session moved to a different calendar — as a standing fact, never open work. Each stage card opens the shared queue pre-filtered. ${CANCELLATIONS_ENGINE_NOTE}`}
              />
            </p>
            <StatusChip
              kind={queue.rows.length > 0 ? "risk" : "positive"}
              label={queue.rows.length > 0 ? `${queue.rows.length} client${queue.rows.length === 1 ? "" : "s"} waiting` : "nothing waiting"}
            />
          </div>
          <div className="mt-4 grid gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-5">
            {/* Card 1 — Excitement Calls (blue). */}
            <div className="rounded-lg border border-(--ret-blue-border) bg-(--ret-blue-bg) px-4 py-3">
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-blue-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-blue-dot)" aria-hidden="true" />
                Excitement Calls
              </p>
              <div className="mt-2 space-y-1 text-[15px] text-(--text-body)">
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{num(String(due.value ?? 0))}</span> due this week
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{num(String(unreached.value ?? 0))}</span> still unreached
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{compliance.ratio == null ? num("—") : pct(compliance.ratio)}</span> contact compliance
                </p>
              </div>
              <Link
                to="/retention"
                search={{ queue: "excitement" }}
                className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-(--text-primary) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                Open Queue <span aria-hidden="true">→</span>
              </Link>
            </div>
            {/* Card 2 — Cancellation Recovery (amber card, green count accents). */}
            <div className="rounded-lg border border-(--ret-amber-border) bg-(--ret-amber-bg) px-4 py-3">
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-amber-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-amber-dot)" aria-hidden="true" />
                Cancellation Recovery
              </p>
              <div className="mt-2 space-y-1 text-[15px] text-(--text-body)">
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{cancellations.value == null ? num("—") : num(String(cancellations.value))}</span> active — awaiting outcome
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--ret-green-fg)">{saves.value == null ? num("—") : num(String(saves.value))}</span> saved
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--ret-green-fg)">{reschedules.value == null ? num("—") : num(String(reschedules.value))}</span> rescheduled
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--ret-green-fg)">{recovery.ratio == null ? num("—") : pct(recovery.ratio)}</span> recovery rate
                </p>
              </div>
              <Link
                to="/retention"
                search={{ queue: "cancellations" }}
                className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-(--text-primary) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                Open Queue <span aria-hidden="true">→</span>
              </Link>
            </div>
            {/* Card 3 — No-Show Prevention (red). Honest: today this is a list
                + analysis, not an action queue — the no-show pipeline stage is
                not built, so the CTA goes to the comparison, never a fake
                worklist. */}
            <div className="rounded-lg border border-(--ret-red-border) bg-(--ret-red-bg) px-4 py-3">
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-red-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-red-dot)" aria-hidden="true" />
                No-Show Prevention
              </p>
              <div className="mt-2 space-y-1 text-[15px] text-(--text-body)">
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{num(String(noShows.value ?? 0))}</span> no-shows
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--ret-green-fg)">{noShows.spokenSplit?.spoken ?? 0}</span> had spoken with {ownerFirst}
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{noShows.spokenSplit?.notSpoken ?? 0}</span> had not
                </p>
              </div>
              <Link
                to="/retention-drill"
                search={{ kpi: "no-shows" }}
                className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-(--text-primary) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                See the comparison <span aria-hidden="true">→</span>
              </Link>
            </div>
            {/* Card 4 — Needs Review (purple/gray: system review). */}
            <div className="rounded-lg border border-(--ret-purple-border) bg-(--ret-purple-bg) px-4 py-3">
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-purple-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-purple-dot)" aria-hidden="true" />
                Needs Review
              </p>
              <div className="mt-2 space-y-1 text-[15px] text-(--text-body)">
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{num(String(needsReview.value ?? 0))}</span> records with conflicting evidence
                </p>
              </div>
              <Link
                to="/retention"
                search={{ queue: "needs-review" }}
                className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-(--text-primary) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                Review <span aria-hidden="true">→</span>
              </Link>
            </div>
            {/* Card 5 — Transfers (purple/gray: a standing fact for awareness,
                Records rank — the client already moved calendars; nothing is
                saved or called from here, §16 excludes transfers from owner
                compliance). The count reads the stage-5 transfers ledger
                DISPLAY-scoped; the share rate exists only with a real
                denominator (tracked cancellations cancelled this week). */}
            <div className="rounded-lg border border-(--ret-purple-border) bg-(--ret-purple-bg) px-4 py-3">
              <p className="kpi-label flex items-center gap-1.5 text-(--ret-purple-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-purple-dot)" aria-hidden="true" />
                Transfers
              </p>
              <div className="mt-2 space-y-1 text-[15px] text-(--text-body)">
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{num(String(data.transfersTotal ?? 0))}</span> transferred — client moved calendars
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--text-primary)">{num(String(data.transfersThisWeek ?? 0))}</span> this week
                </p>
                <p>
                  <span className="font-semibold tabular-nums text-(--ret-green-fg)">{data.transfersRate == null ? num("—") : pct(data.transfersRate)}</span>{" "}
                  {data.transfersRate == null ? "no tracked cancellations this week" : "of tracked cancellations"}
                </p>
              </div>
              <Link
                to="/retention"
                search={{ queue: "transfers" }}
                className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-(--text-primary) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                Open Queue <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </Panel>
      </section>

      {/* §5.3 TODAY'S RETENTION QUEUE — THE one unified list. Filter chips
          over the SAME loader array; the owner urgency order comes from the
          loader (row.priority); the Action verbs are links into the
          drill-downs. */}
      <section aria-label="Today's Retention Queue" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
            <p className="section-heading flex items-center gap-1.5">
              Today&rsquo;s Retention Queue
              <InfoTip
                label="One list, one source"
                tip={`Everyone the engine can prove needs action today — excitement calls, still-unreached clients, cancellations awaiting an outcome, records with conflicting evidence — plus confirmed transfers (standing facts, Records rank). Filtered by stage. The rows are the SAME data the drill-downs use, never re-counted. Priority is the owner's order: save first, call next, salvage, then records. ${CANCELLATIONS_ENGINE_NOTE}`}
              />
            </p>
            <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
              <Segmented
                options={QUEUE_FILTERS}
                value={queueFilter}
                onChange={navigateQueue}
                ariaLabel="Filter the retention queue by stage"
              />
              {/* Completed affordance (D3, link-only): the drill-downs hold
                  the reached/recovered rows; no fake "resolved" count is
                  invented for calls (the ledger has no resolution stamp). */}
              <Link
                to="/retention-drill"
                search={{ kpi: "spoken-with", range: "this-week" }}
                className="text-xs font-medium text-(--text-caption) underline-offset-2 hover:underline"
              >
                Completed: see everyone reached this week <span aria-hidden="true">→</span>
              </Link>
              <Link
                to="/retention-drill"
                search={{ kpi: "recovery", range: "this-week" }}
                className="text-xs font-medium text-(--text-caption) underline-offset-2 hover:underline"
              >
                <span className="font-semibold tabular-nums">{queue.cancellationsRecoveredThisWeek}</span> cancellations recovered this week <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
          {filteredRows.length === 0 ? (
            <p className="px-5 pb-5 pt-4 text-[15px] text-(--text-body)">{QUEUE_EMPTY_WHY[queueFilter]}</p>
          ) : (
            <>
              {/* Desktop table — the §5.3 seven columns. */}
              <div className="hidden px-0 pb-3 md:block">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-(--table-border-strong) text-xs uppercase tracking-wide text-(--text-caption)">
                      <th className="px-5 py-2 font-medium">Client</th>
                      <th className="px-3 py-2 font-medium">Stage</th>
                      <th className="px-3 py-2 font-medium">Appointment</th>
                      <th className="px-3 py-2 font-medium">Last Contact</th>
                      <th className="px-3 py-2 font-medium">Priority</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-5 py-2 text-right font-medium">
                        <span className="inline-flex items-center gap-1">
                          Action
                          <InfoTip
                            label="About the action links"
                            tip="Opens this client's record — Laura works in Acuity and GHL; the dashboard tracks and never contacts anyone."
                          />
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => (
                      <QueueRow key={row.appointmentId} row={row} compact={false} />
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Phones — the card list pairing. */}
              <div className="space-y-2 px-5 pb-5 pt-3 md:hidden">
                {filteredRows.map((row) => (
                  <QueueRow key={row.appointmentId} row={row} compact={true} />
                ))}
              </div>
            </>
          )}
        </Panel>
      </section>

      {/* §5.4 + §5.5 — Performance (span 7) beside Impact (span 5) in the
          12-col flow; they stack on mobile. */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
        <section aria-label="This Week's Retention Performance" className="xl:col-span-7">
          <Panel className="h-full overflow-hidden">
            <p className="section-heading flex items-center gap-1.5 px-5 pt-5">
              This Week&rsquo;s Retention Performance
              <InfoTip
                label="How these are computed"
                tip={`Contact Compliance = spoke with ÷ clients due. Clients Reached = the clients due who have a verified conversation. The cancellation family (Saves, Reschedules, Recovery Rate) reads the cancellations ledger. Exact formulas: ${formulaOf("compliance")} · ${formulaOf("spoken-with")} · ${formulaOf("saves")} · ${formulaOf("reschedules")} · ${formulaOf("recovery")}. ${CANCELLATIONS_ENGINE_NOTE}`}
              />
            </p>
            <div className="mt-4 grid grid-cols-2 gap-y-5 pb-5 sm:grid-cols-3 xl:grid-cols-6 xl:divide-x xl:divide-(--table-border-weak)">
              <div className="px-5 py-1">
                <p className="kpi-label flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-blue-dot)" aria-hidden="true" />
                  Contact Compliance
                </p>
                <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{compliance.ratio == null ? num("—") : pct(compliance.ratio)}</p>
                <p className="kpi-sub mt-1.5">Share of this week&rsquo;s due clients</p>
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
              {/* Stage-5 transfers — the written ledger, display-scoped. The
                  share rate exists only when a real denominator exists
                  (tracked cancellations cancelled this week); otherwise an
                  honest — (never a fabricated 0%). */}
              <div className="px-5 py-1">
                <p className="kpi-label flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-purple-dot)" aria-hidden="true" />
                  This Week Transfers
                </p>
                <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{num(String(data.transfersThisWeek ?? 0))}</p>
                <p className="kpi-sub mt-1.5">
                  {data.transfersRate == null ? "No tracked cancellations this week" : `${pct(data.transfersRate)} of tracked cancellations`}
                </p>
              </div>
            </div>
          </Panel>
        </section>

        <section aria-label="Retention Impact" className="xl:col-span-5">
          <Panel className="h-full overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
              <p className="section-heading flex items-center gap-1.5">
                Retention Impact
                <InfoTip
                  label="How No-Shows are counted"
                  tip={`No-Shows = sessions whose appointment time has passed while still marked scheduled (the same counting as the drill-down). Exact formula: ${formulaOf("no-shows")}. The spoken comparison answers the long-term question: do excitement calls actually reduce no-shows?`}
                />
              </p>
              <Link to="/retention-drill" search={{ kpi: "no-shows" }} className="text-xs font-medium text-(--text-caption) underline-offset-2 hover:underline">
                Compare in the drill-down <span aria-hidden="true">→</span>
              </Link>
            </div>
            <div className="px-5 pb-5 pt-3">
              {/* §5.5 — a titled mini-list with room for the future metrics
                  (show rate, save rate, revenue protected) — each row appears
                  only when a real loader exists; no placeholder cells. */}
              <p className="kpi-label text-(--text-caption)">No-Show Comparison</p>
              <p className="kpi-label mt-2 flex items-center gap-1.5 text-(--ret-red-fg)">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-red-dot)" aria-hidden="true" />
                No-Shows
              </p>
              <p className="mt-1.5 text-5xl font-semibold tracking-tight tabular-nums text-(--text-primary)">{num(String(noShows.value ?? 0))}</p>
              <div className="mt-3 flex flex-col gap-1.5 text-[15px] text-(--text-body)">
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-(--ret-green-dot)" aria-hidden="true" />
                  <span>
                    <span className="font-semibold tabular-nums">{noShows.spokenSplit?.spoken ?? 0}</span> had spoken with {ownerFirst}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-(--ret-amber-dot)" aria-hidden="true" />
                  <span>
                    <span className="font-semibold tabular-nums">{noShows.spokenSplit?.notSpoken ?? 0}</span> had not spoken with {ownerFirst}
                  </span>
                </span>
              </div>
              <p className="kpi-sub mt-3">Over time this answers: do excitement calls actually reduce no-shows?</p>
            </div>
          </Panel>
        </section>
      </div>

      {/* §5.6 WEEKLY SCORECARD — stage-3c behavior preserved in full (stored
          weeks never rewrite, WeekOfSelect, ?week=, honest "—"); the
          cancellation-family cells now read the STORED row (null stays "—"
          for uncovered weeks) and the zone-2 labels speak human. */}
      <section aria-label="Weekly scorecard" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
            <div>
              <p className="kpi-label flex flex-wrap items-center gap-2">
                Weekly Scorecard
                <StatusChip kind="neutral" label="Results lock each Monday for the previous week" />
                <InfoTip
                  label="Scoring basis"
                  tip={`Auto-computes every Monday for the prior completed Mon–Sun ET week and is then stored — a stored week is never rewritten, so past weeks render byte-identically forever. The Retention Owner for each week resolves via retention_owner_history effective dates; a week is scored against whoever owned the role that week. Formulas are §16 verbatim. The cancellation-family cells (Cancellations worked, Saves, Reschedules, Recovery rate) read the written ret_cancellations ledger for weeks the ledger covers — older weeks store null and render —. The No-Shows and Transfers cells stay — (never 0): their scorecard writers are follow-ups — the transfers ledger itself IS written (stage 5), but same-appointment staff-move detection is unobservable from stored data, and the scorecard row does not compute transfers yet. ${CANCELLATIONS_ENGINE_NOTE}`}
                />
              </p>
              {scorecard && (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-[15px] font-medium text-(--text-body)">
                  <span>Computed {formatStamp(scorecard.computed_at)} ET</span>
                  <StatusChip kind="neutral" label={`week of ${formatShort(scorecard.week_start)}–${formatShort(scorecard.week_end)}`} />
                </p>
              )}
            </div>
            {scorecard && <WeekOfSelect mondays={mondays} value={scorecard.week_start} onChange={(m) => navigate({ to: "/retention", search: { ...(queueFilter === "all" ? {} : { queue: queueFilter }), week: m } })} />}
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

              {/* Zone 2 — compact metric grid; the cancellation family reads
                  the stored row (null → "—" for uncovered weeks); No-Shows and
                  Transfers stay honest "—" until a writer exists. */}
              <div className="mt-6 grid grid-cols-2 gap-y-5 border-t border-(--table-border-weak) pt-5 sm:grid-cols-4 xl:grid-cols-6">
                <KpiMid label="Clients due" value={scorecard.eligible} sub="The week's due clients" />
                <KpiMid label="Contact attempted" value={scorecard.called} sub={`${pct(scorecard.compliance_attempt)} of eligible`} />
                <KpiMid label="Still unreached" value={scorecard.unreached} sub="No answer / unclear" />
                <KpiMid label="Cancellations worked" value={scorecard.cancellations_worked ?? "—"} sub="Tracked in the week" />
                <KpiMid label="Saves" value={scorecard.saves ?? "—"} sub="Original appointment kept" />
                <KpiMid label="Reschedules" value={scorecard.reschedules ?? "—"} sub="Rebooked within the window" />
                <KpiMid label="Recoveries" value={scorecard.recoveries ?? "—"} sub="Saved or rescheduled" />
                <KpiMid label="Recovery rate" value={scorecard.recovery_rate == null ? "—" : pct(scorecard.recovery_rate)} sub="Recovered, of tracked" />
                <KpiMid label="No-Shows" value="—" />
                <KpiMid label="Transfers" value="—" sub="Deferred — scorecard writer is a follow-up" />
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

      {/* §5.8 DATA QUALITY — demoted and quiet (one small line): fixing data
          is NOT as prominent as contacting clients. Purple/gray. */}
      <section aria-label="Data Quality" className="mt-4">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-5 py-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-(--text-caption)">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ret-purple-dot)" aria-hidden="true" />
              Data Quality
              <InfoTip
                label="About Data Quality"
                tip={`System-health counts, not client work: unmatched records are contacts the identity chain could not tie to a client (they resolve in the exceptions workspace); records requiring review have conflicting contact evidence. ${formulaOf("match-exceptions")} · ${formulaOf("needs-review")}`}
              />
            </p>
            <Link to="/retention-drill" search={{ kpi: "match-exceptions", exc: "open" }} className="text-xs text-(--text-caption) underline-offset-2 hover:underline">
              <span className="font-semibold tabular-nums text-(--text-primary)">{matchExceptions.value ?? 0}</span> unmatched records
            </Link>
            <Link to="/retention-drill" search={{ kpi: "needs-review" }} className="text-xs text-(--text-caption) underline-offset-2 hover:underline">
              <span className="font-semibold tabular-nums text-(--text-primary)">{needsReview.value ?? 0}</span> records requiring review
            </Link>
          </div>
        </Panel>
      </section>

      {/* §5.9 Method footer — computed stamp + who owns the role; exact
          formulas behind the InfoTip (human language on the surface). */}
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

/** §5.1 Row B — one demoted supporting count: quiet label + value, linked to
    its drill-down. Neutral on purpose (system context, not client work). */
function SecondaryCount({ label, value, kpi }: { label: string; value: number | null; kpi: RetentionKpiKey }) {
  return (
    <Link to="/retention-drill" search={{ kpi }} className="group block rounded focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none">
      <p className="kpi-label text-(--text-caption)">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-(--text-primary) group-hover:underline">
        {value == null ? num("—") : num(String(value))}
      </p>
    </Link>
  );
}

/** The priority cell (§5.3): a small neutral chip with the segment dot —
    "1 · Save now", "2 · Call" (window-closing rows add the caution dot),
    "4 · Salvage", "5 · Records". The rank is the LOADER's derivation, the
    same one the list is sorted by. */
function PriorityChip({ row }: { row: RetentionQueueRow }) {
  const tone = SEGMENT_TONE[row.segment];
  return (
    <span className="chip bg-(--chip-neutral-bg) text-(--chip-neutral-fg)">
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
      {row.priority} · {RETENTION_PRIORITY_LABEL[row.priority]}
      {row.windowClosing ? <span className="h-1.5 w-1.5 rounded-full bg-(--dot-caution)" aria-hidden="true" /> : null}
    </span>
  );
}

/** One queue row: a desktop <tr> or a phone card (md:hidden pairing). The
    Action cell is the row's link into the pre-filtered drill-down — a LINK,
    never a mutating button (spec §4.4). Transfer rows have NO drill home, so
    the Action cell is an honest "—" (a link to the wrong list would be a
    fabrication). */
function QueueRow({ row, compact }: { row: RetentionQueueRow; compact: boolean }) {
  const tone = SEGMENT_TONE[row.segment];
  const drillSearch =
    row.drillKpi === "clients-due"
      ? { kpi: "clients-due", range: "this-week" } as const
      : row.drillKpi === "unreached"
        ? { kpi: "unreached", range: "all" } as const
        : row.drillKpi === "active-cancellations"
          ? { kpi: "active-cancellations", range: "all" } as const
          : row.drillKpi === "needs-review"
            ? { kpi: "needs-review", range: "all", classification: "needs_review" } as const
            : null; // transfers — no drill mode exists; the Action cell renders —
  const appointment = row.apptDateEt ? `${formatShort(row.apptDateEt)}${row.apptTimeEt ? ` · ${row.apptTimeEt}` : ""}` : "—";
  const client = row.clientName ?? "Unnamed client";
  // D1 — last contact ("Oct 20", or "— none yet" when nothing is recorded).
  const lastContact = row.lastAttemptAt ? formatDay(row.lastAttemptAt) : null;
  // D2 — the window line under the appointment (derived at load, never at render).
  const windowLine =
    row.segment === "cancellation"
      ? row.dueDate
        ? `cancelled ${formatShort(row.dueDate)}`
        : "cancelled —"
      : row.segment === "transfer"
        ? row.dueDate
          ? `transferred ${formatShort(row.dueDate)}`
          : "transferred —"
        : row.segment === "window-missed"
          ? "window closed"
          : row.windowCloses
            ? row.windowClosing
              ? `window closes today, ${formatTime(row.windowCloses)}`
              : `window closes ${formatDayTime(row.windowCloses)}`
            : `due ${formatShort(row.dueDate)}`;
  if (compact) {
    const cardBody = (
      <>
        <p className="flex items-center justify-between gap-2">
          <span className="font-medium text-(--text-primary)">{client}</span>
          <span className="text-xs text-(--text-caption)">{appointment}</span>
        </p>
        <p className="mt-1 text-xs text-(--text-muted)">
          {windowLine}
          <span aria-hidden="true"> · </span>
          Last contact {lastContact ?? "— none yet"}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`chip ${tone.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
            {SEGMENT_REASON[row.segment]}
          </span>
          <PriorityChip row={row} />
        </p>
        <p className="mt-2 text-sm text-(--text-body)">
          {row.statusLabel}
          {row.attemptsCount > 0 ? ` · ${row.attemptsCount} attempt${row.attemptsCount === 1 ? "" : "s"}` : ""}
        </p>
        {row.drillKpi == null ? (
          <p className="mt-2 text-xs text-(--text-muted)">No in-app action — tracked for awareness</p>
        ) : (
          <p className="mt-2 text-xs font-medium text-(--text-primary)">{row.actionLabel} →</p>
        )}
      </>
    );
    return drillSearch ? (
      <Link
        to="/retention-drill"
        search={drillSearch}
        className="block rounded-lg border border-(--card-border) bg-(--card-bg) px-4 py-3 transition-colors hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
      >
        {cardBody}
      </Link>
    ) : (
      <div className="block rounded-lg border border-(--card-border) bg-(--card-bg) px-4 py-3">{cardBody}</div>
    );
  }
  return (
    <tr className="border-b border-(--table-border-weak) last:border-b-0 hover:bg-(--hover-row)">
      <td className="px-5 py-2.5 font-medium text-(--text-primary)">{client}</td>
      <td className="px-3 py-2.5">
        <span className={`chip ${tone.chip}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
          {SEGMENT_REASON[row.segment]}
        </span>
      </td>
      <td className="px-3 py-2.5 tabular-nums text-(--text-body)">
        {appointment}
        <span className="block text-xs text-(--text-muted)">{windowLine}</span>
      </td>
      <td className="px-3 py-2.5 tabular-nums text-(--text-body)">
        {lastContact ?? <span className="text-(--text-muted)">— none yet</span>}
      </td>
      <td className="px-3 py-2.5">
        <PriorityChip row={row} />
      </td>
      <td className="px-3 py-2.5 text-(--text-body)">
        {row.statusLabel}
        {row.attemptsCount > 0 ? <span className="block text-xs text-(--text-muted)">{row.attemptsCount} attempt{row.attemptsCount === 1 ? "" : "s"}</span> : null}
      </td>
      <td className="px-5 py-2.5 text-right">
        {drillSearch ? (
          <Link
            to="/retention-drill"
            search={drillSearch}
            className="inline-flex items-center gap-1 rounded text-sm font-medium text-(--text-primary) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
          >
            {row.actionLabel}
            <span aria-hidden="true">→</span>
          </Link>
        ) : (
          <span className="text-(--text-muted)">—</span>
        )}
      </td>
    </tr>
  );
}
