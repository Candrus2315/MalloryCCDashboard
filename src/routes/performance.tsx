import { createFileRoute, useRouter, type SearchParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  addPipCheckin,
  cancelPip,
  completePip,
  createPipDraft,
  getPerformanceList,
  getPipDetail,
  getPipEvidence,
  getRosterReps,
  issuePip,
  listPipTemplates,
  updatePipDraft,
  type PipListItem,
} from "~/server/pip-api";
import type { PipDetail } from "~/server/pip-api";
import { Card, EmptyState, Field, GhostButton, PerformanceShell, PipStatusChip, PipTable, inputClass } from "~/components/performance-shell";

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

type PipSearch = { status?: string; edit?: string };

export const Route = createFileRoute("/performance")({
  validateSearch: (search: SearchParams): PipSearch => ({
    status: typeof search.status === "string" ? search.status : undefined,
    edit: typeof search.edit === "string" ? search.edit : undefined,
  }),
  loader: () => getPerformanceList(),
  component: PipsPage,
});

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
  const shown = filter === "all" ? all : all.filter((p) => p.status === filter);
  const editingId = isStatusFilter(search.edit) || typeof search.edit === "string" ? search.edit : null;
  const editPip = editingId ? (all.find((p) => p.id === editingId) ?? null) : null;

  return (
    <PerformanceShell path="/performance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-(--text-caption)">
          {filter === "draft"
            ? "Drafts are private to managers and never visible to employees."
            : filter === "all"
              ? "Every record, every status — newest first."
              : FILTER_LABEL[filter] === "Issued" || filter === "issued"
                ? "Issued plans under review — the issued document is a frozen evidence snapshot."
                : "Immutable records — kept permanently."}
        </p>
        <button
          type="button"
          className="rounded-md bg-(--accent-solid) px-3 py-2 text-[13px] font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover)"
          onClick={() => navigate({ to: "/performance", search: { status: filter === "all" ? "all" : filter, edit: "new" } })}
        >
          New draft
        </button>
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
            onClick={() => navigate({ to: "/performance", search: { status: f, edit: search.edit } })}
          >
            {FILTER_LABEL[f]} <span className="tabular-nums">{counts[f]}</span>
          </button>
        ))}
      </div>

      {(filter === "draft" || filter === "all") && editPip === null && search.edit === "new" && (
        <div className="mt-4">
          <DraftForm onCancel={() => navigate({ to: "/performance", search: { status: "draft" } })} onSaved={() => navigate({ to: "/performance", search: { status: "draft" } })} />
        </div>
      )}
      {editPip && editPip.status === "draft" && (
        <div className="mt-4">
          <DraftForm pip={editPip} onCancel={() => navigate({ to: "/performance", search: { status: "draft" } })} onSaved={() => navigate({ to: "/performance", search: { status: "draft" } })} />
        </div>
      )}

      <div className="mt-4">
        {shown.length === 0 ? (
          <EmptyState
            title={filter === "issued" ? "No active PIPs" : `No ${FILTER_LABEL[filter].toLowerCase()} PIPs`}
            hint={
              filter === "issued"
                ? "Issued plans appear here until completed or cancelled."
                : filter === "draft"
                  ? "Start a draft from the New draft button or from a template."
                  : "Nothing recorded under this status yet."
            }
          />
        ) : (
          <PipTable
            pips={shown}
            actions={(pip) =>
              pip.status === "draft" ? (
                <DraftRowActions pip={pip} />
              ) : pip.status === "issued" ? (
                <ActivePipActions pip={pip} />
              ) : undefined
            }
          />
        )}
      </div>
    </PerformanceShell>
  );
}

function DraftRowActions({ pip }: { pip: PipListItem }) {
  const navigate = Route.useNavigate();
  return (
    <div className="flex justify-end">
      <GhostButton onClick={() => navigate({ to: "/performance", search: { status: "draft", edit: pip.id } })}>Continue draft</GhostButton>
    </div>
  );
}

// ---------- creation workflow (pick rep → period → live evidence → goal + plan → issue) ----------

