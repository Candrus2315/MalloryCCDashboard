/**
 * COMMISSION DATA FIX — FINAL STEP (owner decision 2026-10-02).
 *
 * Applies 9 owner-directed manual attributions (of the 10 unattributed W1/W2
 * paid Booking Wins) to Allison Wittner via the EXISTING audited manual path:
 * `assignAttributionCore` (booking_attributions method='manual',
 * manual_override=true + manual_overrides audit rows for rep + note — the same
 * mechanism as the 17 previously existing manual rows). NO side channel.
 *
 * The 10th unattributed win (Jackie LaVerde 2026-08-31) is deliberately NOT
 * touched: nearest activity is a Carmine voicemail + inactive-rep calls —
 * flagged to the owner as possibly Carmine's, awaiting their word.
 *
 * Safety:
 *  - Pre-flight: every target must match its expected client name, win date,
 *    and paid state EXACTLY, else the whole run aborts before any write.
 *  - A target already manually attributed to Allison is skipped (idempotent
 *    re-runs); anything else already attributed is an ABORT, never a takeover.
 *  - Read-back verification after the writes.
 *
 * Run: bun scripts/commission-apply-owner-attributions.ts
 */
import { readFileSync } from "node:fs";
import { getStore } from "../src/server/store";
import { assignAttributionCore } from "../src/server/queries";
// env secrets may reach /proc/self/environ with odd casing; canonicalize before use.
const envOf = (k: string): string => {
  const m = readFileSync("/proc/self/environ", "utf8").split("\0").find((s) => s.toLowerCase().startsWith(k.toLowerCase() + "="));
  return m ? m.slice(k.length + 1) : "";
};
for (const canon of ["DATABASE_URL"] as const) {
  if (!process.env[canon]) {
    const v = envOf(canon);
    if (v) process.env[canon] = v;
  }
}

const NOTE_PREFIX =
  "Owner-directed manual attribution 2026-10-02; owner payroll totals 35/42/46/47; per-record review of complete GHL history; evidence: ";

/** The 9 owner-directed attributions (appointment ids from the step-4 probe). */
const TARGETS: { apptId: string; name: string; winDate: string; evidence: string }[] = [
  // W1 (5)
  { apptId: "bef3fd03-462e-4387-8b05-d4ea051aa715", name: "Jean Ciannavei", winDate: "2026-09-01", evidence: "roster-rep calls 09-02 10:48 + 10:49, one day past window edge" },
  { apptId: "d4a6eb61-a61a-4932-9499-66621283a560", name: "Bridge Galilee", winDate: "2026-09-03", evidence: "in-window call, non-roster rep" },
  { apptId: "98d9d3ec-37e0-4703-8e0b-d3253f70716e", name: "Jared Hanson", winDate: "2026-09-04", evidence: "roster-rep call 09-01 15:26, pre-window" },
  { apptId: "53d0dbfb-956c-4da0-97ef-2d9b11a5833a", name: "Karen Berube", winDate: "2026-09-04", evidence: "in-window call, non-roster rep" },
  { apptId: "60b3d548-23c7-4498-b0cf-63ae0402b58a", name: "Samantha Matthews", winDate: "2026-09-05", evidence: "in-window call, non-roster rep" },
  // W2 (4)
  { apptId: "c843c48f-8297-4557-b7c1-0f5c9470230c", name: "Samantha Rivera", winDate: "2026-09-08", evidence: "no in-window call on record" },
  { apptId: "9a2bfb23-5b22-4762-832d-c4801a12a4c7", name: "Wendy Crocker", winDate: "2026-09-09", evidence: "no in-window call on record" },
  { apptId: "942c8856-d0f4-4e0a-989d-8f6bf5e9d7dc", name: "Leah Balenger", winDate: "2026-09-10", evidence: "roster-rep calls 09-07/09-08, pre-window" },
  { apptId: "71c7f382-1801-4523-90ff-115f0f179a81", name: "Lynn Adams", winDate: "2026-09-12", evidence: "roster-rep call 09-10, pre-window" },
];

const store = (await getStore()) as any;
if (store.mode !== "postgres") {
  console.error("FATAL: postgres store unavailable — the audited manual path needs the real database.");
  process.exit(1);
}

const allison = ((await store.getUsers()) as any[]).find((u) => u.name === "Allison Wittner" && u.is_active);
if (!allison) {
  console.error("FATAL: Allison Wittner not found / not an active roster rep — aborting.");
  process.exit(1);
}

// ---- PRE-FLIGHT VALIDATION (no writes until every target checks out) ----
const appts = (await store.getAppointmentsWithClientsSince(new Date(Date.parse("2026-08-30T04:00:00.000Z")).toISOString())) as any[];
const apptById = new Map<string, any>();
for (const a of appts) apptById.set(String(a.id ?? a.appointment_id), a);
const attributions = (await store.getAttributions()) as any[];
const attrByAppt = new Map<string, any>();
for (const a of attributions) attrByAppt.set(a.appointment_id, a);

