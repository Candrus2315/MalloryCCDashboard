import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  addPipCheckin,
  cancelPip,
  completePip,
  getPerformanceList,
  getPipDetail,
  getPipEvidence,
  listPipTemplates,
  recordPipAck,
  type PipLandingItem,
} from "~/server/pip-api";
import type { PipDetail } from "~/server/pip-api";
import type { PipEvidence } from "~/server/pip-evidence";
import type { PipCheckinRow } from "~/server/store/types";
import { EmptyState, Field, PerformanceShell, PipStatusChip, GhostButton, inputClass } from "~/components/performance-shell";
import { AttentionPanel } from "~/components/AttentionPanel";
import { DetailDrawer } from "~/components/DetailDrawer";
import { GoalProgress } from "~/components/GoalProgress";
import { InfoTip } from "~/components/InfoTip";
import { StatusChip } from "~/components/StatusChip";
import { WarningList } from "~/components/warnings";
import type { AttentionNote } from "~/components/today-views";

/** Owner ruling 9/30: statuses are FILTER CHIPS on one list, not separate pages. */
const STATUS_FILTERS = ["issued", "draft", "completed", "cancelled", "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const FILTER_LABEL: Record<StatusFilter, string> = {
  issued: "Active",
  draft: "Drafts",
  completed: "Completed",
  cancelled: "Cancelled",
  all: "All",
};
function isStatusFilter(v: unknown): v is StatusFilter {
  return typeof v === "string" && (STATUS_FILTERS as readonly string[]).includes(v);
}

type SortKey = "days" | "checkins" | "employee" | "window";

/**
 * Spec §5 microcopy migration: policy lives in the header InfoTip, one per
 * status filter; the visible line stays operational.
 */
const FILTER_TIP: Record<StatusFilter, string> = {
  issued: "The issued document is a permanent frozen snapshot — check-ins append; conclusions and cancellations are explicit manager actions.",
  draft: "Issue freezes the document permanently as version 1 — corrections only via documented amendment. A draft needs a goal and PIP start/end dates before it can issue.",
  completed: "The issued document is a permanent frozen snapshot — completed plans keep the exact content they were issued with.",
  cancelled: "Ending a plan records the reason permanently; the issued document itself is never rewritten.",
  all: "Every record, every status — the issued document is a permanent frozen snapshot; conclusions and cancellations are explicit manager actions.",
};

type PipSearch = { status?: string; sort?: string; p?: string };

export const Route = createFileRoute("/performance")({
  validateSearch: (search: Record<string, unknown>): PipSearch => ({
    status: typeof search.status === "string" ? search.status : undefined,
    sort: typeof search.sort === "string" ? search.sort : undefined,
    p: typeof search.p === "string" ? search.p : undefined,
  }),
  loader: () => getPerformanceList(),
  component: PipsPage,
});

/** Sort with the spec's default: days remaining ascending; nulls last. */
function sortRows(rows: PipLandingItem[], key: SortKey, dir: "asc" | "desc"): PipLandingItem[] {
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: PipLandingItem, b: PipLandingItem): number => {
    switch (key) {
      case "days": {
        const da = a.days_left ?? Number.POSITIVE_INFINITY;
        const db = b.days_left ?? Number.POSITIVE_INFINITY;
        return da === db ? nameCmp(a, b) : da - db;
      }
      case "checkins": {
        const oa = a.checkin_overdue ? 0 : a.next_checkin_date ? 1 : 2;
        const ob = b.checkin_overdue ? 0 : b.next_checkin_date ? 1 : 2;
        if (oa !== ob) return oa - ob;
        const na = a.next_checkin_date ?? "9999-12-31";
        const nb = b.next_checkin_date ?? "9999-12-31";
        return na === nb ? nameCmp(a, b) : na.localeCompare(nb);
      }
      case "window": {
        const wa = a.pip_start_date ?? "9999-12-31";
        const wb = b.pip_start_date ?? "9999-12-31";
        return wa === wb ? nameCmp(a, b) : wa.localeCompare(wb);
      }
      case "employee":
        return nameCmp(a, b);
    }
  };
  return [...rows].sort((a, b) => sign * cmp(a, b));
}
function nameCmp(a: PipLandingItem, b: PipLandingItem): number {
  const na = a.rep_name ?? "";
  const nb = b.rep_name ?? "";
  return na === nb ? a.title.localeCompare(b.title) : na.localeCompare(nb);
}

/** Human ET date for stored YYYY-MM-DD or ISO stamps ("Sep 30"). */
function etShort(dateStr: string): string {
  const src = dateStr.length > 10 ? dateStr : `${dateStr}T12:00:00Z`;
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(
    new Date(Date.parse(src)),
  );
}
function etDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.parse(iso));
}

function PipsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const filter: StatusFilter = isStatusFilter(search.status) ? search.status : "issued";
  const all = data.pips;
  const counts: Record<StatusFilter, number> = {
    issued: all.filter((p) => p.status === "issued").length,
    draft: all.filter((p) => p.status === "draft").length,
    completed: all.filter((p) => p.status === "completed").length,
    cancelled: all.filter((p) => p.status === "cancelled").length,
    all: all.length,
  };
  const shown0 = filter === "all" ? all : all.filter((p) => p.status === filter);
  const sortKey: SortKey = search.sort === "checkins" ? "checkins" : search.sort === "employee" ? "employee" : search.sort === "window" ? "window" : "days";
  const shown = useMemo(() => sortRows(shown0, sortKey, "asc"), [shown0, sortKey]);

  // Template names for record chips ("Template: {name} v{n}") — read-only.
  const [templatesById, setTemplatesById] = useState<Map<string, { name: string; version: number }>>(new Map());
  useEffect(() => {
    let alive = true;
    listPipTemplates().then((t) => {
      if (alive) setTemplatesById(new Map(t.templates.map((x) => [x.id, { name: x.name, version: x.version }])));
    });
    return () => {
      alive = false;
    };
  }, []);

  // Attention-panel deep link (?p=<pipId>) opens that PIP's Manage drawer.
  const [openPipId, setOpenPipId] = useState<string | null>(search.p ?? null);
  useEffect(() => {
    if (search.p) setOpenPipId(search.p);
  }, [search.p]);
  const openPip = openPipId ? (all.find((p) => p.id === openPipId) ?? null) : null;

  const attentionNotes: AttentionNote[] = useMemo(
    () =>
      all
        .filter((p) => p.attention)
        .sort((a, b) => (a.attention!.rank - b.attention!.rank) || (a.rep_name ?? "").localeCompare(b.rep_name ?? ""))
        .map((p) => ({
          severity: "risk" as const,
          text: p.attention!.text,
          rep: p.rep_name ?? "",
          href: `/performance?status=issued&p=${p.id}`,
        })),
    [all],
  );

  const activeCount = counts.issued;

  return (
    <PerformanceShell
      path="/performance"
      headerAction={
        <button type="button" className="btn-primary" onClick={() => navigate({ to: "/performance-new" })}>
          New PIP
        </button>
      }
      tabCounts={{ pips: all.length }}
    >
      {/* demo-mode banner: in-memory store = not live data */}
      {data.mode === "memory" && (
        <div className="status-banner status-banner-warn" role="status">
          Demo data — the database is unreachable; these are sample records, not production PIPs.
        </div>
      )}
      {data.warnings.length > 0 && (
        <div className="mt-2">
          <WarningList items={data.warnings} />
        </div>
      )}

      {/* Management status strip (spec §3A): the owner's four metrics + the
          remaining lifecycle counts, one compact strip. Counts visible but not
          enormous; each cell links to the filtered/sorted view it summarizes. */}
      <div className="card mt-1 overflow-hidden p-0">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6">
          <KpiCell
            to="/performance?status=issued"
            label="Active PIPs"
            labelTip="Issued plans currently in force. Counts only — never scores."
            value={activeCount}
            sub={
              data.kpis.past_end > 0 ? (
                <SubLine tone="risk" dot>{data.kpis.past_end} past end date</SubLine>
              ) : null
            }
          />
          <KpiCell
            to="/performance?status=issued&sort=checkins"
            label="Check-ins due"
            labelTip="Active PIPs whose next check-in date has passed (America/New_York). Rule-based from stored dates."
            value={data.kpis.checkins_due}
            sub={
              data.kpis.checkins_due > 0 ? (
                <StatusChip kind="risk" label="Action needed" />
              ) : (
                <span className="text-xs text-(--text-muted)">None overdue</span>
              )
            }
            cellClass="border-l border-(--table-border-weak)"
          />
          <KpiCell
            to="/performance?status=issued&sort=days"
            label="PIPs ending soon"
            labelTip="Counts active PIPs whose window ends in 3 calendar days or fewer (America/New_York), including any already past their end date but not yet closed. Fixed date math — the threshold never varies."
            value={data.kpis.ending_soon}
            sub={
              data.kpis.ending_soon > 0 ? (
                <SubLine tone="risk" dot>{data.kpis.ending_soon} due within 3 days</SubLine>
              ) : null
            }
            cellClass="border-(--table-border-weak) border-t sm:border-t-0 sm:border-l"
          />
          <KpiCell
            to="/performance?status=draft"
            label="Drafts"
            labelTip="Editable plans, private to managers; never visible to employees."
            value={data.kpis.drafts}
            cellClass="border-(--table-border-weak) border-t border-l sm:border-l-0 md:border-t-0 md:border-l"
          />
          <KpiCell
            to="/performance?status=completed"
            label="Completed"
            labelTip="Plans closed as completed — the issued record is immutable."
            value={counts.completed}
            cellClass="border-(--table-border-weak) border-t sm:border-l md:border-t-0"
          />
          <KpiCell
            to="/performance?status=cancelled"
            label="Cancelled"
            labelTip="Plans ended without completion — the reason is part of the permanent record."
            value={counts.cancelled}
            cellClass="border-(--table-border-weak) border-t border-l md:border-t-0"
          />
        </div>
      </div>

      {/* PIP attention (WHO NEEDS ATTENTION) */}
      <div className="mt-8">
        <AttentionPanel
          title="PIP attention"
          subtitle="Rule-based from PIP dates and stored check-ins — no scores."
          allClear="Nothing needs attention — no overdue check-ins, no windows past their end date, and no check-in left unscheduled."
          notes={attentionNotes}
        />
      </div>

      {/* Plans — the primary content (filter chips + management table); the
          New PIP action lives in the page header, not above the table */}
      <section className="mt-8" aria-label="Plans">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[13px] text-(--text-caption)">
            {filter === "draft"
              ? "Editable drafts."
              : filter === "all"
                ? "Every record, every status."
                : filter === "issued"
                  ? "Issued plans in force."
                  : filter === "completed"
                    ? "Closed plans."
                    : "Plans ended without completion."}
            <InfoTip tip={FILTER_TIP[filter]} />
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Status filter">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              className={
                "rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors " +
                (filter === f
                  ? "border-transparent bg-(--accent-solid) text-(--accent-solid-fg)"
                  : "border-(--card-border) bg-(--card-bg) text-(--text-caption) hover:border-(--input-border) hover:text-(--text-primary)")
              }
              onClick={() => navigate({ to: "/performance", search: { status: f } })}
            >
              {FILTER_LABEL[f]} <span className="tabular-nums">{counts[f]}</span>
            </button>
          ))}
        </div>

        <div className="mt-4">
          {shown.length === 0 ? (
            <EmptyState
              title={filter === "issued" ? "No active PIPs" : `No ${FILTER_LABEL[filter].toLowerCase()} PIPs`}
              hint={
                filter === "issued"
                  ? "There are currently no issued performance plans."
                  : filter === "draft"
                    ? "Start a draft from the New PIP button or from a template."
                    : "Nothing recorded under this status yet."
              }
              action={
                filter === "issued" ? (
                  <button type="button" className="btn-primary" onClick={() => navigate({ to: "/performance-new" })}>
                    Create PIP
                  </button>
                ) : filter === "draft" ? (
                  <Link to="/performance-templates" className="btn-secondary">
                    Browse templates
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <PipRowsTable
              rows={shown}
              filter={filter}
              sortKey={sortKey}
              templatesById={templatesById}
              onManage={(id) => setOpenPipId(id)}
            />
          )}
        </div>
      </section>

      {/* Manage drawer (DetailDrawer width=lg) */}
      {openPip && <ManageDrawer pip={openPip} onClose={() => setOpenPipId(null)} />}
    </PerformanceShell>
  );
}

