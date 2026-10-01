/**
 * TEMPLATES SEGMENT (refinement spec §4, 9/30) — card list, NOT a database
 * form. Five seeded Mallory management structures (Booking / Conversion /
 * Call Activity / Attendance/Reliability / Custom) as cards; create/edit runs
 * in the editor route (/performance/templates/$id/edit, "new" = create).
 *
 * MICROCOPY (spec §5): "Starting points for new plans." visible; the no-AI
 * policy lives once in the shell header InfoTip. "changes are audited" stays
 * visible on the mutating controls.
 *
 * HONESTY: templates carry NO weekly-minimum field (the manager enters it per
 * PIP in the wizard) — the card facts row shows only cadence + duration, and
 * omits segments with nothing to show rather than inventing values.
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
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
    <PerformanceShell path="/performance-templates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-[13px] text-(--text-caption)">Starting points for new plans.</p>
          <InfoTip tip="Templates pre-fill a draft; applying one is always an explicit manager action." />
        </div>
        <Link to="/performance/templates/new/edit" className="btn-primary">
          New template
        </Link>
      </div>

      <p className="mt-2 text-[12px] text-(--text-caption)">
        {data.templates.length} templates · changes are audited
      </p>

      <div className="mt-4 max-w-3xl space-y-4">
        {data.templates.length === 0 ? (
          <EmptyState title="No templates" hint="Create the first starting point with New template." />
        ) : (
          data.templates.map((t) => (
            <TemplateCard key={t.id} t={t} inUse={usage.get(t.id) ?? 0} />
          ))
        )}
      </div>
    </PerformanceShell>
  );
}

function TemplateCard({ t, inUse }: { t: PipTemplateRow; inUse: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const facts: string[] = [];
  if (t.default_checkin_cadence_days != null) facts.push(`Check-ins: every ${t.default_checkin_cadence_days} days`);
  if (t.default_duration_weeks != null) facts.push(`Duration: ${t.default_duration_weeks} weeks`);

  const structure: { label: string; value: string }[] = [
    { label: "Goal & dates", value: t.default_goal_text ? "Written" : "—" },
    { label: "Manager observations", value: "Entered per PIP" },
    { label: "Action plan", value: t.default_action_plan.length > 0 ? `${t.default_action_plan.length} items` : "—" },
    { label: "Personal development", value: t.default_personal.length > 0 ? `${t.default_personal.length} items` : "—" },
    { label: "Professional development", value: t.default_professional.length > 0 ? `${t.default_professional.length} items` : "—" },
  ];

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[15px] font-semibold text-(--text-primary)">{t.name}</p>
          <span className="chip chip-neutral text-[11px]">v{t.version}</span>
          {inUse > 0 && (
            <span className="rounded-full bg-(--chip-current-bg) px-2 py-0.5 text-[11px] font-medium text-(--chip-current-fg)">
              Used by {inUse} {inUse === 1 ? "PIP" : "PIPs"}
              <InfoTip className="ml-1 inline-flex align-middle" tip="Counts issued plans created from this template — completed and cancelled included. Issued PIPs keep the version they were issued with." />
            </span>
          )}
        </div>
        {t.category && <span className="chip chip-neutral text-[11px]">{t.category}</span>}
      </div>

      <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-(--text-body)">
        {t.default_goal_text ?? "No goal wording yet — the manager writes it per PIP."}
      </p>

      <div className="mt-3 divide-y divide-(--table-border-weak)">
        {structure.map((s) => (
          <div key={s.label} className="flex items-center justify-between py-1.5 text-[12px] first:border-0">
            <span className="text-(--text-caption)">{s.label}</span>
            <span className={s.value === "—" || s.value === "Entered per PIP" ? "text-(--text-muted)" : "text-(--text-body)"}>{s.value}</span>
          </div>
        ))}
      </div>

      {facts.length > 0 && <p className="mt-3 text-[12px] text-(--text-caption)">{facts.join(" · ")}</p>}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-(--table-border-weak) pt-3">
        <p className="text-[12px] text-(--text-caption)">
          Edited {new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(Date.parse(t.updated_at))}
          {t.created_by ? ` by ${t.created_by}` : ""}
        </p>
        <div className="flex items-center gap-1.5">
          <GhostButton
            title="Duplicate this template"
            disabled={busy}
            onClick={() => {
              setBusy(true);
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
              })
                .then(() => router.invalidate())
                .finally(() => setBusy(false));
            }}
          >
            Duplicate
          </GhostButton>
          <Link
            to="/performance/templates/$id/edit"
            params={{ id: t.id }}
            className="rounded-md border border-(--card-border) px-2 py-1 text-[12px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary)"
          >
            Edit
          </Link>
          {inUse === 0 && (
            <GhostButton
              title={`Delete template "${t.name}"`}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                deletePipTemplate({ data: { templateId: t.id } })
                  .then(() => router.invalidate())
                  .finally(() => setBusy(false));
              }}
            >
              Delete
            </GhostButton>
          )}
        </div>
      </div>
    </div>
  );
}
