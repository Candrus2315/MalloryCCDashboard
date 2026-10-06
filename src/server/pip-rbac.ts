/**
 * PIP RBAC — SERVER-SIDE manager assertion (Phase 5 hardening, owner
 * directive 9/30: "Strict RBAC … No employee logins — manager records
 * acknowledgment").
 *
 * WHY THIS EXISTS NEXT TO THE GLOBAL GATE: src/start.ts runs resolveGate for
 * EVERY request (SSR + serverFn RPC), which is the first layer. Phase 5 adds
 * a second, INDEPENDENT check inside every PIP server function — the manager
 * assertion below is called as the FIRST step of each handler, so the module's
 * employee-PI data can never be served or mutated by a request that skipped
 * or lost the global gate (future middleware reorderings, route-level loaders
 * that bypass it, etc.). It is verification, not new policy: the SAME signed
 * session cookie, the SAME passphrase, verified again at the endpoint.
 *
 * POLICY (unchanged by this phase):
 *  - The app has exactly ONE shared manager passphrase (DASHBOARD_PASSPHRASE).
 *    Valid session = manager session. There is NO employee login, NO roles
 *    table, and no employee-visible variant of PIP data (employee_visible
 *    stays false; the print export renders for the manager only).
 *  - When DASHBOARD_PASSPHRASE is UNSET the whole app is open (Settings
 *    warns) — the assertion then passes with gateOpen=true, mirroring the
 *    global gate so dev/demo mode keeps working.
 *  - Reads AND mutations of PIP data are manager-only.
 */
import { getRequestHeader } from "@tanstack/react-start/server";
import { getSecret } from "./env";
import { readSessionCookie, verifySessionToken } from "./auth";

export interface PipManagerVerdict {
  ok: boolean;
  /** True when the passphrase is unset (open dev/demo mode — same policy as the global gate). */
  gateOpen: boolean;
  /** 401 when denied (the global gate denies with 401 as well). */
  status: 200 | 401;
  /** Denial reason (safe to surface — never contains the passphrase). */
  error: string | null;
}

const DENY_MESSAGE =
  "PIP data is manager-only — this dashboard has no employee logins, so the manager passphrase session is required.";

/** Pure, testable decision: does this request carry a valid manager session? */
export function verifyPipManagerRequest(request: Request, now = Date.now()): PipManagerVerdict {
  const passphrase = getSecret("DASHBOARD_PASSPHRASE");
  if (!passphrase) return { ok: true, gateOpen: true, status: 200, error: null };
  const token = readSessionCookie(request.headers.get("cookie"));
  if (verifySessionToken(token, passphrase, now)) return { ok: true, gateOpen: false, status: 200, error: null };
  return { ok: false, gateOpen: false, status: 401, error: DENY_MESSAGE };
}

/** Thrown by assertPipManager(); carries the HTTP status the endpoint would deny with. */
export class PipManagerDeniedError extends Error {
  status: 401;
  constructor(message = DENY_MESSAGE) {
    super(message);
    this.name = "PipManagerDeniedError";
    this.status = 401;
  }
}

/**
 * SERVER RUNTIME — assert the CURRENT request is a manager session. Call this
 * as the FIRST statement of every PIP server-function handler (before any
 * store read/write). Uses the h3 request context TanStack Start provides for
 * the in-flight server function; a context failure denies (fail closed).
 */
export function assertPipManager(now = Date.now()): void {
  let cookie: string | null = null;
  try {
    cookie = getRequestHeader("cookie");
  } catch {
    // No h3 request context in scope → the endpoint cannot be tied to an
    // authenticated manager session: deny (fail closed), never allow.
    throw new PipManagerDeniedError();
  }
  const request = new Request("http://pip-rbac.internal/", { headers: cookie ? { cookie } : {} });
  const verdict = verifyPipManagerRequest(request, now);
  if (!verdict.ok) throw new PipManagerDeniedError(verdict.error ?? DENY_MESSAGE);
}
