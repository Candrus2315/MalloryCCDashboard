/**
 * 7-STEP GUIDED CREATION (designer refinement spec §3, 9/30) — route
 * /performance/new with ?step=n. Replaces the old gutted DraftForm entirely.
 *
 * Flow: Step 1 creates the draft SERVER-SIDE (createPipDraft — with template
 * provenance when a chip was applied); every Continue persists that step's
 * fields with updatePipDraft; Step 7 calls issuePip → frozen v1 snapshot.
 * Everything stays draft and fully editable until the explicit issue action.
 *
 * The evidence shown is the SAME engine the issue freezes (getPipEvidence →
 * pipEvidenceCore) — this file is presentation + flow only: no calculation,
 * no status-guard logic, no AI. Validation gates Next with inline messages.
 *
 * After issue the manager lands on the PIPs list (Active filter) — the full
 * record page is a later pass (designer spec §2); no extra routes were added
 * in this change.
 */
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createPipDraft,
  getPipDetail,
  getPipEvidence,
  getRosterReps,
  issuePip,
  listPipTemplates,
  updatePipDraft,
} from "~/server/pip-api";
import type { PipEvidence } from "~/server/pip-evidence";
import type { PipActionItem, PipTemplateRow } from "~/server/store/types";
import { EvidencePanel, EvidenceWeekTable } from "~/components/pip-evidence-panel";
import { InfoTip } from "~/components/InfoTip";
import { inputClass } from "~/components/performance-shell";

type NewSearch = { step?: string; pip?: string; template?: string };

export const Route = createFileRoute("/performance-new")({
  validateSearch: (search: Record<string, unknown>): NewSearch => ({
    step: typeof search.step === "string" ? search.step : undefined,
    pip: typeof search.pip === "string" ? search.pip : undefined,
    template: typeof search.template === "string" ? search.template : undefined,
  }),
  component: NewPipWizard,
});

const STEPS = [
  { n: 1, label: "Employee" },
  { n: 2, label: "Evidence" },
  { n: 3, label: "Goal & dates" },
  { n: 4, label: "Observations & plan" },
  { n: 5, label: "Development" },
  { n: 6, label: "Preview" },
  { n: 7, label: "Issue" },
] as const;

function clampStep(v: string | undefined): number {
  const n = Number(v ?? "1");
  return Number.isFinite(n) && n >= 1 && n <= 7 ? Math.trunc(n) : 1;
}

/** ET calendar today, YYYY-MM-DD (en-CA formats ISO). */
function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(Date.parse(`${dateStr}T12:00:00Z`));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday strictly AFTER the given date (PIP window starts the week after the evidence window ends). */
function mondayAfter(dateStr: string): string {
  const dow = new Date(Date.parse(`${dateStr}T12:00:00Z`)).getUTCDay(); // 0 Sun … 6 Sat
  const delta = ((8 - dow) % 7) || 7;
  return addDays(dateStr, delta);
}

function etShort(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(
    new Date(Date.parse(`${dateStr}T12:00:00Z`)),
  );
}

interface FormState {
  repId: string;
  title: string;
  goalText: string;
  weeklyGoalMin: string;
  hardMin: boolean;
  reviewStart: string;
  reviewEnd: string;
  pipStart: string;
  pipEnd: string;
  cadence: string;
  observations: string;
  actionPlan: PipActionItem[];
  personal: PipActionItem[];
  professional: PipActionItem[];
}

const EMPTY_FORM: FormState = {
  repId: "",
  title: "",
  goalText: "",
  weeklyGoalMin: "",
  hardMin: false,
  reviewStart: "",
  reviewEnd: "",
  pipStart: "",
  pipEnd: "",
  cadence: "",
  observations: "",
  actionPlan: [],
  personal: [],
  professional: [],
};

