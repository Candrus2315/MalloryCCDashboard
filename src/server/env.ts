/**
 * Centralized secret/env resolver.
 *
 * Secrets are saved by the owner in the platform's Secrets UI and injected as
 * environment variables. The canonical names are ALL-CAPS (DATABASE_URL,
 * HIGHLEVEL_API_KEY, …), but saved names may drift in casing (e.g.
 * "Database_URL"), and a stale canonical value can linger after the owner
 * re-saves under a different casing.
 *
 * Resolution rules (getSecret):
 *  1. Collect every process.env key that matches the canonical name
 *     case-insensitively. The exact ALL-CAPS key is tried first.
 *  2. If there is only one candidate, use it.
 *  3. With several candidates, prefer the canonical ALL-CAPS key ONLY if its
 *     value passes a basic completeness check; otherwise fall back to the
 *     first complete alternative. This is what keeps a stale passwordless
 *     DATABASE_URL from shadowing a good "Database_URL" (and vice versa).
 *
 * SECURITY: never log, echo, or serialize secret VALUES. Use
 * describeSecretSource() if you need to report WHICH key was selected.
 */

export const SECRET_NAMES = [
  "DATABASE_URL",
  "HIGHLEVEL_API_KEY",
  "HIGHLEVEL_LOCATION_ID",
  "ACUITY_USER_ID",
  "ACUITY_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "DASHBOARD_PASSPHRASE",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

function isCanonical(name: string, key: string): boolean {
  return key === name;
}

/** Case-insensitive env lookup: exact key first, then any other casing. */
function candidates(name: SecretName): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (key.toUpperCase() !== upper) continue;
    // canonical ALL-CAPS key sorts first regardless of Object.entries order
    out.push({ key, value });
  }
  out.sort((a, b) => Number(isCanonical(name, b.key)) - Number(isCanonical(name, a.key)));
  return out;
}

/**
 * Cheap completeness check — catches the "saved without a password" class of
 * bad URLs without ever inspecting the value's contents beyond its structure.
 */
function looksComplete(name: SecretName, value: string): boolean {
  if (name === "DATABASE_URL") {
    try {
      const u = new URL(value);
      return u.hostname.length > 0 && (u.password.length > 0 || !u.protocol.startsWith("postgres"));
    } catch {
      return false;
    }
  }
  return value.trim().length > 0;
}

/** Resolve a secret by canonical name (case-insensitive fallback). Null if absent. */
export function getSecret(name: SecretName): string | null {
  const cands = candidates(name);
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0].value;
  // Canonical key first (sorted); first complete value wins if the canonical
  // one is broken (e.g. saved without a password).
  for (const c of cands) if (looksComplete(name, c.value)) return c.value;
  return cands[0].value;
}

/** Which env key a secret resolved from (safe to log — never the value). */
export function describeSecretSource(name: SecretName): string | null {
  const cands = candidates(name);
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0].key;
  for (const c of cands) if (looksComplete(name, c.value)) return c.key;
  return cands[0].key;
}
