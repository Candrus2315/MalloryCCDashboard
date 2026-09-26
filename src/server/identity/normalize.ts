/**
 * CANONICAL IDENTITY NORMALIZERS (owner-ratified attribution program,
 * Session 1). One source of truth for contact identity values — the
 * backfill stores through these and Session 2's matching reads them.
 *
 * Rules (owner spec):
 *  - normalizeUSPhone: strip non-digits; 11 digits starting with "1" →
 *    drop the leading 1; 10 digits → keep as-is; ANYTHING ELSE → store the
 *    full digit string unchanged. Weird values are NEVER nulled out (they
 *    stay available for exact-match and human review).
 *  - normalizeEmail: trim + lowercase. Never rejects odd-but-real emails.
 *  - Raw provider values are always preserved alongside (contacts.phone /
 *    contacts.email keep the untouched HL values).
 */
export function normalizeUSPhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null; // no digits at all → nothing identity-bearing
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits; // 10-digit US numbers AND every other shape, unchanged
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim().toLowerCase();
  return t.length ? t : null;
}
