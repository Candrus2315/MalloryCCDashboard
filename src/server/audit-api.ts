/**
 * AUDIT ENDPOINT CORE — GET /api/audit?rep=<repId|all|non-roster|unattributed|unassigned>&date=YYYY-MM-DD
 *
 * Read-only DB inspection for the owner: any rep's calls for any ET day,
 * straight from the normalized `calls` table. NO live HighLevel harvesting —
 * the only I/O is store reads (calls joined to users/contacts) + settings.
 *
 * CALL-OWNERSHIP BUCKETS (design/data-terminology.md — three, mutually
 * exclusive; labels are EXACT owner terminology):
 *   - "non-roster"    → Non Roster Calls: a KNOWN HighLevel user outside the
 *                       CC roster. Visible + auditable; never in CC metrics.
 *   - "unattributed"  → Unattributed: ownership genuinely undeterminable
 *                       (no HL user). NEVER used for non-roster users.
 *   - "unassigned"    → legacy alias kept for backward compatibility; returns
 *                       the UNION of both buckets (the old combined view).
 *   - "roster"        → Roster calls (merged-build Phase 3 §16 drill-down):
 *                       exactly the roster-eligible rows the Team/Reps metrics
 *                       count — resolved by the SAME roster.ts eligibility
 *                       helper the metrics layer uses, so a drawer count can
 *                       never diverge from the chart it reconciles to.
 *
 * ET day boundaries come from the CENTRALIZED date helpers (etDayStartUtc /
 * etDayEndUtc, America/New_York) — never the server's local timezone. The
 * over-threshold flag is computed with the LIVE settings threshold, the same
 * rule the metrics layer (summarizeCalls) applies, so the audit view cannot
 * diverge from what Reps/Team show for the same day.
 *
 * Served from two places (same code):
 *   - serve.ts  (production bun server, behind the passphrase gate)
 *   - vite.config.ts dev middleware (working site)
 * The /audit page reads the same logic via getAuditData in queries.ts.
 */
import { etDateStrFromInstant, etDayEndUtc, etDayStartUtc, etToday, formatDateHumanFull } from "./date-logic";
import { buildRosterEligibility, eligibleRepId } from "./roster";
import type { AuditCallRow, RepMapping } from "./store/types";

export const AUDIT_NON_ROSTER = "non-roster";
export const AUDIT_UNATTRIBUTED = "unattributed";
/** Legacy alias → the UNION of non-roster + unattributed (old combined view). */
export const AUDIT_UNASSIGNED = "unassigned";
/** §16 drill-down bucket → exactly the rows the CC-team metrics count. */
export const AUDIT_ROSTER = "roster";
export const LABEL_ROSTER = "Roster calls (CC team metrics)";
export const AUDIT_ALL = "all";

/** Exact owner terminology (design/data-terminology.md) — used everywhere. */
export const LABEL_NON_ROSTER = "Non Roster Calls";
export const LABEL_UNATTRIBUTED = "Unattributed";

/** Pure ET-day resolution: null date → today; invalid → error (HTTP 400). */
export function resolveAuditDayBounds(
  date: string | null | undefined,
  today: string,
): { ok: true; date: string; startUtc: string; endUtc: string; note: string | null } | { ok: false; error: string } {
  const d = date == null || date === "" ? today : date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { ok: false, error: `Invalid date "${d}" — expected YYYY-MM-DD (an America/New_York calendar date).` };
  }
  const note = d > today ? `No calls can exist for a future ET date (${formatDateHumanFull(d)}); rows will be empty.` : null;
  return { ok: true, date: d, startUtc: etDayStartUtc(d), endUtc: etDayEndUtc(d), note };
}

export interface AuditUserRef {
  id: string;
  name: string;
  is_active: boolean;
}

/**
 * Pure rep-filter resolution. Accepts "all"/null (every call), the ownership
 * buckets ("non-roster", "unattributed", legacy alias "unassigned", the §16
 * "roster" metric set), or an internal user id — roster or not, the audit view
 * can inspect ANY user's raw rows. Raw view only: roster MAPPINGS change
 * reporting eligibility, never what these source rows show.
 */
