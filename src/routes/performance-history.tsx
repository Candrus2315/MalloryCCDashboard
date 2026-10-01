import { createFileRoute } from "@tanstack/react-router";
import { getPerformanceEvents } from "~/server/pip-api";
import { EmptyState, PerformanceShell } from "~/components/performance-shell";

export const Route = createFileRoute("/performance/history")({
  loader: () => getPerformanceEvents({ data: { limit: 300 } }),
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
  return (
    <PerformanceShell path="/performance/history">
      {data.events.length === 0 ? (
        <EmptyState title="No events yet" hint="Every action taken anywhere in Performance Management is recorded here automatically." />
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
                  <td className="py-2 font-mono text-[11px]">{e.pip_id ? `pip ${e.pip_id.slice(0, 8)}` : e.template_id ? `template ${e.template_id.slice(0, 8)}` : "—"}</td>
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
    </PerformanceShell>
  );
}
