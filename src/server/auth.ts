/**
 * Passphrase gate — SERVER-SIDE (Phase 9).
 *
 * When DASHBOARD_PASSPHRASE is set (resolved via the centralized env resolver,
 * canonical name first, case-insensitive fallback), every request — SSR page
 * loads AND server-function RPC endpoints — must present a valid session
 * cookie. Without it: browsers get the lock screen (401 + HTML), everything
 * else (RPC/API) gets a 401 JSON response. When the secret is unset the gate
 * is open and Settings shows a warning.
 *
 * The session cookie is signed: `v1.<expiryMs>.<sig>` where sig is a keyed
 * digest over the expiry using the current passphrase. Tokens expire (7d) and
 * are invalidated automatically when the passphrase changes. No server-side
 * session state — a signed cookie is enough per the SPEC.
 *
 * The login endpoint (POST /auth/login) is handled INSIDE the gate itself so
 * there is no unauthenticated route to protect-by-exception.
 */
import { getSecret } from "./env";

export const SESSION_COOKIE = "mallory_session";
export const LOGIN_PATH = "/auth/login";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

/** Keyed FNV-style digest (deterministic, Bun/WebCrypto-free, sync). */
function digest(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function isPassphraseConfigured(): boolean {
  return getSecret("DASHBOARD_PASSPHRASE") !== null;
}

/** Signed session token; expires after ttlMs and is bound to the passphrase. */
export function createSessionToken(passphrase: string, now = Date.now(), ttlMs = SESSION_TTL_MS): string {
  const expiry = Math.floor(now + ttlMs);
  return `v1.${expiry}.${digest(`v1::${expiry}::${passphrase}`)}`;
}

/** Constant-time-ish token check: valid version, unexpired, signature matches. */
export function verifySessionToken(token: string | null | undefined, passphrase: string, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || expiry < Math.floor(now)) return false;
  const expected = digest(`v1::${expiry}::${passphrase}`);
  const sig = parts[2];
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Parse the session cookie value out of a raw Cookie header. */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    if (name === SESSION_COOKIE) return decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return null;
}

/** Only a same-app path is a safe redirect target. */
export function safeRedirectTarget(raw: string | null | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw;
  return "/";
}

// Static asset prefixes never need the gate (they carry no data; the dev
// server needs them for HMR). Everything else — pages, RPC, unknown API
// paths — is protected.
const ASSET_PREFIXES = [
  "/@vite/",
  "/@fs/",
  "/node_modules/",
  "/assets/",
  "/_build/",
  "/favicon.ico",
  "/favicon.svg",
  "/.well-known/",
];

export type GateOutcome = { kind: "allow" } | { kind: "response"; response: Response };

/**
 * Pure-ish gate resolver — the single decision point for every request.
 * Returns `{ kind: "allow" }` to pass through, or a ready Response that the
 * caller must return instead of continuing (lock screen, 401, or login
 * redirect). Exported for tests; the request middleware in src/start.ts wraps it.
 */
export async function resolveGate(request: Request, now = Date.now()): Promise<GateOutcome> {
  const passphrase = getSecret("DASHBOARD_PASSPHRASE");
  if (!passphrase) return { kind: "allow" }; // unset → open access (Settings warns)

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === LOGIN_PATH) return handleLogin(request, passphrase, now);
  if (ASSET_PREFIXES.some((p) => path.startsWith(p))) return { kind: "allow" };

  const token = readSessionCookie(request.headers.get("cookie"));
  if (verifySessionToken(token, passphrase, now)) return { kind: "allow" };

  const wantsDocument =
    (request.method === "GET" || request.method === "HEAD") &&
    (request.headers.get("accept") ?? "").includes("text/html");
  if (wantsDocument) {
    return {
      kind: "response",
      response: new Response(lockScreenHtml(safeRedirectTarget(path + url.search)), {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }),
    };
  }
  return {
    kind: "response",
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  };
}

/** POST /auth/login — validate the passphrase, set the signed cookie, redirect. */
async function handleLogin(request: Request, passphrase: string, now: number): Promise<GateOutcome> {
  if (request.method !== "POST") {
    // Convenience: land on /auth/login via GET → the home page (which gates).
    return { kind: "response", response: Response.redirect(new URL("/", request.url), 303) };
  }
  let supplied: string | null = null;
  let redirectTo: string | null = null;
  try {
    const form = await request.formData();
    supplied = typeof form.get("passphrase") === "string" ? (form.get("passphrase") as string) : null;
    redirectTo = typeof form.get("redirectTo") === "string" ? (form.get("redirectTo") as string) : null;
  } catch {
    return { kind: "response", response: new Response("Invalid form submission", { status: 400 }) };
  }
  if (supplied === passphrase) {
    const token = createSessionToken(passphrase, now);
    return {
      kind: "response",
      response: new Response(null, {
        status: 303,
        headers: {
          location: safeRedirectTarget(redirectTo),
          "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax`,
          "cache-control": "no-store",
        },
      }),
    };
  }
  // Small delay to blunt online guessing; internal dashboard, no lockout state.
  await new Promise((r) => setTimeout(r, 400));
  return {
    kind: "response",
    response: new Response(lockScreenHtml(safeRedirectTarget(redirectTo), "Incorrect passphrase — try again."), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }),
  };
}

/** Standalone lock screen (no app JS, no assets needed — works pre-cookie). */
export function lockScreenHtml(redirectTo: string, error?: string): string {
  const err = error
    ? `<p style="margin:14px 0 0;color:#b91c1c;font-size:13px">${error}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mallory CC Performance — Locked</title>
</head>
<body style="margin:0;background:#fafaf9;color:#1c1917;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <form method="post" action="${LOGIN_PATH}" style="width:100%;max-width:22rem;background:#ffffff;border:1px solid #e7e5e4;border-radius:0.75rem;padding:2rem;box-shadow:0 1px 2px rgba(0,0,0,0.04)">
    <h1 style="margin:0;font-size:17px;font-weight:600;letter-spacing:-0.01em">Mallory Portraits</h1>
    <p style="margin:2px 0 0;font-size:13px;color:#78716c">CC Performance Dashboard</p>
    <p style="margin:18px 0 0;font-size:13px;color:#57534e">Enter the dashboard passphrase to continue.</p>
    <input type="hidden" name="redirectTo" value="${redirectTo.replace(/"/g, "&quot;")}">
    <input type="password" name="passphrase" required autofocus placeholder="Passphrase"
      style="margin-top:12px;width:100%;box-sizing:border-box;border:1px solid #d6d3d1;border-radius:0.5rem;padding:8px 12px;font-size:14px;outline:none"
      onfocus="this.style.borderColor='#78716c'" onblur="this.style.borderColor='#d6d3d1'">
    ${err}
    <button type="submit"
      style="margin-top:16px;width:100%;background:#1c1917;color:#ffffff;border:0;border-radius:0.5rem;padding:8px 12px;font-size:14px;font-weight:500;cursor:pointer"
      onmouseover="this.style.background='#44403c'" onmouseout="this.style.background='#1c1917'">Unlock dashboard</button>
  </form>
</body>
</html>`;
}