function SubLine({ children, dot }: { children: ReactNode; tone: "risk"; dot?: boolean }) {
  return (
    <span className="mt-1 flex h-5 items-center gap-1.5 text-xs" style={{ color: "var(--chip-risk-fg)" }}>
      {dot && <span aria-hidden="true" className="inline-block h-1 w-1 rounded-full bg-(--dot-caution)" />}
      {children}
    </span>
  );
}

function KpiCell({
  to,
  label,
  labelTip,
  value,
  sub,
  cellClass = "",
}: {
  to: string;
  label: string;
  labelTip: string;
  value: number;
  sub?: ReactNode;
  /** Per-cell divider borders — the strip uses explicit hairlines, not divide-x, so the 2/3/6-col wraps stay clean. */
  cellClass?: string;
}) {
  return (
    <Link
      to={to}
      className={
        "block px-5 py-4 transition-colors hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) md:hover:bg-(--surface-hover) " +
        cellClass
      }
    >
      <span className="kpi-label flex items-center gap-1.5">
        {label}
        <InfoTip tip={labelTip} />
      </span>
      <p className="kpi-mid mt-1 text-2xl font-semibold tabular-nums text-(--text-primary)">{value}</p>
      {sub}
      {!sub && <span className="mt-1 block h-5" aria-hidden="true" />}
    </Link>
  );
}

// ---------- dense active-PIP table (spec §2) ----------

type SortCol = "employee" | "days" | "window" | "checkins";

