import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { getAuditData } from "~/server/queries";
import { addDays, formatDateHuman } from "~/server/date-logic";
import { formatInt } from "~/server/metrics/report-text";
import type { AuditOkBody } from "~/server/audit-api";
import { InfoTip } from "~/components/InfoTip";

export const Route = createFileRoute("/audit")({
  validateSearch: (search: Record<string, unknown>) => ({
    rep: typeof search.rep === "string" ? search.rep : undefined,
    date: typeof search.date === "string" ? search.date : undefined,
  }),
  loaderDeps: ({ search }) => ({ rep: search.rep, date: search.date }),
  loader: ({ deps }) => getAuditData({ data: deps }),
  component: AuditPage,
});

type SortKey = "started_at_et" | "rep_name" | "direction" | "duration_seconds" | "over_threshold";

/** One sortable column of the audit table (native, no deps — same as Reps). */
function Th({
  label,
  sortKey,
  sort,
  onSort,
  left,
  stickyLeft,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; asc: boolean };
  onSort: (k: SortKey) => void;
  left?: boolean;
  /** FIRST column only: pinned during horizontal scroll on phones. */
  stickyLeft?: boolean;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.asc ? "ascending" : "descending") : undefined}
      className={(stickyLeft ? "sticky left-0 z-[2] bg-(--card-bg) " : "") + (left ? "text-left" : "text-right")}
    >
      <button type="button" className="th-sort-btn" onClick={() => onSort(sortKey)}>
        {label}
        <span aria-hidden="true" className={active ? "text-(--text-primary)" : "text-(--text-muted)"}>
          {active ? (sort.asc ? "↑" : "↓") : "↓"}
        </span>
      </button>
    </th>
  );
}

