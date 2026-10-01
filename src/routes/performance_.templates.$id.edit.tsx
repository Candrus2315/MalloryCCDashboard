/**
 * TEMPLATE EDITOR (refinement spec §4, 9/30) — /performance/templates/$id/edit
 * with $id = "new" (create) or a template id (edit). Six defaults per the
 * owner's list: goal wording, action-plan items, personal-dev list,
 * professional-dev list, default duration weeks, default check-in cadence
 * days — plus name and category.
 *
 * IN-USE VERSIONING (spec §4): the store bumps the version on EVERY update —
 * issued PIPs keep the version they were issued with — so when a template is
 * in use the save button reads "Save as new version" and the InfoTip explains
 * the frozen provenance. The file is a PATHLESS-NESTED route (performance_.)
 * so the spec URL exists without restructuring /performance into a layout —
 * the full nested restructure stays Phase 3 (out of scope here).
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createPipTemplate, listPipTemplatesWithUsage, updatePipTemplate } from "~/server/pip-api";
import type { PipActionItem } from "~/server/store/types";
import { PerformanceShell, ListEditor, inputClass } from "~/components/performance-shell";
import { InfoTip } from "~/components/InfoTip";

type EditorParams = { id: string };

export const Route = createFileRoute("/performance_/templates/$id/edit")({
  params: {
    // "new" = create mode; otherwise a template id.
    parse: (raw) => ({ id: String(raw) }),
    stringify: (p) => ({ id: String(p.id) }),
  },
  loader: () => listPipTemplatesWithUsage(),
  component: TemplateEditor,
});

interface EditorState {
  name: string;
  category: string;
  goalText: string;
  actionPlan: PipActionItem[];
  personal: PipActionItem[];
  professional: PipActionItem[];
  cadence: string;
  weeks: string;
}

const EMPTY: EditorState = {
  name: "",
  category: "",
  goalText: "",
  actionPlan: [],
  personal: [],
  professional: [],
  cadence: "",
  weeks: "",
};

function TemplateEditor() {
  const params = Route.useParams();
  const data = Route.useLoaderData();
  const router = useRouter();
  const isNew = params.id === "new";
  const existing = isNew ? null : (data.templates.find((t) => t.id === params.id) ?? null);
  const inUse = existing ? (data.usage.find(([tid]) => tid === existing.id)?.[1] ?? 0) : 0;

  const [form, setForm] = useState<EditorState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!existing) return;
    setForm({
      name: existing.name,
      category: existing.category ?? "",
      goalText: existing.default_goal_text ?? "",
      actionPlan: existing.default_action_plan ?? [],
      personal: existing.default_personal ?? [],
      professional: existing.default_professional ?? [],
      cadence: existing.default_checkin_cadence_days == null ? "" : String(existing.default_checkin_cadence_days),
      weeks: existing.default_duration_weeks == null ? "" : String(existing.default_duration_weeks),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id]);

  const patch = (p: Partial<EditorState>) => setForm((f) => ({ ...f, ...p }));
  const valid = form.name.trim().length > 0;

  const save = async () => {
    if (!valid) {
      setError("Give the template a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category.trim() || null,
        defaultGoalText: form.goalText.trim() || null,
        defaultActionPlan: form.actionPlan.filter((x) => x.text.trim()),
        defaultPersonal: form.personal.filter((x) => x.text.trim()),
        defaultProfessional: form.professional.filter((x) => x.text.trim()),
        defaultCheckinCadenceDays: form.cadence.trim() === "" ? null : Number(form.cadence),
        defaultDurationWeeks: form.weeks.trim() === "" ? null : Number(form.weeks),
      };
      if (existing) {
        await updatePipTemplate({ data: { templateId: existing.id, ...payload } });
      } else {
        await createPipTemplate({ data: payload });
      }
      await router.invalidate();
      router.history.push("/performance-templates");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PerformanceShell path="/performance-templates">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{isNew ? "New template" : `Edit template — ${form.name || "…"}`}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-(--text-caption)">
            Defaults pre-fill a new PIP draft.
            {inUse > 0 && (
              <InfoTip tip="In use — editing creates a new version; issued PIPs keep the version they were issued with." />
            )}
          </p>
        </div>
        <Link to="/performance-templates" className="rounded-md border border-(--card-border) px-3 py-2 text-[13px] text-(--text-caption) hover:border-(--input-border) hover:text-(--text-primary)">
          Back
        </Link>
      </div>

      <div className="mt-5 max-w-3xl card p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium text-(--text-caption)">Name</span>
            <input className={inputClass} value={form.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium text-(--text-caption)">Category (optional)</span>
            <input className={inputClass} value={form.category} onChange={(e) => patch({ category: e.target.value })} placeholder="e.g. Booking" />
          </label>
          <div className="sm:col-span-2">
            <p className="section-heading">Default goal wording</p>
            <textarea
              className={inputClass + " mt-2 min-h-[88px]"}
              value={form.goalText}
              onChange={(e) => patch({ goalText: e.target.value })}
              placeholder="The expectation the employee will be measured against…"
            />
          </div>
          <div className="sm:col-span-2">
            <p className="section-heading">Default action-plan items</p>
            <div className="mt-2">
              <ListEditor items={form.actionPlan} onChange={(items) => patch({ actionPlan: items })} addLabel="Add action item" />
            </div>
          </div>
          <div className="sm:col-span-2">
            <p className="section-heading">Default personal development</p>
            <div className="mt-2">
              <ListEditor items={form.personal} onChange={(items) => patch({ personal: items })} addLabel="Add personal action" />
            </div>
          </div>
          <div className="sm:col-span-2">
            <p className="section-heading">Default professional development</p>
            <div className="mt-2">
              <ListEditor items={form.professional} onChange={(items) => patch({ professional: items })} addLabel="Add professional action" />
            </div>
          </div>
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium text-(--text-caption)">Default duration (weeks)</span>
            <input type="number" min={1} className={inputClass} value={form.weeks} onChange={(e) => patch({ weeks: e.target.value })} />
          </label>
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium text-(--text-caption)">Default check-in cadence (days)</span>
            <input type="number" min={1} className={inputClass} value={form.cadence} onChange={(e) => patch({ cadence: e.target.value })} />
          </label>
        </div>
        {error && <p className="mt-3 text-[12px]" style={{ color: "var(--neg-text)" }}>{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-3 border-t border-(--table-border-weak) pt-3">
          <span className="text-[12px] text-(--text-muted)">changes are audited</span>
          <button type="button" disabled={busy} className="btn-primary" onClick={() => void save()}>
            {busy ? "Saving…" : inUse > 0 ? "Save as new version" : "Save"}
          </button>
        </div>
      </div>
    </PerformanceShell>
  );
}
