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

// ---------- HISTORICAL REPS (owner directive 2026-10-20) ----------
//
// A DEPARTED rep (removed from active_roster → users.is_active=false by the
// sync) keeps their HISTORICAL contribution on the reporting surfaces: the
// owner explicitly ordered Laura Rivera's bookings/calls/leads restored to
// Weekly + Reps ("add back whatever you took out"). Reporting eligibility is
// therefore ACTIVE ROSTER ∪ HISTORICAL REPS, computed with the SAME name+email
// match rule as the active roster. The union is QUERY-TIME only: it never
// flips users.is_active (the sync's is_active write keeps using the ACTIVE
// roster alone) and never feeds the operational surfaces (Today, Daily
// Report, lead assignment/cohort logic, the attribution engine's write path).

/**
 * Internal ids of the users matching the historical roster — INDEPENDENT of
 * is_active (a historical rep is precisely an inactive user whose rows must
 * still report). Empty historical list → empty set (bit-identical to today).
 */
export function historicalRepIds(
  users: { id: string; name?: string | null; email?: string | null }[],
  historical: RosterEntry[],
): Set<string> {
  if (historical.length === 0) return new Set();
  return new Set(users.filter((u) => isRosterUser(u.name, u.email, historical)).map((u) => u.id));
}

/**
 * The REPORTING rep list: active-roster users PLUS users matching a
 * historical_reps entry (even though is_active=false) — the roster the
 * Weekly/Reps reporting surfaces render rows for. With an empty historical
 * list this is exactly the active users (same rows, same order as the input
 * filter — bit-identical to today's getUsers()-driven lists).
 */
export function reportingRepUsers<U extends { id: string; is_active: boolean; name?: string | null; email?: string | null }>(
  allUsers: U[],
  historical: RosterEntry[],
): U[] {
  if (historical.length === 0) return allUsers.filter((u) => u.is_active);
  return allUsers.filter((u) => u.is_active || isRosterUser(u.name, u.email, historical));
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
 * REPORTING eligibility (Weekly + Reps surfaces): the ACTIVE roster ∪ the
 * HISTORICAL reps. Built on buildRosterEligibility so the rep_mappings
 * behavior CANNOT drift: a mapping still only lands when it points at an
 * ACTIVE roster rep — a mapping pointing at a historical (non-active) rep
 * stays inert exactly as today. With an empty historical list the returned
 * eligibility is DEEP-IDENTICAL to buildRosterEligibility's (test-pinned).
 */
export function buildReportingEligibility(
  users: { id: string; is_active: boolean; name?: string | null; email?: string | null }[],
  settings: { historical_reps?: RosterEntry[]; rep_mappings?: RepMapping[] },
): RosterEligibility {
  const base = buildRosterEligibility(users, settings.rep_mappings ?? []);
  const hist = historicalRepIds(users, settings.historical_reps ?? []);
  if (hist.size === 0) return base;
  const activeIds = new Set(base.activeIds);
  for (const id of hist) activeIds.add(id);
  return { activeIds, mapping: base.mapping };
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

// ---------- Settings §7 Roster Mapping panel payload ----------
/**
 * Pure builder for the Settings §7 Roster Mapping panel rows: every NON-ROSTER
 * HighLevel user (inactive, and not sharing an internal id with an active row)
 * with its 30-day call count (calls carry the RAW HL user id — immutable) and
 * any existing mapping. Sorted callCount desc, then name.
 *
 * OWNER DIRECTIVE ("erase everyone not on my roster"): zero-call rows
 * (test/app/marketing accounts) are noise — the PANEL hides them by default
 * behind a show-all toggle (see rosterPanelVisibleRows in components/
 * settings-views.ts). This builder still returns ALL inactive users — the
 * server payload never excludes them, so a zero-call user stays mappable once
 * revealed. `zeroCallCount` labels that toggle.
 */
export interface NonRosterPanelRow {
  externalId: string;
  name: string;
  callCount: number;
  mappedTo: string | null;
}

export function buildNonRosterPanel(
  allUsers: { id: string; external_id: string; name: string; is_active: boolean }[],
  activeUserIds: Set<string>,
  callsByExternalId: Map<string, number>,
  repMappings: RepMapping[],
): { nonRosterUsers: NonRosterPanelRow[]; zeroCallCount: number } {
  const nonRosterUsers = allUsers
    .filter((u) => !u.is_active && !activeUserIds.has(u.id))
    .map((u) => ({
      externalId: u.external_id,
      name: u.name,
      callCount: callsByExternalId.get(u.external_id) ?? 0,
      mappedTo: repMappings.find((m) => m.external_user_id === u.external_id)?.rep_id ?? null,
    }))
    .sort((a, b) => b.callCount - a.callCount || a.name.localeCompare(b.name));
  return { nonRosterUsers, zeroCallCount: nonRosterUsers.filter((u) => u.callCount === 0).length };
}