const failures: string[] = [];
const ready: { apptId: string; note: string; skip: boolean }[] = [];
for (const t of TARGETS) {
  const a = apptById.get(t.apptId);
  if (!a) { failures.push(`${t.name} ${t.winDate}: appointment not found in window`); continue; }
  const aName = String(a.client_name ?? "").trim();
  const aWin = a.booking_win_business_date ? String(a.booking_win_business_date).slice(0, 10) : "";
  if (aName.toLowerCase() !== t.name.toLowerCase()) { failures.push(`${t.apptId}: client_name mismatch — expected "${t.name}", stored "${aName}"`); continue; }
  if (aWin !== t.winDate) { failures.push(`${t.name}: booking_win_business_date mismatch — expected ${t.winDate}, stored ${aWin}`); continue; }
  if (a.payment_state !== "paid") { failures.push(`${t.name}: payment_state=${a.payment_state}, expected paid`); continue; }
  const prev = attrByAppt.get(t.apptId);
  if (prev) {
    if (prev.manual_override && prev.rep_id === allison.id) { ready.push({ apptId: t.apptId, note: "", skip: true }); continue; }
    if (prev.manual_override) { failures.push(`${t.name}: ALREADY manually attributed to ${prev.rep_id} — refusing takeover, abort run`); continue; }
    if (prev.rep_id && prev.rep_id !== allison.id) { failures.push(`${t.name}: engine-attributed to ${prev.rep_id} — refusing takeover, abort run`); continue; }
  }
  ready.push({ apptId: t.apptId, note: NOTE_PREFIX + t.evidence, skip: false });
}
if (failures.length) {
  console.error("PRE-FLIGHT FAILED — NOTHING WRITTEN. Mismatches:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
if (ready.length !== TARGETS.length) {
  console.error(`PRE-FLIGHT arithmetic failure: ${ready.length}/${TARGETS.length} ready — aborting.`);
  process.exit(1);
}
console.log(`Pre-flight OK: ${TARGETS.length} targets verified (name + win date + paid state).`);

// ---- WRITES ----
let written = 0, skipped = 0;
for (const t of TARGETS) {
  const r = ready.find((x) => x.apptId === t.apptId)!;
  if (r.skip) { skipped++; console.log(`SKIP (already manual → Allison Wittner): ${t.name} ${t.winDate}`); continue; }
  await assignAttributionCore(store, { appointmentId: t.apptId, repId: allison.id, note: r.note });
  written++;
  console.log(`ASSIGNED ${t.name} ${t.winDate} → Allison Wittner (method=manual, audited)`);
}
console.log(`\nwrites=${written} skipped=${skipped}`);

// ---- READ-BACK VERIFICATION ----
const after = (await store.getAttributions()) as any[];
const afterByAppt = new Map<string, any>();
for (const a of after) afterByAppt.set(a.appointment_id, a);
let ok = 0;
for (const t of TARGETS) {
  const a = afterByAppt.get(t.apptId);
  const good = a && a.manual_override && a.method === "manual" && a.rep_id === allison.id;
  if (good) ok++;
  else console.error(`VERIFY FAIL: ${t.name} ${t.winDate} — ${a ? `method=${a.method} manual=${a.manual_override} rep=${a.rep_id}` : "no row"}`);
}
console.log(`read-back: ${ok}/${TARGETS.length} now manual → Allison Wittner`);

// Remaining unattributed paid wins in W1/W2 (must be exactly 1: Jackie LaVerde 8/31)
const winDateOf = (id: string): string => {
  const a = apptById.get(id);
  return a?.booking_win_business_date ? String(a.booking_win_business_date).slice(0, 10) : "";
};
const inWindow = (id: string): boolean => {
  const d = winDateOf(id);
  return d >= "2026-08-31" && d <= "2026-09-13";
};
const targetIds = new Set(TARGETS.map((t) => t.apptId));
const remaining = (after as any[]).filter(
  (a) => !targetIds.has(a.appointment_id) && inWindow(a.appointment_id) && !a.rep_id,
);
const remainingNames = remaining.map((a) => `${winDateOf(a.appointment_id)} ${apptById.get(a.appointment_id)?.client_name ?? "?"}`).sort();
console.log(`remaining unattributed W1/W2 target-window rows: ${remaining.length} (expected 1 = Jackie LaVerde 8/31, untouched by design)`);
for (const n of remainingNames) console.log(`  remaining: ${n}`);
process.exit(ok === TARGETS.length ? 0 : 1);