export function resolveAuditRepFilter(
  rep: string | null | undefined,
  users: AuditUserRef[],
): { ok: true; spec: string | null; label: string } | { ok: false; error: string } {
  const r = rep == null || rep === "" ? AUDIT_ALL : rep;
  if (r === AUDIT_ALL) return { ok: true, spec: null, label: "All calls (roster + non-roster + unattributed)" };
  if (r === AUDIT_NON_ROSTER) return { ok: true, spec: AUDIT_NON_ROSTER, label: LABEL_NON_ROSTER };
  if (r === AUDIT_UNATTRIBUTED) return { ok: true, spec: AUDIT_UNATTRIBUTED, label: LABEL_UNATTRIBUTED };
  if (r === AUDIT_UNASSIGNED)
    return { ok: true, spec: AUDIT_UNASSIGNED, label: "Unassigned (legacy alias — Non Roster Calls + Unattributed)" };
  if (r === AUDIT_ROSTER) return { ok: true, spec: AUDIT_ROSTER, label: LABEL_ROSTER };
  const u = users.find((x) => x.id === r);
  if (!u) {
    return {
      ok: false,
      error: `Unknown rep "${r}" — use a user id from this database, "all", "non-roster", or "unattributed".`,
    };
  }
  return { ok: true, spec: u.id, label: `${u.name}${u.is_active ? "" : " (non-roster user)"}` };
}

/**
 * §16 reconciliation set: filter rows down to EXACTLY the roster-eligible rows
 * the metrics layer counts, using the SAME eligibility helper (roster.ts →
 * buildRosterEligibility + eligibleRepId) the metrics pass runs. Pure — no
 * store call, so both the memory and pg stores behave identically and the
 * drawer count can never diverge from the chart it reconciles to.
 */
export function rosterEligibleRows<
  T extends { rep_id: string | null; provider_rep_external_id?: string | null },
>(rows: T[], users: AuditUserRef[], mappings: RepMapping[]): T[] {
  const elig = buildRosterEligibility(users, mappings ?? []);
  return rows.filter((r) => eligibleRepId(r, elig) !== null);
}

/** ET presentation fields — implementation lives in date-logic (client-safe, so
 *  routes can import it without dragging server runtime into the client bundle);
 *  imported here for local use and re-exported for server consumers. */
import { auditRowView } from "./date-logic";
export { auditRowView };

export interface AuditOkBody {
  date: string;
  date_label: string;
  rep: string;
  rep_label: string;
  threshold_seconds: number;
  timezone: string;
  range: { startUtc: string; endUtc: string };
  count: number;
  over_threshold_count: number;
  note: string | null;
  rows: ReturnType<typeof auditRowView>[];
}

export interface AuditQueryResult {
  status: number;
  body: AuditOkBody | { error: string };
}

/** Orchestration shared by serve.ts (prod), the vite dev middleware, and the /audit page loader. */
export async function handleAuditQuery(params: { rep?: string | null; date?: string | null }): Promise<AuditQueryResult> {
  // LAZY store import: this module is also pulled into the client bundle (the
  // /audit page shares the response types) — a static store import here drags
  // the pg driver into the browser graph and breaks `vite build`.
  const { getStore } = await import("./store");
  const store = await getStore();
  const settings = await store.getSettings();
  const today = etToday();

  const day = resolveAuditDayBounds(params.date, today);
  if (!day.ok) return { status: 400, body: { error: day.error } };

  const users = await store.getAllUsers();
  const repFilter = resolveAuditRepFilter(params.rep, users);
  if (!repFilter.ok) return { status: 400, body: { error: repFilter.error } };

  const threshold = settings.meaningful_call_threshold_seconds;
  let rows: AuditCallRow[];
  if (repFilter.spec === AUDIT_ROSTER) {
    // §16 drill-down: fetch the full day once, then keep exactly the
    // roster-eligible rows via the SAME helper the metrics layer runs.
    const allRows = await store.getAuditCalls(day.startUtc, day.endUtc, null, threshold);
    rows = rosterEligibleRows(allRows, users, settings.rep_mappings ?? []);
  } else {
    rows = await store.getAuditCalls(day.startUtc, day.endUtc, repFilter.spec, threshold);
  }

  // Echo the requested bucket back (all / non-roster / unattributed / unassigned / roster)
  const requested = params.rep == null || params.rep === "" ? AUDIT_ALL : params.rep;
  const bucketEcho = [AUDIT_NON_ROSTER, AUDIT_UNATTRIBUTED, AUDIT_UNASSIGNED, AUDIT_ROSTER].includes(requested)
    ? requested
    : AUDIT_ALL;

  return {
    status: 200,
    body: {
      date: day.date,
      date_label: formatDateHumanFull(day.date),
      rep: repFilter.spec ?? bucketEcho,
      rep_label: repFilter.label,
      threshold_seconds: threshold,
      timezone: "America/New_York",
      range: { startUtc: day.startUtc, endUtc: day.endUtc },
      count: rows.length,
      over_threshold_count: rows.filter((r) => r.over_threshold).length,
      note: day.note,
      rows: rows.map(auditRowView),
    },
  };
}
