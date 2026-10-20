/**
 * RETENTION DRILL-DOWN (stage 3b; UI-DESIGN-SPEC.md §3 + §5) — ONE shared
 * drill-down for every KPI card, driven by ?kpi= search params (deep-linkable,
 * back-button-safe, no page state). Desktop = the 11-column data table with a
 * sticky client column and in-row evidence expansion from the outcome row's
 * evidence jsonb; phones = the card list (md:hidden pairing). The Data Match
 * Exceptions kpi renders the resolve workspace (§5a) against the shipped
 * exceptions-api endpoints; Needs Review exposes the four-signal grid (§5b).
 *
 * Honesty: transcript column is always "—" (no transcripts exist in the GHL
 * payload — probe verdict 2026-10-19) and keeps its explicit InfoTip; notes
 * render verbatim; classification badges carry text + dot (never color-only);
 * the cancellations-outcome column reads the unwritten ret_cancellations
 * ledger, so it renders "—" and its filter honestly matches nothing yet.
 */
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { formatDateHuman } from "~/server/date-logic";
import { getRetentionDrillData } from "~/server/queries";
import { Panel } from "~/components/page-panel";
import { StatusChip } from "~/components/StatusChip";
import { InfoTip } from "~/components/InfoTip";
import { GhostButton, EmptyState } from "~/components/performance-shell";
import { Segmented } from "~/components/Segmented";
import {
  RETENTION_KPIS,
  RETENTION_RANGES,
  FINAL_STATUS_LABEL,
  EXCEPTION_KIND_LABEL,
  OUTCOME_FILTER_OPTIONS,
  deriveSignalCells,
  retentionDrillCsv,
  type RetentionKpiKey,
  type RetentionRange,
  type RetentionDrillRow,
} from "~/server/retention/ui-data";

const KPI_KEYS = RETENTION_KPIS.map((k) => k.key);

export const Route = createFileRoute("/retention-drill")({
  validateSearch: (search: Record<string, unknown>) => {
    const kpi: RetentionKpiKey = KPI_KEYS.includes(search.kpi as RetentionKpiKey) ? (search.kpi as RetentionKpiKey) : "clients-due";
    // Queue KPIs default to All open (the card counts the whole open queue);
    // week-scoped cohort KPIs default to This week (the card's own window).
    const defaultRange: RetentionRange = kpi === "needs-review" || kpi === "match-exceptions" ? "all" : "this-week";
    const range: RetentionRange = RETENTION_RANGES.some((r) => r.value === search.range) ? (search.range as RetentionRange) : defaultRange;
    const rawClassification = typeof search.classification === "string" ? search.classification : "all";
    return {
      kpi,
      range,
      // Needs Review is locked to its own classification (the card IS the filter).
      classification: kpi === "needs-review" ? "needs_review" : rawClassification,
      outcome: typeof search.outcome === "string" ? search.outcome : "all",
      employee: typeof search.employee === "string" ? search.employee : "all",
      exc: search.exc === "resolved" || search.exc === "dismissed" ? search.exc : "open",
    };
  },
  loaderDeps: ({ search }) => ({
    kpi: search.kpi,
    range: search.range,
    classification: search.classification,
    outcome: search.outcome,
    employee: search.employee,
    exc: search.exc,
  }),
  loader: ({ deps }) => getRetentionDrillData({ data: { ...deps } }),
  component: RetentionDrillPage,
});

