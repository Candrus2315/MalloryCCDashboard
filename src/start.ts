/**
 * Start instance — registers GLOBAL request middleware.
 *
 * The gate runs for every request TanStack Start handles: SSR page loads
 * (handlerType "router") and server-function RPC endpoints (handlerType
 * "serverFn"). With DASHBOARD_PASSPHRASE set, unauthenticated requests get the
 * lock screen (documents) or a 401 (RPC/API). Unset → fully open.
 *
 * Providing a start instance replaces the framework's default CSRF middleware,
 * so it is restated here first — server-function RPCs stay CSRF-protected.
 */
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { resolveGate } from "./server/auth";

const csrfMiddleware = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

const dashboardGate = createMiddleware({ type: "request" }).server(async ({ request, next }) => {
  const gate = await resolveGate(request);
  return gate.kind === "allow" ? next() : gate.response;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, dashboardGate],
}));