function sortRows(rows: AuditOkBody["rows"], sort: { key: SortKey; asc: boolean }) {
  const dir = sort.asc ? 1 : -1;
  const val = (r: AuditOkBody["rows"][number]): string | number | boolean => {
    if (sort.key === "rep_name") return r.rep_name ?? "";
    return r[sort.key];
  };
  return [...rows].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (av === bv) return 0;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    if (typeof av === "boolean" && typeof bv === "boolean") return (av === bv ? 0 : av ? 1 : -1) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function AuditPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const search = Route.useSearch();
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "started_at_et", asc: false });

  const navigate = (rep: string, date: string) => {
    router.navigate({ to: "/audit", search: { rep, date } });
  };

  // last 7 ET days (today .. today-6) as a quick strip — ET via server `today`
  const days = data.today ? Array.from({ length: 7 }, (_, i) => addDays(data.today!, -i)) : [];

  const rows = data.payload?.rows ?? [];
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort.key, sort.asc]);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: key === "rep_name" || key === "direction" }));

  const p = data.payload;
  return (
    <div className="space-y-4">
      <header>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className="text-xl font-semibold tracking-tight text-(--text-primary)">Audit</h1>
          <span className="text-[15px] font-medium text-(--text-faint)" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-(--text-caption)">Raw Call Audit (read-only)</span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-(--text-caption)">
          <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
          <span>DB call rows for one rep × one day · America/New_York · also served as JSON at /api/audit</span>
          <InfoTip
            tip={`Read-only rows from the normalized calls table — the same rows Reps/Team count. Over-threshold uses the live settings threshold (${p?.threshold_seconds ?? 120}s), the same rule as every page; no live HighLevel harvesting happens here. Buckets per the owner's terminology: Non Roster Calls = a known HighLevel user outside the CC roster; Unattributed = no determinable owner. Roster mappings (Settings) change reporting eligibility at query time — these raw rows always show the original source values.`}
            label="About these audit rows"
          />
        </p>
        {data.error && (
          <div className="status-banner mt-2" role="alert">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-danger)" aria-hidden="true" />
            <span className="min-w-0 truncate">{data.error}</span>
          </div>
        )}
      </header>

      {/* pickers: rep + date (+ last-7-days strip) */}
      <section aria-label="Audit filters" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <select
          aria-label="Rep"
          value={search.rep ?? "all"}
          onChange={(e) => navigate(e.target.value, search.date ?? data.today ?? "")}
          className="rounded-lg border border-(--card-border) bg-(--card-bg) px-2 py-1.5 text-[13px] text-(--text-primary) outline-none focus:border-(--input-focus-border)"
        >
          <option value="all">{data.picker?.allLabel ?? "All calls"}</option>
          <option value="non-roster">{data.picker?.nonRosterLabel ?? "Non Roster Calls"}</option>
          <option value="unattributed">{data.picker?.unattributedLabel ?? "Unattributed"}</option>
          <option value="unassigned">{data.picker?.unassignedLabel ?? "Unassigned (legacy — both buckets)"}</option>
          {(data.picker?.reps ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="Date (ET)"
          value={search.date ?? data.today ?? ""}
          onChange={(e) => navigate(search.rep ?? "all", e.target.value)}
          className="rounded-lg border border-(--card-border) bg-(--card-bg) px-2 py-1.5 text-[13px] text-(--text-primary) outline-none focus:border-(--input-focus-border)"
        />
        <span className="flex flex-wrap items-center gap-1" aria-label="Last 7 days">
          {days.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => navigate(search.rep ?? "all", d)}
              className={
                "rounded-md px-2 py-1 text-[12px] font-medium transition-colors " +
                ((search.date ?? data.today) === d
                  ? "bg-(--accent-solid) text-(--accent-solid-fg)"
                  : "text-(--text-caption) hover:bg-(--bar-track)/60 hover:text-(--text-primary)")
              }
            >
              {formatDateHuman(d)}
            </button>
          ))}
        </span>
      </section>

      {p && (
        <p className="text-xs text-(--text-caption)">
          {p.date_label} · {p.rep_label} · {formatInt(p.count)} call{p.count === 1 ? "" : "s"} ·{" "}
          {formatInt(p.over_threshold_count)} over {p.threshold_seconds}s · ET day {p.range.startUtc.slice(0, 10)}{" "}
          {p.range.startUtc.slice(11, 16)}Z → {p.range.endUtc.slice(11, 16)}Z
          {p.note ? ` · ${p.note}` : ""}
        </p>
      )}

      {/* raw rows — every ID visible, sortable, read-only */}
      <section aria-label="Audit call rows">
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="data-table min-w-[980px] text-[12px] [&_td]:py-2">
              <thead>
                <tr>
                  <Th label="Started (ET)" sortKey="started_at_et" sort={sort} onSort={onSort} stickyLeft />
                  <Th label="Rep" sortKey="rep_name" sort={sort} onSort={onSort} left />
                  <Th label="Direction" sortKey="direction" sort={sort} onSort={onSort} />
                  <Th label="Duration" sortKey="duration_seconds" sort={sort} onSort={onSort} />
                  <Th label={`Over threshold`} sortKey="over_threshold" sort={sort} onSort={onSort} />
                  <th scope="col" className="text-left">HL Message ID</th>
                  <th scope="col" className="text-left">Conversation ID</th>
                  <th scope="col" className="text-left">HL User ID</th>
                  <th scope="col" className="text-left">Contact</th>
                  <th scope="col" className="text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-(--text-muted)">
                      No call rows in the database for this rep and ET day.
                    </td>
                  </tr>
                ) : (
                  sorted.map((r) => (
                    <tr key={r.external_call_id} className="border-b border-(--table-border-weak) last:border-0">
                      <td className="sticky left-0 z-[1] whitespace-nowrap bg-(--card-bg) tabular-nums text-(--text-body)">
                        {r.et_date} {r.started_at_et}
                      </td>
                      <td className="text-left">
                        <span className={r.rep_is_active ? "font-medium text-(--text-primary)" : "text-(--text-caption)"}>
                          {r.rep_name ?? "(no user)"}
                        </span>
                        {r.rep_is_active === false && (
                          <span className="ml-1.5 text-xs uppercase tracking-wide text-(--banner-fg)">non-roster</span>
                        )}
                      </td>
                      <td className="tabular-nums text-(--chip-neutral-fg)">{r.direction ?? "—"}</td>
                      <td className="tabular-nums text-(--text-body)">{formatInt(r.duration_seconds)}s</td>
                      <td className="text-center">
                        <span
                          className={
                            "inline-block rounded px-1.5 py-0.5 text-xs font-medium " +
                            (r.over_threshold ? "bg-(--chip-positive-bg) text-(--chip-positive-fg)" : "bg-(--chip-neutral-bg) text-(--chip-neutral-fg)")
                          }
                        >
                          {r.over_threshold ? "yes" : "no"}
                        </span>
                      </td>
                      <td className="max-w-[220px] break-all font-mono text-xs text-(--text-caption)">{r.external_call_id}</td>
                      <td className="max-w-[220px] break-all font-mono text-xs text-(--text-caption)">{r.conversation_id ?? "—"}</td>
                      <td className="max-w-[160px] break-all font-mono text-xs text-(--text-caption)">
                        {r.provider_rep_external_id ?? "—"}
                      </td>
                      <td className="text-left text-(--chip-neutral-fg)">
                        {r.contact_name ?? "—"}
                        {r.contact_external_id && (
                          <span className="ml-1 font-mono text-xs text-(--text-muted)">{r.contact_external_id}</span>
                        )}
                      </td>
                      <td className="text-left text-(--text-caption)">{r.call_status ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
