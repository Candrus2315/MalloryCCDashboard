import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { createPipTemplate, deletePipTemplate, listPipTemplates } from "~/server/pip-api";
import type { PipTemplateRow } from "~/server/store/types";
import { Card, EmptyState, Field, GhostButton, PerformanceShell, inputClass } from "~/components/performance-shell";

export const Route = createFileRoute("/performance-templates")({
  loader: () => listPipTemplates(),
  component: TemplatesPage,
});

function TemplatesPage() {
  const data = Route.useLoaderData();
  return (
    <PerformanceShell path="/performance/templates">
      <div className="space-y-4">
        <CreateTemplateForm />
        {data.templates.length === 0 ? (
          <EmptyState title="No templates" hint="Create a reusable template above: name, category, default goal text, check-in cadence, and duration." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-(--card-border) bg-(--card-bg)">
            <table className="data-table min-w-[760px] text-[13px]">
              <thead>
                <tr>
                  <th scope="col" className="text-left">Name</th>
                  <th scope="col" className="text-left">Category</th>
                  <th scope="col" className="text-left">Default goal</th>
                  <th scope="col" className="text-right">Check-in cadence</th>
                  <th scope="col" className="text-right">Duration</th>
                  <th scope="col" className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.templates.map((t) => (
                  <tr key={t.id}>
                    <td className="py-2 font-medium">{t.name}</td>
                    <td className="py-2">{t.category ?? "—"}</td>
                    <td className="py-2 max-w-[280px] truncate" title={t.default_goal_text ?? undefined}>{t.default_goal_text ?? "—"}</td>
                    <td className="py-2 text-right">{t.default_checkin_cadence_days == null ? "—" : `${t.default_checkin_cadence_days} days`}</td>
                    <td className="py-2 text-right">{t.default_duration_weeks == null ? "—" : `${t.default_duration_weeks} weeks`}</td>
                    <td className="py-2 text-right"><DeleteTemplateButton id={t.id} name={t.name} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PerformanceShell>
  );
}

function CreateTemplateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [goal, setGoal] = useState("");
  const [cadence, setCadence] = useState("");
  const [weeks, setWeeks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          createPipTemplate({
            data: {
              name,
              category: category || null,
              defaultGoalText: goal || null,
              defaultCheckinCadenceDays: cadence ? Number(cadence) : null,
              defaultDurationWeeks: weeks ? Number(weeks) : null,
            },
          })
            .then(() => {
              setName("");
              setCategory("");
              setGoal("");
              setCadence("");
              setWeeks("");
              return router.invalidate();
            })
            .catch((e2: unknown) => setError(e2 instanceof Error ? e2.message : String(e2)))
            .finally(() => setBusy(false));
        }}
      >
        <p className="text-[13px] font-medium">New template</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Category (optional)">
            <input className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Booking goals" />
          </Field>
          <Field label="Default check-in cadence (days, optional)">
            <input type="number" min={1} className={inputClass} value={cadence} onChange={(e) => setCadence(e.target.value)} />
          </Field>
          <Field label="Default duration (weeks, optional)">
            <input type="number" min={1} className={inputClass} value={weeks} onChange={(e) => setWeeks(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Default goal text (optional)">
              <textarea className={inputClass + " min-h-[56px]"} value={goal} onChange={(e) => setGoal(e.target.value)} />
            </Field>
          </div>
        </div>
        {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
        <div className="mt-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-(--accent-solid) px-3 py-1.5 text-[13px] font-medium text-(--accent-solid-fg) disabled:opacity-50"
          >
            {busy ? "Saving…" : "Create template"}
          </button>
        </div>
      </form>
    </Card>
  );
}

function DeleteTemplateButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <GhostButton
      title={`Delete template "${name}"`}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        deletePipTemplate({ data: { templateId: id } })
          .then(() => router.invalidate())
          .finally(() => setBusy(false));
      }}
    >
      Delete
    </GhostButton>
  );
}
