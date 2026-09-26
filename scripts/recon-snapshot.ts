/** Reconciliation: harvest_calls ledger vs dashboard `calls` per rep, 9/25 ET + WTD. */
import postgres from "postgres";
import { readFileSync } from "node:fs";
const envOf = (k: string): string => {
  const m = readFileSync("/proc/self/environ", "utf8").split("\0").find((s) => s.toLowerCase().startsWith(k.toLowerCase() + "="));
  return m ? m.slice(k.length + 1) : "";
};
const url = process.env.DATABASE_URL || envOf("DATABASE_URL");
const sql = postgres(url, { max: 2 });
const led = async (a: string, b: string | null) =>
  (await sql`SELECT user_external_id ext, count(*)::int n, SUM(CASE WHEN duration_seconds > 120 THEN 1 ELSE 0 END)::int over2 FROM harvest_calls WHERE started_at >= ${a} ${b ? sql`AND started_at < ${b}` : sql``} GROUP BY 1`) as any[];
const db = async (a: string, b: string | null) =>
  (await sql`SELECT u.external_id ext, u.name, count(*)::int n, SUM((c.duration_seconds > 120)::int)::int over2 FROM calls c JOIN users u ON u.id=c.rep_id WHERE c.provider='highlevel' AND c.started_at >= ${a} ${b ? sql`AND c.started_at < ${b}` : sql``} GROUP BY 1,2`) as any[];
const [ly, dbY, lw, dbW, days] = await Promise.all([
  led("2026-09-25T04:00:00Z", "2026-09-26T04:00:00Z"), db("2026-09-25T04:00:00Z", "2026-09-26T04:00:00Z"),
  led("2026-09-21T04:00:00Z", null), db("2026-09-21T04:00:00Z", null),
  sql`SELECT to_char(started_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') d, count(*)::int n, SUM(CASE WHEN duration_seconds > 120 THEN 1 ELSE 0 END)::int over2 FROM harvest_calls WHERE user_external_id='Pf0rllLIswGz28ljL5pZ' GROUP BY 1 ORDER BY 1`,
]);
const cov = (await sql`SELECT count(*)::int total, count(*) FILTER (WHERE visited)::int visited, count(*) FILTER (WHERE message_types @> '[1]'::jsonb OR last_message_type='TYPE_CALL')::int flagged FROM harvest_conversations WHERE last_message_date >= 1789467600000::bigint`)[0] as any;
const run = (await sql`SELECT list_requests, conversations_listed, visits_done, calls_found, messages_scanned, stopped_reason FROM harvest_runs ORDER BY started_at DESC LIMIT 1`)[0] as any;
const ym = new Map(ly.map((r) => [r.ext, r])), yd = new Map(dbY.map((r) => [r.ext, r])), wm = new Map(lw.map((r) => [r.ext, r])), wd = new Map(dbW.map((r) => [r.ext, r]));
const roster = (await sql`SELECT external_id, name FROM users WHERE is_active ORDER BY name`) as any[];
const L = (m: Map<any, any>, k: string) => { const r = m.get(k); return r ? `${r.n}/${r.over2}` : "0/0"; };
let out = `HARVEST RECONCILIATION ${new Date().toISOString()} (window 2026-09-14T04:00Z -> now)\n`;
out += `RUN: list_requests=${run.list_requests} convs_listed=${run.conversations_listed} visits=${run.visits_done} calls=${run.calls_found} msgs=${run.messages_scanned} stopped=${run.stopped_reason ?? "running"}\n`;
out += `COVERAGE in-window: listed=${cov.total} visited=${cov.visited} call-flagged=${cov.flagged}\n\n`;
out += `rep | yest ledger(db) | wtd ledger(db) | match\n`;
for (const u2 of roster) {
  const e = u2.external_id;
  const ok = L(ym, e) === L(yd, e) && L(wm, e) === L(wd, e) ? "OK" : "MISMATCH";
  out += `${u2.name} (${e}) | ${L(ym, e)} (${L(yd, e)}) | ${L(wm, e)} (${L(wd, e)}) | ${ok}\n`;
}
const alL = (await sql`SELECT count(*)::int n, SUM(CASE WHEN duration_seconds > 120 THEN 1 ELSE 0 END)::int over2 FROM harvest_calls WHERE user_external_id='Pf0rllLIswGz28ljL5pZ' AND started_at >= '2026-09-25T04:00:00Z' AND started_at < '2026-09-26T04:00:00Z'`)[0] as any;
const alD = (await sql`SELECT count(*)::int n, SUM((c.duration_seconds > 120)::int)::int over2 FROM calls c JOIN users u ON u.id=c.rep_id WHERE u.external_id='Pf0rllLIswGz28ljL5pZ' AND c.started_at >= '2026-09-25T04:00:00Z' AND c.started_at < '2026-09-26T04:00:00Z'`)[0] as any;
out += `\nALLISON 9/25 ET: harvest-ledger=${alL.n}/${alL.over2} dashboard-DB=${alD.n}/${alD.over2}\n`;
out += `ALLISON per ET day (ledger n/over2): ${(days as any[]).map((r) => `${r.d}:${r.n}/${r.over2}`).join("  ")}\n`;
console.log(out);
await sql.end();
