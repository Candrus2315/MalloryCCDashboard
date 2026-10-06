/**
 * AUDIT — command-center redesign (harmonization wave 3, owner directive 10/1).
 *
 * The dense 10-column call table becomes a readable day-grouped event stream
 * (same anatomy as the Performance History log): each call row is an event —
 * time · direction · duration · rep · contact on the collapsed line, and the
 * FULL raw record (every id and status, nothing truncated) inside the native
 * <details> expansion, so the SSR payload still carries every value.
 *
 * Presentation only — same loader, same route search params (rep · date), same
 * rep-filter semantics, same client-side sort keys and default (Started desc),
 * same honesty rules (honest "—" for missing, raw ids always inspectable).
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { getAuditData } from "~/server/queries";
import { addDays, formatDateHuman } from "~/server/date-logic";
import { formatInt } from "~/server/metrics/report-text";
import type { AuditOkBody } from "~/server/audit-api";
import { InfoTip } from "~/components/InfoTip";
import { Eyebrow, Panel } from "~/components/page-panel";

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

/** Labels reused verbatim from the table headers this stream replaces. */
const SORT_LABELS: Record<SortKey, string> = {
  started_at_et: "Started (ET)",
  rep_name: "Rep",
  direction: "Direction",
  duration_seconds: "Duration",
  over_threshold: "Over threshold",
};

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

  // Day groups (wave-2 History anatomy). The loader window is one ET day, so
  // this yields the selected day's single group; grouping stays by et_date so
  // the presentation never invents a second day.
  const groups = useMemo(() => {
    const out: { day: string; items: AuditOkBody["rows"] }[] = [];
    for (const r of sorted) {
      let g = out[out.length - 1];
      if (!g || g.day !== r.et_date) {
        g = { day: r.et_date, items: [] };
        out.push(g);
      }
      g.items.push(r);
    }
    return out;
  }, [sorted]);

  const p = data.payload;
  return (
    <div className="space-y-4">
      {/* header — wave-2 anatomy: title pair on line 1, meta line beneath */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h1 className="text-[22px] font-semibold tracking-tight text-(--text-primary)">Audit</h1>
            <span className="text-[15px] font-medium text-(--text-faint)" aria-hidden="true">
              —
            </span>
            <span className="text-[15px] font-medium text-(--text-caption)">Raw Call Audit (read-only)</span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-(--text-caption)">
            <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
            <span>DB call rows for one rep × one day · America/New_York · also served as JSON at /api/audit</span>
            <InfoTip
              tip={`Read-only rows from the normalized calls table — the same rows Reps/Team count. Over-threshold uses the live settings threshold (${p?.threshold_seconds ?? 120}s), the same rule as every page; no live HighLevel harvesting happens here. Buckets per the owner's terminology: Non Roster Calls = a known HighLevel user outside the CC roster; Unattributed = no determinable owner. Roster mappings (Settings) change reporting eligibility at query time — these raw rows always show the original source values.`}
              label="About these audit rows"
            />
          </p>
        </div>
      </header>
      {data.error && (
        <div className="status-banner" role="alert">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-danger)" aria-hidden="true" />
          <span className="min-w-0 truncate">{data.error}</span>
        </div>
      )}

      {/* filters — Panel; rep + date + last-7-days strip (same handlers/route) */}
      <Panel>
        <div className="p-4 sm:p-5">
          <Eyebrow>Filters</Eyebrow>
          <section aria-label="Audit filters" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
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
        </div>
      </Panel>

      {/* day summary — the count line, re-set as a labeled hairline stat strip
          (every value is the exact clause the old count line rendered) */}
      {p && (
        <Panel className="overflow-hidden">
          <div className="grid grid-cols-2 gap-px bg-(--table-border-weak) sm:grid-cols-3 lg:grid-cols-5">
            <div className="bg-(--card-bg) px-4 py-3">
              <p className="kpi-label">Day</p>
              <p className="mt-1 truncate text-[13px] font-medium text-(--text-body)">{p.date_label}</p>
            </div>
            <div className="bg-(--card-bg) px-4 py-3">
              <p className="kpi-label">Rep filter</p>
              <p className="mt-1 truncate text-[13px] font-medium text-(--text-body)" title={p.rep_label}>
                {p.rep_label}
              </p>
            </div>
            <div className="bg-(--card-bg) px-4 py-3">
              <p className="kpi-label">Calls</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-(--text-primary)">
                {formatInt(p.count)}
                <span className="ml-1 text-[13px] font-medium text-(--text-muted)">call{p.count === 1 ? "" : "s"}</span>
              </p>
            </div>
            <div className="bg-(--card-bg) px-4 py-3">
              <p className="kpi-label">Over threshold</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-(--text-primary)">
                {formatInt(p.over_threshold_count)}
                <span className="ml-1 text-[13px] font-medium text-(--text-muted)">over {p.threshold_seconds}s</span>
              </p>
            </div>
            <div className="col-span-2 bg-(--card-bg) px-4 py-3 sm:col-span-1">
              <p className="kpi-label">ET day</p>
              <p className="mt-1 whitespace-nowrap text-[13px] font-medium tabular-nums text-(--text-body)">
                {p.range.startUtc.slice(0, 10)} {p.range.startUtc.slice(11, 16)}Z → {p.range.endUtc.slice(11, 16)}Z
              </p>
            </div>
          </div>
          {p.note && (
            <p className="border-t border-(--table-border-weak) px-4 py-2 text-xs text-(--banner-fg)">{p.note}</p>
          )}
        </Panel>
      )}

      {/* call event stream — grouped by ET day; each row expands to the full raw record */}
      <section aria-label="Audit call rows">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--table-border-weak) px-4 py-3">
            <Eyebrow>Call events</Eyebrow>
            {/* client-side sort — same keys + default as the table this replaces */}
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-1.5 text-xs text-(--text-caption)">
                Sort
                <select
                  aria-label="Sort calls by"
                  value={sort.key}
                  onChange={(e) => {
                    const key = e.target.value as SortKey;
                    setSort((s) => (s.key === key ? s : { key, asc: key === "rep_name" || key === "direction" }));
                  }}
                  className="rounded-lg border border-(--card-border) bg-(--card-bg) px-2 py-1 text-[12px] text-(--text-primary) outline-none focus:border-(--input-focus-border)"
                >
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                    <option key={k} value={k}>
                      {SORT_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                aria-label={sort.asc ? "Sort ascending" : "Sort descending"}
                onClick={() => setSort((s) => ({ ...s, asc: !s.asc }))}
                className="rounded-md px-2 py-1 text-[12px] font-medium text-(--text-caption) hover:bg-(--bar-track)/60 hover:text-(--text-primary)"
              >
                {sort.asc ? "↑" : "↓"}
              </button>
            </div>
          </div>

          {sorted.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-[13px] text-(--text-muted)">No call rows in the database for this rep and ET day.</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.day} aria-label={g.day}>
                {/* day group header — same date_label the old count line rendered
                    for this day; plain et_date when the payload is absent */}
                <p className="px-4 pb-1 pt-4 text-[11px] font-medium uppercase tracking-[0.12em] text-(--text-muted)">
                  {p && g.day === p.date ? p.date_label : formatDateHuman(g.day)}
                </p>
                <ul>
                  {g.items.map((r) => (
                    <CallEventRow key={r.external_call_id} r={r} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </Panel>
      </section>
    </div>
  );
}

const detailLabel = "text-[11px] font-medium uppercase tracking-[0.08em] text-(--text-muted)";

/**
 * One call event — collapsed line: time · direction · duration · rep · contact
 * (the values the old table put in its first five columns); expansion: the
 * FULL raw record, every field rendered, nothing truncated. All values live in
 * the SSR payload either way (native <details>), so nothing honest is hidden.
 */
function CallEventRow({ r }: { r: AuditOkBody["rows"][number] }) {
  return (
    <li className="border-b border-(--table-border-weak) last:border-0">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-2.5 transition-colors hover:bg-(--hover-row) [&::-webkit-details-marker]:hidden">
          <span className="w-14 shrink-0 pt-0.5 text-[12px] tabular-nums text-(--text-muted)">{r.started_at_et}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-(--text-muted)">
                {r.direction ?? "—"}
              </span>
              <span
                className={
                  "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " +
                  (r.over_threshold ? "bg-(--chip-positive-bg) text-(--chip-positive-fg)" : "bg-(--chip-neutral-bg) text-(--chip-neutral-fg)")
                }
              >
                {r.over_threshold ? "yes" : "no"}
              </span>
            </span>
            <span className="mt-0.5 block text-[13px] leading-snug text-(--text-body)">
              <span className={r.rep_is_active === false ? "text-(--text-caption)" : "font-medium text-(--text-primary)"}>
                {r.rep_name ?? "(no user)"}
              </span>
              {r.rep_is_active === false && (
                <span className="ml-1.5 text-[11px] uppercase tracking-wide text-(--banner-fg)">non-roster</span>
              )}
              <span className="mx-1.5 text-(--text-faint)">·</span>
              <span className="tabular-nums">{formatInt(r.duration_seconds)}s</span>
              <span className="mx-1.5 text-(--text-faint)">·</span>
              <span className="text-(--text-caption)">{r.contact_name ?? "—"}</span>
            </span>
          </span>
          <span aria-hidden="true" className="mt-1 shrink-0 text-[10px] text-(--text-muted) transition-transform group-open:rotate-90">
            ▶
          </span>
        </summary>
        {/* full raw record — audit semantics unchanged: original source values,
            honest "—" when a field has none */}
        <div className="mb-3 ml-4 rounded-md bg-(--surface-inset) px-3 py-3 text-[12px] sm:ml-[68px]">
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0">
              <p className={detailLabel}>Started (ET)</p>
              <p className="mt-0.5 whitespace-nowrap tabular-nums text-(--text-body)">
                {r.et_date} {r.started_at_et}
              </p>
            </div>
            <div className="min-w-0">
              <p className={detailLabel}>Rep</p>
              <p className="mt-0.5 text-(--text-body)">
                <span className={r.rep_is_active ? "font-medium text-(--text-primary)" : "text-(--text-caption)"}>
                  {r.rep_name ?? "(no user)"}
                </span>
                {r.rep_is_active === false && (
                  <span className="ml-1.5 text-[11px] uppercase tracking-wide text-(--banner-fg)">non-roster</span>
                )}
              </p>
            </div>
            <div className="min-w-0">
              <p className={detailLabel}>Direction</p>
              <p className="mt-0.5 tabular-nums text-(--chip-neutral-fg)">{r.direction ?? "—"}</p>
            </div>
            <div className="min-w-0">
              <p className={detailLabel}>Duration</p>
              <p className="mt-0.5 tabular-nums text-(--text-body)">{formatInt(r.duration_seconds)}s</p>
            </div>
            <div className="min-w-0">
              <p className={detailLabel}>Over threshold</p>
              <p className="mt-0.5">
                <span
                  className={
                    "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " +
                    (r.over_threshold ? "bg-(--chip-positive-bg) text-(--chip-positive-fg)" : "bg-(--chip-neutral-bg) text-(--chip-neutral-fg)")
                  }
                >
                  {r.over_threshold ? "yes" : "no"}
                </span>
              </p>
            </div>
            <div className="min-w-0">
              <p className={detailLabel}>Status</p>
              <p className="mt-0.5 text-(--text-caption)">{r.call_status ?? "—"}</p>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <p className={detailLabel}>HL Message ID</p>
              <p className="mt-0.5 break-all font-mono text-(--text-caption)">{r.external_call_id}</p>
            </div>
            <div className="min-w-0">
              <p className={detailLabel}>HL User ID</p>
              <p className="mt-0.5 break-all font-mono text-(--text-caption)">{r.provider_rep_external_id ?? "—"}</p>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <p className={detailLabel}>Conversation ID</p>
              <p className="mt-0.5 break-all font-mono text-(--text-caption)">{r.conversation_id ?? "—"}</p>
            </div>
            <div className="min-w-0">
              <p className={detailLabel}>Contact</p>
              <p className="mt-0.5 text-(--chip-neutral-fg)">
                {r.contact_name ?? "—"}
                {r.contact_external_id && (
                  <span className="ml-1 font-mono text-(--text-muted)">{r.contact_external_id}</span>
                )}
              </p>
            </div>
          </div>
        </div>
      </details>
    </li>
  );
}
