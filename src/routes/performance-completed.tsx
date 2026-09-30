import { createFileRoute } from "@tanstack/react-router";
import { getPerformanceList } from "~/server/pip-api";
import { EmptyState, PerformanceShell, PipTable } from "~/components/performance-shell";

export const Route = createFileRoute("/performance-completed")({
  loader: () => getPerformanceList({ data: { status: "completed" } }),
  component: CompletedPage,
});

function CompletedPage() {
  const data = Route.useLoaderData();
  return (
    <PerformanceShell
      path="/performance-completed"
      title="Completed PIPs"
      subtitle="Finished review periods. Completed PIPs are fully immutable — the record, its conclusion, and its evidence snapshots are kept permanently."
    >
      {data.pips.length === 0 ? (
        <EmptyState
          title="No completed PIPs"
          hint="A completed PIP is one a manager closed with a conclusion category and notes after its review period."
        />
      ) : (
        <PipTable pips={data.pips} />
      )}
    </PerformanceShell>
  );
}
