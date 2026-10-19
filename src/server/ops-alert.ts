/**
 * OPS ALERTING (Reliability Phase 2a, owner directive 2026-10-16) —
 * `sendOpsAlert(subject, body)` emails the owner via Knock when the dashboard
 * self-recovery machinery marks a sync provider DEGRADED.
 *
 * ENV-GATED BY DESIGN: KNOCK_API_KEY + ALERT_TO_EMAIL arrive later via the
 * platform Secrets UI (resolved through getSecret's case-insensitive env
 * pattern). When either is unset the alert is LOG-ONLY and the call returns
 * `{configured:false}` — no crash, no retry storm, zero behavior change for
 * every existing caller path. When set but Knock errors, the same holds:
 * the failure is logged and returned, never thrown — an alerting outage must
 * never take the watchdog (or anything else) down with it.
 *
 * SECURITY: secrets are read from env inside this module and NEVER logged,
 * echoed, or serialized — only WHICH env keys resolved (describeSecretSource).
 */
import { getSecret, describeSecretSource } from "./env";

/** Knock API base — the server API (KNOCK_API_KEY is a SERVER key, never a user one). */
const KNOCK_API_BASE = "https://api.knock.app";

/** Env-gated workflow key so the owner can rename the workflow without a code change. */
const KNOCK_WORKFLOW_KEY = process.env.KNOCK_WORKFLOW_KEY || "dashboard-ops-alert";

/** Bounded outbound call — PR #73 rule: no unbounded fetches on the serve path. */
const KNOCK_TIMEOUT_MS = 10_000;

export interface OpsAlertResult {
  /** false = KNOCK_API_KEY or ALERT_TO_EMAIL unset → log-only mode. */
  configured: boolean;
  /** true only when Knock answered 2xx (or the alert was successfully logged in log-only mode). */
  delivered: boolean;
  /** Which env keys resolved — safe to log, never the values. */
  source?: { apiKey: string | null; email: string | null };
  error?: string;
}

/**
 * THE Knock request shape — one small function on purpose. Credentials and
 * workflow naming arrive later; when Knock's exact contract needs adjusting
 * (workflow key, recipient identity, data payload), change ONLY this function.
 *
 * Shape (Knock "trigger a workflow" — POST /v1/notifications/trigger):
 *   Authorization: Bearer <KNOCK_API_KEY>
 *   { workflow, recipients: [<ALERT_TO_EMAIL>], data: { subject, body, severity } }
 *
 * The recipient is identified BY EMAIL: Knock resolves user identity by id or
 * email when the workflow's email channel targets the recipient's email. If
 * the owner's Knock workspace instead keys users by a distinct id, this is the
 * one function to adjust (and optionally pair it with a POST /v1/users
 * identify call in sendOpsAlert below).
 */
export function buildKnockTriggerRequest(
  subject: string,
  body: string,
  toEmail: string,
  severity: "high" | "low" = "high",
): {
  path: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  return {
    path: "/v1/notifications/trigger",
    headers: { "content-type": "application/json" },
    payload: {
      workflow: KNOCK_WORKFLOW_KEY,
      recipients: [toEmail],
      data: {
        subject,
        body,
        severity,
        system: "Mallory CC Performance Dashboard",
      },
    },
  };
}

/**
 * Fire one ops alert. Best-effort by contract: never throws. Log-only when
 * unconfigured; honest `{configured, delivered, error}` otherwise. severity
 * maps to the Knock data payload ("high" = degradation page, "low" = the
 * once-per-incident resolved notice).
 */
export async function sendOpsAlert(
  subject: string,
  body: string,
  severity: "high" | "low" = "high",
): Promise<OpsAlertResult> {
  const apiKey = getSecret("KNOCK_API_KEY");
  const toEmail = getSecret("ALERT_TO_EMAIL");
  const signingKey = getSecret("KNOCK_SIGNING_KEY");
  void signingKey; // read for completeness; Knock's trigger API authenticates with the server API key alone.

  const source = { apiKey: describeSecretSource("KNOCK_API_KEY"), email: describeSecretSource("ALERT_TO_EMAIL") };
  if (!apiKey || !toEmail) {
    console.log(
      `[ops-alert] LOG-ONLY (no KNOCK_API_KEY/ALERT_TO_EMAIL in env — no retry, no storm): ${subject} :: ${body}`,
    );
    return { configured: false, delivered: true, source };
  }

  try {
    const { path, headers, payload } = buildKnockTriggerRequest(subject, body, toEmail, severity);
    const res = await fetch(`${KNOCK_API_BASE}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(KNOCK_TIMEOUT_MS),
    });
    if (!res.ok) {
      const msg = `knock trigger answered HTTP ${res.status}`;
      console.log(`[ops-alert] FAILED (${msg}; no retry storm — the next escalation decision retries if warranted): ${subject}`);
      return { configured: true, delivered: false, source, error: msg };
    }
    console.log(`[ops-alert] sent to ${source.email ?? "alert recipient"}: ${subject}`);
    return { configured: true, delivered: true, source };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[ops-alert] FAILED (${msg}): ${subject}`);
    return { configured: true, delivered: false, source, error: msg };
  }
}
