/**
 * RETENTION IDENTITY MATCH PIPELINE (stage 2 — owner-approved D1–D14, 2026-10-19).
 *
 * Pure matcher: given ONE incoming subject (a GHL contact, an Acuity
 * appointment, …) and the universe of existing internal clients, decides —
 * in the owner's FIXED priority order — which internal client (if any) the
 * subject belongs to, or that it must become a Data Match Exception.
 *
 * Owner rules implemented here (IMPLEMENTATION-PLAN.md §7):
 *   1. explicit cross-system IDs      → method 'exact_id'   (confidence exact)
 *   2. normalized phone (+ email)     → 'phone_email'/'phone' (exact/high)
 *   3. normalized email alone         → 'email'            (high)
 *   4. name + supporting identifiers  → 'phone_name'       (medium)
 *   5. name ALONE                     → NEVER matches (owner rule) →
 *                                       Data Match Exception (name_only)
 * Ambiguity (≥2 distinct candidate clients at any tier) is NEVER guessed —
 * it returns { status: "ambiguous" } so the caller writes a Data Match
 * Exception. Manual resolutions are sticky at the STORE layer (the
 * (provider, entity, external_id) UNIQUE link + resolveDataMatchException);
 * callers consult existing links BEFORE invoking this matcher, so a manual
 * resolve is never re-matched or overridden by an auto pass.
 *
 * Normalization reuses the identity program's single source of truth
 * (src/server/identity/normalize.ts): normalizeUSPhone collapses
 * (603) 555-1212 / 603-555-1212 / +1 603 555 1212 to the same 10-digit
 * NANP value; normalizeEmail is trim+lowercase.
 */
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";

export type MatchMethod = "exact_id" | "phone_email" | "phone" | "email" | "phone_name" | "manual";
export type MatchConfidence = "exact" | "high" | "medium" | "manual";

/** Exception kinds (plan §7; 'ambiguous_id'/'ambiguous_name' are honest extensions for ambiguity at the id/name tiers — plan lists only the phone/email ambiguity kinds). */
export type MatchExceptionKind =
  | "ambiguous_id"
  | "ambiguous_phone"
  | "ambiguous_email"
  | "ambiguous_name"
  | "name_only"
  | "no_identity";

/** One existing internal client offered as a match candidate. */
export interface IdentityCandidate {
  internalClientId: string;
  displayName?: string | null;
  normalizedPhone?: string | null;
  normalizedEmail?: string | null;
}

/** The incoming subject's identity attributes (whatever the source system reports). */
export interface IdentitySubject {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Explicit cross-system client ids (tier 1): e.g. a known internal client id from appointments.contact_id's resolved GHL contact. */
  explicitClientIds?: (string | null | undefined)[];
  /** Supporting context for the name+supporting tier (plan §7.4). */
  supportingPhonePrefix?: string | null; // ≥7 leading digits of the subject's phone
  supportingEmailDomain?: string | null; // subject email domain
  supportingAssignedRepId?: string | null; // GHL-assigned rep context
  candidateAssignedRepIds?: Record<string, string | null | undefined>; // candidateId → rep id
}

export type MatchOutcome =
  | { status: "matched"; internalClientId: string; matchMethod: MatchMethod; confidence: MatchConfidence; evidence: MatchEvidence }
  | { status: "ambiguous"; kind: MatchExceptionKind; candidateIds: string[]; evidence: MatchEvidence }
  | { status: "unmatched"; kind: "name_only" | "no_identity"; evidence: MatchEvidence };

export interface MatchEvidence {
  /** Which tier decided (owner priority order 1–4; 5 = name alone, never matches). */
  tier: "explicit_id" | "phone_email" | "phone" | "email" | "name_supporting" | "name_only" | "none";
  normalizedPhone: string | null;
  normalizedEmail: string | null;
  /** Supporting-identifier hits recorded for audit (never a sole basis). */
  supporting: string[];
}

/** lowercase/strip punctuation/collapse whitespace — supporting evidence ONLY (owner rule: never a sole basis). */
export function normalizeName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length ? t : null;
}

function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1) : null;
}

function supportingHits(subject: IdentitySubject, c: IdentityCandidate, subjectName: string | null): string[] {
  const hits: string[] = [];
  const sp = subject.supportingPhonePrefix ?? null;
  const cp = c.normalizedPhone ?? null;
  if (sp && cp && cp.startsWith(sp) && sp.length >= 7) hits.push("phone_prefix");
  const sd = subject.supportingEmailDomain ?? emailDomain(subject.email);
  const cd = emailDomain(c.normalizedEmail ?? null);
  if (sd && cd && sd === cd) hits.push("email_domain");
  const srep = subject.supportingAssignedRepId ?? null;
  const crep = subject.candidateAssignedRepIds?.[c.internalClientId] ?? null;
  if (srep && crep && srep === crep) hits.push("assigned_rep");
  // A name agreement alone is REQUIRED for this tier but is never itself a
  // "supporting" hit — supporting means a SECOND, non-name identifier.
  const cn = normalizeName(c.displayName);
  if (subjectName && cn && subjectName === cn) hits.push("name_equal");
  return hits;
}

