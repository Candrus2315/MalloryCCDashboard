/** OWNER RULING 9/30: the four statuses are filter chips on /performance — this legacy route redirects so no old link breaks. */
import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/performance-drafts")({
  beforeLoad: () => {
    throw redirect({ to: "/performance", search: { status: "draft" }, replace: true });
  },
});