function NewPipWizard() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const step = clampStep(search.step);
  const pipParam = search.pip ?? null;

  const [reps, setReps] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<PipTemplateRow[]>([]);
  const [repSearch, setRepSearch] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [templateId, setTemplateId] = useState("");
  const [pipId, setPipId] = useState<string | null>(pipParam);
  const [loadedPip, setLoadedPip] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hydratedRepName, setHydratedRepName] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<PipEvidence | null>(null);
  const [statements, setStatements] = useState<{ key: string; text: string }[]>([]);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);

  const patch = useCallback((p: Partial<FormState>) => setForm((f) => ({ ...f, ...p })), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [r, t] = await Promise.all([getRosterReps(), listPipTemplates()]);
      if (!alive) return;
      setReps(r.reps);
      setTemplates(t.templates);
      // "Use in new PIP" preselect (designer spec §7): ?template=<id> applies at Step 1.
      if (!pipParam && typeof search.template === "string" && t.templates.some((x) => x.id === search.template)) {
        const tpl = t.templates.find((x) => x.id === search.template)!
        setTemplateId(tpl.id);
        patch({
          goalText: tpl.default_goal_text ?? "",
          actionPlan: tpl.default_action_plan ?? [],
          personal: tpl.default_personal ?? [],
          professional: tpl.default_professional ?? [],
          cadence: tpl.default_checkin_cadence_days == null ? "" : String(tpl.default_checkin_cadence_days),
        });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Continue-draft hydration: ?pip=<id> loads the draft row into the wizard.
  useEffect(() => {
    if (!pipParam || loadedPip === pipParam) return;
    let alive = true;
    getPipDetail({ data: { pipId: pipParam } })
      .then((d) => {
        if (!alive) return;
        setLoadedPip(pipParam);
        if (!d) {
          setLoadError("No PIP found for this link.");
          return;
        }
        if (d.pip.status !== "draft") {
          setLoadError("This PIP is no longer a draft — issued documents are frozen. Open it from the PIPs list.");
          return;
        }
        setPipId(d.pip.id);
        setHydratedRepName(d.pip.rep_name ?? null);
        setTemplateId(d.pip.template_id ?? "");
        setForm({
          repId: d.pip.rep_id ?? "",
          title: d.pip.title ?? "",
          goalText: d.pip.goal_text ?? "",
          weeklyGoalMin: d.pip.weekly_goal_min == null ? "" : String(d.pip.weekly_goal_min),
          hardMin: d.pip.hard_weekly_minimum,
          reviewStart: d.pip.review_start_date ?? "",
          reviewEnd: d.pip.review_end_date ?? "",
          pipStart: d.pip.pip_start_date ?? "",
          pipEnd: d.pip.pip_end_date ?? "",
          cadence: d.pip.checkin_cadence_days == null ? "" : String(d.pip.checkin_cadence_days),
          observations: d.pip.manager_observations ?? "",
          actionPlan: d.pip.action_plan ?? [],
          personal: d.pip.personal_development_actions ?? [],
          professional: d.pip.professional_development_actions ?? [],
        });
      })
      .catch(() => {
        if (alive) setLoadError("Could not load the draft.");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipParam, loadedPip]);

  // LIVE evidence: the same pipEvidenceCore the issue path freezes — recomputes
  // as rep + review period + goal change (never a second engine).
  const goalNum = useMemo(() => {
    const t = form.weeklyGoalMin.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }, [form.weeklyGoalMin]);

  useEffect(() => {
    if (!form.repId || !form.reviewStart || !form.reviewEnd) {
      setEvidence(null);
      setStatements([]);
      return;
    }
    let alive = true;
    getPipEvidence({
      data: {
        repId: form.repId,
        reviewStart: form.reviewStart,
        reviewEnd: form.reviewEnd,
        weeklyGoalMin: goalNum,
        hardWeeklyMinimum: form.hardMin,
      },
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
  }, [form.repId, form.reviewStart, form.reviewEnd, goalNum, form.hardMin]);

  const template = templates.find((t) => t.id === templateId) ?? null;
  const durationWeeks = template?.default_duration_weeks ?? 6;

  // Step 2 defaults: today → +template duration (or 6 weeks).
  useEffect(() => {
    if (step !== 2) return;
    if (!form.reviewStart) {
      const t = etToday();
      setForm((p) => ({ ...p, reviewStart: p.reviewStart || t, reviewEnd: p.reviewEnd || addDays(t, durationWeeks * 7 - 1) }));
    } else if (!form.reviewEnd) {
      setForm((p) => ({ ...p, reviewEnd: p.reviewEnd || addDays(p.reviewStart, durationWeeks * 7 - 1) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, durationWeeks]);

  // Step 3 defaults: title "{employee} — {template}"; PIP window = Monday after
  // the review period → start + duration.
  useEffect(() => {
    if (step !== 3) return;
    if (!form.title.trim()) {
      const rep = reps.find((r) => r.id === form.repId);
      const name = rep?.name ?? hydratedRepName;
      if (name) {
        setForm((p) => (p.title.trim() ? p : { ...p, title: `${name} — ${template?.name ?? "Performance Improvement Plan"}` }));
      }
    }
    if (!form.pipStart && form.reviewEnd) {
      const monday = mondayAfter(form.reviewEnd);
      setForm((p) => ({ ...p, pipStart: p.pipStart || monday, pipEnd: p.pipEnd || addDays(monday, durationWeeks * 7 - 1) }));
    } else if (form.pipStart && !form.pipEnd) {
      setForm((p) => ({ ...p, pipEnd: p.pipEnd || addDays(p.pipStart, durationWeeks * 7 - 1) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, durationWeeks]);

  const employeeName = reps.find((r) => r.id === form.repId)?.name ?? (form.repId ? hydratedRepName : null) ?? null;

  // Forward navigation unlocks only when each earlier step's required fields hold.
  const reviewDatesOk = !!form.reviewStart && !!form.reviewEnd && form.reviewEnd >= form.reviewStart;
  const step3Ok =
    !!form.title.trim() && !!form.goalText.trim() && !!form.pipStart && !!form.pipEnd && form.pipEnd >= form.pipStart;
  const maxAllowed = !form.repId ? 1 : !reviewDatesOk ? 2 : !step3Ok ? 3 : 7;

  function validateStep(n: number): string | null {
    if (n === 1 && !form.repId) return "Pick an employee to continue.";
    if (n === 2) {
      if (!form.reviewStart || !form.reviewEnd) return "Set both review period dates to continue.";
      if (form.reviewEnd < form.reviewStart) return "Review period end cannot precede its start.";
    }
    if (n === 3) {
      if (!form.title.trim()) return "Give the plan a title.";
      if (!form.goalText.trim()) return "Write the expectations the employee will be measured against.";
      if (!form.pipStart || !form.pipEnd) return "Set the PIP window start and end dates.";
      if (form.pipEnd < form.pipStart) return "PIP window end cannot precede its start.";
    }
    return null;
  }

  const go = useCallback(
    (n: number) => {
      setError(null);
      void navigate({ to: "/performance/new", search: { step: String(n), pip: pipId ?? undefined, template: undefined } });
    },
    [navigate, pipId],
  );

  const markSaved = () => {
    setSavedAt(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date()),
    );
  };

  const saveStep = async (n: number): Promise<boolean> => {
    const msg = validateStep(n);
    if (msg) {
      setError(msg);
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      if (n === 1) {
        const title = form.title.trim() || `${employeeName ?? "New"} — ${template?.name ?? "Performance Improvement Plan"}`;
        if (pipId) {
          await updatePipDraft({ data: { pipId, repId: form.repId, title } });
        } else {
          const created = await createPipDraft({
            data: {
              repId: form.repId,
              title,
              goalText: form.goalText,
              weeklyGoalMin: goalNum,
              hardWeeklyMinimum: form.hardMin,
              managerObservations: form.observations,
              actionPlan: form.actionPlan,
              personalDevelopmentActions: form.personal,
              professionalDevelopmentActions: form.professional,
              checkinCadenceDays: form.cadence.trim() === "" ? null : Number(form.cadence),
              templateId: templateId || null,
            },
          });
          setPipId(created.id);
          setSavedAt(
            new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date()),
          );
          void navigate({ to: "/performance/new", search: { step: "2", pip: created.id, template: undefined } });
          return true;
        }
      } else if (n === 2 && pipId) {
        await updatePipDraft({ data: { pipId, reviewStartDate: form.reviewStart || null, reviewEndDate: form.reviewEnd || null } });
      } else if (n === 3 && pipId) {
        await updatePipDraft({
          data: {
            pipId,
            title: form.title,
            goalText: form.goalText,
            weeklyGoalMin: goalNum,
            hardWeeklyMinimum: form.hardMin,
            pipStartDate: form.pipStart || null,
            pipEndDate: form.pipEnd || null,
            checkinCadenceDays: form.cadence.trim() === "" ? null : Number(form.cadence),
          },
        });
      } else if (n === 4 && pipId) {
        await updatePipDraft({ data: { pipId, managerObservations: form.observations, actionPlan: form.actionPlan } });
      } else if (n === 5 && pipId) {
        await updatePipDraft({
          data: { pipId, personalDevelopmentActions: form.personal, professionalDevelopmentActions: form.professional },
        });
      } else if (n === 6) {
        void navigate({ to: "/performance/new", search: { step: "7", pip: pipId ?? undefined, template: undefined } });
        return true;
      }
      markSaved();
      void navigate({ to: "/performance/new", search: { step: String(Math.min(n + 1, 7)), pip: pipId ?? undefined, template: undefined } });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const applyTemplate = (t: PipTemplateRow) => {
    setTemplateId(t.id);
    patch({
      goalText: t.default_goal_text ?? "",
      actionPlan: t.default_action_plan ?? [],
      personal: t.default_personal ?? [],
      professional: t.default_professional ?? [],
      cadence: t.default_checkin_cadence_days == null ? "" : String(t.default_checkin_cadence_days),
    });
  };

  const issue = async () => {
    if (!pipId) return;
    setIssuing(true);
    setError(null);
    try {
      await issuePip({ data: { pipId } });
      await router.invalidate();
      void navigate({ to: "/performance", search: { status: "issued" } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIssuing(false);
    }
  };

  // ---------- step content ----------

  const filteredReps = repSearch.trim()
    ? reps.filter((r) => r.name.toLowerCase().includes(repSearch.trim().toLowerCase()))
    : reps;

  const stepEmployee = (
    <div>
      <p className="section-heading">Select employee</p>
      {reps.length > 8 && (
        <input
          className={inputClass + " mt-3"}
          placeholder="Search the roster…"
          value={repSearch}
          onChange={(e) => setRepSearch(e.target.value)}
        />
      )}
      <div className="mt-3 space-y-1.5">
        {filteredReps.map((r) => (
          <label
            key={r.id}
            className={
              "flex cursor-pointer items-center justify-between rounded-md border px-3 py-2.5 text-[13px] transition-colors " +
              (form.repId === r.id
                ? "border-(--input-border) bg-(--surface-selected)"
                : "border-(--card-border) bg-(--card-bg) hover:border-(--input-border)")
            }
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name="pip-rep"
                checked={form.repId === r.id}
                onChange={() => patch({ repId: r.id })}
              />
              <span className="font-medium text-(--text-primary)">{r.name}</span>
            </span>
            {form.repId === r.id && <span className="text-[11px] text-(--text-caption)">selected</span>}
          </label>
        ))}
        {filteredReps.length === 0 && <p className="px-1 text-[13px] text-(--text-muted)">No roster members match.</p>}
      </div>

      <div className="mt-8">
        <hr className="border-(--card-border)" />
        <p className="section-heading mt-4 flex items-center gap-1.5">
          Start from a template
          <InfoTip tip="Templates pre-fill a draft; applying one is always an explicit manager action. Skipping is the default." />
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={templateId === t.id}
              onClick={() => (templateId === t.id ? setTemplateId("") : applyTemplate(t))}
              className={
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors " +
                (templateId === t.id
                  ? "border-transparent bg-(--surface-subtle) text-(--text-primary)"
                  : "border-(--card-border) bg-(--card-bg) text-(--text-caption) hover:border-(--input-border) hover:text-(--text-primary)")
              }
            >
              {t.name}
              <span className="chip chip-neutral text-[11px]">v{t.version}</span>
            </button>
          ))}
          {templates.length === 0 && <p className="text-[12px] text-(--text-muted)">No templates yet — start blank.</p>}
        </div>
      </div>
    </div>
  );

  const stepEvidence = (
    <div>
      <p className="section-heading">Review period</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-(--text-caption)">Review period start</span>
          <input type="date" className={inputClass} value={form.reviewStart} onChange={(e) => patch({ reviewStart: e.target.value })} />
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-(--text-caption)">Review period end</span>
          <input type="date" className={inputClass} value={form.reviewEnd} onChange={(e) => patch({ reviewEnd: e.target.value })} />
        </label>
      </div>
      <div className="mt-4">
        {!form.repId || !form.reviewStart || !form.reviewEnd ? (
          <p className="text-[13px] text-(--text-muted)">Set the review period to compute the evidence.</p>
        ) : evidenceError ? (
          <p className="text-[13px]" style={{ color: "var(--neg-text)" }}>{evidenceError}</p>
        ) : evidence ? (
          <EvidencePanel evidence={evidence} statements={statements} />
        ) : (
          <p className="text-[13px] text-(--text-muted)">Computing evidence…</p>
        )}
      </div>
    </div>
  );

  const stepGoal = (
    <div>
      <p className="section-heading">Set PIP goal and dates</p>
      <div className="mt-3 grid gap-3">
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-(--text-caption)">Title</span>
          <input className={inputClass} value={form.title} onChange={(e) => patch({ title: e.target.value })} />
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-(--text-caption)">Expectations / goal text</span>
          <textarea className={inputClass + " min-h-[72px]"} value={form.goalText} onChange={(e) => patch({ goalText: e.target.value })} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium text-(--text-caption)">Weekly goal (bookings)</span>
            <input type="number" min="0" className={inputClass} value={form.weeklyGoalMin} onChange={(e) => patch({ weeklyGoalMin: e.target.value })} />
          </label>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-[13px] text-(--text-body)">
              <input type="checkbox" checked={form.hardMin} onChange={(e) => patch({ hardMin: e.target.checked })} />
              Hard weekly minimum
              <InfoTip tip="Each week is evaluated individually against this number; weeks are never averaged." />
            </label>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px]">
            <span className="mb-1 flex items-center gap-1.5 font-medium text-(--text-caption)">
              PIP window start
              <InfoTip tip="The review period is the evidence window; the PIP window is the improvement period being planned." />
            </span>
            <input type="date" className={inputClass} value={form.pipStart} onChange={(e) => patch({ pipStart: e.target.value })} />
          </label>
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium text-(--text-caption)">PIP window end</span>
            <input type="date" className={inputClass} value={form.pipEnd} onChange={(e) => patch({ pipEnd: e.target.value })} />
          </label>
        </div>
        <label className="block text-[13px] sm:max-w-[240px]">
          <span className="mb-1 block font-medium text-(--text-caption)">Check-in cadence (days)</span>
          <input type="number" min="1" className={inputClass} value={form.cadence} onChange={(e) => patch({ cadence: e.target.value })} />
        </label>
      </div>
      {evidence && (
        <div className="mt-6">
          <hr className="border-(--card-border)" />
          <p className="section-heading mt-4">Goal-met preview (live)</p>
          <div className="mt-2">
            <EvidenceWeekTable evidence={evidence} />
          </div>
        </div>
      )}
    </div>
  );

  const stepObservations = (
    <div>
      <p className="section-heading">Manager observations</p>
      <textarea
        className={inputClass + " mt-3 min-h-[96px]"}
        placeholder="What you have observed — entered by you; the system never drafts observations."
        value={form.observations}
        onChange={(e) => patch({ observations: e.target.value })}
      />
      <p className="section-heading mt-8">Action plan</p>
      <div className="mt-2">
        <ListEditor items={form.actionPlan} onChange={(items) => patch({ actionPlan: items })} addLabel="Add action" />
      </div>
    </div>
  );

  const stepDevelopment = (
    <div>
      <p className="section-heading">Personal development</p>
      <div className="mt-2">
        <ListEditor items={form.personal} onChange={(items) => patch({ personal: items })} addLabel="Add personal action" />
      </div>
      <div className="mt-8">
        <hr className="border-(--card-border)" />
        <p className="section-heading mt-4">Professional development</p>
        <div className="mt-2">
          <ListEditor items={form.professional} onChange={(items) => patch({ professional: items })} addLabel="Add professional action" />
        </div>
      </div>
    </div>
  );

  const previewMeta: { label: string; value: string }[] = [
    { label: "Employee", value: employeeName ?? "—" },
    { label: "Manager", value: "christopher" },
    { label: "Template", value: template ? `${template.name} v${template.version}` : "—" },
    { label: "Issued", value: `${etToday()} at issue` },
    { label: "Status", value: "Draft — freezes at issue" },
    { label: "Window", value: form.pipStart && form.pipEnd ? `${etShort(form.pipStart)} – ${etShort(form.pipEnd)}` : "—" },
  ];

  const stepPreview = (
    <div className="mx-auto max-w-2xl">
      <div className="card p-6">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[10px] uppercase tracking-[0.2em] text-(--text-caption)">Mallory Portraits</p>
          <p className="text-[10px] text-(--text-caption)">Confidential — management record</p>
        </div>
        <hr className="mt-2 border-(--card-border)" />
        <p className="mt-4 text-[20px] font-semibold tracking-tight">Performance Improvement Plan</p>
        <p className="mt-1 text-[12px] text-(--text-muted)">
          Draft preview · will freeze as version 1 at issue · window{" "}
          {form.pipStart && form.pipEnd ? `${form.pipStart} – ${form.pipEnd}` : "—"}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[12px] sm:grid-cols-3">
          {previewMeta.map((m) => (
            <div key={m.label}>
              <p className="text-(--text-caption)">{m.label}</p>
              <p className="mt-0.5 font-medium text-(--text-primary)">{m.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 space-y-6">
          <PreviewSection n={1} title="Purpose & expectations" editStep={3} onEdit={go}>
            {form.goalText.trim() ? (
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-(--text-body)">{form.goalText}</p>
            ) : (
              <p className="text-[13px] text-(--text-muted)">Not written yet.</p>
            )}
          </PreviewSection>

          <PreviewSection n={2} title="Evidence at issue" editStep={2} onEdit={go}>
            {evidence ? (
              <div>
                <p className="text-[12px] text-(--text-caption)">
                  Captured at issue · computed {new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(Date.parse(evidence.computed_at))} ET — verified from dashboard data; later dashboard changes never rewrite this record.
                </p>
                <ul className="mt-2 space-y-2">
                  {statements.map((s) => (
                    <li key={s.key} className="rounded-md bg-(--surface-inset) px-3 py-2 text-[13px] leading-relaxed text-(--text-body)">
                      {s.text}
                    </li>
                  ))}
                </ul>
                {statements.length === 0 && (
                  <p className="mt-2 text-[13px] text-(--text-muted)">No statements yet — set the weekly goal to generate them.</p>
                )}
              </div>
            ) : (
              <p className="text-[13px] text-(--text-muted)">
                No review period set — the frozen snapshot will carry no weekly evidence.
              </p>
            )}
          </PreviewSection>

          <PreviewSection n={3} title="Weekly goals" editStep={3} onEdit={go}>
            {evidence ? <EvidenceWeekTable evidence={evidence} /> : <p className="text-[13px] text-(--text-muted)">—</p>}
          </PreviewSection>

          <PreviewSection n={4} title="Check-in log">
            <p className="text-[13px] text-(--text-muted)">No check-ins yet — the log starts at issue.</p>
          </PreviewSection>

          <PreviewSection n={7} title="Acknowledgment">
            <p className="text-[13px] text-(--text-muted)">Recorded by the manager during the acknowledgment meeting.</p>
          </PreviewSection>
        </div>

        <hr className="mt-6 border-(--card-border)" />
        <p className="mt-3 text-[12px] text-(--text-caption)">Preview — issuing freezes exactly this content as version 1.</p>
      </div>
    </div>
  );

  const stepIssue = (
    <div className="mx-auto max-w-2xl">
      <div className="card p-5">
        <p className="section-heading">Issue this PIP</p>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-[12px] sm:grid-cols-3">
          {previewMeta.map((m) => (
            <div key={m.label}>
              <p className="text-(--text-caption)">{m.label}</p>
              <p className="mt-0.5 font-medium text-(--text-primary)">{m.value}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 space-y-1.5 rounded-md bg-(--surface-inset) px-3 py-3 text-[13px] leading-relaxed text-(--text-body)">
          <p>Issuing freezes this document as version 1 — later dashboard changes never rewrite it.</p>
          <p>Corrections after issue happen through documented amendments.</p>
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          <span className="text-[12px] text-(--text-muted)">changes are audited</span>
          <button type="button" disabled={issuing || !pipId} className="btn-primary" onClick={issue}>
            {issuing ? "Issuing…" : "Issue PIP"}
          </button>
        </div>
        {loadError && <p className="mt-2 text-[12px]" style={{ color: "var(--neg-text)" }}>{loadError}</p>}
      </div>
    </div>
  );

  const content =
    step === 1 ? stepEmployee : step === 2 ? stepEvidence : step === 3 ? stepGoal : step === 4 ? stepObservations : step === 5 ? stepDevelopment : step === 6 ? stepPreview : stepIssue;

  return (
    <div>
      {/* page header (scrolls away; the step strip sticks under the app header) */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{pipId ? "Continue PIP draft" : "New PIP"}</h1>
          <p className="mt-0.5 text-[13px] text-(--text-caption)">Guided creation — everything stays draft until you issue.</p>
        </div>
        <Link to="/performance" className="rounded-md border border-(--card-border) px-3 py-2 text-[13px] text-(--text-caption) hover:border-(--input-border) hover:text-(--text-primary)">
          Close
        </Link>
      </div>

      {/* sticky step strip */}
      <div className="sticky top-[68px] z-[1] -mx-4 mt-3 border-b border-(--card-border) bg-(--sticky-header-bg) px-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:top-14">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-between gap-3 pt-2">
            <p className="truncate text-[13px] font-medium">New PIP — {employeeName ?? "Select employee"}</p>
            <div className="whitespace-nowrap text-right text-[12px] text-(--text-caption)">
              <p>Step {step} of 7</p>
              {savedAt && <p>Draft saved {savedAt}</p>}
            </div>
          </div>
          <div className="hidden gap-1 overflow-x-auto py-2 whitespace-nowrap sm:flex">
            {STEPS.map((s) => {
              const active = s.n === step;
              const done = s.n < step;
              const reachable = s.n <= maxAllowed;
              return (
                <button
                  key={s.n}
                  type="button"
                  disabled={!reachable}
                  onClick={() => reachable && go(s.n)}
                  aria-current={active ? "step" : undefined}
                  className={
                    "rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors " +
                    (active
                      ? "bg-(--surface-subtle) text-(--text-primary)"
                      : done
                        ? "text-(--text-caption) hover:bg-(--surface-subtle) hover:text-(--text-primary)"
                        : reachable
                          ? "text-(--text-muted) hover:bg-(--surface-subtle)"
                          : "cursor-default text-(--text-muted) opacity-60")
                  }
                >
                  {done && <span aria-hidden className="mr-1 inline-block h-1 w-1 rounded-full bg-(--dot-positive)" />}
                  <span className="tabular-nums">{s.n}</span> {s.label}
                </button>
              );
            })}
          </div>
          <p className="py-2 text-[12px] text-(--text-caption) sm:hidden">
            {step} / 7 · {STEPS[step - 1].label}
          </p>
          <div className="bg-(--bar-track) pb-0" style={{ height: 2 }}>
            <div className="h-0.5 bg-(--bar-fill) transition-all" style={{ width: `${(step / 7) * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="mx-auto mt-6 max-w-3xl">
        {loadError && (
          <div className="card p-4">
            <p className="text-[13px]" style={{ color: "var(--neg-text)" }}>{loadError}</p>
            <Link to="/performance" className="mt-2 inline-block text-[12px] text-(--text-caption) underline">
              Back to PIPs
            </Link>
          </div>
        )}
        {!loadError && (
          <>
            <div className="card p-5">{content}</div>
            <div className="sticky bottom-0 z-[1] -mx-4 mt-4 border-t border-(--card-border) bg-(--sticky-header-bg) px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
              <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
                <div className="min-w-0">
                  {error && <p className="truncate text-[12px]" style={{ color: "var(--neg-text)" }}>{error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {step > 1 && (
                    <button type="button" className="btn-secondary" onClick={() => go(step - 1)} disabled={busy}>
                      Back
                    </button>
                  )}
                  {step < 7 ? (
                    <button type="button" className="btn-primary" disabled={busy} onClick={() => void saveStep(step)}>
                      {busy ? "Saving…" : step === 1 && !pipId ? "Create draft & continue" : "Save & continue"}
                    </button>
                  ) : (
                    <span className="text-[12px] text-(--text-muted)">Use Issue PIP above.</span>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One numbered document section for the Step 6 preview. */
function PreviewSection({
  n,
  title,
  editStep,
  onEdit,
  children,
}: {
  n: number;
  title: string;
  editStep?: number;
  onEdit?: (n: number) => void;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold text-(--text-primary)">
          <span className="tabular-nums text-(--text-caption)">{n}.</span> {title}
        </p>
        {editStep != null && onEdit && (
          <button type="button" onClick={() => onEdit(editStep)} className="text-[12px] text-(--text-caption) underline">
            Edit
          </button>
        )}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/** Add/remove list editor for action rows (spec §3 steps 4–5). */
function ListEditor({
  items,
  onChange,
  addLabel,
}: {
  items: PipActionItem[];
  onChange: (items: PipActionItem[]) => void;
  addLabel: string;
}) {
  if (items.length === 0) {
    return (
      <button
        type="button"
        onClick={() => onChange([{ text: "", completed: false, completed_at: null }])}
        className="rounded-md border border-(--card-border) px-3 py-2 text-[12px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary)"
      >
        {addLabel}
      </button>
    );
  }
  return (
    <div>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className={inputClass}
              value={item.text}
              placeholder="Describe the action…"
              onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
            />
            <button
              type="button"
              aria-label={`Remove action ${i + 1}`}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-(--text-muted) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary)"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...items, { text: "", completed: false, completed_at: null }])}
        className="mt-1.5 rounded-md border border-(--card-border) px-3 py-2 text-[12px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary)"
      >
        {addLabel}
      </button>
    </div>
  );
}
