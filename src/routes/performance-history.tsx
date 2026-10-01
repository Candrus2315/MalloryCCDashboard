/**
 * HISTORY SEGMENT (refinement spec §5, 9/30) — the module's full event ledger.
 * MICROCOPY RULE: visible copy is operational only — "Every action, with actor
 * and before/after." + one header InfoTip ("History is never deleted.").
 *
 * SUBJECT FIX (spec §5, last row): subjects render as EMPLOYEE NAME + PIP
 * TITLE (template name for template events) resolved server-side — raw IDs
 * never render as a subject/employee anywhere. An event whose PIP row is gone
 * still names what it can: "Deleted record" is never shown as a raw ID.
 */
import { createFileRoute } from "@tanstack/react-router";
import { getPerformanceHistory } from "~/server/pip-api";
import { EmptyState, PerformanceShell } from "~/components/performance-shell";
import { InfoTip } from "~/components/InfoTip";

export const Route = createFileRoute("/performance-history")({
  loader: () => getPerformanceHistory(),
  component: HistoryPage,
});

const EVENT_LABELS: Record<string, string> = {
  pip_created: "Draft created",
  pip_edited: "Draft edited",
  pip_observation_changed: "Observations changed",
  pip_issued: "Issued (snapshot v1 frozen)",
  pip_completed: "Completed",
  pip_cancelled: "Cancelled",
  pip_checkin_added: "Check-in added",
  pip_template_created: "Template created",
  pip_template_updated: "Template updated",
  pip_template_deleted: "Template deleted",
};

function HistoryPage() {
  const data = Route.useLoaderData();
  const pipSubjects = new Map(data.pipSubjects);
  const templateNames = new Map(data.templateNames);

  const subject = (e: (typeof data.events)[number]): string => {
    if (e.template_id) return templateNames.get(e.template_id) ?? "Deleted template";
    if (e.pip_id) {
      const s = pipSubjects.get(e.pip_id);
      if (s && (s.employee || s.title)) return [s.employee ?? "Unassigned", s.title].filter(Boolean).join(" — ");
      return "Deleted record";
    }
    return "—";
  };

  return (
    <PerformanceShell path="/performance/history">
      <div className="flex items-center gap-2">
        <p className="text-[13px] text-(--text-caption)">Every action, with actor and before/after.</p>
        <InfoTip tip="History is never deleted." />
      </div>
      <div className="mt-3">
        {data.events.length === 0 ? (
          <EmptyState title="No events yet" hint="Actions appear here automatically as they happen." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-(--card-border) bg-(--card-bg)">
            <table className="data-table min-w-[860px] text-[12px]">
              <thead>
                <tr>
                  <th scope="col" className="text-left">When</th>
                  <th scope="col" className="text-left">Event</th>
                  <th scope="col" className="text-left">By</th>
                  <th scope="col" className="text-left">Subject</th>
                  <th scope="col" className="text-left">Field</th>
                  <th scope="col" className="text-left">Before → After</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 whitespace-nowrap text-(--text-muted)">{e.created_at.replace("T", " ").slice(0, 16)}</td>
                    <td className="py-2 font-medium">{EVENT_LABELS[e.event_type] ?? e.event_type}</td>
                    <td className="py-2">{e.actor ?? "—"}</td>
                    <td className="py-2 max-w-[280px] truncate font-medium text-(--text-primary)" title={subject(e)}>
                      {subject(e)}
                    </td>
                    <td className="py-2">{e.field ?? "—"}</td>
                    <td className="py-2 max-w-[320px] truncate text-(--text-muted)" title={`${e.previous_value ?? ""} → ${e.new_value ?? ""}`}>
                      {e.previous_value == null ? "" : e.previous_value} → {e.new_value == null ? "" : e.new_value}
                    </td>
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
