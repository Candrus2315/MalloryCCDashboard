/**
 * STEP 5 ALL-REPS PROBE (READ-ONLY) — owner per-record review of the written
 * commission cycle "Aug 31 – Sep 27, 2026". Four queries, tables only, zero
 * writes. Weeks (ET, wins dated by booking_win_business_date):
 *   W1 8/31–9/6, W2 9/7–13, W3 9/14–20, W4 9/21–27.
 * Reuses connection setup + windowing from scratch/step3-evidence.ts /
 * step4-probe-unattributed.ts. Run: bun scratch/step5-allreps-probe.ts
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
const envOf = (k: string): string => {
  const m = readFileSync("/proc/self/environ", "utf8").split("\0").find((s) => s.toLowerCase().startsWith(k.toLowerCase() + "="));
  return m ? m.slice(k.length + 1) : "";
};
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = envOf("DATABASE_URL");
let ssl = false;
try {
  const u = new URL(process.env.DATABASE_URL!);
  ssl = u.searchParams.get("sslmode") === null && u.protocol.startsWith("postgres");
} catch {}
const sql = postgres(process.env.DATABASE_URL!, { max: 3, idle_timeout: 20, connect_timeout: 10, ...(ssl ? { ssl: "require" } : {}) });

const normPh = (v: unknown): string => String(v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const addDay = (d: string, n: number): string => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v ?? "");
const unwrap = (r: unknown): Record<string, unknown> | null => {
  let raw: unknown = r;
  for (let i = 0; typeof raw === "string" && i < 5; i++) { try { raw = JSON.parse(raw); } catch { raw = null; break; } }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
};

try {
  // ---------- context: roster ----------
  const users = (await sql`SELECT id::text AS id, external_id, name, is_active FROM users ORDER BY name`) as Row[];
  console.log("=== USERS (roster context) ===");
  for (const u of users) console.log(`${u.name} | ext=${s(u.external_id).slice(0, 12)} | active=${u.is_active}`);
  const rep = (pat: string) => users.find((u) => new RegExp(pat, "i").test(s(u.name))) ?? null;
  const jen = rep("Jennifer\\s+Stitt"), carmine = rep("Carmine\\s+Morgano"), laura = rep("Laura\\s+Rivera");
  console.log(`resolved reps: jen=${s(jen?.id).slice(0, 8)} carmine=${s(carmine?.id).slice(0, 8)} laura=${s(laura?.id).slice(0, 8)}\n`);

  // ---------- identity maps (email/phone duplicate contacts) ----------
  const allC = (await sql`SELECT id::text AS id, external_id, email_normalized, phone_normalized FROM contacts WHERE provider='highlevel'`) as Row[];
  const byEmail = new Map<string, Row[]>(), byPhone = new Map<string, Row[]>();
  for (const c of allC) {
    const em = s(c.email_normalized).trim().toLowerCase(), ph = normPh(c.phone_normalized);
    if (em) (byEmail.get(em) ?? byEmail.set(em, []).get(em)!).push(c);
    if (ph.length >= 10) (byPhone.get(ph) ?? byPhone.set(ph, []).get(ph)!).push(c);
  }
  const identityOf = (r: Row): { cids: string[]; exts: string[] } => {
    const cids = new Set<string>(), exts = new Set<string>();
    if (s(r.fk_contact_id)) cids.add(s(r.fk_contact_id));
    if (s(r.fk_ext)) exts.add(s(r.fk_ext));
    const em = s(r.client_email).trim().toLowerCase(), ph = normPh(r.client_phone);
    for (const c of (em ? byEmail.get(em) : undefined) ?? []) { cids.add(s(c.id)); exts.add(s(c.external_id)); }
    for (const c of (ph.length >= 10 ? byPhone.get(ph) : undefined) ?? []) { cids.add(s(c.id)); exts.add(s(c.external_id)); }
    return { cids: [...cids], exts: [...exts] };
  };

  // Carmine call-link sets (Q2 tiers) — built once.
  const carmCallCids = new Set<string>();
  const carmCallByCid = new Map<string, string[]>();
  const carmCallExts = new Set<string>();
  const carmCallByExt = new Map<string, string[]>();
  if (carmine) {
    const cc = (await sql`SELECT to_char(c.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, c.contact_id::text cid FROM calls c WHERE c.rep_id=${carmine.id}::uuid AND c.contact_id IS NOT NULL ORDER BY c.started_at`) as Row[];
    for (const r of cc) { carmCallCids.add(s(r.cid)); (carmCallByCid.get(s(r.cid)) ?? carmCallByCid.set(s(r.cid), []).get(s(r.cid))!).push(s(r.t)); }
    const ch = (await sql`SELECT to_char(h.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, h.contact_external_id ext FROM harvest_calls h WHERE h.user_external_id=${s(carmine.external_id)} AND h.contact_external_id IS NOT NULL ORDER BY h.started_at`) as Row[];
    for (const r of ch) { carmCallExts.add(s(r.ext)); (carmCallByExt.get(s(r.ext)) ?? carmCallByExt.set(s(r.ext), []).get(s(r.ext))!).push(s(r.t)); }
  }

  // ---------- shared credited-win loader + evidence scorer ----------
  interface Win extends Row { score: number; rank: number; ev: string }
  const creditedWins = async (repName: string, from: string, to: string, otherRepCheck: boolean): Promise<Win[]> => {
    const rows = (await sql`
      SELECT a.id::text AS appt_id, a.client_name, a.client_email, a.client_phone,
             to_char(a.appointment_datetime AT TIME ZONE 'America/New_York','MM-DD HH:MI') AS appt_et,
             a.payment_state, a.cancelled, a.status,
             to_char(a.booking_win_business_date,'YYYY-MM-DD') AS win_bd, a.payment_business_date_source AS src,
             to_char(COALESCE(a.created_business_date,(a.created_at AT TIME ZONE 'America/New_York')::date),'YYYY-MM-DD') AS crbd,
             to_char(a.created_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') AS created_et,
             c.id::text AS fk_contact_id, c.external_id AS fk_ext,
             ba.method, ba.confidence, ba.manual_override, ba.note, ba.reason_code, ba.call_id::text AS call_id, u.name AS rep_name
      FROM appointments a
      JOIN booking_attributions ba ON ba.appointment_id = a.id
      JOIN users u ON u.id = ba.rep_id
      LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.payment_state='paid' AND a.cancelled = false
        AND a.booking_win_business_date BETWEEN ${from} AND ${to}
        AND ba.method <> 'none' AND u.name = ${repName}
      ORDER BY a.booking_win_business_date, a.client_name`) as Row[];
    const out: Win[] = [];
    for (const r of rows) {
      const { cids, exts } = identityOf(r);
      const crbd = s(r.crbd), wFrom = addDay(crbd, -1), wTo = crbd;
      const midTs = `${crbd} 12:00:00`;
      const parts: string[] = [];
      let score = 0;
      let nearDist = Infinity, nearLine = "";
      let durPen = 0;
      if (s(r.call_id)) {
        const ex = (await sql`SELECT to_char(c.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, to_char((c.started_at AT TIME ZONE 'America/New_York')::date,'YYYY-MM-DD') d, COALESCE(u.name,'?') rep, c.duration_seconds dur, abs(extract(epoch from (c.started_at - ${midTs}::timestamp))) dist FROM calls c LEFT JOIN users u ON u.id=c.rep_id WHERE c.id=${s(r.call_id)}::uuid`) as Row[];
        if (ex.length) {
          const e = ex[0]; parts.push(`attrCall ${e.t}ET ${e.rep} dur=${s(e.dur)}s`);
          if (Number(e.dur) <= 5) durPen = 1;
          if (s(e.d) >= wFrom && s(e.d) <= wTo) score = 5; else score = Math.max(score, 2);
          if (Number(e.dist) < nearDist) { nearDist = Number(e.dist); nearLine = `${e.t}ET ${e.rep}`; }
        }
      }
      if (cids.length) {
        const cw = (await sql`SELECT to_char(c.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, COALESCE(u.name,'?') rep, abs(extract(epoch from (c.started_at - ${midTs}::timestamp))) dist FROM calls c LEFT JOIN users u ON u.id=c.rep_id WHERE c.contact_id IN ${sql(cids)} AND (c.started_at AT TIME ZONE 'America/New_York')::date BETWEEN ${wFrom} AND ${wTo} ORDER BY c.started_at`) as Row[];
        if (cw.length) { parts.push(`calls-in-win: ${cw.map((x) => `${x.t} ${x.rep}`).join(" | ")}`); score = Math.max(score, cw.some((x) => s(x.rep) === s(r.rep_name)) ? 4 : 3); }
        if (!s(r.call_id)) {
          const nc = (await sql`SELECT to_char(c.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, COALESCE(u.name,'?') rep, abs(extract(epoch from (c.started_at - ${midTs}::timestamp))) dist FROM calls c LEFT JOIN users u ON u.id=c.rep_id WHERE c.contact_id IN ${sql(cids)} ORDER BY dist LIMIT 1`) as Row[];
          if (nc.length && Number(nc[0].dist) < nearDist) { nearDist = Number(nc[0].dist); nearLine = `${nc[0].t} ${nc[0].rep}`; }
        }
      }
      if (exts.length) {
        const hw = (await sql`SELECT to_char(h.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, COALESCE(u.name,h.user_external_id,'?') rep, abs(extract(epoch from (h.started_at - ${midTs}::timestamp))) dist FROM harvest_calls h LEFT JOIN users u ON u.provider='highlevel' AND u.external_id=h.user_external_id WHERE h.contact_external_id IN ${sql(exts)} AND (h.started_at AT TIME ZONE 'America/New_York')::date BETWEEN ${wFrom} AND ${wTo} ORDER BY h.started_at`) as Row[];
        if (hw.length) { parts.push(`harvest-in-win: ${hw.map((x) => `${x.t} ${x.rep}`).join(" | ")}`); score = Math.max(score, hw.some((x) => s(x.rep) === s(r.rep_name)) ? 4 : 3); }
        const nh = (await sql`SELECT to_char(h.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, COALESCE(u.name,h.user_external_id,'?') rep, abs(extract(epoch from (h.started_at - ${midTs}::timestamp))) dist FROM harvest_calls h LEFT JOIN users u ON u.provider='highlevel' AND u.external_id=h.user_external_id WHERE h.contact_external_id IN ${sql(exts)} ORDER BY dist LIMIT 1`) as Row[];
        if (nh.length && Number(nh[0].dist) < nearDist) { nearDist = Number(nh[0].dist); nearLine = `${nh[0].t} ${nh[0].rep}`; }
      }
      if (!score) {
        if (nearLine) {
          parts.push(`no-in-window-call; nearest ${nearLine} (${Math.round(nearDist / 3600)}h off mid-window)`);
          score = nearLine.endsWith(s(r.rep_name)) ? 2 : 1;
        }
        parts.push("no call evidence in engine window");
      }
      if (!r.fk_contact_id && !s(r.client_email) && !s(r.client_phone)) score = Math.min(score, 1); // weak identity
      if (otherRepCheck) { // nearest roster call by a DIFFERENT rep (any date)
        let other = "", otherDist = Infinity;
        if (exts.length) {
          const oh = (await sql`SELECT to_char(h.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, COALESCE(u.name,h.user_external_id,'?') rep, abs(extract(epoch from (h.started_at - ${midTs}::timestamp))) dist FROM harvest_calls h LEFT JOIN users u ON u.provider='highlevel' AND u.external_id=h.user_external_id WHERE h.contact_external_id IN ${sql(exts)} AND COALESCE(u.name,'') <> ${s(r.rep_name)} ORDER BY dist LIMIT 1`) as Row[];
          if (oh.length) { other = `${oh[0].rep} ${oh[0].t}`; otherDist = Number(oh[0].dist); }
        }
        if (cids.length) {
          const oc = (await sql`SELECT to_char(c.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t, COALESCE(u.name,'?') rep, abs(extract(epoch from (c.started_at - ${midTs}::timestamp))) dist FROM calls c LEFT JOIN users u ON u.id=c.rep_id WHERE c.contact_id IN ${sql(cids)} AND COALESCE(u.name,'') <> ${s(r.rep_name)} ORDER BY dist LIMIT 1`) as Row[];
          if (oc.length && Number(oc[0].dist) < otherDist) { other = `${oc[0].rep} ${oc[0].t}`; otherDist = Number(oc[0].dist); }
        }
        if (other) parts.push(`otherRep nearest: ${other} (${Math.round(otherDist / 3600)}h off mid-window)`);
      }
      const methodPen = (s(r.method) === "window_interaction" ? 2 : 0) + (Number(r.confidence) < 1 ? 2 : 0) + durPen;
      out.push({ ...r, score, rank: score * 10 - methodPen, ev: parts.join(" || ") });
    }
    return out;
  };

  const printWins = (title: string, expected: number, wins: Win[]) => {
    console.log(`\n=== ${title} ===`);
    console.log(`credited count: ${wins.length} (owner expects ${expected} — ${wins.length === expected ? "MATCH" : "MISMATCH"})`);
    const min = Math.min(...wins.map((w) => w.rank)), max = Math.max(...wins.map((w) => w.rank));
    if (min === max) console.log(`(all rows tie on evidence quality — no single weakest)`);
    wins.forEach((w, i) => {
      const flag = min !== max && w.rank === min ? "  <<< WEAKEST-EVIDENCE" : "";
      console.log(`${i + 1}. ${s(w.appt_id)} | ${s(w.client_name)} | appt ${s(w.appt_et)}ET | pay=${s(w.payment_state)} | cancelled=${s(w.cancelled)} | win=${s(w.win_bd)} (${s(w.src)}) | attr=${s(w.rep_name)}/${s(w.method)} conf=${s(w.confidence)} ovr=${s(w.manual_override)} reason=${s(w.reason_code)} note=${s(w.note) || "-"}`);
      console.log(`   created ${s(w.crbd)} ${s(w.created_et)}ET | evidence score ${w.score}/5 rank=${w.rank}: ${w.ev}${flag}`);
    });
  };

  // ================================================================= Q1
  if (jen) printWins("Q1: JENNIFER STITT — credited W1 wins (2026-08-31..2026-09-06)", 4, await creditedWins(s(jen.name), "2026-08-31", "2026-09-06", true));

  // ================================================================= Q2
  {
    console.log(`\n=== Q2: CARMINE-LINKED bookings, session/creation 9/7–9/13, NOT paid wins in the W2 band ===`);
    const cand = (await sql`
      SELECT a.id::text AS appt_id, a.client_name, a.client_email, a.client_phone, a.raw,
             to_char(a.appointment_datetime AT TIME ZONE 'America/New_York','MM-DD HH:MI') AS sess_et,
             to_char((a.appointment_datetime AT TIME ZONE 'America/New_York')::date,'YYYY-MM-DD') AS sess_d,
             to_char(COALESCE(a.created_business_date,(a.created_at AT TIME ZONE 'America/New_York')::date),'YYYY-MM-DD') AS crbd,
             a.payment_state, a.cancelled, a.status,
             to_char(a.booking_win_business_date,'YYYY-MM-DD') AS win_bd, a.payment_business_date_source AS src,
             COALESCE(ba.method,'no-row') AS m, COALESCE(u.name,'') AS arep,
             a.contact_id::text AS fk_contact_id, c.external_id AS fk_ext, c.assigned_rep_id::text AS assigned_id, cu.name AS assigned_name
      FROM appointments a
      LEFT JOIN booking_attributions ba ON ba.appointment_id = a.id
      LEFT JOIN users u ON u.id = ba.rep_id
      LEFT JOIN contacts c ON c.id = a.contact_id
      LEFT JOIN users cu ON cu.id = c.assigned_rep_id
      WHERE ((a.appointment_datetime AT TIME ZONE 'America/New_York')::date BETWEEN '2026-09-07' AND '2026-09-13')
         OR (COALESCE(a.created_business_date,(a.created_at AT TIME ZONE 'America/New_York')::date) BETWEEN '2026-09-07' AND '2026-09-13')
      ORDER BY a.appointment_datetime`) as Row[];
    const isW2win = (r: Row) => s(r.payment_state) === "paid" && r.cancelled === false && s(r.win_bd) >= "2026-09-07" && s(r.win_bd) <= "2026-09-13";
    const kept: { r: Row; tier: string; ev: string }[] = [];
    for (const r of cand) {
      if (isW2win(r)) continue;
      const { cids, exts } = identityOf(r);
      let tier = "";
      if (carmine && s(r.arep) === s(carmine.name) && s(r.m) !== "no-row" && s(r.m) !== "none") tier = "T1:attributed";
      else if (carmine && s(r.assigned_id) === s(carmine.id)) tier = "T1:contact-assigned";
      else if (cids.some((c) => carmCallCids.has(c))) tier = "T2:carmine-call(calls)";
      else if (exts.some((e) => carmCallExts.has(e))) tier = "T3:carmine-call(harvest)";
      else continue;
      const ev: string[] = [];
      const ccid = cids.flatMap((c) => carmCallByCid.get(c) ?? []);
      const cext = exts.flatMap((e) => carmCallByExt.get(e) ?? []);
      if (ccid.length) ev.push(`carmine calls(calls): ${ccid.slice(0, 12).join(",")}`);
      if (cext.length) ev.push(`carmine calls(harvest): ${cext.slice(0, 12).join(",")}`);
      const raw = unwrap(r.raw);
      const pay = raw ? `raw{paid=${s(raw.paid)}, price=${s(raw.price)}, priceSold=${s(raw.priceSold)}, amountPaid=${s(raw.amountPaid)}, payTs=${s(raw.paymentTimestamp) || "-"}}` : "raw=null";
      kept.push({ r, tier, ev: `${ev.join(" || ") || "no carmine call rows found"}` + ` | ${pay}` });
    }
    console.log(`band appointments scanned: ${cand.length} | non-W2-win kept: ${kept.length} (T1 attributed/assigned, T2 carmine call in calls, T3 carmine call in harvest)`);
    kept.forEach((k, i) => {
      const r = k.r;
      console.log(`${i + 1}. ${s(r.appt_id)} | ${s(r.client_name)} | sess ${s(r.sess_et)}ET (${s(r.sess_d)}) | created ${s(r.crbd)} | status=${s(r.status)} cancelled=${s(r.cancelled)} pay=${s(r.payment_state)} | win=${s(r.win_bd) || "null"} (${s(r.src) || "-"}) | attr=${s(r.arep) || "none"}/${s(r.m)} | assigned=${s(r.assigned_name) || "-"} | ${k.tier}`);
      console.log(`   why-not-W2-win: ${s(r.cancelled) === "true" ? "CANCELLED" : s(r.payment_state) !== "paid" ? `payment_state=${s(r.payment_state)}` : `win date ${s(r.win_bd)} outside band`} | ${k.ev}`);
    });
  }

  // ================================================================= Q3
  if (jen) printWins("Q3: JENNIFER STITT — credited W3 wins (2026-09-14..2026-09-20)", 4, await creditedWins(s(jen.name), "2026-09-14", "2026-09-20", true));

  // ================================================================= Q4
  {
    console.log(`\n=== Q4: W4 (2026-09-21..2026-09-27) — CARMINE's credited wins, then LAURA's, each client's harvested calls by rep ===`);
    const cw4 = carmine ? await creditedWins(s(carmine.name), "2026-09-21", "2026-09-27", true) : [];
    const lw4 = laura ? await creditedWins(s(laura.name), "2026-09-21", "2026-09-27", true) : [];
    let lauraTotalOnCarmineClients = 0, lauraInWindowOnCarmineClients = 0;
    const dumpPerClient = async (w: Win, creditedRep: string, crbd: string) => {
      const { cids, exts } = identityOf(w);
      if (!exts.length) { console.log(`     harvested calls by rep: none (no contact identity)`); return; }
      const all = (await sql`
        SELECT to_char(h.started_at AT TIME ZONE 'America/New_York','MM-DD HH:MI') t,
               to_char((h.started_at AT TIME ZONE 'America/New_York')::date,'YYYY-MM-DD') d,
               COALESCE(u.name,h.user_external_id,'?') rep
        FROM harvest_calls h LEFT JOIN users u ON u.provider='highlevel' AND u.external_id=h.user_external_id
        WHERE h.contact_external_id IN ${sql(exts)} ORDER BY h.started_at`) as Row[];
      const byRep = new Map<string, string[]>();
      for (const r of all) (byRep.get(s(r.rep)) ?? byRep.set(s(r.rep), []).get(s(r.rep))!).push(s(r.t));
      const line = [...byRep.entries()].sort().map(([rp, ts]) => `${rp} ×${ts.length} (${ts.slice(0, 14).join(" ")}${ts.length > 14 ? ` …+${ts.length - 14}` : ""})`).join(" ; ") || "none";
      console.log(`     harvested calls by rep (${all.length} rows): ${line}`);
      if (carmine && creditedRep === s(carmine.name) && laura) {
        const inWin = all.filter((r) => s(r.rep) === s(laura.name) && s(r.d) >= addDay(crbd, -1) && s(r.d) <= crbd);
        if (inWin.length) { lauraInWindowOnCarmineClients += inWin.length; console.log(`     <<< LAURA IN ENGINE WINDOW (${addDay(crbd, -1)}..${crbd}) on this CARMINE-credited client: ${inWin.map((r) => s(r.t)).join(" ")}`); }
        lauraTotalOnCarmineClients += all.filter((r) => s(r.rep) === s(laura.name)).length;
      }
    };
    const w4Flag = (wins: Win[]): ((w: Win) => string) => {
      const min = Math.min(...wins.map((w) => w.rank)), max = Math.max(...wins.map((w) => w.rank));
      if (min === max) { console.log(`(all rows tie on evidence quality — no single weakest)`); return () => ""; }
      return (w: Win) => (w.rank === min ? "  <<< WEAKEST-EVIDENCE" : "");
    };
    console.log(`--- CARMINE MORGANO credited W4 ---`);
    const cFlag = w4Flag(cw4);
    for (const [i, w] of cw4.entries()) {
      console.log(`${i + 1}. ${s(w.appt_id)} | ${s(w.client_name)} | appt ${s(w.appt_et)}ET | pay=${s(w.payment_state)} | cancelled=${s(w.cancelled)} | win=${s(w.win_bd)} (${s(w.src)}) | attr=${s(w.rep_name)}/${s(w.method)} conf=${s(w.confidence)} ovr=${s(w.manual_override)} reason=${s(w.reason_code)} note=${s(w.note) || "-"}`);
      console.log(`   created ${s(w.crbd)} ${s(w.created_et)}ET | evidence score ${w.score}/5 rank=${w.rank}: ${w.ev}${cFlag(w)}`);
      await dumpPerClient(w, s(w.rep_name), s(w.crbd));
    }
    console.log(`--- LAURA RIVERA credited W4 ---`);
    const lFlag = w4Flag(lw4);
    for (const [i, w] of lw4.entries()) {
      console.log(`${i + 1}. ${s(w.appt_id)} | ${s(w.client_name)} | appt ${s(w.appt_et)}ET | pay=${s(w.payment_state)} | cancelled=${s(w.cancelled)} | win=${s(w.win_bd)} (${s(w.src)}) | attr=${s(w.rep_name)}/${s(w.method)} conf=${s(w.confidence)} ovr=${s(w.manual_override)} reason=${s(w.reason_code)} note=${s(w.note) || "-"}`);
      console.log(`   created ${s(w.crbd)} ${s(w.created_et)}ET | evidence score ${w.score}/5 rank=${w.rank}: ${w.ev}${lFlag(w)}`);
      await dumpPerClient(w, s(w.rep_name), s(w.crbd));
    }
    console.log(`SUMMARY: Laura harvested calls on Carmine-credited W4 clients' contacts: ${lauraTotalOnCarmineClients} total, ${lauraInWindowOnCarmineClients} inside the engine attribution window (created date + prior day).`);
  }

  console.log("\n=== END STEP5 PROBE (read-only, no writes) ===");
} catch (e) {
  console.error("PROBE ERROR:", e);
}
await sql.end({ timeout: 3 });
process.exit(0);
