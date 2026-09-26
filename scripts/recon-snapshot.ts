/** Reconciliation: harvest_calls ledger vs dashboard `calls` per rep, 9/25 ET + WTD. */
/** --matrix: full per-rep × per-ET-DAY recount over 9/14 00:00 ET → today. */
import postgres from "postgres";
import { readFileSync } from "node:fs";
const envOf = (k: string): string => {
  const m = readFileSync("/proc/self/environ", "utf8").split("\0").find((s) => s.toLowerCase().startsWith(k.toLowerCase() + "="));
  return m ? m.slice(k.length + 1) : "";
};
const url = process.env.DATABASE_URL || envOf("DATABASE_URL");
const sql = postgres(url, { max: 2 });
// Operative-window start: Mon 2026-09-14 00:00 ET = 2026-09-14T04:00:00Z (EDT).
const WINDOW_START_MS = 1789358400000;
const WINDOW_START_DAY = "2026-09-14";
const led = async (a: string, b: string | null) =>
  (await sql`SELECT user_external_id ext, count(*)::int n, SUM(CASE WHEN duration_seconds > 120 THEN 1 ELSE 0 END)::int over2 FROM harvest_calls WHERE started_at >= ${a} ${b ? sql`AND started_at < ${b}` : sql``} GROUP BY 1`) as any[];
const db = async (a: string, b: string | null) =>
  (await sql`SELECT u.external_id ext, u.name, count(*)::int n, SUM((c.duration_seconds > 120)::int)::int over2 FROM calls c JOIN users u ON u.id=c.rep_id WHERE c.provider='highlevel' AND c.started_at >= ${a} ${b ? sql`AND c.started_at < ${b}` : sql``} GROUP BY 1,2`) as any[];
const [ly, dbY, lw, dbW, days] = await Promise.all([
  led("2026-09-25T04:00:00Z", "2026-09-26T04:00:00Z"), db("2026-09-25T04:00:00Z", "2026-09-26T04:00:00Z"),
  led("2026-09-21T04:00:00Z", null), db("2026-09-21T04:00:00Z", null),
  sql`SELECT to_char(started_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') d, count(*)::int n, SUM(CASE WHEN duration_seconds > 120 THEN 1 ELSE 0 END)::int over2 FROM harvest_calls WHERE user_external_id='Pf0rllLIswGz28ljL5pZ' GROUP BY 1 ORDER BY 1`,
]);
const covWin = async (a: number, b: number | null) =>
  ((await sql`SELECT count(*)::int total, count(*) FILTER (WHERE visited)::int visited FROM harvest_conversations WHERE last_message_date >= ${a} ${b ? sql`AND last_message_date < ${b}` : sql``}`)[0]) as any;
const pct = (v: number, t: number) => (t === 0 ? "n/a" : `${((v / t) * 100).toFixed(1)}%`);
const [covPrev, covWtd, covY] = await Promise.all([
  covWin(WINDOW_START_MS, 1789963200000), // prev week: 9/14 04:00Z -> 9/21 04:00Z
  covWin(1789963200000, Date.now()), // WTD: 9/21 04:00Z -> now
  covWin(1790308800000, 1790395200000), // 9/25 ET: 9/25 04:00Z -> 9/26 04:00Z
]);
const run = (await sql`SELECT list_requests, conversations_listed, visits_done, calls_found, messages_scanned, stopped_reason FROM harvest_runs ORDER BY started_at DESC LIMIT 1`)[0] as any;
const ym = new Map(ly.map((r) => [r.ext, r])), yd = new Map(dbY.map((r) => [r.ext, r])), wm = new Map(lw.map((r) => [r.ext, r])), wd = new Map(dbW.map((r) => [r.ext, r]));
const roster = (await sql`SELECT external_id, name FROM users WHERE is_active ORDER BY name`) as any[];
const L = (m: Map<any, any>, k: string) => { const r = m.get(k); return r ? `${r.n}/${r.over2}` : "0/0"; };
let out = `HARVEST RECONCILIATION ${new Date().toISOString()} (window 2026-09-14T04:00Z -> now)\n`;
out += `RUN: list_requests=${run.list_requests} convs_listed=${run.conversations_listed} visits=${run.visits_done} calls=${run.calls_found} msgs=${run.messages_scanned} stopped=${run.stopped_reason ?? "running"}\n`;
out += `COVERAGE (conversations with last activity in window, visited = message-visited):\n`;
out += `  prev week 9/14-9/20 ET: listed=${covPrev.total} visited=${covPrev.visited} coverage=${pct(covPrev.visited, covPrev.total)}\n`;
out += `  WTD 9/21-9/26 ET:       listed=${covWtd.total} visited=${covWtd.visited} coverage=${pct(covWtd.visited, covWtd.total)}\n`;
out += `  9/25 ET:                listed=${covY.total} visited=${covY.visited} coverage=${pct(covY.visited, covY.total)}\n\n`;
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
if (process.argv.includes("--matrix")) {
  await runMatrix();
}
await sql.end();

