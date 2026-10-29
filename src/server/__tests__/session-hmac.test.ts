/**
 * SECURITY (2026-10-28, owner directive) — the session signing battery.
 *
 * The session token's signature is now HMAC-SHA-256 (node:crypto createHmac,
 * keyed with the dashboard passphrase) over the versioned expiry — replacing
 * the old custom FNV-style digest. Covered here:
 *   - valid token round-trips; deterministic signature (cookie round-trips
 *     rely on it); base64url shape (43 chars, no padding, no +// chars);
 *   - expiry is enforced (expired → reject);
 *   - tamper rejection: modified expiry, modified signature, truncated sig;
 *   - passphrase binding: a token minted under passphrase A is INVALID under
 *     passphrase B — changing the passphrase invalidates every session;
 *   - malformed tokens (garbage, wrong version, wrong arity, non-numeric
 *     expiry, Infinity) → reject, never throw;
 *   - the OLD v1 FNV-format token string is rejected (stateless tokens: the
 *     signing-scheme switch invalidates pre-existing sessions by design);
 *   - cookie attributes: HttpOnly; SameSite=Lax; Path=/; Max-Age preserved;
 *     Secure ONLY when the caller says the runtime is prod HTTPS — dev/HTTP
 *     logins never get it (gated on environment, not on a request header);
 *   - end-to-end login flow: POST /auth/login sets the cookie WITHOUT Secure
 *     in dev runtime, WITH Secure once markProdServeRuntime() runs (prod);
 *   - no secret ever leaks into a denial body or error string.
 */
import { describe, expect, test } from "bun:test";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSessionToken,
  markProdServeRuntime,
  readSessionCookie,
  resolveGate,
  sessionSetCookie,
  verifySessionToken,
} from "../auth";

const PASSPHRASE = "hmac-battery-passphrase-11b7";
const ORIGIN = "https://dashboard.example.com";

function req(path: string, opts: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, opts);
}

// HERMETIC ENV (PR #117 completion): EVERY call site awaits this helper, so
// the set AND the restore happen inside the test's own lifecycle — no promise
// outlives the test, and a failure inside fails THAT test instead of surfacing
// as an unhandled rejection attributed to whichever file bun runs next.
async function withPassphrase<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.DASHBOARD_PASSPHRASE;
  process.env.DASHBOARD_PASSPHRASE = PASSPHRASE;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DASHBOARD_PASSPHRASE;
    else process.env.DASHBOARD_PASSPHRASE = prev;
  }
}

describe("HMAC session tokens — valid + shape", () => {
  test("valid token verifies; deterministic for the same passphrase+expiry", () => {
    const now = 1_700_000_000_000;
    const a = createSessionToken(PASSPHRASE, now);
    const b = createSessionToken(PASSPHRASE, now);
    expect(a).toBe(b); // deterministic — a cookie minted at login must re-verify later
    expect(verifySessionToken(a, PASSPHRASE, now + 1000)).toBe(true);
  });

  test("token format: v2.<expiry>.<base64url 43-char sig>", () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(PASSPHRASE, now);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe(String(now + SESSION_TTL_MS));
    const sig = parts[2] ?? "";
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes → 43 base64url chars, no padding
  });

  test("different passphrase produces a DIFFERENT token for the same expiry", () => {
    const now = 1_700_000_000_000;
    expect(createSessionToken(PASSPHRASE, now)).not.toBe(createSessionToken("another-passphrase", now));
  });
});

describe("HMAC session tokens — tamper + expiry rejection", () => {
  test("expired token is rejected (expiry enforced with the same signature)", () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(PASSPHRASE, now, 5_000);
    // pre-existing semantics (unchanged by the HMAC swap): expiry is inclusive
    // (`expiry < now` rejects), so the token is still valid exactly AT expiry.
    expect(verifySessionToken(token, PASSPHRASE, now + 5_000)).toBe(true);
    expect(verifySessionToken(token, PASSPHRASE, now + 5_001)).toBe(false);
    expect(verifySessionToken(token, PASSPHRASE, now + 4_999)).toBe(true);
  });

  test("modified expiry invalidates the signature (expiry is signed material)", () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(PASSPHRASE, now);
    const [version, expiry, sig] = token.split(".");
    // push expiry further out, keep the original signature
    const extended = `${version}.${Number(expiry) + 3_600_000}.${sig}`;
    expect(verifySessionToken(extended, PASSPHRASE, now + 1000)).toBe(false);
    // shorten it too — any expiry change breaks the HMAC
    const shortened = `${version}.${Number(expiry) - 1000}.${sig}`;
    expect(verifySessionToken(shortened, PASSPHRASE, now + 1000)).toBe(false);
  });

  test("modified signature is rejected (bit flips in any position)", () => {
    const token = createSessionToken(PASSPHRASE);
    const [version, expiry, sig] = token.split(".");
    for (const idx of [0, Math.floor(sig.length / 2), sig.length - 1]) {
      const flipped = sig[idx] === "A" ? "B" : "A";
      const tampered = `${version}.${expiry}.${sig.slice(0, idx)}${flipped}${sig.slice(idx + 1)}`;
      expect(verifySessionToken(tampered, PASSPHRASE)).toBe(false);
    }
    // truncated / lengthened signature — fails the length gate, not timingSafeEqual
    expect(verifySessionToken(`${version}.${expiry}.${sig.slice(1)}`, PASSPHRASE)).toBe(false);
    expect(verifySessionToken(`${version}.${expiry}.${sig}x`, PASSPHRASE)).toBe(false);
  });

  test("different passphrase invalidates an existing token (passphrase rotation)", () => {
    const token = createSessionToken(PASSPHRASE);
    expect(verifySessionToken(token, "rotated-passphrase-99")).toBe(false);
    // the round-trip under the ORIGINAL passphrase still works
    expect(verifySessionToken(token, PASSPHRASE)).toBe(true);
  });
});