function PipRowsTable({
  rows,
  filter,
  sortKey,
  templatesById,
  onManage,
}: {
  rows: PipLandingItem[];
  filter: StatusFilter;
  sortKey: SortKey;
  templatesById: Map<string, { name: string; version: number }>;
  onManage: (pipId: string) => void;
}) {
  const navigate = Route.useNavigate();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const showStatus = filter === "all";
  const setSort = (col: SortCol) => {
    void navigate({ to: "/performance", search: { status: filter, sort: col } });
  };
  return (
    <div className="card overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="data-table min-w-[980px] text-[13px]">
          <thead>
            <tr>
              <th scope="col" className="w-6" aria-hidden="true" />
              <th scope="col" className="text-left">
                <SortBtn label="Employee" active={sortKey === "employee"} onClick={() => setSort("employee")} />
              </th>
              <th scope="col" className="text-left">This week</th>
              <th scope="col" className="text-left">Review week</th>
              <th scope="col" className="text-left">
                <SortBtn label="Window" active={sortKey === "window"} onClick={() => setSort("window")} />
              </th>
              <th scope="col" className="text-left" aria-sort={sortKey === "days" ? "ascending" : undefined}>
                <span className="inline-flex items-center gap-1">
                  <SortBtn label="Days left" active={sortKey === "days"} onClick={() => setSort("days")} />
                  <InfoTip tip="Calendar days from today (America/New_York) to the PIP window end. 3 or fewer shows “ending soon”; a passed end date shows “overdue”. Fixed date math." />
                </span>
              </th>
              <th scope="col" className="text-left">
                <SortBtn label="Next check-in" active={sortKey === "checkins"} onClick={() => setSort("checkins")} />
              </th>
              {showStatus && <th scope="col" className="text-left">Status</th>}
              <th scope="col" className="text-right">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const expanded = expandedId === p.id;
              const tpl = p.template_id ? templatesById.get(p.template_id) : undefined;
              return (
                <PipRowChunk
                  key={p.id}
                  pip={p}
                  tpl={tpl}
                  expanded={expanded}
                  showStatus={showStatus}
                  onToggle={() => setExpandedId(expanded ? null : p.id)}
                  onManage={onManage}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={"th-sort-btn text-[12px] font-medium uppercase tracking-wide " + (active ? "text-(--text-primary)" : "text-(--text-muted)")}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
      <span aria-hidden="true" className="ml-0.5">{active ? "↑" : "↕"}</span>
    </button>
  );
}

function PipRowChunk({
  pip,
  tpl,
  expanded,
  showStatus,
  onToggle,
  onManage,
}: {
  pip: PipLandingItem;
  tpl: { name: string; version: number } | undefined;
  expanded: boolean;
  showStatus: boolean;
  onToggle: () => void;
  onManage: (id: string) => void;
}) {
  const navigate = Route.useNavigate();
  const isDraft = pip.status === "draft";
  return (
    <>
      <tr className="align-middle">
        <td className="py-2.5 pr-0">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse row" : "Expand row"}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-(--text-muted) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary)"
            onClick={onToggle}
          >
            <span aria-hidden="true" className="text-[10px]" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
              ▶
            </span>
          </button>
        </td>
        <td className="py-2.5">
          <div className="sticky-cell">
            <p className="font-medium text-(--text-primary)">
              {pip.rep_name ?? (isDraft ? "Unassigned draft" : "—")}
              {pip.ack_awaiting && (
                <span
                  className="chip chip-neutral ml-2 align-middle text-[11px]"
                  title="Issued but no acknowledgment recorded yet — the manager records it during the acknowledgment meeting."
                >
                  ack pending
                </span>
              )}
            </p>
            <p className="mt-0.5 truncate text-[12px] text-(--text-caption)" title={pip.title}>
              {pip.title}
              {tpl && <span className="chip chip-neutral ml-2 align-middle text-[11px]">v{pip.template_version ?? tpl.version}</span>}
            </p>
          </div>
        </td>
        <td className="py-2.5">
          {isDraft || pip.weekly_goal_min == null ? (
            <span className="text-(--text-faint)">—</span>
          ) : (
            <div className="w-[140px]">
              <GoalProgress actual={pip.this_week_wins ?? 0} goal={pip.weekly_goal_min} size="sm" />
              <p className="mt-0.5 text-[12px] text-(--text-caption)">week in progress</p>
            </div>
          )}
        </td>
        <td className="py-2.5">
          {pip.review_week_index != null ? (
            <>
              <p className="tabular-nums">
                Week {pip.review_week_index} of {pip.review_weeks_total}
              </p>
              {pip.weeks_missed != null && pip.weeks_missed > 0 ? (
                <p className="mt-0.5 text-[12px]" style={{ color: "var(--chip-risk-fg)" }}>
                  {pip.weeks_missed} week{pip.weeks_missed === 1 ? "" : "s"} missed
                </p>
              ) : pip.weeks_missed === 0 ? (
                <p className="mt-0.5 text-[12px] text-(--text-caption)">none missed</p>
              ) : null}
            </>
          ) : pip.review_start_date && pip.review_end_date ? (
            <p className="text-[12px] text-(--text-muted)">outside window</p>
          ) : (
            <span className="text-(--text-faint)">—</span>
          )}
        </td>
        <td className="py-2.5 text-(--text-muted)">
          <p className="tabular-nums">
            {pip.pip_start_date ? etShort(pip.pip_start_date) : "—"} – {pip.pip_end_date ? etShort(pip.pip_end_date) : "—"}
          </p>
          <p className="mt-0.5 text-[12px] text-(--text-caption)">{pip.issued_at ? `issued ${etShort(pip.issued_at.slice(0, 10))}` : "draft"}</p>
        </td>
        <td className="py-2.5">
          <p className="font-semibold tabular-nums">{pip.days_left ?? "—"}</p>
          {pip.days_left != null && pip.days_left < 0 && <span className="chip chip-risk mt-0.5 inline-block">overdue</span>}
          {pip.days_left != null && pip.days_left >= 0 && pip.days_left <= 3 && (
            <span className="chip chip-risk mt-0.5 inline-block">ending soon</span>
          )}
        </td>
        <td className="py-2.5">
          {isDraft ? (
            <span className="text-(--text-faint)">—</span>
          ) : pip.next_checkin_date ? (
            <>
              <p className="tabular-nums">{etShort(pip.next_checkin_date)}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-(--text-caption)">
                check-in {pip.checkin_count + 1}
                {pip.checkin_expected_total != null ? ` of ${pip.checkin_expected_total}` : ""}
                {pip.checkin_overdue && <span className="chip chip-risk">overdue</span>}
              </p>
            </>
          ) : (
            <p className="text-[12px] text-(--text-muted)">not scheduled</p>
          )}
        </td>
        {showStatus && (
          <td className="py-2.5">
            <PipStatusChip status={pip.status} />
          </td>
        )}
        <td className="py-2.5 text-right">
          {isDraft ? (
            <GhostButton
              onClick={() => void navigate({ to: "/performance-new", search: { step: "1", pip: pip.id } })}
            >
              Continue draft
            </GhostButton>
          ) : (
            <GhostButton onClick={() => onManage(pip.id)}>Manage</GhostButton>
          )}
        </td>
      </tr>
      {expanded && <PipExpandedRow pip={pip} colSpan={8 + (showStatus ? 1 : 0)} />}
    </>
  );
}

/** Dashboard-goal label for the weekly table: integers plain, fractions 1dp (team-share fallback). */
function goalLabel(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

const WEEK_STATE_LABEL: Record<string, string> = {
  completed: "completed",
  in_progress: "in progress",
  future: "not started",
};

/**
 * Inline expansion (spec §2 two-tier): the WEEKLY GOAL-MET TABLE — per-week
 * minimum tracking through the ONE evidence engine (getPipEvidence, the same
 * function issue freezes). Each week is evaluated individually against the
 * PIP's weekly minimum; weeks are never averaged (owner rule). Right rail:
 * review context — acknowledgment state, next check-in, the goal text.
 */
function PipExpandedRow({ pip, colSpan }: { pip: PipLandingItem; colSpan: number }) {
  const [evidence, setEvidence] = useState<PipEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pip.review_start_date || !pip.review_end_date || !pip.rep_id) return;
    let alive = true;
    getPipEvidence({
      data: {
        repId: pip.rep_id,
        reviewStart: pip.review_start_date,
        reviewEnd: pip.review_end_date,
        weeklyGoalMin: pip.weekly_goal_min,
        hardWeeklyMinimum: pip.hard_weekly_minimum,
      },
    })
      .then((r) => {
        if (alive) setEvidence(r.evidence);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [pip.id, pip.rep_id, pip.review_start_date, pip.review_end_date, pip.weekly_goal_min, pip.hard_weekly_minimum]);

  return (
    <tr>
      <td colSpan={colSpan} className="border-0 bg-(--surface-inset) px-4 pb-4 pt-1">
        <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div>
            <p className="text-[12px] text-(--text-caption)">
              {pip.issued_at
                ? `Captured ${etDateTime(pip.issued_at)} at issue · verified from dashboard data · later dashboard changes never rewrite this record.`
                : "Draft — the document freezes when issued."}
            </p>
            {pip.review_start_date && pip.review_end_date ? (
              evidence ? (
                <div className="mt-2">
                  <div className="overflow-x-auto rounded-md border border-(--table-border-weak) bg-(--card-bg)">
                    <table className="data-table min-w-[560px] text-[12px]" aria-label="Weekly goal-met table">
                      <thead>
                        <tr>
                          <th scope="col" className="text-left">Week</th>
                          <th scope="col" className="text-right">PIP minimum</th>
                          <th scope="col" className="text-right">Dashboard goal</th>
                          <th scope="col" className="text-right">Actual</th>
                          <th scope="col" className="text-left">Met</th>
                          <th scope="col" className="text-left">State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evidence.weekly.map((w) => (
                          <tr key={w.week_start}>
                            <td className="py-1.5 tabular-nums">
                              {etShort(w.clamped_start)}
                              {w.clamped_start !== w.clamped_end ? <>–{etShort(w.clamped_end)}</> : null}
                            </td>
                            <td className="py-1.5 text-right tabular-nums">{w.pip_goal ?? "—"}</td>
                            <td
                              className="py-1.5 text-right tabular-nums text-(--text-caption)"
                              title={w.dashboard_goal_note ?? undefined}
                            >
                              {w.dashboard_goal == null ? "—" : goalLabel(w.dashboard_goal)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums">{w.actual == null ? "—" : w.actual}</td>
                            <td className="py-1.5">
                              {w.met === true ? (
                                <span className="chip chip-positive">met</span>
                              ) : w.met === false ? (
                                <span className="chip chip-risk">not met</span>
                              ) : (
                                <span className="text-(--text-faint)">—</span>
                              )}
                            </td>
                            <td className="py-1.5 text-(--text-caption)">{WEEK_STATE_LABEL[w.state] ?? w.state}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1.5 flex items-center gap-1 text-[11px] text-(--text-muted)">
                    {evidence.weeks_goal_met}/{evidence.weeks_completed} weeks met
                    <InfoTip
                      className="inline-flex align-middle"
                      tip="Each week is evaluated individually against the weekly minimum; weeks are never averaged. The dashboard goal column is provenance (rep goal or team share) — the met evaluation uses the PIP's own minimum."
                    />
                  </p>
                </div>
              ) : error ? (
                <p className="mt-2 text-[12px]" style={{ color: "var(--neg-text)" }}>{error}</p>
              ) : (
                <p className="mt-2 text-[12px] text-(--text-muted)">Loading weekly evidence…</p>
              )
            ) : (
              <p className="mt-2 text-[12px] text-(--text-muted)">No review period set.</p>
            )}
          </div>
          <div className="text-[12px] text-(--text-caption)">
            {pip.status === "issued" && (
              <p>
                {pip.ack_awaiting ? (
                  <>
                    <span style={{ color: "var(--chip-risk-fg)" }}>Acknowledgment not yet recorded</span>
                    {" "}— recorded by the manager during the acknowledgment meeting.
                  </>
                ) : pip.manager_acked_at ? (
                  <>Acknowledgment recorded {etShort(pip.manager_acked_at.slice(0, 10))}{pip.manager_acked_by ? ` by ${pip.manager_acked_by}` : ""}.</>
                ) : null}
              </p>
            )}
            {pip.next_checkin_date ? (
              <p className={pip.ack_awaiting ? "mt-1" : undefined}>
                Next check-in {etShort(pip.next_checkin_date)}
                {pip.checkin_overdue ? " — overdue" : ""}
              </p>
            ) : pip.status === "issued" ? (
              <p className={pip.ack_awaiting ? "mt-1" : undefined}>Next check-in not scheduled</p>
            ) : null}
            {pip.goal_text && <p className="mt-1 line-clamp-2 text-(--text-body)">{pip.goal_text}</p>}
          </div>
        </div>
      </td>
    </tr>
  );
}

// ---------- check-in timeline (Phase 3: logged check-ins + pending node) ----------

/**
 * Vertical timeline of a PIP's check-ins: oldest → newest, each node showing
 * the date, manager, and the recorded fields that exist (honest sparse
 * rendering — nothing invented). The final PENDING node renders the next
 * scheduled check-in with the SERVER-derived overdue state (pip.checkin_overdue
 * — a scheduled date that has passed, America/New_York); no logged check-ins
 * yet renders the muted empty line above the pending node.
 */
function CheckinTimeline({
  checkins,
  nextCheckinDate,
  overdue,
}: {
  checkins: PipCheckinRow[];
  nextCheckinDate: string | null;
  overdue: boolean;
}) {
  const sorted = [...checkins].sort(
    (a, b) => a.checkin_date.localeCompare(b.checkin_date) || a.created_at.localeCompare(b.created_at),
  );
  return (
    <ol className="relative ml-1 border-l border-(--table-border-weak) pl-4">
      {sorted.length === 0 && <p className="mb-2 text-[12px] text-(--text-muted)">No check-ins yet — the log starts at issue.</p>}
      {sorted.map((c) => (
        <li key={c.id} className="relative pb-4">
          <span aria-hidden="true" className="absolute top-1.5 -left-[21px] h-2 w-2 rounded-full bg-(--dot-muted)" />
          <p className="text-[12px] font-medium text-(--text-primary)">
            {etShort(c.checkin_date)}
            {c.manager_name ? ` · ${c.manager_name}` : ""}
          </p>
          {c.current_performance && <p className="mt-1 text-[13px] leading-relaxed text-(--text-body)">{c.current_performance}</p>}
          {c.topics_discussed && <p className="mt-1 text-[12px] text-(--text-body)">Topics: {c.topics_discussed}</p>}
          {c.coaching_provided && <p className="mt-1 text-[12px] text-(--text-body)">Coaching: {c.coaching_provided}</p>}
          {c.employee_comments && <p className="mt-1 text-[12px] text-(--text-body)">Employee: {c.employee_comments}</p>}
          {c.manager_notes && <p className="mt-1 text-[12px] text-(--text-muted)">{c.manager_notes}</p>}
          {c.next_checkin_date && (
            <p className="mt-1 text-[12px] text-(--text-caption)">Next check-in recorded: {etShort(c.next_checkin_date)}</p>
          )}
        </li>
      ))}
      <li className="relative pt-1">
        <span
          aria-hidden="true"
          className={
            "absolute top-2 -left-[21px] h-2 w-2 rounded-full " +
            (overdue ? "bg-(--dot-caution)" : "border border-(--card-border) bg-(--card-bg)")
          }
        />
        <p className="text-[12px] font-medium text-(--text-muted)">
          {nextCheckinDate ? `Next check-in scheduled ${etShort(nextCheckinDate)}` : "Next check-in not scheduled"}
          {overdue && <span className="chip chip-risk ml-2">overdue</span>}
        </p>
      </li>
    </ol>
  );
}

// ---------- Manage drawer (spec §2: DetailDrawer width=lg, bands) ----------

function ManageDrawer({ pip, onClose }: { pip: PipLandingItem; onClose: () => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<PipDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [checkinDate, setCheckinDate] = useState(new Date().toISOString().slice(0, 10));
  const [checkinNotes, setCheckinNotes] = useState("");
  const [nextCheckin, setNextCheckin] = useState("");
  const isDraft = pip.status === "draft";

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Typed await: the server-fn client proxy collapses `PipDetail | null`
      // to unknown/{} in this framework version — the imported interface keeps
      // the real shape at the call site (same fix as the wizard, Unit 6).
      const d = (await getPipDetail({ data: { pipId: pip.id } })) as PipDetail | null;
      if (alive) setDetail(d);
    })();
    return () => {
      alive = false;
    };
  }, [pip.id]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await router.invalidate();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailDrawer
      open
      onClose={onClose}
      width="lg"
      title={pip.title}
      contextLines={[
        pip.rep_name ?? (isDraft ? "Unassigned draft" : "—"),
        `${pip.pip_start_date ?? "—"} → ${pip.pip_end_date ?? "—"}${pip.days_left != null ? ` · ${Math.abs(pip.days_left)} days ${pip.days_left < 0 ? "past end" : "left"}` : ""}`,
      ]}
    >
      {error && <p className="mb-3 rounded-md bg-(--surface-subtle) px-3 py-2 text-[12px]" style={{ color: "var(--neg-text)" }}>{error}</p>}

      {/* Record band: goal + observations as manager-note insets */}
      <div className="rounded-md bg-(--surface-inset) px-3 py-3">
        <p className="text-[12px] font-medium uppercase tracking-wide text-(--text-caption)">Goal</p>
        <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-(--text-body)">{pip.goal_text ?? "—"}</p>
        {pip.manager_observations && (
          <>
            <p className="mt-3 text-[12px] font-medium uppercase tracking-wide text-(--text-caption)">
              Manager observations
              <InfoTip className="ml-1.5" tip="Recorded by the manager; part of the issued document." />
            </p>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-(--text-body)">{pip.manager_observations}</p>
          </>
        )}
      </div>
      <p className="mt-2 text-[12px] text-(--text-muted)">
        {pip.issued_at
          ? `Captured ${etDateTime(pip.issued_at)} at issue · verified from dashboard data · later dashboard changes never rewrite this record.`
          : "Draft — editable until issued."}
      </p>
      {/* Phase 4: acknowledgment state + ACTION — the manager records the
          acknowledgment (no employee logins); recording is an audited mutation
          that stamps manager_acked_at/by, so the EXISTING ack_awaiting
          derivation clears the "ack pending" chip and the rank-4 attention
          line with no second derivation path. */}
      {pip.ack_awaiting ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-(--card-border) px-3 py-2.5">
          <p className="text-[12px]" style={{ color: "var(--chip-risk-fg)" }}>
            Acknowledgment not yet recorded — the manager records it during the acknowledgment meeting.
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-[12px] text-(--text-muted)">changes are audited</span>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => run(() => recordPipAck({ data: { pipId: pip.id } }))}
            >
              Record acknowledgment
            </button>
          </div>
        </div>
      ) : pip.manager_acked_at ? (
        <p className="mt-1 text-[12px] text-(--text-muted)">
          Acknowledgment recorded {etShort(pip.manager_acked_at.slice(0, 10))}
          {pip.manager_acked_by ? ` by ${pip.manager_acked_by}` : ""}.
        </p>
      ) : null}

      {isDraft ? (
        <p className="mt-4 text-[13px] text-(--text-muted)">
          Drafts are edited in the guided creation flow.
        </p>
      ) : (
        <>
          {/* Check-in TIMELINE (Phase 3): logged check-ins on a vertical rail,
              oldest → newest, then the pending next check-in with the
              server-derived overdue detection (pip.checkin_overdue). */}
          <div className="mt-6">
            <p className="section-heading">Check-in timeline ({detail?.checkins.length ?? 0})</p>
            <div className="mt-2">
              <CheckinTimeline
                checkins={detail?.checkins ?? []}
                nextCheckinDate={pip.next_checkin_date}
                overdue={pip.checkin_overdue}
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Field label="Check-in date">
                <input type="date" className={inputClass} value={checkinDate} onChange={(e) => setCheckinDate(e.target.value)} />
              </Field>
              <Field label="Next check-in (optional)">
                <input type="date" className={inputClass} value={nextCheckin} onChange={(e) => setNextCheckin(e.target.value)} />
              </Field>
            </div>
            <Field label="Notes (performance, topics, coaching, next actions)">
              <textarea className={inputClass + " mt-1 min-h-[64px]"} value={checkinNotes} onChange={(e) => setCheckinNotes(e.target.value)} />
            </Field>
            <div className="mt-2 flex items-center justify-end gap-3">
              <span className="text-[12px] text-(--text-muted)">changes are audited</span>
              <button
                type="button"
                disabled={busy || !checkinDate || !checkinNotes.trim()}
                className="btn-primary"
                onClick={() =>
                  run(() =>
                    addPipCheckin({
                      data: {
                        pipId: pip.id,
                        checkinDate,
                        currentPerformance: checkinNotes,
                        managerNotes: checkinNotes,
                        nextCheckinDate: nextCheckin || null,
                        managerName: "christopher",
                      },
                    }),
                  )
                }
              >
                Add check-in
              </button>
            </div>
          </div>

          {/* Close-plan band: Complete + Cancel side by side */}
          <div className="mt-8">
            <hr className="border-(--card-border)" />
            <p className="section-heading mt-4">Close plan</p>
            <div className="mt-2 grid gap-4 md:grid-cols-2">
              <div className="rounded-md border border-(--card-border) p-3">
                <p className="text-[13px] font-medium">Mark completed</p>
                <Field label="Conclusion category">
                  <input
                    className={inputClass + " mt-1"}
                    placeholder="e.g. Successful completion / Extended / Terminated"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                </Field>
                <Field label="Conclusion notes">
                  <textarea className={inputClass + " mt-1 min-h-[56px]"} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
                <div className="mt-2 flex items-center justify-end gap-3">
                  <span className="text-[12px] text-(--text-muted)">changes are audited</span>
                  <button
                    type="button"
                    disabled={busy || !category.trim() || !notes.trim()}
                    className="btn-primary"
                    onClick={() => run(() => completePip({ data: { pipId: pip.id, conclusionCategory: category, conclusionNotes: notes } }))}
                  >
                    Complete
                  </button>
                </div>
              </div>
              <div className="rounded-md border border-(--card-border) p-3">
                <p className="text-[13px] font-medium">
                  Cancel
                  <InfoTip className="ml-1.5" tip="Ends the plan without a conclusion; the reason becomes part of the permanent record." />
                </p>
                <Field label="Cancellation reason">
                  <textarea className={inputClass + " mt-1 min-h-[56px]"} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                </Field>
                <div className="mt-2 flex items-center justify-end gap-3">
                  <span className="text-[12px] text-(--text-muted)">changes are audited</span>
                  <button
                    type="button"
                    disabled={busy || !cancelReason.trim()}
                    className="btn-secondary"
                    onClick={() => run(() => cancelPip({ data: { pipId: pip.id, reason: cancelReason } }))}
                  >
                    Cancel PIP
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </DetailDrawer>
  );
}
