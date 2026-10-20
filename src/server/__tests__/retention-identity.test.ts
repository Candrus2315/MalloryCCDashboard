/**
 * RETENTION IDENTITY MATCH PIPELINE tests (stage 2 — owner priority order).
 * Owner rules under test: explicit IDs > phone > email > name+supporting;
 * phone format collapse; ambiguity → exception outcome, never guessed;
 * name-only NEVER matches.
 */
import { describe, expect, test } from "bun:test";
import { matchIdentity, normalizeName, type IdentityCandidate } from "../retention/identity";

const A: IdentityCandidate = { internalClientId: "client-a", displayName: "Jane Doe", normalizedPhone: "6035551212", normalizedEmail: "jane@example.com" };
const B: IdentityCandidate = { internalClientId: "client-b", displayName: "Bob Roe", normalizedPhone: "2125550101", normalizedEmail: "bob@other.org" };

describe("matchIdentity — priority order", () => {
  test("tier 1: explicit cross-system id wins over everything", () => {
    const out = matchIdentity({ displayName: "Someone Else", phone: "2125550101", email: "bob@other.org", explicitClientIds: ["client-a"] }, [A, B]);
    expect(out.status).toBe("matched");
    expect(out).toMatchObject({ internalClientId: "client-a", matchMethod: "exact_id", confidence: "exact" });
  });

  test("tier 1 conflict (two explicit ids) is ambiguous, never guessed", () => {
    const out = matchIdentity({ explicitClientIds: ["client-a", "client-b"] }, [A, B]);
    expect(out).toMatchObject({ status: "ambiguous", kind: "ambiguous_id", candidateIds: ["client-a", "client-b"] });
  });

  test("phone formats (603) 555-1212 / 603-555-1212 / +1 603 555 1212 collapse to one match", () => {
    for (const phone of ["(603) 555-1212", "603-555-1212", "+1 603 555 1212", "6035551212"]) {
      const out = matchIdentity({ displayName: "jane doe", phone }, [A, B]);
      expect(out.status).toBe("matched");
      expect(out).toMatchObject({ internalClientId: "client-a", matchMethod: "phone" });
    }
  });

  test("phone + email agreement labels phone_email", () => {
    const out = matchIdentity({ phone: "603-555-1212", email: "JANE@example.com " }, [A, B]);
    expect(out).toMatchObject({ status: "matched", internalClientId: "client-a", matchMethod: "phone_email" });
  });

  test("duplicate phone across two clients → ambiguous_phone (never guessed)", () => {
    const shared: IdentityCandidate = { internalClientId: "client-c", displayName: "Jim Nue", normalizedPhone: "6035551212", normalizedEmail: "jim@x.io" };
    const out = matchIdentity({ phone: "6035551212" }, [A, shared]);
    expect(out).toMatchObject({ status: "ambiguous", kind: "ambiguous_phone", candidateIds: ["client-a", "client-c"] });
  });

  test("tier 3: email alone when phone misses", () => {
    const out = matchIdentity({ email: "bob@other.org" }, [A, B]);
    expect(out).toMatchObject({ status: "matched", internalClientId: "client-b", matchMethod: "email", confidence: "high" });
  });

  test("duplicate email → ambiguous_email", () => {
    const dup: IdentityCandidate = { internalClientId: "client-d", displayName: "Ann Two", normalizedEmail: "bob@other.org" };
    const out = matchIdentity({ email: "bob@other.org" }, [B, dup]);
    expect(out).toMatchObject({ status: "ambiguous", kind: "ambiguous_email" });
  });

  test("tier 4: name + supporting identifier (email domain, different exact email) matches phone_name/medium", () => {
    const domainC: IdentityCandidate = { internalClientId: "client-e", displayName: "Jane Doe", normalizedEmail: "jane@other.org" };
    // Exact email differs (tier 3 cannot fire) but the DOMAIN agrees → supporting hit.
    const subject = { displayName: "Jane Doe", email: "jane@elsewhere.org", supportingEmailDomain: "other.org" };
    const out = matchIdentity(subject, [A, domainC]);
    expect(out.status).toBe("matched");
    expect(out).toMatchObject({ internalClientId: "client-e", matchMethod: "phone_name", confidence: "medium" });
    expect((out as { evidence: { supporting: string[] } }).evidence.supporting).toContain("email_domain");
  });

  test("tier 5 — NAME ALONE NEVER MATCHES (owner rule) even with an exact name hit", () => {
    const out = matchIdentity({ displayName: "Jane Doe" }, [A, B]);
    expect(out).toMatchObject({ status: "unmatched", kind: "name_only" });
  });

  test("name + wrong supporting identifier does not match", () => {
    const out = matchIdentity({ displayName: "Jane Doe", email: "jane@elsewhere.net", supportingEmailDomain: "elsewhere.net" }, [A, B]);
    expect(out).toMatchObject({ status: "unmatched", kind: "name_only" });
  });

  test("no identity attributes at all → no_identity", () => {
    const out = matchIdentity({}, [A, B]);
    expect(out).toMatchObject({ status: "unmatched", kind: "no_identity" });
  });

  test("zero candidates + phone present → unmatched (caller decides create-new vs exception)", () => {
    const out = matchIdentity({ phone: "9175550199" }, []);
    expect(out.status).toBe("unmatched");
    expect((out as { kind: string }).kind).toBe("no_identity");
  });
});

describe("normalizeName", () => {
  test("case/punctuation/whitespace collapse", () => {
    expect(normalizeName("  O'Brien-Mary,  Jane ")).toBe("o brien mary jane");
    expect(normalizeName(null)).toBeNull();
  });
});