/**
 * Resolve ONE subject against the candidate universe. Never throws, never
 * guesses: ambiguity and name-only subjects come back as non-match outcomes
 * the caller turns into Data Match Exceptions (dedupe keys chosen by caller).
 */
export function matchIdentity(subject: IdentitySubject, candidates: IdentityCandidate[]): MatchOutcome {
  const nPhone = normalizeUSPhone(subject.phone ?? null);
  const nEmail = normalizeEmail(subject.email ?? null);
  const nName = normalizeName(subject.displayName);
  const base: MatchEvidence = { tier: "none", normalizedPhone: nPhone, normalizedEmail: nEmail, supporting: [] };

  const explicit = [...new Set((subject.explicitClientIds ?? []).filter((x): x is string => !!x))];
  if (explicit.length === 1) {
    return {
      status: "matched",
      internalClientId: explicit[0],
      matchMethod: "exact_id",
      confidence: "exact",
      evidence: { ...base, tier: "explicit_id", supporting: ["explicit_cross_system_id"] },
    };
  }
  if (explicit.length > 1) {
    return {
      status: "ambiguous",
      kind: "ambiguous_id",
      candidateIds: explicit,
      evidence: { ...base, tier: "explicit_id", supporting: ["explicit_cross_system_id_conflict"] },
    };
  }

  // Tier 2 — normalized phone. Zero duplicate phones exist in live contacts
  // today, so a phone match is de-facto unique; a future duplicate STILL
  // never matches (ambiguous_phone) and never silently picks one.
  if (nPhone) {
    const byPhone = candidates.filter((c) => c.normalizedPhone === nPhone);
    if (byPhone.length === 1) {
      const c = byPhone[0];
      const emailAlso = nEmail && normalizeEmail(c.normalizedEmail ?? null) === nEmail;
      return {
        status: "matched",
        internalClientId: c.internalClientId,
        matchMethod: emailAlso ? "phone_email" : "phone",
        confidence: "exact",
        evidence: { ...base, tier: emailAlso ? "phone_email" : "phone", supporting: emailAlso ? ["email_equal"] : [] },
      };
    }
    if (byPhone.length > 1) {
      return {
        status: "ambiguous",
        kind: "ambiguous_phone",
        candidateIds: byPhone.map((c) => c.internalClientId),
        evidence: { ...base, tier: "phone" },
      };
    }
  }

  // Tier 3 — normalized email alone.
  if (nEmail) {
    const byEmail = candidates.filter((c) => c.normalizedEmail === nEmail);
    if (byEmail.length === 1) {
      return {
        status: "matched",
        internalClientId: byEmail[0].internalClientId,
        matchMethod: "email",
        confidence: "high",
        evidence: { ...base, tier: "email" },
      };
    }
    if (byEmail.length > 1) {
      return {
        status: "ambiguous",
        kind: "ambiguous_email",
        candidateIds: byEmail.map((c) => c.internalClientId),
        evidence: { ...base, tier: "email" },
      };
    }
  }

  // Tier 4 — name + supporting identifiers (medium). Name agreement is the
  // gate; at least one NON-name supporting hit is required. Name alone
  // (tier 5) NEVER matches — the owner rule this module exists to enforce.
  if (nName) {
    const eligible = candidates.filter((c) => normalizeName(c.displayName) === nName);
    const supported = eligible.filter((c) => {
      const hits = supportingHits(subject, c, nName).filter((h) => h !== "name_equal");
      return hits.length > 0;
    });
    if (supported.length === 1) {
      const c = supported[0];
      return {
        status: "matched",
        internalClientId: c.internalClientId,
        matchMethod: "phone_name",
        confidence: "medium",
        evidence: { ...base, tier: "name_supporting", supporting: supportingHits(subject, c, nName).filter((h) => h !== "name_equal") },
      };
    }
    if (supported.length > 1) {
      return {
        status: "ambiguous",
        kind: "ambiguous_name",
        candidateIds: supported.map((c) => c.internalClientId),
        evidence: { ...base, tier: "name_supporting" },
      };
    }
    // Name present but no supporting identifier anywhere → name-only subject.
    return {
      status: "unmatched",
      kind: "name_only",
      evidence: { ...base, tier: "name_only" },
    };
  }

  // Nothing identity-bearing at all.
  return { status: "unmatched", kind: "no_identity", evidence: base };
}
