/**
 * TEMPLATES SEGMENT (management-redesign spec §3B, command-center pass 10/2)
 * — compact 2-column template library, NOT a database form or giant stacked
 * cards. Five seeded Mallory management structures (Booking / Conversion /
 * Call Activity / Attendance/Reliability / Custom) as cards; create/edit runs
 * in the editor route (/performance/templates/$id/edit, "new" = create).
 *
 * CARD ACTIONS (spec §3B): Use Template is the card's PRIMARY action (opens
 * the guided wizard with the template preselected — the existing ?template=<id>
 * deep link); Edit and Duplicate stay visible but restrained; Delete hides in
 * the ⋯ More menu. No new capability is invented — same handlers as before.
 *
 * MICROCOPY (refinement spec §5): "Starting points for new plans." visible; the
 * no-AI policy lives once in the shell header InfoTip. "changes are audited"
 * stays visible on the mutating controls.
 *
 * HONESTY: templates carry NO weekly-minimum field (the manager enters it per
 * PIP in the wizard) — the card facts row shows only cadence + duration, and
 * omits segments with nothing to show rather than inventing values. The old
 * "Goal & dates — Written" pseudo-table is condensed to one "Predefined" line.
 *
 * PHASE 4 — TEMPLATES-IN-USE: the count is server-derived from LIVE PIP rows
 * (draft + issued states) via store.getPipTemplateUsage — so every card shows
 * whether/how many active PIPs reference the template ("In use by N active
 * PIPs" vs "No active PIPs"). Closed plans stop counting (their frozen
 * snapshots keep the provenance), which makes the count the honest
 * "safe to revise or delete" signal. The Delete action stays gated on 0.
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  createPipTemplate,
  deletePipTemplate,
  listPipTemplatesWithUsage,
} from "~/server/pip-api";
import type { PipTemplateRow } from "~/server/store/types";
import { EmptyState, GhostButton, PerformanceShell } from "~/components/performance-shell";
import { InfoTip } from "~/components/InfoTip";

export const Route = createFileRoute("/performance-templates")({
  loader: () => listPipTemplatesWithUsage(),
  component: TemplatesPage,
});

function TemplatesPage() {
  const data = Route.useLoaderData();
  const usage = new Map(data.usage);
  return (
    <PerformanceShell
      path="/performance-templates"
      headerAction={
        <Link to="/performance/templates/$id/edit" params={{ id: "new" }} className="btn-primary">
          New template
        </Link>
      }
      tabCounts={{ templates: data.templates.length }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-[13px] text-(--text-caption)">Starting points for new plans.</p>
          <InfoTip tip="Templates pre-fill a draft; applying one is always an explicit manager action." />
        </div>
        <p className="text-[12px] text-(--text-caption)">
          {data.templates.length} {data.templates.length === 1 ? "template" : "templates"} · changes are audited
        </p>
      </div>

      <div className="mt-4">
        {data.templates.length === 0 ? (
          <EmptyState
            title="No templates yet"
            hint="A template pre-fills a draft — goal wording, duration, and check-in cadence — so a new PIP starts from a known structure."
            action={
              <Link to="/performance/templates/$id/edit" params={{ id: "new" }} className="btn-primary">
                New template
              </Link>
            }
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {data.templates.map((t) => (
              <TemplateCard key={t.id} t={t} inUse={usage.get(t.id) ?? 0} />
            ))}
          </div>
        )}
      </div>
    </PerformanceShell>
  );
}

/** The ⋯ More menu — restrained overflow actions (Delete lives here, per spec §3B). */
function TemplateMoreMenu({ children }: { children: ReactNode }) {
  return (
    <details className="relative inline-block">
      <summary
        className="inline-flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-md text-[13px] text-(--text-muted) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary) [&::-webkit-details-marker]:hidden"
        aria-label="More template actions"
      >
        <span aria-hidden="true">⋯</span>
      </summary>
      <div
        className="absolute bottom-8 right-0 z-10 min-w-36 rounded-md border border-(--card-border) bg-(--card-bg) py-1 shadow-sm"
        onClick={(e) => {
          const d = e.currentTarget.closest("details");
          if (d) d.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}

function TemplateCard({ t, inUse }: { t: PipTemplateRow; inUse: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const facts: string[] = [];
  if (t.default_duration_weeks != null) facts.push(`${t.default_duration_weeks} weeks`);
  if (t.default_checkin_cadence_days != null) facts.push(`Check-in every ${t.default_checkin_cadence_days} days`);

  // "Predefined" condensed to one line — only what the template actually carries.
  const predefined: string[] = [];
  if (t.default_goal_text) predefined.push("Goal wording");
  if (t.default_action_plan.length > 0) predefined.push(`Action plan (${t.default_action_plan.length})`);
  if (t.default_personal.length > 0) predefined.push(`Personal dev (${t.default_personal.length})`);
  if (t.default_professional.length > 0) predefined.push(`Professional dev (${t.default_professional.length})`);

  const runMutate = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(() => router.invalidate()).finally(() => setBusy(false));
  };

  return (
    <article className="card flex flex-col p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="truncate text-[15px] font-semibold text-(--text-primary)" title={t.name}>
            {t.name}
          </h3>
          <span className="chip chip-neutral text-[11px]">v{t.version}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {t.category && <span className="chip chip-neutral text-[11px]">{t.category}</span>}
          {inUse > 0 ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-(--chip-current-bg) px-2 py-0.5 text-[11px] font-medium text-(--chip-current-fg)">
              In use by {inUse} active {inUse === 1 ? "PIP" : "PIPs"}
              <InfoTip
                className="ml-0.5 inline-flex align-middle"
                tip="Counts LIVE plans created from this template — drafts and issued plans in force. Completed and cancelled plans are closed records and stop counting, so this is the honest 'still referenced' signal. Issued PIPs keep the version they were issued with."
              />
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-0.5 rounded-full border border-(--card-border) px-2 py-0.5 text-[11px] text-(--text-muted)"
              title="No draft or issued PIP references this template."
            >
              No active PIPs
              <InfoTip
                className="ml-0.5 inline-flex align-middle"
                tip="No draft or issued PIP references this template — it is safe to revise or delete without orphaning a live plan. Closed plans (completed/cancelled) keep their frozen snapshots either way."
              />
            </span>
          )}
        </div>
      </div>

      <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-(--text-body)">
        {t.default_goal_text ?? "No goal wording yet — the manager writes it per PIP."}
      </p>

      <p className="mt-3 text-[12px] text-(--text-caption)">
        <span className="text-(--text-muted)">Predefined:</span>{" "}
        {predefined.length > 0 ? predefined.join(" · ") : <span className="text-(--text-faint)">—</span>}
      </p>
      {facts.length > 0 && <p className="mt-1 text-[12px] text-(--text-caption)">{facts.join(" · ")}</p>}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-(--table-border-weak) pt-3">
        <Link to="/performance-new" search={{ template: t.id }} className="btn-primary">
          Use Template
        </Link>
        <div className="flex items-center gap-1.5">
          <Link
            to="/performance/templates/$id/edit"
            params={{ id: t.id }}
            className="rounded-md border border-(--card-border) px-2 py-1 text-[12px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary)"
          >
            Edit
          </Link>
          <GhostButton
            title={`Duplicate "${t.name}"`}
            disabled={busy}
            onClick={() =>
              runMutate(() =>
                createPipTemplate({
                  data: {
                    name: `${t.name} (copy)`,
                    category: t.category,
                    defaultGoalText: t.default_goal_text,
                    defaultActionPlan: t.default_action_plan,
                    defaultPersonal: t.default_personal,
                    defaultProfessional: t.default_professional,
                    defaultCheckinCadenceDays: t.default_checkin_cadence_days,
                    defaultDurationWeeks: t.default_duration_weeks,
                  },
                }),
              )
            }
          >
            Duplicate
          </GhostButton>
          {inUse === 0 && (
            <TemplateMoreMenu>
              <button
                type="button"
                disabled={busy}
                title={`Delete template "${t.name}"`}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-(--text-body) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary) disabled:opacity-50"
                onClick={() =>
                  runMutate(() => deletePipTemplate({ data: { templateId: t.id } }))
                }
              >
                Delete
              </button>
            </TemplateMoreMenu>
          )}
        </div>
      </div>

      <p className="mt-2.5 text-[11px] text-(--text-caption)">
        Edited{" "}
        {new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(Date.parse(t.updated_at))}
        {t.created_by ? ` by ${t.created_by}` : ""}
      </p>
    </article>
  );
}