describe("HMAC session tokens — malformed input", () => {
  test("null/undefined/empty/garbage → false, never throws", () => {
    expect(verifySessionToken(null, PASSPHRASE)).toBe(false);
    expect(verifySessionToken(undefined, PASSPHRASE)).toBe(false);
    expect(verifySessionToken("", PASSPHRASE)).toBe(false);
    expect(verifySessionToken("garbage", PASSPHRASE)).toBe(false);
    expect(verifySessionToken("a.b.c.d", PASSPHRASE)).toBe(false); // wrong arity
    expect(verifySessionToken("v1.999999999999999.deadbeef", PASSPHRASE)).toBe(false); // wrong version
    expect(verifySessionToken("v3.999999999999999.deadbeef", PASSPHRASE)).toBe(false);
    expect(verifySessionToken("v2.notanumber.deadbeef", PASSPHRASE)).toBe(false);
    expect(verifySessionToken("v2.Infinity.deadbeef", PASSPHRASE)).toBe(false);
    expect(verifySessionToken("v2.-5.deadbeef", PASSPHRASE)).toBe(false);
  });

  test("the OLD v1 FNV-format token is rejected — sessions invalidate on deploy", () => {
    // shape the old scheme produced: v1.<expiry>.<16 hex chars>
    const legacy = "v1.1730000000000.a1b2c3d4e5f60718";
    expect(verifySessionToken(legacy, PASSPHRASE)).toBe(false);
    // even an attacker-replayed REAL old cookie cannot survive the scheme switch
    expect(verifySessionToken("v1.1730000000000.deadbeefdeadbeef", PASSPHRASE)).toBe(false);
  });
});

describe("session cookie attributes (Secure gated on environment)", () => {
  test("dev/HTTP: HttpOnly, SameSite=Lax, Path=/, Max-Age preserved — NO Secure", () => {
    const token = createSessionToken(PASSPHRASE);
    const cookie = sessionSetCookie(token, { secure: false });
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}`);
    expect(cookie).not.toContain("Secure");
  });

  test("prod/HTTPS: same attributes PLUS Secure", () => {
    const cookie = sessionSetCookie(createSessionToken(PASSPHRASE), { secure: true });
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  test("login flow in DEV runtime sets the cookie WITHOUT Secure (localhost logins keep working)", async () => {
    await withPassphrase(async () => {
      delete (globalThis as { __MALLORY_SERVE_PROD__?: boolean }).__MALLORY_SERVE_PROD__;
      try {
        const gate = await resolveGate(req("/auth/login", { method: "POST", body: new URLSearchParams({ passphrase: PASSPHRASE, redirectTo: "/settings" }) }));
        expect(gate.kind).toBe("response");
        if (gate.kind !== "response") throw new Error("expected response");
        expect(gate.response.status).toBe(303);
        const cookie = gate.response.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).not.toContain("Secure");
        expect(verifySessionToken(readSessionCookie(cookie), PASSPHRASE)).toBe(true);
      } finally {
        delete (globalThis as { __MALLORY_SERVE_PROD__?: boolean }).__MALLORY_SERVE_PROD__;
      }
    });
  });

  test("login flow in PROD runtime (markProdServeRuntime) sets the cookie WITH Secure", async () => {
    await withPassphrase(async () => {
      markProdServeRuntime();
      try {
        const gate = await resolveGate(req("/auth/login", { method: "POST", body: new URLSearchParams({ passphrase: PASSPHRASE, redirectTo: "/settings" }) }));
        expect(gate.kind).toBe("response");
        if (gate.kind !== "response") throw new Error("expected response");
        const cookie = gate.response.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("Secure");
        expect(cookie).toContain("HttpOnly");
        expect(verifySessionToken(readSessionCookie(cookie), PASSPHRASE)).toBe(true);
      } finally {
        delete (globalThis as { __MALLORY_SERVE_PROD__?: boolean }).__MALLORY_SERVE_PROD__;
      }
    });
  });
});

describe("no secret leakage", () => {
  test("denial bodies and lock screen never contain the passphrase or a token", async () => {
    await withPassphrase(async () => {
      const rpc = await resolveGate(req("/_serverFn/fake", { method: "POST" }));
      if (rpc.kind !== "response") throw new Error("expected denial");
      const rpcBody = await rpc.response.text();
      expect(rpcBody).not.toContain(PASSPHRASE);
      const page = await resolveGate(req("/", { headers: { accept: "text/html" } }));
      if (page.kind !== "response") throw new Error("expected denial");
      const pageBody = await page.response.text();
      expect(pageBody).not.toContain(PASSPHRASE);
      // wrong-passphrase login error message echoes nothing secret either
      const bad = await resolveGate(req("/auth/login", { method: "POST", body: new URLSearchParams({ passphrase: "wrong-guess", redirectTo: "/" }) }));
      if (bad.kind !== "response") throw new Error("expected denial");
      const badBody = await bad.response.text(); // read ONCE — a Response body is single-use
      expect(badBody).not.toContain(PASSPHRASE);
      expect(badBody).not.toContain("wrong-guess");
    });
  });
});
