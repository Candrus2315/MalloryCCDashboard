/**
 * ACTIVE ROSTER — the pure half of the roster rule (OWNER SPEC: the dashboard's
 * reps are EXACTLY the five-person CC team, configured in
 * settings.active_roster — see DEFAULT_ACTIVE_ROSTER in store/types.ts).
 *
 * Division of labor:
 *   - The SYNC (run.ts full + scheduler.ts incremental tick) calls isRosterUser
 *     per live HighLevel user and stores the verdict in users.is_active. Users
 *     that do not match KEEP their rows (calls/contacts may reference them) but
 *     are marked inactive.
 *   - The READ side never hardcodes names: every page loads users through
 *     store.getUsers() (active only), and team-level CALL metrics filter the
 *     call rows through keepRosterRepCalls with activeRepIds(...) so non-roster
 *     calls never reach team totals.
 *
 * Match rule: a live user is a rep iff their name equals a roster entry's name
 * (case/whitespace-insensitive) AND their email equals one of that entry's
 * emails (case-insensitive). Missing email never matches — an unverifiable
 * identity is excluded, never silently guessed.
 */
import type { RosterEntry, RepMapping } from "./store/types";

function normName(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** The match rule (incl. the Allison exception — both her emails are listed). */
export function isRosterUser(
  name: string | null | undefined,
  email: string | null | undefined,
  roster: RosterEntry[],
): boolean {
  const n = normName(name);
  const e = normEmail(email);
  if (!n || !e) return false;
  return roster.some((entry) => normName(entry.name) === n && entry.emails.some((x) => normEmail(x) === e));
}

/** Internal IDs of the active-roster users (input: store rows, any shape with id+is_active). */
export function activeRepIds(users: { id: string; is_active: boolean }[]): Set<string> {
  return new Set(users.filter((u) => u.is_active).map((u) => u.id));
}

/**
 * Keep only calls whose rep is an active-roster member. Team call metrics must
 * reflect ONLY the CC team: calls from excluded users (and unlinked calls with
 * no rep) stay in the DB but never count toward team totals. An empty active
 * set yields zero calls (no reps → no team numbers).
 */
export function keepRosterRepCalls<T extends { rep_id: string | null }>(calls: T[], activeIds: Set<string>): T[] {
  if (activeIds.size === 0) return [];
  return calls.filter((c) => c.rep_id !== null && activeIds.has(c.rep_id));
}

// ---------- mapping-driven eligibility (design/data-terminology.md) ----------

/**
 * ROSTER MAPPINGS drive REPORTING ELIGIBILITY at query time. When the owner
 * maps a HighLevel user (outside the CC roster) to a CC rep, ALL historical
 * calls under that original HL user id become eligible for that rep's
 * historical performance and the appropriate CC team totals — no re-import,
 * no backfill. SOURCE RECORDS ARE IMMUTABLE: eligibility is computed from the
 * mapping, never by rewriting provider_rep_external_id, rep linkage, message
 * id, conversation id, timestamp or duration. With NO mappings configured the
 * functions below are bit-identical to keepRosterRepCalls (the verified
 * part-2 reconciliation behavior — pinned by tests).
 */

/** Query-time eligibility inputs: the active-roster id set + the owner's mappings. */
export interface RosterEligibility {
  activeIds: Set<string>;
  /** HL external user id → internal rep id (ACTIVE roster reps only). */
  mapping: Map<string, string>;
}

/**
 * Build the eligibility inputs from ALL user rows (active ones become the
 * roster set) + the settings' rep_mappings. Mappings that point at a user
 * that is not an active roster member are inert (dropped) — a deactivated rep
 * can never silently inherit calls.
 */
export function buildRosterEligibility(
  users: { id: string; is_active: boolean }[],
  mappings: RepMapping[],
): RosterEligibility {
  const activeIds = new Set(users.filter((u) => u.is_active).map((u) => u.id));
  const mapping = new Map<string, string>();
  for (const m of mappings) {
    const ext = (m.external_user_id ?? "").trim();
    const rep = (m.rep_id ?? "").trim();
    if (ext && rep && activeIds.has(rep)) mapping.set(ext, rep);
  }
  return { activeIds, mapping };
}

/** The eligibility predicate for ONE call row (pure; shared by filters + rollups). */
export function eligibleRepId(
  call: { rep_id: string | null; provider_rep_external_id?: string | null },
  elig: RosterEligibility,
): string | null {
  if (call.rep_id !== null && elig.activeIds.has(call.rep_id)) return call.rep_id;
  const prov = call.provider_rep_external_id ?? null;
  if (prov && elig.mapping.has(prov)) return elig.mapping.get(prov)!;
  return null;
}

/**
 * Mapping-aware roster filter — THE query-time eligibility gate every call
 * metric flows through (evolves keepRosterRepCalls). Rows pass either because
 * their rep is an active roster member or because their raw HL user id is
 * mapped to one; mapped rows are returned as NEW objects with the eligible
 * rep id (the input rows are never mutated). An empty mapping behaves
 * EXACTLY like keepRosterRepCalls (same rows, same order, same references).
 */
export function applyRosterEligibility<
  T extends { rep_id: string | null; provider_rep_external_id?: string | null },
>(calls: T[], elig: RosterEligibility): T[] {
  if (elig.mapping.size === 0) return keepRosterRepCalls(calls, elig.activeIds);
  const out: T[] = [];
  for (const c of calls) {
    const rep = eligibleRepId(c, elig);
    if (rep == null) continue;
    out.push(rep === c.rep_id ? c : { ...c, rep_id: rep });
  }
  return out;
}

/**
 * Booking attributions gain the same query-time eligibility: a booking whose
 * attributed rep is not on the active roster (or has none) flows to the
 * mapped rep when the UNDERLYING CALL's raw HL user id is mapped — so a
 * mapped user's historical "Bookings From Calls Over 2 Minutes" and
 * conversions move with their calls. Only attribution rep_id is overridden,
 * in a fresh object (rows are never mutated); an empty mapping is the
 * identity (every row passes through unchanged, matching today).
 */
export function applyAttributionEligibility<
  A extends { rep_id: string | null; call_id?: string | null },
>(attributions: A[], eligibleCalls: { id: string; provider_rep_external_id?: string | null }[], elig: RosterEligibility): A[] {
  if (elig.mapping.size === 0) return attributions;
  const provByCallId = new Map(eligibleCalls.map((c) => [c.id, c.provider_rep_external_id ?? null]));
  return attributions.map((a) => {
    if (a.rep_id !== null && elig.activeIds.has(a.rep_id)) return a;
    const prov = a.call_id ? provByCallId.get(a.call_id) : undefined;
    if (prov && elig.mapping.has(prov)) return { ...a, rep_id: elig.mapping.get(prov)! };
    return a;
  });
}