/** Classification badge (text + dot, never color-only; spec §3 table). */
function ClassificationBadge({ status }: { status: string }) {
  const label = FINAL_STATUS_LABEL[status] ?? status;
  const cls =
    status === "verified_spoke_with"
      ? "chip chip-positive"
      : status === "needs_review"
        ? "chip chip-risk"
        : "chip chip-neutral";
  const dot =
    status === "verified_spoke_with"
      ? "bg-(--dot-positive)"
      : status === "attempted_unclear" || status === "needs_review"
        ? "bg-(--dot-caution)"
        : "bg-(--dot-muted)";
  return (
    <span className={cls}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

const ATTEMPT_DOT: Record<string, string> = {
  completed: "bg-(--dot-positive)",
  voicemail: "bg-(--dot-muted)",
  "no-answer": "bg-(--dot-muted)",
  failed: "bg-(--dot-danger)",
};

function AttemptsCell({ row }: { row: RetentionDrillRow }) {
  if (row.attempts.length === 0) return <span className="text-(--text-muted)">0</span>;
  const shown = row.attempts.slice(-3);
  const overflow = row.attempts.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1 tabular-nums">
      <span className="font-medium">{row.attemptsCount}</span>
      {shown.map((a, i) => (
        <span key={i} className="chip chip-neutral">
          <span className={`h-1.5 w-1.5 rounded-full ${ATTEMPT_DOT[a.status ?? ""] ?? "bg-(--dot-muted)"}`} aria-hidden="true" />
          {a.status ?? "—"}
        </span>
      ))}
      {overflow > 0 && <span className="chip chip-neutral">+{overflow}</span>}
    </span>
  );
}

/** Verbatim notes clamp (~80 chars, line-clamp-2) — never paraphrased. */
function clamp(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function RetentionDrillPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<Record<string, string>>({}); // exception id → candidate client id
  const [actionError, setActionError] = useState<string | null>(null);
  const setParam = (patch: Partial<typeof search>) =>
    void navigate({ to: "/retention-drill", search: (prev) => ({ ...prev, ...patch }) });
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const isExceptions = data.exceptions != null;
  const complianceFormula =
    "Contact Compliance % (appointment flavor) = Clients Spoken With / Clients Due · Contact Compliance % (attempt flavor) = count(A: attempts ≥ 1 within window) / Clients Due";

  const downloadCsv = () => {
    const csv = retentionDrillCsv(data.rows, { kpi: data.kpi, range: data.range, ownerName: data.ownerName, dueDaysSetting: data.dueDaysSetting });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `retention-${data.kpi}-${data.range}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Management resolve actions → the shipped /api/retention-exceptions endpoint (write-once, audited). */
  const act = async (body: Record<string, string>) => {
    setActionError(null);
    try {
      const res = await fetch("/api/retention-exceptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(err.error ?? `Request failed (${res.status})`);
        return;
      }
      await router.invalidate();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const emptyState = () => {
    if (data.emptyReason) return <EmptyState title="Nothing computed here yet" hint={data.emptyReason} />;
    if (isExceptions && (data.exceptions?.rows.length ?? 0) === 0)
      return <EmptyState title="No Data Match Exceptions" hint="Every client matched on explicit ID, phone, or email." />;
    if (data.rows.length === 0)
      return (
        <EmptyState
          title="No clients due in this range"
          hint={`due = appointment ET date − ${data.dueDaysSetting} (Settings). Widen the range, or check back after the next retention compute tick.`}
        />
      );
    return null;
  };

  const scopeLine = (
    <p className="mt-0.5 text-xs text-(--text-caption)">
      {data.rangeLabel} · Retention Owner: {data.ownerName ?? "—"} · America/New_York
    </p>
  );

  return (
    <div>
      {/* Header: title + exact-value chip + scope line; filters + CSV right. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {data.kpiLabel}
            <span className="chip chip-neutral tabular-nums" aria-label={`${data.matchedCount} rows match this drill`}>
              {data.matchedCount}
            </span>
            {data.kpi === "compliance" && <InfoTip label="Both flavors" tip={complianceFormula} />}
            {data.kpi === "unreached" && (
              <InfoTip
                label="Formula"
                tip="count(A: eligible, attempts ≥ 0, final_status ∈ {no_answer, attempted_unclear}, appointment_datetime ≥ now (window still open) OR window closed with zero answered attempts)"
              />
            )}
            {data.kpi === "no-shows" && (
              <InfoTip
                label="No-show rule"
                tip="D10 (owner-ratified proxy): the appointment's start has passed and its status is still scheduled. Split spoken-with (final_status = verified) vs not-spoken. A manual confirm arrives with the Settings surface."
              />
            )}
          </h1>
          {scopeLine}
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Date range"
            options={RETENTION_RANGES.map((r) => ({ value: r.value, label: r.label }))}
            value={search.range}
            onChange={(v) => setParam({ range: v })}
          />
          {!isExceptions && (
            <button type="button" onClick={downloadCsv} className="btn-secondary">
              Export CSV
            </button>
          )}
        </span>
      </div>

      {/* Filter row: classification / outcome / employee selects — all URL-backed. */}
      {!isExceptions && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium text-(--text-caption)">Classification</span>
            <select
              aria-label="Filter by final contact classification"
              value={search.classification}
              disabled={search.kpi === "needs-review"}
              onChange={(e) => setParam({ classification: e.target.value })}
              className="min-h-[44px] rounded-lg border border-(--card-border) bg-(--card-bg) px-2.5 py-1.5 text-[13px] font-medium text-(--text-primary) outline-none focus:border-(--input-focus-border) disabled:opacity-60"
            >
              {search.kpi === "needs-review" && <option value="needs_review">Needs Review</option>}
              {search.kpi !== "needs-review" && (
                <>
                  <option value="all">All classifications</option>
                  {Object.entries(FINAL_STATUS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
          <label className="block text-[13px]">
            <span className="mb-1 flex items-center gap-1 font-medium text-(--text-caption)">
              Appointment outcome
              <InfoTip
                tip="Cancellation-outcome words (saved original, rescheduled, confirmed cancellation, …) live in the cancellations ledger, which no stage writes yet — until then every row renders — and any specific outcome filter honestly matches nothing."
              />
            </span>
            <select
              aria-label="Filter by appointment outcome"
              value={search.outcome}
              onChange={(e) => setParam({ outcome: e.target.value })}
              className="min-h-[44px] rounded-lg border border-(--card-border) bg-(--card-bg) px-2.5 py-1.5 text-[13px] font-medium text-(--text-primary) outline-none focus:border-(--input-focus-border)"
            >
              <option value="all">All outcomes</option>
              {OUTCOME_FILTER_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium text-(--text-caption)">Employee</span>
            <select
              aria-label="Filter by employee"
              value={search.employee}
              onChange={(e) => setParam({ employee: e.target.value })}
              className="min-h-[44px] rounded-lg border border-(--card-border) bg-(--card-bg) px-2.5 py-1.5 text-[13px] font-medium text-(--text-primary) outline-none focus:border-(--input-focus-border)"
            >
              <option value="all">All employees</option>
              {data.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Match-exceptions queue segment (§5a): Open · Resolved · Dismissed. */}
      {isExceptions && (
        <div className="mt-3">
          <Segmented
            ariaLabel="Exception queue"
            options={[
              { value: "open", label: `Open (${data.exceptions!.counts.open})` },
              { value: "resolved", label: `Resolved (${data.exceptions!.counts.resolved})` },
              { value: "dismissed", label: `Dismissed (${data.exceptions!.counts.dismissed})` },
            ]}
            value={search.exc}
            onChange={(v) => setParam({ exc: v })}
          />
        </div>
      )}

      {actionError && (
        <p role="alert" className="mt-3 rounded-lg border border-(--card-border) bg-(--surface-subtle) px-4 py-2 text-[13px] text-(--text-body)">
          {actionError}
        </p>
      )}

      <div className="mt-4">{emptyState()}</div>

      {/* ---- Exceptions resolve workspace (§5a) ---- */}
      {isExceptions && (data.exceptions?.rows.length ?? 0) > 0 && (
        <div className="mt-4 space-y-3">
          {data.exceptions!.rows.map((exc) => {
            const candidates = exc.candidates_expanded ?? [];
            const confirmFor = confirming[exc.id];
            const resolved = exc.status !== "open";
            return (
              <Panel key={exc.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip
                    kind={exc.kind === "no_identity" || exc.kind === "name_only" ? "risk" : "neutral"}
                    label={EXCEPTION_KIND_LABEL[exc.kind] ?? exc.kind}
                  />
                  <span className="text-[13px] font-medium">{formatDateHuman(exc.first_seen_at.slice(0, 10))}</span>
                  {exc.status !== "open" && <StatusChip kind="neutral" label={exc.status} />}
                </div>
                <p className="mt-1 text-[13px] text-(--text-body)">
                  {contextLine(exc.context)} <span className="text-(--text-muted)">· {exc.dedupe_key}</span>
                </p>
                {!resolved && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {candidates.map((c) => (
                      <div key={c?.id ?? "unknown"} className="card-nest rounded-lg p-3">
                        <CandidateCard client={c} />
                        {confirmFor === c?.id ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="btn-secondary min-h-[44px]"
                              onClick={() =>
                                act({ action: "resolve", id: exc.id, internalClientId: c!.id }).then(() =>
                                  setConfirming((p) => {
                                    const n = { ...p };
                                    delete n[exc.id];
                                    return n;
                                  }),
                                )
                              }
                            >
                              Confirm — link these as one client?
                            </button>
                            <GhostButton onClick={() => setConfirming((p) => ({ ...p, [exc.id]: "" }))}>Cancel</GhostButton>
                          </div>
                        ) : (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="btn-secondary min-h-[44px]"
                              onClick={() => setConfirming((p) => ({ ...p, [exc.id]: c!.id }))}
                            >
                              Same client — link
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    {candidates.length === 0 && (
                      <p className="text-[13px] text-(--text-muted)">No candidate clients recorded in the exception payload.</p>
                    )}
                  </div>
                )}
                {!resolved && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button type="button" className="btn-secondary min-h-[44px]" onClick={() => act({ action: "resolve_new", id: exc.id })}>
                      Different clients — create separate
                    </button>
                    <GhostButton onClick={() => act({ action: "dismiss", id: exc.id })}>Dismiss</GhostButton>
                  </div>
                )}
                {resolved && (
                  <p className="mt-2 text-[13px] text-(--text-muted)">
                    Resolved {exc.resolved_at?.slice(0, 10)} by {exc.resolved_by ?? "—"} · method {exc.resolved_method ?? "—"} — write-once; the
                    sticky link persists and auto passes never re-match this entity.
                  </p>
                )}
              </Panel>
            );
          })}
          <p className="px-1 text-xs text-(--text-muted)">
            Resolving writes one permanent link (method: manual, by you, audited). Resolved clients are never re-matched.
          </p>
        </div>
      )}

      {/* ---- Desktop table (≥md) ---- */}
      {!isExceptions && data.rows.length > 0 && (
        <div className="mt-4 hidden md:block">
          <div className="overflow-x-auto rounded-lg border border-(--card-border) bg-(--card-bg)">
            <table className="data-table min-w-[1080px] text-[13px]">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-[3] bg-(--card-bg) text-left">
                    Client
                  </th>
                  <th scope="col" className="text-left">
                    Appointment
                  </th>
                  <th scope="col" className="text-left">
                    Contact due
                  </th>
                  <th scope="col" className="text-left">
                    GHL contact
                  </th>
                  <th scope="col" className="text-left">
                    GHL call attempts
                  </th>
                  <th scope="col" className="text-left">
                    Call status
                  </th>
                  <th scope="col" className="text-left">
                    <span className="inline-flex items-center gap-1">
                      Transcript result
                      <InfoTip
                        tip="No transcripts exist in the GHL payload (probe verdict 2026-10-19). Column stays so the evidence hierarchy is visible; if transcription is ever enabled account-side it fills from the same endpoint."
                      />
                    </span>
                  </th>
                  <th scope="col" className="text-left">
                    Acuity notes
                  </th>
                  <th scope="col" className="text-left">
                    Final contact classification
                  </th>
                  <th scope="col" className="text-left">
                    Appointment outcome
                  </th>
                  <th scope="col" className="text-right">
                    <span className="sr-only">Expand evidence</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const open = expanded.has(row.appointmentId);
                  return (
                    <RowGroup
                      key={row.appointmentId}
                      row={row}
                      open={open}
                      toggle={() => toggle(row.appointmentId)}
                      todayDue={data.todayEt}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Mobile card list (phones; md:hidden) ---- */}
      {!isExceptions && data.rows.length > 0 && (
        <div className="mt-4 space-y-3 md:hidden">
          {data.rows.map((row) => (
            <MobileCard key={row.appointmentId} row={row} open={expanded.has(row.appointmentId)} toggle={() => toggle(row.appointmentId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function contextLine(context: Record<string, unknown> | null): string {
  if (!context || typeof context !== "object") return "—";
  const bits: string[] = [];
  for (const [k, v] of Object.entries(context)) {
    if (v != null && typeof v !== "object") bits.push(`${k}: ${String(v)}`);
  }
  return bits.length ? bits.join(" · ") : "—";
}

function CandidateCard({ client }: { client: { display_name: string | null; normalized_phone: string | null; normalized_email: string | null; id: string; ghl_contact_external_id: string | null } | null }) {
  if (!client) return <p className="text-[13px] text-(--text-muted)">Candidate details unavailable (client row missing).</p>;
  return (
    <div>
      <p className="text-[13px] font-medium">{client.display_name ?? "—"}</p>
      <dl className="mt-1 space-y-0.5 text-xs text-(--text-caption) tabular-nums">
        <div>phone: {client.normalized_phone ? `··${client.normalized_phone.slice(-4)}` : "—"}</div>
        <div className="truncate">email: {client.normalized_email ?? "—"}</div>
        <div className="truncate">internal client: {client.id}</div>
        <div className="truncate">GHL contact: {client.ghl_contact_external_id ?? "—"}</div>
      </dl>
    </div>
  );
}

function RowGroup({ row, open, toggle, todayDue }: { row: RetentionDrillRow; open: boolean; toggle: () => void; todayDue: string | null }) {
  const overdueUnreached = row.dueDate < (todayDue ?? "") && (row.finalStatus === "no_answer" || row.finalStatus === "attempted_unclear");
  const signals = useMemo(() => deriveSignalCells({ final_status: row.finalStatus, needs_review_reason: row.needsReviewReason, evidence: row.evidence }), [row]);
  const agg = (row.evidence as { aggregation?: { basis?: string[]; note_overlay?: unknown; final_status?: string } }).aggregation;
  const inbound = (row.evidence as { inbound_in_window?: { count?: number } }).inbound_in_window;
  return (
    <>
      <tr className="border-t border-(--table-border-weak)">
        <td className="sticky left-0 z-[3] bg-(--card-bg) py-2 font-medium text-(--text-primary)">
          {row.clientName ?? "—"}
          {row.cancelled && (
            <span className="chip chip-neutral ml-2 align-middle text-[11px]">
              <span className="h-1.5 w-1.5 rounded-full bg-(--dot-muted)" aria-hidden="true" />
              cancelled
            </span>
          )}
        </td>
        <td className="py-2 tabular-nums">
          {row.apptDateEt ? `${formatDateHuman(row.apptDateEt)} ${row.apptTimeEt ?? ""}`.trim() : "—"}
        </td>
        <td className="py-2 tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            {overdueUnreached && <span className="h-1.5 w-1.5 rounded-full bg-(--dot-caution)" aria-hidden="true" title="Overdue and unreached" />}
            {formatDateHuman(row.dueDate)}
          </span>
        </td>
        <td className="py-2">
          {row.contactName ? `${row.contactName} · ··${row.contactPhoneLast4 ?? "—"}` : "—"}
        </td>
        <td className="py-2">
          <AttemptsCell row={row} />
        </td>
        <td className="py-2">{row.lastCallStatus ?? "—"}</td>
        <td className="py-2 text-(--text-muted)">—</td>
        <td className="max-w-[16rem] py-2">
          {row.notes ? (
            <span className="line-clamp-2 whitespace-pre-wrap text-(--text-body)">{clamp(row.notes)}</span>
          ) : (
            <span className="text-(--text-muted)">—</span>
          )}
        </td>
        <td className="py-2">
          <ClassificationBadge status={row.finalStatus} />
        </td>
        <td className="py-2 text-(--text-muted)">—</td>
        <td className="py-2 text-right">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} evidence for ${row.clientName ?? "client"}`}
            onClick={toggle}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-(--text-muted) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
          >
            {open ? "▲" : "▼"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="bg-(--surface-subtle)">
          <td colSpan={11} className="p-4">
            <EvidencePanel row={row} signals={signals} aggregation={agg} inboundCount={inbound?.count ?? 0} />
          </td>
        </tr>
      )}
    </>
  );
}

