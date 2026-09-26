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
import type { RosterEntry } from "./store/types";

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
