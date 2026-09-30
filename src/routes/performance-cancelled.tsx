import { createFileRoute } from "@tanstack/react-router";
import { getPerformanceList } from "~/server/pip-api";
import { EmptyState, PerformanceShell, PipTable } from "~/components/performance-shell";

export const Route = createFileRoute("/performance-cancelled")({
  loader: () => getPerformanceList({ data: { status: "cancelled" } }),
  component: CancelledPage,
});

function CancelledPage() {
  const data = Route.useLoaderData();
  return (
    <PerformanceShell
      path="/performance-cancelled"
      title="Cancelled PIPs"
      subtitle="Plans ended without completion, each with its recorded cancellation reason. Cancelled PIPs are fully immutable and kept permanently."
    >
      {data.pips.length === 0 ? (
        <EmptyState
          title="No cancelled PIPs"
          hint="A cancelled PIP is one a manager ended with a recorded reason instead of a conclusion."
        />
      ) : (
        <PipTable pips={data.pips} />
      )}
    </PerformanceShell>
  );
}