function MobileCard({ row, open, toggle }: { row: RetentionDrillRow; open: boolean; toggle: () => void }) {
  const signals = useMemo(() => deriveSignalCells({ final_status: row.finalStatus, needs_review_reason: row.needsReviewReason, evidence: row.evidence }), [row]);
  const agg = (row.evidence as { aggregation?: { basis?: string[]; note_overlay?: unknown } }).aggregation;
  const inbound = (row.evidence as { inbound_in_window?: { count?: number } }).inbound_in_window;
  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
            {row.clientName ?? "—"}
            {row.cancelled && <StatusChip kind="neutral" label="cancelled" />}
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-(--text-caption)">
            {row.apptDateEt ? `${formatDateHuman(row.apptDateEt)} ${row.apptTimeEt ?? ""}`.trim() : "—"} · due {formatDateHuman(row.dueDate)}
          </p>
          <p className="mt-1 text-xs text-(--text-caption)">
            {row.contactName ? `${row.contactName} · ··${row.contactPhoneLast4 ?? "—"}` : "—"}
          </p>
        </div>
        <ClassificationBadge status={row.finalStatus} />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-1 text-xs tabular-nums text-(--text-caption)">
        <span className="font-medium text-(--text-body)">{row.attemptsCount} attempts</span>
        <span>last: {row.lastCallStatus ?? "—"}</span>
      </p>
      {row.notes && <p className="mt-2 whitespace-pre-wrap text-xs text-(--text-body)">{clamp(row.notes)}</p>}
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} evidence for ${row.clientName ?? "client"}`}
        onClick={toggle}
        className="mt-3 min-h-[44px] w-full rounded-md border border-(--card-border) px-3 text-[13px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
      >
        {open ? "▲ Hide evidence" : "▼ Evidence"}
      </button>
      {open && (
        <div className="mt-3">
          <EvidencePanel row={row} signals={signals} aggregation={agg} inboundCount={inbound?.count ?? 0} />
        </div>
      )}
    </Panel>
  );
}

/**
 * The evidence panel — every metric preserves WHY a client was counted that
 * way (owner auditability requirement): IDs block, the per-attempt ledger
 * (one row per attempt, never merged), the classification path, and the full
 * verbatim notes. Needs Review rows lead with the reason + the four-signal
 * grid (§5b); no resolve action in v1 (D5).
 */
function EvidencePanel({
  row,
  signals,
  aggregation,
  inboundCount,
}: {
  row: RetentionDrillRow;
  signals: ReturnType<typeof deriveSignalCells>;
  aggregation?: { basis?: string[]; note_overlay?: unknown };
  inboundCount: number;
}) {
  const ev = row.evidence as {
    attempts?: { external_message_id?: string; call_id?: string | null; attempt_at?: string; call_status?: string | null; duration_seconds?: number | null; attempt_class?: string; attribution?: string; employee_user_id?: string | null; employee_external_id?: string | null }[];
    notes_excerpt?: string | null;
    window?: { rule?: string };
  };
  const attemptLedger = ev.attempts ?? row.attempts.map((a, i) => ({ external_message_id: `${i + 1}`, attempt_at: a.attemptAt, call_status: a.status, duration_seconds: a.durationSeconds, attempt_class: a.attemptClass, attribution: a.attribution, employee_user_id: null, employee_external_id: null, call_id: null, direction: a.direction }));
  return (
    <div className="space-y-4 text-[13px]">
      {row.finalStatus === "needs_review" && (
        <div>
          <p className="kpi-label">Needs Review — reason</p>
          <p className="mt-1 text-(--text-body)">{row.needsReviewReason ?? "—"}</p>
          {/* Four-signal grid (§5b): amber dot on conflicting cells; duration
              labeled supporting-only; no resolve action in v1 (D5). */}
          <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {signals.map((s) => (
              <div key={s.label} className="card-nest rounded-lg p-3">
                <p className="kpi-label flex items-center gap-1.5">
                  {s.conflict && <span className="h-1.5 w-1.5 rounded-full bg-(--dot-caution)" aria-hidden="true" />}
                  {s.label}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-(--text-body)">{s.value}</p>
                {s.note && <p className="kpi-sub mt-1">{s.note}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* IDs block — the auditability chain, every id inspectable. */}
      <div>
        <p className="kpi-label">IDs &amp; identity</p>
        <dl className="mt-1 grid gap-x-6 gap-y-1 text-xs tabular-nums text-(--text-caption) sm:grid-cols-2">
          <div>internal client ID: {row.internalClientId}</div>
          <div>Acuity appointment ID: {row.acuityId ?? "—"}</div>
          <div>GHL contact ID: {row.ghlContactId ?? "—"}</div>
          <div>GHL call IDs: {attemptLedger.map((a) => a.call_id ?? a.external_message_id ?? "—").join(", ") || "—"}</div>
          <div>match method: {row.matchMethod ?? "—"}</div>
          <div>contact match method: {row.contactMatchMethod ?? "—"}</div>
          <div>employee(s): {[...new Set(row.attempts.map((a) => a.employeeName))].join(", ") || "—"}</div>
          <div>in-window inbound calls (tracked, never attempts): {inboundCount}</div>
        </dl>
      </div>

      {/* Attempt ledger — one row per attempt, never merged. */}
      <div>
        <p className="kpi-label">Attempt ledger ({attemptLedger.length})</p>
        {attemptLedger.length === 0 ? (
          <p className="mt-1 text-(--text-muted)">No outbound attempts recorded in this appointment's contact window.</p>
        ) : (
          <div className="mt-1 overflow-x-auto">
            <table className="data-table min-w-[560px] text-xs">
              <thead>
                <tr>
                  <th scope="col" className="text-left">
                    When (ET)
                  </th>
                  <th scope="col" className="text-left">
                    Employee
                  </th>
                  <th scope="col" className="text-left">
                    Direction
                  </th>
                  <th scope="col" className="text-left">
                    Status
                  </th>
                  <th scope="col" className="text-right">
                    Duration
                  </th>
                  <th scope="col" className="text-left">
                    Disposition class
                  </th>
                  <th scope="col" className="text-left">
                    Attribution
                  </th>
                </tr>
              </thead>
              <tbody>
                {attemptLedger.map((a, i) => (
                  <tr key={i}>
                    <td className="py-1 tabular-nums">
                      {a.attempt_at
                        ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
                            new Date(a.attempt_at),
                          )
                        : "—"}
                    </td>
                    <td className="py-1">{row.attempts[i]?.employeeName ?? (a.employee_user_id ? String(a.employee_user_id) : "—")}</td>
                    <td className="py-1">{(a as { direction?: string | null }).direction ?? "—"}</td>
                    <td className="py-1">{a.call_status ?? "—"}</td>
                    <td className="py-1 text-right tabular-nums">{a.duration_seconds == null ? "—" : `${a.duration_seconds}s`}</td>
                    <td className="py-1">{a.attempt_class ?? "—"}</td>
                    <td className="py-1">{a.attribution ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Classification path — which signals agreed/disagreed + the rule. */}
      <div>
        <p className="kpi-label">Classification path</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-(--text-body)">
          {(aggregation?.basis ?? []).map((b, i) => (
            <li key={i}>{b}</li>
          ))}
          {!aggregation?.basis?.length && <li>—</li>}
        </ul>
        {aggregation?.note_overlay != null && (
          <p className="mt-1 text-xs text-(--text-muted)">note overlay: {JSON.stringify(aggregation.note_overlay)}</p>
        )}
        {ev.window?.rule && <p className="mt-1 text-xs text-(--text-muted)">window rule: {ev.window.rule}</p>}
      </div>

      {/* Full verbatim notes + appointment status/outcome/recovery fields. */}
      <div>
        <p className="kpi-label">Acuity notes (verbatim)</p>
        <p className="mt-1 whitespace-pre-wrap text-(--text-body)">
          {row.notes ?? "— none recorded"}
        </p>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs tabular-nums text-(--text-caption) sm:grid-cols-2">
          <div>appointment status: {row.appointmentStatus ?? "—"}</div>
          <div>appointment outcome: {row.outcome ?? "— (cancellations ledger not yet computed)"}</div>
          <div>recovered: — (cancellations ledger not yet computed)</div>
          <div>successor appointment: — (cancellations ledger not yet computed)</div>
        </dl>
      </div>
    </div>
  );
}
