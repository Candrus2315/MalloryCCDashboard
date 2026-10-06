/**
 * PIP RBAC (Phase 5 hardening) — the manager assertion is server-side,
 * independent of the global gate, and FAILS CLOSED.
 *
 * Under test:
 *  - verifyPipManagerRequest: valid session → allow; missing/garbage/expired/
 *    wrong-passphrase cookie → 401 deny; unset passphrase → open (the SAME
 *    policy as the global gate — dev/demo mode keeps working, Settings warns);
 *  - the denial never leaks the secret;
 *  - assertPipManager (the endpoint runtime path) FAILS CLOSED when no
 *    request context exists — it can never be talked into "allow" by an
 *    environment hiccup;
 *  - NO EMPLOYEE LOGINS exist: the auth model is ONE shared manager
 *    passphrase — the lock screen has no user/email login affordance, and
 *    resolveGate denies RPC without a session (401 JSON) exactly like the
 *    global gate;
 *  - every PIP server function calls assertPipManager() before any store
 *    access (the wiring walk — see also pip-acceptance.test.ts AC8).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PipManagerDeniedError,
  assertPipManager,
  verifyPipManagerRequest,
} from "../pip-rbac";
import { createSessionToken, lockScreenHtml, resolveGate, verifySessionToken } from "../auth";

const SECRET = "rbac-test-passphrase-7d92";
let restored: string | undefined;

function withSecret<T>(fn: () => T): T {
  restored = process.env.DASHBOARD_PASSPHRASE;
  process.env.DASHBOARD_PASSPHRASE = SECRET;
  try {
    return fn();
  } finally {
    if (restored === undefined) delete process.env.DASHBOARD_PASSPHRASE;
    else process.env.DASHBOARD_PASSPHRASE = restored;
  }
}

function reqWithCookie(cookie: string | null): Request {
  return new Request("http://internal/performance", {
    headers: cookie ? { cookie } : {},
  });
}

describe("PIP RBAC — verifyPipManagerRequest", () => {
  test("valid manager session → allow (gateOpen false)", () => {
    withSecret(() => {
      const token = createSessionToken(SECRET);
      const v = verifyPipManagerRequest(reqWithCookie(`mallory_session=${token}`));
      expect(v.ok).toBe(true);
      expect(v.gateOpen).toBe(false);
      expect(v.status).toBe(200);
    });
  });

  test("missing cookie → 401 deny; garbage token → 401 deny; tampered signature → 401 deny", () => {
    withSecret(() => {
      expect(verifyPipManagerRequest(reqWithCookie(null)).ok).toBe(false);
      const denied = verifyPipManagerRequest(reqWithCookie(null));
      expect(denied.status).toBe(401);
      expect(denied.error).toMatch(/manager-only/i);
      expect(verifyPipManagerRequest(reqWithCookie("mallory_session=not-a-token")).ok).toBe(false);
      const good = createSessionToken(SECRET).split(".");
      const tampered = `${good[0]}.${good[1]}.${good[2].slice(0, -1)}${good[2].slice(-1) === "0" ? "1" : "0"}`;
      expect(verifyPipManagerRequest(reqWithCookie(`mallory_session=${tampered}`)).ok).toBe(false);
      expect(verifyPipManagerRequest(reqWithCookie("some_other_cookie=1")).ok).toBe(false);
    });
  });

  test("expired token → 401 deny; token from a DIFFERENT passphrase → 401 deny", () => {
    withSecret(() => {
      const past = Date.now() - 1000;
      const expired = createSessionToken(SECRET, past, 10); // expired long before now
      expect(verifySessionToken(expired, SECRET)).toBe(false);
      expect(verifyPipManagerRequest(reqWithCookie(`mallory_session=${expired}`), Date.now()).ok).toBe(false);
      const otherPass = createSessionToken("some-other-passphrase");
      expect(verifyPipManagerRequest(reqWithCookie(`mallory_session=${otherPass}`)).ok).toBe(false);
    });
  });

  test("the denial message never contains the secret value", () => {
    withSecret(() => {
      const denied = verifyPipManagerRequest(reqWithCookie(null));
      expect(denied.error ?? "").not.toContain(SECRET);
    });
  });

  test("unset passphrase → open with gateOpen=true (dev/demo policy, same as the global gate)", () => {
    const prev = process.env.DASHBOARD_PASSPHRASE;
    delete process.env.DASHBOARD_PASSPHRASE;
    try {
      const v = verifyPipManagerRequest(reqWithCookie(null));
      expect(v.ok).toBe(true);
      expect(v.gateOpen).toBe(true);
    } finally {
      if (prev !== undefined) process.env.DASHBOARD_PASSPHRASE = prev;
    }
  });
});

describe("PIP RBAC — assertPipManager fails closed", () => {
  test("no request context → PipManagerDeniedError (never a silent allow)", () => {
    withSecret(() => {
      expect(() => assertPipManager()).toThrow(PipManagerDeniedError);
      try {
        assertPipManager();
      } catch (e) {
        expect((e as PipManagerDeniedError).status).toBe(401);
        expect((e as Error).name).toBe("PipManagerDeniedError");
      }
    });
  });
});

describe("PIP RBAC — no employee logins exist (single shared manager passphrase)", () => {
  test("resolveGate: valid session → allow; no session → 401 (lock screen for documents, JSON for RPC)", async () => {
    const token = createSessionToken(SECRET);
    const cookieHeader = `mallory_session=${token}`;
    // resolveGate reads the secret synchronously before its first await, so
    // the calls run under the test secret; the promises resolve after restore.
    let allowed: Awaited<ReturnType<typeof resolveGate>>;
    let rpcDenied: Awaited<ReturnType<typeof resolveGate>>;
    let docDenied: Awaited<ReturnType<typeof resolveGate>>;
    withSecret(() => {
      allowed = resolveGate(new Request("http://internal/performance", { headers: { cookie: cookieHeader } }));
      rpcDenied = resolveGate(
        new Request("http://internal/_serverFn/x", { method: "POST", headers: { "content-type": "application/json" } }),
      );
      docDenied = resolveGate(
        new Request("http://internal/performance", { headers: { accept: "text/html" } }),
      );
    });
    expect((await allowed!).kind).toBe("allow");
    const rpcRes = (await rpcDenied!) as { kind: "response"; response: Response };
    expect(rpcRes.kind).toBe("response");
    expect(rpcRes.response.status).toBe(401);
    expect(await rpcRes.response.text()).toContain("unauthorized");
    const docRes = (await docDenied!) as { kind: "response"; response: Response };
    expect(docRes.kind).toBe("response");
    expect(docRes.response.status).toBe(401);
    expect(await docRes.response.text()).toContain("Unlock dashboard");
  });

  test("the lock screen has NO employee/login-by-identity affordance — one passphrase field only", () => {
    const html = lockScreenHtml("/performance");
    expect((html.match(/type="password" name="passphrase"/g) ?? []).length).toBe(1); // single passphrase input
    expect(html).not.toMatch(/name="(?:user|email|username|employee)/i); // no identity login
    expect(html).not.toMatch(/role|manager account/i); // no role selection
  });

  test("the session cookie is the ONLY credential: wrong passphrase mints a token that does not verify", () => {
    withSecret(() => {
      expect(verifySessionToken(createSessionToken("wrong"), SECRET)).toBe(false);
      expect(verifySessionToken(createSessionToken(SECRET), SECRET)).toBe(true);
    });
  });
});

describe("PIP RBAC — wiring guard (every PIP server fn asserts manager)", () => {
  test("pip-api.ts imports the assertion and the rbac module ships it", () => {
    const apiSource = readFileSync(new URL("../pip-api.ts", import.meta.url), "utf8");
    expect(apiSource).toContain('import { assertPipManager } from "./pip-rbac"');
    // The runtime module reads the cookie header server-side (h3 request context).
    const rbacSource = readFileSync(new URL("../pip-rbac.ts", import.meta.url), "utf8");
    expect(rbacSource).toContain("getRequestHeader");
    expect(rbacSource).toContain("verifySessionToken");
  });
});
