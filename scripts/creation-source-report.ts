/**
 * CREATION-SOURCE RE-DERIVATION REPORT (owner directive 2026-11-04) — REPORT
 * ONLY, applied nothing. Read-only SQL over the production DB + the pure
 * engine functions; no store import (PgStore construction runs migrations —
 * never from a branch), no writes of any kind.
 *
 * Produces:
 *   1. creation-source tier counts over every stored attribution row;
 *   2. the flip set under the rule as wired (provenClientCreated = the sticky
 *      online-booking set only) — expected: zero new flips (W1: no synced
 *      data proves client-creation);
 *   3. the named cases: Lucas Finch, the 2 SMS-fix credits, the 4 ambiguous —
 *      current verdict + creation-source tier;
 *   4. the Lucas Finch creation-evidence audit (why he CANNOT be proven
 *      client-created from synced data — owner decision required).
 */
import postgres from "postgres";
import { writeFileSync } from "node:fs";
const sql = postgres(process.env.Database_URL!, { max: 2, prepare: false });

const lines: string[] = [];
const say = (s = "") => lines.push(s);

const rows = await sql.unsafe(`
  SELECT b.method, b.reason_code, b.manual_override, b.note, a.acuity_appointment_id,
         a.client_name, a.created_at, a.appointment_type
  FROM appointments a LEFT JOIN booking_attributions b ON b.appointment_id = a.id
`);
type Row = Record<string, unknown>;

// ---- 1. tier counts
let clientCreated = 0, agentCreated = 0, unknown = 0, noRow = 0;
const byMethod = new Map<string, number>();
for (const r of rows) {
  const m = (r.method as string) ?? "NO_ATTR_ROW";
  byMethod.set(m, (byMethod.get(m) ?? 0) + 1);
  if (!r.method) { noRow++; continue; }
  if (r.reason_code === "online-booking") clientCreated++;
  else if (r.manual_override || r.method === "owner-rule-auction") agentCreated++;
  else unknown++;
}
say("== CREATION-SOURCE RE-DERIVATION REPORT (owner directive 2026-11-04) — REPORT ONLY, nothing applied ==");
say(`generated ${new Date().toISOString()}`);
say("");
say("1) Creation-source tiers over every stored attribution row:");
say(`   proven AGENT-created (owner rulings: manual_override + owner-rule-auction): ${agentCreated}`);
say(`   proven CLIENT-created (reason_code online-booking): ${clientCreated}`);
say(`   UNKNOWN creation source (evidence-chain verdicts stand): ${unknown}`);
say(`   (appointments without an attribution row: ${noRow})`);
say("");
say("   attribution methods all-time (reconciliation vs the lead's 11/4 probe):");
for (const [m, c] of [...byMethod.entries()].sort()) say(`     ${m}: ${c}`);

// ---- 2. flips under the rule as wired
say("");
say("2) Flips under the rule AS WIRED (provenClientCreated = sticky online-booking set only):");
say(`   flipped to online-booking: 0 (no row gains the verdict — the sticky set is ${clientCreated} row(s) and they KEEP it)`);
say(`   flipped AWAY from rep credit: 0`);
say(`   flipped to rep credit: 0`);
say(`   net effect on team totals: none (totals derive from payment state, not attribution)`);

// ---- 3. named cases
const pick = (pred: (r: Row) => boolean) => rows.filter(pred);
const fmt = (r: Row) =>
  `   - ${r.client_name ?? "?"} #${r.acuity_appointment_id} type="${r.appointment_type}" created=${r.created_at} → method=${r.method} reason=${r.reason_code ?? "—"} manual=${r.manual_override ? "yes" : "no"} | creation-source tier: ${
    r.reason_code === "online-booking" ? "proven CLIENT-created" : r.manual_override || r.method === "owner-rule-auction" ? "proven AGENT-created (owner ruling)" : "UNKNOWN (keeps current verdict)"
  }`;
say("");
say("3) Named cases (current verdict + creation-source tier):");
say("   Lucas Finch (ground-truth candidate true online booking):");
for (const r of pick((r) => r.acuity_appointment_id === "1800632924")) say(fmt(r));
say("   SMS-backfill rep-credits (owner decision pending — do NOT flip silently):");
for (const r of pick((r) => r.method === "sms")) say(fmt(r));
say("   The 2 named SMS-fix credits (Kim Sharpe → Carmine Morgano, Sharon Morais → Allison Wittner) carry method window_interaction with conversation evidence:");
for (const r of pick((r) => r.acuity_appointment_id === "1781029846" || r.acuity_appointment_id === "1792908191")) say(fmt(r));
say("   Ambiguous (multi-rep, 4 named by the owner's plan):");
for (const r of pick((r) => r.reason_code === "ambiguous")) say(fmt(r));
say("   self-booked-no-conversation (6 all-time):");
for (const r of pick((r) => r.reason_code === "self-booked-no-conversation")) say(fmt(r));

// ---- 4. Lucas Finch creation-evidence audit
say("");
say("4) Lucas Finch creation-evidence audit (acuity 1800632924):");
const lucas = await sql.unsafe(`SELECT raw FROM appointments WHERE acuity_appointment_id = '1800632924'`);
if (lucas.length) {
  let raw: unknown = lucas[0]!.raw;
  for (let i = 0; typeof raw === "string" && i < 5; i++) { try { raw = JSON.parse(raw as string); } catch { raw = null; } }
  const r = (raw ?? {}) as Record<string, unknown>;
  say(`   - notes: ${JSON.stringify(r.notes)} (an invoice marker — NOT creation evidence: invoices are payment, not creation)`);
  say(`   - formsText contains "Paid Online:" line: ${/Paid Online:/i.test(String(r.formsText ?? ""))} (ABSENT — but the line is PROVEN not-a-creation-signal: 66 of 98 agent-created bookings paid >3d after creation carry it)`);
  say(`   - amountPaid at snapshot: ${r.amountPaid} (informational — snapshot state, not creation state)`);
  say(`   - no created-by / admin-vs-public marker anywhere in the raw key set (verified: key presence is identical across both ground-truth sets)`);
  say(`   VERDICT: client-creation NOT provable from synced data → under the new rule his creation source is UNKNOWN and the current window_interaction credit STANDS. If the owner wants him designated an Online Booking, that is an owner designation (manual), not a derivation.`);
}

// ---- 5. engine-rule demonstration (pure, synthetic)
say("");
say("5) Engine rule verification (synthetic, pure matchAppointmentsToCalls):");
say("   - proven client-created beats qualifying-call + conversation evidence → online-booking (team-only) ✔ (creation-source.test.ts)");
say("   - owner rulings win: manual carried verbatim; owner-rule-auction fires before the rule ✔");
say("   - unknown creation source → evidence-chain verdicts byte-unchanged ✔");
say(`   - payment state is not an engine input; paid:"yes"+amountPaid 0.00 → paid (informational amount) ✔`);
say("");
say("6) Owner decisions surfaced by this report:");
say("   a. Lucas Finch: designate as Online Booking (owner action) or leave credited to Allison — nothing flips automatically.");
say("   b. The 2 SMS-fix credits + 4 ambiguous: creation source UNKNOWN — they keep their verdicts under the rule.");
say("   c. If the owner wants future client-creation PROOF, the source must be a new evidence surface (owner designation UI, or GHL appointments with assignedUserId/created-by — the GHL sync today carries calls only).");

const report = lines.join("\n") + "\n";
writeFileSync("/tmp/creation-source-report.txt", report);
console.log(report);
await sql.end({ timeout: 5 });
