/**
 * RELIABILITY PHASE 2a — ops alert util (`sendOpsAlert` → Knock → email).
 *
 * Contract under test: honest {configured, delivered} in every mode; log-only
 * when KNOCK_API_KEY/ALERT_TO_EMAIL are unset (no crash, no fetch, no retry
 * storm); the Knock request shape lives in ONE function
 * (buildKnockTriggerRequest) so credentials arriving later only touch that;
 * failures are returned, never thrown; severity maps through.
 *
 * Env is manipulated here via process.env (getSecret's canonical lookup is
 * case-insensitive — also asserted) and ALWAYS restored.
 */
import { describe, expect, test } from "bun:test";
import { buildKnockTriggerRequest, sendOpsAlert } from "../ops-alert";

const EMAIL = "ops-owner@example.com";

function withEnv(fn: () => Promise<void>, env: Record<string, string | undefined>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("buildKnockTriggerRequest — THE one adjustable Knock shape", () => {
  test("standard trigger flow: workflow + recipients + data payload", () => {
    const req = buildKnockTriggerRequest("SUBJ", "BODY", EMAIL);
    expect(req.path).toBe("/v1/notifications/trigger");
    expect(req.headers["content-type"]).toBe("application/json");
    const payload = req.payload as { workflow: string; recipients: string[]; data: Record<string, unknown> };
    expect(typeof payload.workflow).toBe("string");
    expect(payload.workflow.length).toBeGreaterThan(0);
    expect(payload.recipients).toEqual([EMAIL]);
    expect(payload.data.subject).toBe("SUBJ");
    expect(payload.data.body).toBe("BODY");
    expect(payload.data.severity).toBe("high");
  });

  test("severity passes through (resolved alerts are low-priority)", () => {
    const req = buildKnockTriggerRequest("S", "B", EMAIL, "low");
    expect((req.payload as { data: { severity: string } }).data.severity).toBe("low");
  });
});

describe("sendOpsAlert — env-gated, honest, never throws", () => {
  test("unset credentials: log-only, no fetch, honest {configured:false}", () =>
    withEnv(
      async () => {
        let fetched = false;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
          fetched = true;
          return new Response("{}", { status: 200 });
        }) as typeof fetch;
        try {
          const out = await sendOpsAlert("SUBJ", "BODY");
          expect(out.configured).toBe(false);
          expect(out.delivered).toBe(true); // logged = delivered in log-only mode
          expect(fetched).toBe(false);
          expect(out.error).toBeUndefined();
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
      { KNOCK_API_KEY: undefined, ALERT_TO_EMAIL: undefined, knock_api_key: undefined, alert_to_email: undefined },
    ));

  test("configured: POSTs the Knock trigger with Bearer auth and the built payload", () =>
    withEnv(
      async () => {
        let captured: { url: string; init: RequestInit } | null = null;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          captured = { url: String(url), init: init ?? {} };
          return new Response("{}", { status: 200 });
        }) as typeof fetch;
        try {
          const out = await sendOpsAlert("DB stale", "the highlevel provider is stale", "high");
          expect(out.configured).toBe(true);
          expect(out.delivered).toBe(true);
          expect(out.error).toBeUndefined();
          expect(captured!.url).toBe("https://api.knock.app/v1/notifications/trigger");
          const headers = captured!.init.headers as Record<string, string>;
          expect(headers.authorization).toBe("Bearer test-knock-key");
          const body = JSON.parse(String(captured!.init.body));
          expect(body.recipients).toEqual([EMAIL]);
          expect(body.data.subject).toBe("DB stale");
          expect(body.data.severity).toBe("high");
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
      { KNOCK_API_KEY: "test-knock-key", ALERT_TO_EMAIL: EMAIL },
    ));

  test("case-insensitive env resolution (the getSecret pattern)", () =>
    withEnv(
      async () => {
        const calls: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push(String(url));
          return new Response("{}", { status: 200 });
        }) as typeof fetch;
        try {
          const out = await sendOpsAlert("S", "B");
          expect(out.configured).toBe(true);
          expect(out.source.email).toBe("Alert_To_Email"); // WHICH key resolved — never the value
          expect(calls).toHaveLength(1);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
      { KNOCK_API_KEY: "k", Alert_To_Email: EMAIL },
    ));

  test("Knock failure: honest delivered:false + error, NO throw, no retry storm", () =>
    withEnv(
      async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
        try {
          const out = await sendOpsAlert("S", "B");
          expect(out.configured).toBe(true);
          expect(out.delivered).toBe(false);
          expect(out.error).toContain("500");
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
      { KNOCK_API_KEY: "k", ALERT_TO_EMAIL: EMAIL },
    ));

  test("network error: honest delivered:false, NO throw", () =>
    withEnv(
      async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
          throw new Error("ECONNRESET");
        }) as typeof fetch;
        try {
          const out = await sendOpsAlert("S", "B");
          expect(out.delivered).toBe(false);
          expect(out.error).toContain("ECONNRESET");
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
      { KNOCK_API_KEY: "k", ALERT_TO_EMAIL: EMAIL },
    ));

  test("only the API key set (no email): still log-only, honest, no fetch", () =>
    withEnv(
      async () => {
        let fetched = false;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
          fetched = true;
          return new Response("{}", { status: 200 });
        }) as typeof fetch;
        try {
          const out = await sendOpsAlert("S", "B");
          expect(out.configured).toBe(false);
          expect(fetched).toBe(false);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
      { KNOCK_API_KEY: "k", ALERT_TO_EMAIL: undefined, alert_to_email: undefined },
    ));
});