function DraftForm({ pip, onCancel, onSaved }: { pip?: PipListItem; onCancel: () => void; onSaved: () => void }) {
  const router = useRouter();
  const [reps, setReps] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string; version: number; default_goal_text: string | null; default_action_plan: { text: string; completed: boolean; completed_at: string | null }[]; default_personal: { text: string; completed: boolean; completed_at: string | null }[]; default_professional: { text: string; completed: boolean; completed_at: string | null }[]; default_checkin_cadence_days: number | null; default_duration_weeks: number | null }[]>([]);
  const [templateId, setTemplateId] = useState<string>(pip?.template_id ?? "");
  const [repId, setRepId] = useState(pip?.rep_id ?? "");
  const [title, setTitle] = useState(pip?.title ?? "");
  const [goalText, setGoalText] = useState(pip?.goal_text ?? "");
  const [weeklyGoalMin, setWeeklyGoalMin] = useState<string>(pip?.weekly_goal_min == null ? "" : String(pip.weekly_goal_min));
  const [hardMin, setHardMin] = useState(pip?.hard_weekly_minimum ?? false);
  const [reviewStart, setReviewStart] = useState(pip?.review_start_date ?? "");
  const [reviewEnd, setReviewEnd] = useState(pip?.review_end_date ?? "");
  const [pipStart, setPipStart] = useState(pip?.pip_start_date ?? "");
  const [pipEnd, setPipEnd] = useState(pip?.pip_end_date ?? "");
  const [cadence, setCadence] = useState<string>(pip?.checkin_cadence_days == null ? "" : String(pip.checkin_cadence_days));
  const [observations, setObservations] = useState(pip?.manager_observations ?? "");
  const [actions, setActions] = useState((pip?.action_plan ?? []).map((a) => a.text).join("\n"));
  const [personal, setPersonal] = useState((pip?.personal_development_actions ?? []).map((a) => a.text).join("\n"));
  const [professional, setProfessional] = useState((pip?.professional_development_actions ?? []).map((a) => a.text).join("\n"));
  const [evidence, setEvidence] = useState<import("~/server/pip-evidence").PipEvidence | null>(null);
  const [statements, setStatements] = useState<{ key: string; text: string }[]>([]);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [r, t] = await Promise.all([getRosterReps(), listPipTemplates()]);
      if (!alive) return;
      setReps(r.reps);
      setTemplates(t.templates);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // "New draft from template": apply the template's defaults into the form.
  const applyTemplate = useCallback(
    (id: string) => {
      setTemplateId(id);
      const t = templates.find((x) => x.id === id);
      if (!t) return;
      if (!pip) {
        setGoalText(t.default_goal_text ?? "");
        setActions((t.default_action_plan ?? []).map((a) => a.text).join("\n"));
        setPersonal((t.default_personal ?? []).map((a) => a.text).join("\n"));
        setProfessional((t.default_professional ?? []).map((a) => a.text).join("\n"));
        if (t.default_checkin_cadence_days != null) setCadence(String(t.default_checkin_cadence_days));
        if (t.default_duration_weeks != null && pipStart && !pipEnd) {
          const [y, m2, d2] = pipStart.split("-").map(Number);
          const end = new Date(Date.UTC(y, m2 - 1, d2 + t.default_duration_weeks * 7 - 1));
          setPipEnd(end.toISOString().slice(0, 10));
        }
      }
    },
    [templates, pip, pipStart, pipEnd],
  );

  // LIVE evidence: recompute as rep + review period + goal change (the same
  // pipEvidenceCore that issue freezes — never a second engine).
  useEffect(() => {
    if (!repId || !reviewStart || !reviewEnd) {
      setEvidence(null);
      setStatements([]);
      return;
    }
    let alive = true;
    const goal = weeklyGoalMin.trim() === "" ? null : Number(weeklyGoalMin);
    getPipEvidence({
      data: { repId, reviewStart, reviewEnd, weeklyGoalMin: goal != null && Number.isFinite(goal) ? goal : null, hardWeeklyMinimum: hardMin },
    })
      .then((r) => {
        if (alive) {
          setEvidence(r.evidence);
          setStatements(r.statements);
          setEvidenceError(null);
        }
      })
      .catch((e) => {
        if (alive) {
          setEvidence(null);
          setStatements([]);
          setEvidenceError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [repId, reviewStart, reviewEnd, weeklyGoalMin, hardMin]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await router.invalidate();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toActions = (text: string) =>
    text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text) => ({ text, completed: false, completed_at: null }));

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold tracking-tight">{pip ? "Continue draft" : "New draft"}</p>
          <p className="mt-0.5 text-[12px] text-(--text-muted)">
            Everything stays draft and editable until you explicitly issue — issue freezes the evidence snapshot.
          </p>
        </div>
        <GhostButton onClick={onCancel}>Close</GhostButton>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Employee">
          <select className={inputClass} value={repId} onChange={(e) => setRepId(e.target.value)}>
            <option value="">— pick a rep —</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Start from template (optional)">
          <select className={inputClass} value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">— none —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} v{t.version}</option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly booking goal review" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Review period start">
            <input type="date" className={inputClass} value={reviewStart} onChange={(e) => setReviewStart(e.target.value)} />
          </Field>
          <Field label="Review period end">
            <input type="date" className={inputClass} value={reviewEnd} onChange={(e) => setReviewEnd(e.target.value)} />
          </Field>
        </div>
      </div>

      {/* Evidence + factual statements (§4g) — live for the draft, frozen at issue */}
      <div className="mt-4 rounded-lg border-l-2 border-(--table-border-strong) pl-3">
        <p className="text-[12px] text-(--text-caption)">
          Generated from verified dashboard data — fixed factual statements, reviewed by you before issue. Will be frozen at issue.
        </p>
        {!repId || !reviewStart || !reviewEnd ? (
          <p className="mt-2 text-[13px] text-(--text-muted)">Pick the employee and the review period to compute the evidence.</p>
        ) : evidenceError ? (
          <p className="mt-2 text-[13px] text-red-600">{evidenceError}</p>
        ) : evidence ? (
          <>
            {evidence.warnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-[12px] text-(--text-caption)">
                {evidence.warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
            <div className="mt-2 overflow-x-auto">
              <table className="data-table w-full text-[12px]">
                <thead>
                  <tr>
                    <th className="text-left">Week</th>
                    <th className="text-right">Goal</th>
                    <th className="text-right">Actual</th>
                    <th className="text-left">Met</th>
                    <th className="text-left">Dashboard goal (provenance)</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.weekly.map((w) => (
                    <tr key={w.week_start}>
                      <td className="whitespace-nowrap">
                        {w.week_start} → {w.week_end}
                        {w.state === "in_progress" && <span className="ml-1 text-[11px] text-(--text-muted)">in progress</span>}
                      </td>
                      <td className="text-right tabular-nums">{w.pip_goal == null ? "—" : w.pip_goal}</td>
                      <td className="text-right tabular-nums">{w.actual == null ? "—" : w.actual}</td>
                      <td>{w.met == null ? <span className="text-(--text-faint)">—</span> : w.met ? "Yes" : "No"}</td>
                      <td className="text-(--text-caption)">
                        {w.dashboard_goal == null ? "—" : w.dashboard_goal}
                        {w.dashboard_goal_note ? ` · ${w.dashboard_goal_note}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[12px] text-(--text-caption)">
              Completed weeks: {evidence.weeks_completed} · met the weekly goal {evidence.weeks_goal_met}
              {evidence.goal_hit_rate_pct != null ? ` (${evidence.goal_hit_rate_pct}%)` : ""} · paid bookings credited to date {evidence.total_wins_to_date}
            </p>
            {statements.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {statements.map((s) => (
                  <li key={s.key} className="text-[13px] leading-relaxed text-(--text-body)">{s.text}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-(--text-muted)">
                {weeklyGoalMin.trim() === "" ? "Enter the weekly goal to generate the factual statements." : "No completed weeks in this review period yet — no weekly evidence statements."}
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-[13px] text-(--text-muted)">Computing evidence…</p>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Weekly goal (bookings)">
          <input type="number" min="0" className={inputClass} value={weeklyGoalMin} onChange={(e) => setWeeklyGoalMin(e.target.value)} />
        </Field>
        <Field label="Check-in cadence (days)">
          <input type="number" min="1" className={inputClass} value={cadence} onChange={(e) => setCadence(e.target.value)} />
        </Field>
      </div>
      <label className="mt-2 flex items-center gap-2 text-[13px] text-(--text-body)">
        <input type="checkbox" checked={hardMin} onChange={(e) => setHardMin(e.target.checked)} />
        Hard weekly minimum — each week is evaluated individually, never averaged
      </label>

      <div className="mt-3 grid gap-3">
        <Field label="Expectations / goal text">
          <textarea className={inputClass + " min-h-[64px]"} value={goalText} onChange={(e) => setGoalText(e.target.value)} />
        </Field>
        <Field label="Manager observations">
          <textarea className={inputClass + " min-h-[72px]"} value={observations} onChange={(e) => setObservations(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PIP window start">
            <input type="date" className={inputClass} value={pipStart} onChange={(e) => setPipStart(e.target.value)} />
          </Field>
          <Field label="PIP window end">
            <input type="date" className={inputClass} value={pipEnd} onChange={(e) => setPipEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Action plan (one action per line)">
          <textarea className={inputClass + " min-h-[64px]"} value={actions} onChange={(e) => setActions(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Personal development actions (one per line)">
            <textarea className={inputClass + " min-h-[48px]"} value={personal} onChange={(e) => setPersonal(e.target.value)} />
          </Field>
          <Field label="Professional development actions (one per line)">
            <textarea className={inputClass + " min-h-[48px]"} value={professional} onChange={(e) => setProfessional(e.target.value)} />
          </Field>
        </div>
      </div>

      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="text-[12px] text-(--text-muted)">changes are audited</span>
        <GhostButton onClick={onCancel}>Discard</GhostButton>
        <button
          type="button"
          disabled={busy || !repId || !title.trim() || !goalText.trim() || !reviewStart || !reviewEnd}
          className="rounded-md bg-(--accent-solid) px-3 py-2 text-[13px] font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover) disabled:opacity-50"
          onClick={() =>
            run(async () => {
              const payload = {
                title,
                goalText,
                weeklyGoalMin: weeklyGoalMin.trim() === "" ? null : Number(weeklyGoalMin),
                hardWeeklyMinimum: hardMin,
                reviewStartDate: reviewStart,
                reviewEndDate: reviewEnd,
                pipStartDate: pipStart || null,
                pipEndDate: pipEnd || null,
                managerObservations: observations,
                actionPlan: toActions(actions),
                personalDevelopmentActions: toActions(personal),
                professionalDevelopmentActions: toActions(professional),
                checkinCadenceDays: cadence.trim() === "" ? null : Number(cadence),
                templateId: templateId || null,
              };
              if (pip) await updatePipDraft({ data: { pipId: pip.id, ...payload } });
              else await createPipDraft({ data: { repId, ...payload } });
            })
          }
        >
          {busy ? "Saving…" : pip ? "Save draft" : "Create draft"}
        </button>
      </div>
    </Card>
  );
}

// ---------- issued PIP management (Phase 1 panel, re-homed) ----------

function ActivePipActions({ pip }: { pip: PipListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-end">
      <GhostButton onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Manage"}</GhostButton>
      {open && <ActivePipPanel pip={pip} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ActivePipPanel({ pip, onClose }: { pip: PipListItem; onClose: () => void }) {
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

  useEffect(() => {
    let alive = true;
    getPipDetail({ data: { pipId: pip.id } }).then((d) => {
      if (alive) setDetail(d);
    });
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
    <div className="fixed inset-0 z-50 flex justify-end bg-(--scrim)" onClick={onClose}>
      <div
        className="h-full w-[560px] max-w-[92vw] overflow-y-auto border-l border-(--card-border) bg-(--page-bg) p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold">{pip.title}</p>
            <p className="text-[13px] text-(--text-muted)">
              {pip.rep_name ?? "—"} · {pip.pip_start_date ?? "—"} → {pip.pip_end_date ?? "—"}
            </p>
          </div>
          <GhostButton onClick={onClose}>Close</GhostButton>
        </div>

        {error && <p className="mt-3 rounded-md bg-(--surface-subtle) px-3 py-2 text-[12px] text-red-600">{error}</p>}

        <Card>
          <p className="text-[13px] font-medium">Goal</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] text-(--text-body)">{pip.goal_text ?? "—"}</p>
          {pip.manager_observations && (
            <>
              <p className="mt-3 text-[13px] font-medium">Manager observations (frozen at issue)</p>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-(--text-body)">{pip.manager_observations}</p>
            </>
          )}
          {detail && detail.snapshots.length > 0 && (
            <p className="mt-3 text-[12px] text-(--text-muted)">
              Evidence snapshot v{detail.snapshots[detail.snapshots.length - 1].version} written {detail.snapshots[detail.snapshots.length - 1].created_at.slice(0, 10)} — the issued document is immutable.
            </p>
          )}
        </Card>

        <Card>
          <p className="text-[13px] font-medium">Check-ins ({detail?.checkins.length ?? 0})</p>
          <div className="mt-2 space-y-2">
            {(detail?.checkins ?? []).map((c) => (
              <div key={c.id} className="rounded-md border border-(--card-border) px-3 py-2">
                <p className="text-[12px] font-medium">{c.checkin_date}{c.manager_name ? ` · ${c.manager_name}` : ""}</p>
                {c.current_performance && <p className="mt-1 text-[12px] text-(--text-body)">{c.current_performance}</p>}
                {c.manager_notes && <p className="mt-1 text-[12px] text-(--text-muted)">{c.manager_notes}</p>}
              </div>
            ))}
            {(detail?.checkins.length ?? 0) === 0 && <p className="text-[12px] text-(--text-muted)">No check-ins yet.</p>}
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
          <div className="mt-2">
            <button
              type="button"
              disabled={busy || !checkinDate || !checkinNotes.trim()}
              className="rounded-md bg-(--accent-solid) px-3 py-1.5 text-[12px] font-medium text-(--accent-solid-fg) disabled:opacity-50"
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
        </Card>

        <Card>
          <p className="text-[13px] font-medium">Complete the PIP</p>
          <p className="mt-0.5 text-[12px] text-(--text-muted)">Requires a conclusion category and notes — both entered by you.</p>
          <div className="mt-2">
            <Field label="Conclusion category">
              <input className={inputClass} placeholder="e.g. Successful completion / Extended / Terminated" value={category} onChange={(e) => setCategory(e.target.value)} />
            </Field>
          </div>
          <Field label="Conclusion notes">
            <textarea className={inputClass + " mt-1 min-h-[64px]"} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="mt-2">
            <button
              type="button"
              disabled={busy || !category.trim() || !notes.trim()}
              className="rounded-md bg-(--accent-solid) px-3 py-1.5 text-[12px] font-medium text-(--accent-solid-fg) disabled:opacity-50"
              onClick={() => run(() => completePip({ data: { pipId: pip.id, conclusionCategory: category, conclusionNotes: notes } }))}
            >
              Mark completed
            </button>
          </div>
        </Card>

        <Card>
          <p className="text-[13px] font-medium">Cancel the PIP</p>
          <p className="mt-0.5 text-[12px] text-(--text-muted)">Ends the plan without completion; the reason is recorded permanently.</p>
          <Field label="Cancellation reason">
            <textarea className={inputClass + " mt-1 min-h-[48px]"} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </Field>
          <div className="mt-2">
            <button
              type="button"
              disabled={busy || !cancelReason.trim()}
              className="rounded-md border border-(--card-border) px-3 py-1.5 text-[12px] font-medium text-(--text-body) hover:border-(--input-border) disabled:opacity-50"
              onClick={() => run(() => cancelPip({ data: { pipId: pip.id, reason: cancelReason } }))}
            >
              Cancel PIP
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
