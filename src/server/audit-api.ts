/**
 * AUDIT ENDPOINT CORE — GET /api/audit?rep=<repId|all|unassigned>&date=YYYY-MM-DD
 *
 * Read-only DB inspection for the owner: any rep's calls for any ET day,
 * straight from the normalized `calls` table. NO live HighLevel harvesting —
 * the only I/O is store reads (calls joined to users/contacts) + settings.
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
import type { AuditCallRow } from "./store/types";

export const AUDIT_UNASSIGNED = "unassigned";
export const AUDIT_ALL = "all";

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
 * Pure rep-filter resolution. Accepts "all"/null (every call), "unassigned"
 * (rep NULL or non-roster user), or an internal user id — roster or not, the
 * audit view can inspect ANY user's raw rows.
 */
export function resolveAuditRepFilter(
  rep: string | null | undefined,
  users: AuditUserRef[],
): { ok: true; spec: string | null; label: string } | { ok: false; error: string } {
  const r = rep == null || rep === "" ? AUDIT_ALL : rep;
  if (r === AUDIT_ALL) return { ok: true, spec: null, label: "All calls (roster + unassigned)" };
  if (r === AUDIT_UNASSIGNED) return { ok: true, spec: AUDIT_UNASSIGNED, label: "Unassigned — non-roster HighLevel users" };
  const u = users.find((x) => x.id === r);
  if (!u) {
    return {
      ok: false,
      error: `Unknown rep "${r}" — use a user id from this database, "all", or "unassigned".`,
    };
  }
  return { ok: true, spec: u.id, label: `${u.name}${u.is_active ? "" : " (non-roster user)"}` };
}

/** ET presentation fields for one audit row (ET date + human clock time). */
export function auditRowView(r: AuditCallRow): AuditCallRow & { et_date: string; started_at_et: string } {
  const ms = Date.parse(r.started_at);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ms));
  return { ...r, et_date: etDateStrFromInstant(ms), started_at_et: parts };
}

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
  const rows = await store.getAuditCalls(day.startUtc, day.endUtc, repFilter.spec, threshold);

  return {
    status: 200,
    body: {
      date: day.date,
      date_label: formatDateHumanFull(day.date),
      rep: repFilter.spec ?? (params.rep === AUDIT_UNASSIGNED ? AUDIT_UNASSIGNED : AUDIT_ALL),
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
