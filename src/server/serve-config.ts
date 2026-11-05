/**
 * SERVE CONFIG — managed-mode-driven listen address + managed-mode flag.
 *
 * PORTABILITY (2026-11-05, amended same day): the serve entry used to hard-pin
 * PORT=3000 / HOST=0.0.0.0 because a stray PORT in the CTO sandbox (or a .env
 * Bun auto-loads) could silently move the site off the reverse-proxied :3000.
 * The original hard-pin concern was REAL and stays in force for unmanaged
 * boots: on 2026-11-05 the sandbox shell profile was found to carry PORT=80,
 * and honoring it moved the dev site off :3000 and dark. So the env-driven
 * address is a MANAGED-MODE capability only:
 *
 *   - UNMANAGED (no SERVE_MANAGED=1 — CTO sandbox, local dev): PORT and HOST
 *     are IGNORED entirely; the site always binds 3000 / 0.0.0.0.
 *   - MANAGED (SERVE_MANAGED=1 — independent production host): PORT and HOST
 *     are honored, defaulting to 3000 / 0.0.0.0 when unset. This is the path
 *     a hosting supervisor configures.
 *
 * Every managed value is validated: a non-numeric or out-of-range PORT is a
 * hard, NAMED boot failure (ServeConfigError) — never silently interpreted as
 * the default, which would hide a misconfigured host.
 */

/** Named boot refusal for an invalid serve address env value. */
export class ServeConfigError extends Error {
  readonly envName: string;
  readonly rawValue: string;
  constructor(envName: string, rawValue: string, reason: string) {
    super(`invalid ${envName} in the environment: ${JSON.stringify(rawValue)} — ${reason}`);
    this.name = "ServeConfigError";
    this.envName = envName;
    this.rawValue = rawValue;
  }
}

/** The listen address serve.ts binds. */
export interface ServeAddress {
  port: number;
  host: string;
}

export const DEFAULT_SERVE_PORT = 3000;
export const DEFAULT_SERVE_HOST = "0.0.0.0";

/**
 * Resolve the listen address from an env-style record (pass process.env, or a
 * literal for tests).
 *
 * UNMANAGED boots ignore the environment entirely and always return
 * 3000 / 0.0.0.0 — a stray PORT/HOST in the shell profile or a .env cannot
 * move the site (the 2026-11-05 PORT=80 incident is pinned in tests).
 *
 * MANAGED boots (SERVE_MANAGED=1) honor PORT/HOST: unset/empty PORT → 3000;
 * unset/empty HOST → "0.0.0.0". A present PORT must be an integer 1–65535;
 * anything else throws the named ServeConfigError. HOST is taken verbatim
 * when present.
 */
export function resolveServeAddress(env: Record<string, string | undefined>): ServeAddress {
  if (!isManagedServe(env)) {
    return { port: DEFAULT_SERVE_PORT, host: DEFAULT_SERVE_HOST };
  }
  const rawPort = env.PORT?.trim() ?? "";
  if (rawPort === "") {
    return { port: DEFAULT_SERVE_PORT, host: resolveHost(env) };
  }
  if (!/^\d+$/.test(rawPort)) {
    throw new ServeConfigError("PORT", env.PORT ?? "", "it must be a plain decimal port number");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServeConfigError("PORT", env.PORT ?? "", "it must be an integer between 1 and 65535");
  }
  return { port, host: resolveHost(env) };
}

function resolveHost(env: Record<string, string | undefined>): string {
  const rawHost = env.HOST?.trim() ?? "";
  return rawHost === "" ? DEFAULT_SERVE_HOST : rawHost;
}

/**
 * MANAGED MODE (SERVE_MANAGED=1): the host's supervisor owns the process
 * lifecycle, so serve.ts skips the second-instance boot guard and the sudo
 * lsof port-eviction loop entirely (no port pre-check, no killing other
 * processes) and simply binds — a taken port is one clear log line + exit 1
 * for the supervisor to sort out. Unset (or any value other than exactly
 * "1") keeps the full CTO-sandbox boot behavior byte-identical.
 */
export function isManagedServe(env: Record<string, string | undefined>): boolean {
  return env.SERVE_MANAGED === "1";
}

/**
 * Recognize a "port already taken" bind failure across runtimes: Bun sets
 * code EADDRINUSE on the thrown error; a message fallback keeps the check
 * honest if a Bun upgrade reshapes the error. Anything else is NOT treated
 * as EADDRINUSE (a managed boot rethrows it for the supervisor).
 */
export function isAddressInUseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code === "EADDRINUSE") return true;
  return /EADDRINUSE|address (already )?in use/i.test(err.message);
}
