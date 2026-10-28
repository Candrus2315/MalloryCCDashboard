/**
 * SHARED API GATE — ONE authentication decision for the management APIs.
 *
 * Production serve.ts protects /api/audit and /api/retention-exceptions with
 * resolveGate(); the vite DEV middlewares previously did NOT — an
 * unauthenticated caller of the working site could read the audit API and,
 * worse, POST retention-exception resolve/dismiss actions (state-mutating,
 * audited, sticky). This module closes that gap:
 *
 *   - `requireGate(request)` — the ONE shared wrapper around auth.resolveGate.
 *     Both serve.ts (production) and the dev handlers below call THIS, so the
 *     dev and prod authentication decisions can never drift apart.
 *   - `gateConnectRequest` / `sendResponseToConnect` — the dev-only transport
 *     shim (connect req/res ↔ Web Request/Response). Pure plumbing; every
 *     decision still routes through requireGate.
 *   - `devAuditApiHandler` / `devRetentionExceptionsApiHandler` — the dev API
 *     handlers extracted from vite.config.ts, now gated. The gate runs BEFORE
 *     any store import or query, so an unauthorized POST can never reach
 *     handleExceptionAction (no mutation, no audit row).
 *
 * Dev ergonomics preserved: with DASHBOARD_PASSPHRASE unset the gate is open
 * (same as production — Settings warns); with it set, a browser logged into
 * the app via the lock screen carries the SAME signed session cookie the gate
 * accepts here (vite dev SSR and these middlewares share auth.ts).
 */
import { resolveGate } from "./auth";

/**
 * Shared protection wrapper: null → allowed; otherwise the 401/lock-screen
 * Response the caller must return instead of handling the request.
 */
export async function requireGate(request: Request, now = Date.now()): Promise<Response | null> {
  const gate = await resolveGate(request, now);
  return gate.kind === "allow" ? null : gate.response;
}

// ---------------------------------------------------------------------------
// Connect (node req/res) ↔ Web Request shim — DEV/PIPELINE ONLY.
// ---------------------------------------------------------------------------

/** Minimal structural subset of connect's IncomingMessage the handlers use. */
export interface ConnectLikeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Minimal structural subset of connect's ServerResponse the handlers use. */
export interface ConnectLikeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): unknown;
}

/**
 * Build the gate Request for a connect middleware mounted at mountPath.
 * connect strips the mount prefix (req.url is "/?rep=…"), so the FULL path is
 * reconstructed — resolveGate reasons on the real pathname. Only the headers
 * the gate reads (cookie, accept) are forwarded; no body is attached because
 * resolveGate never reads request bodies.
 */
export function connectRequestToGateRequest(mountPath: string, req: ConnectLikeRequest): Request {
  const suffix = req.url ?? "/";
  const full = `${mountPath}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  const headers = new Headers();
  const cookie = req.headers.cookie;
  if (typeof cookie === "string" && cookie.length > 0) headers.set("cookie", cookie);
  const accept = req.headers.accept;
  if (typeof accept === "string" && accept.length > 0) headers.set("accept", accept);
  return new Request(`http://localhost${full}`, { method: req.method ?? "GET", headers });
}

/**
 * Gate a connect request through the SHARED requireGate decision.
 * Returns null when allowed; otherwise writes the denial into the connect
 * response and returns it (the handler must stop).
 */
export async function gateConnectRequest(
  mountPath: string,
  req: ConnectLikeRequest,
  res: ConnectLikeResponse,
): Promise<Response | null> {
  const denied = await requireGate(connectRequestToGateRequest(mountPath, req));
  if (denied) {
    await sendResponseToConnect(res, denied);
    return denied;
  }
  return null;
}

/** Write a Web Response object into a connect-style response. */
export async function sendResponseToConnect(res: ConnectLikeResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") res.setHeader(name, value);
  });
  res.end(await response.text());
}

function connectError(res: ConnectLikeResponse, message: string): void {
  res.statusCode = 500;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

// ---------------------------------------------------------------------------
// The dev API handlers (extracted from vite.config.ts so they are gated AND
// unit-testable; the wiring in vite.config.ts is now two lines).
// ---------------------------------------------------------------------------

type AuditRunner = (params: { rep?: string | null; date?: string | null }) => Promise<{
  status: number;
  body: unknown;
}>;

/**
 * GET /api/audit?rep=<repId|all|unassigned>&date=YYYY-MM-DD — dev mirror of the
 * serve.ts endpoint (src/server/audit-api.ts), now behind the SAME gate.
 * `runAudit` is injectable for tests; production wiring uses the default
 * (lazy-imported so the vite config never loads the DB graph at boot).
 */
export function devAuditApiHandler(runAudit?: AuditRunner) {
  return (req: ConnectLikeRequest, res: ConnectLikeResponse) => {
    void (async () => {
      try {
        const denied = await gateConnectRequest("/api/audit", req, res);
        if (denied) return; // 401/lock screen already written — handler never runs
        const run =
          runAudit ??
          (await import("./audit-api") as typeof import("./audit-api")).handleAuditQuery;
        // connect strips the mount prefix, so req.url is "/?rep=…&date=…"
        const url = new URL(req.url ?? "/", "http://localhost");
        const out = await run({
          rep: url.searchParams.get("rep"),
          date: url.searchParams.get("date"),
        });
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(out.body));
      } catch (e) {
        connectError(res, e instanceof Error ? e.message : String(e));
      }
    })();
  };
}

/**
 * RETENTION DATA MATCH EXCEPTIONS API (stage 3a) — dev mirror of the serve.ts
 * endpoint: GET list + POST resolve / resolve_new / dismiss (audited, sticky,
 * never re-matched). Now behind the SAME gate — an unauthenticated POST is
 * denied BEFORE the store is even resolved, so it cannot mutate anything.
 * `getStore` is injectable for tests; production wiring uses the default.
 */
export function devRetentionExceptionsApiHandler(getStore?: () => Promise<unknown>) {
  return (req: ConnectLikeRequest, res: ConnectLikeResponse) => {
    void (async () => {
      try {
        const denied = await gateConnectRequest("/api/retention-exceptions", req, res);
        if (denied) return; // 401/lock screen already written — no store touch
        const { handleExceptionsQuery, handleExceptionAction } = await import("./retention/exceptions-api");
        const resolveStore =
          getStore ?? (async () => (await import("./store")).getStore());
        const store = (await resolveStore()) as Parameters<typeof handleExceptionsQuery>[0];
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
          } catch {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "invalid JSON body" }));
            return;
          }
          const str = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string) : undefined);
          const out = await handleExceptionAction(store, {
            action: str("action") ?? "",
            id: str("id"),
            internalClientId: str("internalClientId"),
            displayName: str("displayName"),
            phone: str("phone"),
            email: str("email"),
            resolvedBy: str("resolvedBy"),
          });
          res.statusCode = out.status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(out.body));
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const out = await handleExceptionsQuery(store, { status: url.searchParams.get("status") });
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(out.body));
      } catch (e) {
        connectError(res, e instanceof Error ? e.message : String(e));
      }
    })();
  };
}