/**
 * FULL PER-DAY MATRIX (--matrix): ledger vs `calls` per rep × per ET day,
 * 2026-09-14 00:00 ET → today (ET). Roster + unassigned + team rows, every
 * cell diffed. Both sides read inside ONE transaction so the snapshot is
 * consistent even while the background sweeper upserts.
 */
async function runMatrix() {
  const etTodayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  // exclusive upper bound = ET midnight AFTER today
  const [ty, tm, td] = etTodayStr.split("-").map(Number);
  const endUtc = new Date(Date.UTC(ty, tm - 1, td + 1, 0, 0, 0) - 4 * 3600_000).toISOString(); // EDT fixed for Sep 2026 window
  const dayList: string[] = [];
  for (let d = new Date(WINDOW_START_DAY + "T00:00:00Z"); d.toISOString().slice(0, 10) <= etTodayStr; d.setUTCDate(d.getUTCDate() + 1)) {
    dayList.push(d.toISOString().slice(0, 10));
  }
  const rosterUsers = (await sql`SELECT external_id, name FROM users WHERE is_active ORDER BY name`) as any[];
  const rosterExts = new Set(rosterUsers.map((u) => u.external_id));

  const { ledRows, dbRows } = await sql.begin("repeatable read", async (tx) => ({
    ledRows: (await tx`SELECT COALESCE(user_external_id,'(none)') ext, to_char(started_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') d, count(*)::int n, SUM(CASE WHEN duration_seconds > 120 THEN 1 ELSE 0 END)::int over2 FROM harvest_calls WHERE started_at >= ${new Date(WINDOW_START_MS).toISOString()} AND started_at < ${endUtc} GROUP BY 1,2`) as any[],
    dbRows: (await tx`SELECT COALESCE(u.external_id, c.provider_rep_external_id, '(none)') ext, to_char(c.started_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') d, count(*)::int n, SUM((c.duration_seconds > 120)::int)::int over2 FROM calls c LEFT JOIN users u ON u.id=c.rep_id WHERE c.provider='highlevel' AND c.started_at >= ${new Date(WINDOW_START_MS).toISOString()} AND c.started_at < ${endUtc} GROUP BY 1,2`) as any[],
  }));

  const lmap = new Map<string, { n: number; over2: number }>();
  for (const r of ledRows) lmap.set(`${r.ext}|${r.d}`, { n: r.n, over2: r.over2 });
  const dmap = new Map<string, { n: number; over2: number }>();
  for (const r of dbRows) dmap.set(`${r.ext}|${r.d}`, { n: r.n, over2: r.over2 });

  // every ext seen on EITHER side (ledger or DB), stable order: roster first, then others
  const allExts = new Set<string>([...ledRows.map((r) => r.ext), ...dbRows.map((r) => r.ext)]);
  const otherExts = [...allExts].filter((e) => !rosterExts.has(e)).sort((a, b) => {
    const sa = sumExt(lmap, a) + sumExt(dmap, a), sb = sumExt(lmap, b) + sumExt(dmap, b);
    return sb - sa || a.localeCompare(b);
  });

  let cells = 0, mismatches = 0;
  const mismatchLines: string[] = [];
  const matrixLines: string[] = [];
  const header =
    `ET day      | ` +
    rosterUsers.map((u: any) => pad(u.name.split(" ")[0], 12)).join(" | ") +
    ` | UNASSIGNED   | TEAM(roster) | verdict`;
  matrixLines.push(header);
  for (const day of dayList) {
    const cells1 = rosterUsers.map((u: any) => {
      const cmp = cmpCell(lmap, dmap, u.external_id, day);
      cells += 1;
      if (!cmp.ok) { mismatches += 1; mismatchLines.push(`${day} ${u.name}: ledger=${cmp.l} db=${cmp.d}`); }
      return pad(cmp.ok ? `${cmp.l}` : `${cmp.l}≠${cmp.d}`, 12);
    });
    // unassigned: sum over non-roster exts (still diffed per ext below)
    let la = 0, lo = 0, da = 0, doo = 0;
    for (const e of otherExts) {
      const cmp = cmpCell(lmap, dmap, e, day);
      cells += 1;
      if (!cmp.ok) { mismatches += 1; mismatchLines.push(`${day} ${e}: ledger=${cmp.l} db=${cmp.d}`); }
      la += cmp.l.n; lo += cmp.l.over2; da += cmp.d.n; doo += cmp.d.over2;
    }
    const teamL = rosterUsers.reduce((s: number, u: any) => s + (lmap.get(`${u.external_id}|${day}`)?.n ?? 0), 0);
    const teamO = rosterUsers.reduce((s: number, u: any) => s + (lmap.get(`${u.external_id}|${day}`)?.over2 ?? 0), 0);
    const teamD = rosterUsers.reduce((s: number, u: any) => s + (dmap.get(`${u.external_id}|${day}`)?.n ?? 0), 0);
    const teamOD = rosterUsers.reduce((s: number, u: any) => s + (dmap.get(`${u.external_id}|${day}`)?.over2 ?? 0), 0);
    const unOk = la === da && lo === doo;
    const teamOk = teamL === teamD && teamO === teamOD;
    if (!unOk) { mismatches += 1; mismatchLines.push(`${day} UNASSIGNED: ledger=${la}/${lo} db=${da}/${doo}`); }
    if (!teamOk) { mismatches += 1; mismatchLines.push(`${day} TEAM: ledger=${teamL}/${teamO} db=${teamD}/${teamOD}`); }
    const unTxt = unOk ? `${la}/${lo}` : `${la}/${lo}≠${da}/${doo}`;
    const teamTxt = teamOk ? `${teamL}/${teamO}` : `${teamL}/${teamO}≠${teamD}/${teamOD}`;
    const dayVerdict = !mismatchLines.some((m) => m.startsWith(day + " ")) ? "OK" : "MISMATCH";
    matrixLines.push(`${day} | ${cells1.join(" | ")} | ${pad(unTxt, 12)} | ${pad(teamTxt, 12)} | ${dayVerdict}`);
  }

  // per-ext totals across the window (roster + unassigned, ledger vs db)
  const totalLines: string[] = [];
  let totOk = 0, totBad = 0;
  for (const e of [...rosterUsers.map((u: any) => u.external_id), ...otherExts]) {
    const nm = rosterUsers.find((u: any) => u.external_id === e)?.name ?? e;
    const ln = sumExt(lmap, e), lo2 = sumOver(lmap, e), dn = sumExt(dmap, e), do2 = sumOver(dmap, e);
    const ok = ln === dn && lo2 === do2;
    ok ? totOk++ : totBad++;
    totalLines.push(`${pad(String(nm), 22)} ledger=${ln}/${lo2}  db=${dn}/${do2}  ${ok ? "OK" : "MISMATCH"}`);
  }

  console.log(`\n===== FULL PER-DAY MATRIX (calls/over-2-min, ledger vs DB, 2026-09-14 → ${etTodayStr} ET) =====`);
  console.log(matrixLines.join("\n"));
  console.log(`\n----- per-ext window totals -----`);
  console.log(totalLines.join("\n"));
  console.log(`\n----- verdict -----`);
  console.log(`cells compared: ${cells} (+ per-day unassigned/team aggregates); mismatches: ${mismatches}`);
  if (mismatchLines.length) console.log(`MISMATCH DETAIL:\n` + mismatchLines.map((m) => `  ${m}`).join("\n"));
  else console.log(`ALL CELLS MATCH — zero unexplained mismatches.`);
  console.log(`ext-level totals: ${totOk} OK, ${totBad} MISMATCH`);
}

const cell = (m: Map<string, { n: number; over2: number }>, e: string, d: string) => m.get(`${e}|${d}`) ?? { n: 0, over2: 0 };
function cmpCell(lm: Map<string, { n: number; over2: number }>, dm: Map<string, { n: number; over2: number }>, e: string, d: string) {
  const l = cell(lm, e, d), dbv = cell(dm, e, d);
  const ok = l.n === dbv.n && l.over2 === dbv.over2;
  return { l, d: dbv, ok, lStr: `${l.n}/${l.over2}`, dStr: `${dbv.n}/${dbv.over2}` };
}
function sumExt(m: Map<string, { n: number; over2: number }>, e: string) {
  let s = 0; for (const [k, v] of m) if (k.startsWith(`${e}|`)) s += v.n; return s;
}
function sumOver(m: Map<string, { n: number; over2: number }>, e: string) {
  let s = 0; for (const [k, v] of m) if (k.startsWith(`${e}|`)) s += v.over2; return s;
}
function pad(s: string, n: number) { return s.length >= n ? s : s + " ".repeat(n - s.length); }
