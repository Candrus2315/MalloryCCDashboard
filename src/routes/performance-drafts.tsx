import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { createPipDraft, getPerformanceList, getRosterReps, issuePip, updatePipDraft } from "~/server/pip-api";
import type { PipListItem } from "~/server/pip-api";
import { Card, EmptyState, Field, GhostButton, PerformanceShell, PipTable, inputClass } from "~/components/performance-shell";

export const Route = createFileRoute("/performance-drafts")({
  loader: async () => {
    const [list, reps] = await Promise.all([
      getPerformanceList({ data: { status: "draft" } }),
      getRosterReps(),
    ]);
    return { pips: list.pips, reps: reps.reps };
  },
  component: DraftsPage,
});

function DraftsPage() {
  const data = Route.useLoaderData();
  return (
    <PerformanceShell
      path="/performance-drafts"
      title="Drafts"
      subtitle="Draft plans are fully editable. Issuing freezes the document permanently (a version-1 evidence snapshot) — a draft needs a goal and PIP start/end dates before it can be issued."
    >
      <div className="space-y-4">
        <CreateDraftForm reps={data.reps} />
        {data.pips.length === 0 ? (
          <EmptyState title="No drafts" hint="Create a draft above — nothing is auto-created and nothing is issued until you say so." />
        ) : (
          <PipTable pips={data.pips} actions={(pip) => <DraftActions pip={pip} />} />
        )}
      </div>
    </PerformanceShell>
  );
}

function CreateDraftForm({ reps }: { reps: { id: string; name: string }[] }) {
  const router = useRouter();
  const [repId, setRepId] = useState("");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [weeklyGoal, setWeeklyGoal] = useState("");
  const [hardMin, setHardMin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await createPipDraft({
        data: {
          repId,
          title,
          goalText: goal || null,
          pipStartDate: start || null,
          pipEndDate: end || null,
          weeklyGoalMin: weeklyGoal ? Number(weeklyGoal) : null,
          hardWeeklyMinimum: hardMin,
        },
      });
      setTitle("");
      setGoal("");
      setStart("");
      setEnd("");
      setWeeklyGoal("");
      setHardMin(false);
      setDone(true);
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <p className="text-[13px] font-medium">New draft</p>
      <p className="mt-0.5 text-[12px] text-(--text-muted)">Manager-created only. The system never drafts, proposes, or recommends anything.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Rep">
          <select className={inputClass} value={repId} onChange={(e) => setRepId(e.target.value)}>
            <option value="">Pick a rep…</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly booking goal review" />
        </Field>
        <Field label="PIP start date">
          <input type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="PIP end date">
          <input type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="Weekly goal (optional)">
          <input type="number" min={0} className={inputClass} value={weeklyGoal} onChange={(e) => setWeeklyGoal(e.target.value)} />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-[13px] text-(--text-body)">
          <input type="checkbox" checked={hardMin} onChange={(e) => setHardMin(e.target.checked)} />
          Hard weekly minimum (never averaged)
        </label>
        <div className="sm:col-span-2">
          <Field label="Goal text (required to issue)">
            <textarea className={inputClass + " min-h-[64px]"} value={goal} onChange={(e) => setGoal(e.target.value)} />
          </Field>
        </div>
      </div>
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
      {done && <p className="mt-2 text-[12px] text-(--text-muted)">Draft created.</p>}
      <div className="mt-3">
        <button
          type="button"
          disabled={busy || !repId || !title.trim()}
          onClick={submit}
          className="rounded-md bg-(--accent-solid) px-3 py-1.5 text-[13px] font-medium text-(--accent-solid-fg) disabled:opacity-50"
        >
          {busy ? "Saving…" : "Create draft"}
        </button>
      </div>
    </Card>
  );
}

/** Editable draft: title/goal/dates; Issue freezes the document (server-guarded). */
function DraftActions({ pip }: { pip: PipListItem }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(pip.title);
  const [goal, setGoal] = useState(pip.goal_text ?? "");
  const [start, setStart] = useState(pip.pip_start_date ?? "");
  const [end, setEnd] = useState(pip.pip_end_date ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex justify-end gap-1">
      <GhostButton onClick={() => setEditing((o) => !o)}>{editing ? "Close" : "Edit"}</GhostButton>
      <GhostButton
        title="Issue freezes the document permanently"
        disabled={busy}
        onClick={() => run(() => issuePip({ data: { pipId: pip.id } }))}
      >
        Issue
      </GhostButton>
      {error && <span className="sr-only">{error}</span>}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-(--scrim)" onClick={() => setEditing(false)}>
          <Card>
            <div className="w-[440px] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
              <p className="text-[13px] font-medium">Edit draft</p>
              <div className="mt-2 grid gap-2">
                <Field label="Title">
                  <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <Field label="Goal text">
                  <textarea className={inputClass + " min-h-[64px]"} value={goal} onChange={(e) => setGoal(e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Start">
                    <input type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
                  </Field>
                  <Field label="End">
                    <input type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
                  </Field>
                </div>
              </div>
              {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
              <div className="mt-3 flex justify-end gap-2">
                <GhostButton onClick={() => setEditing(false)}>Discard</GhostButton>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-md bg-(--accent-solid) px-3 py-1.5 text-[12px] font-medium text-(--accent-solid-fg) disabled:opacity-50"
                  onClick={() =>
                    run(() =>
                      updatePipDraft({
                        data: {
                          pipId: pip.id,
                          title,
                          goalText: goal,
                          pipStartDate: start || null,
                          pipEndDate: end || null,
                        },
                      }),
                    ).then(() => setEditing(false))
                  }
                >
                  Save
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
