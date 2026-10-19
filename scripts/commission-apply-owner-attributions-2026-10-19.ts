/**
 * OWNER-DIRECTED MANUAL ATTRIBUTION — owner directive 2026-10-19.
 *
 * Applies 3 owner-directed manual attributions (owner confirms Allison ran
 * these Sat 2026-10-17 sessions) to Allison Wittner via the EXISTING audited
 * manual path: `assignAttributionCore` (booking_attributions method='manual',
 * manual_override=true + manual_overrides audit rows for rep + note — the
 * same mechanism as the 10/2 and 10/6 applications, scripts/
 * commission-apply-owner-attributions.ts). NO side channel, no raw UPDATEs.
 *
 * Targets (held sessions Sat 2026-10-17; deposits paid Jul/Aug → wins of
 * earlier weeks with NO stored commission record — only live held-session
 * views move):
 *   - Mary Krull       — Renewal Certificate — Sat 2026-10-17 1:30pm ET (win 2026-07-15)
 *   - Leah Raymond     — Portrait Session    — Sat 2026-10-17 3:30pm ET (win 2026-07-06)
 *   - Melissa Tgibedes — Portrait Session +  — Sat 2026-10-17 4:30pm ET (win 2026-08-12)
 *
 * Safety (same pattern as the 10/2 script):
 *  - Pre-flight: every target must match its expected client name, session
 *    type, held-session datetime, win date, and paid state EXACTLY, else the
 *    whole run aborts before any write.
 *  - A target already manually attributed to Allison is skipped (idempotent
 *    re-runs); anything else already attributed is an ABORT, never a takeover.
 *  - commission_weekly snapshot before/after — any difference is an abort.
 *  - Read-back verification after the writes.
 *
 * Run: bun scripts/commission-apply-owner-attributions-2026-10-19.ts
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
  "owner directive 2026-10-19 — owner confirms Allison ran these Sat sessions; evidence: ";

/** The 3 owner-directed attributions (appointment ids verified by probe 2026-10-19). */
const TARGETS: {
  apptId: string;
  name: string;
  typePrefix: string;
  datetimeUtc: string;
  winDate: string;
  evidence: string;
}[] = [
  {
    apptId: "2a12f272-2041-48cf-928e-052fc2511231",
    name: "Mary Krull",
    typePrefix: "Renewal Certificate",
    datetimeUtc: "2026-10-17T17:30:00.000Z", // 1:30pm ET (EDT = UTC-4)
    winDate: "2026-07-15",
    evidence: "owner confirms Allison ran the Sat session",
  },
  {
    apptId: "9b85e5f5-eb05-43f0-9890-c70f8f7eec63",
    name: "Leah Raymond",
    typePrefix: "Portrait Session",
    datetimeUtc: "2026-10-17T19:30:00.000Z", // 3:30pm ET
    winDate: "2026-07-06",
    evidence: "owner confirms Allison ran the Sat session",
  },
  {
    apptId: "9714529c-21a2-420f-b367-d337f9f53a28",
    name: "Melissa Tgibedes",
    typePrefix: "Portrait Session +",
    datetimeUtc: "2026-10-17T20:30:00.000Z", // 4:30pm ET
    winDate: "2026-08-12",
    evidence: "owner confirms Allison ran the Sat session",
  },
];

/** Held-session week 2026-10-12..2026-10-18 (Mon 00:00 ET = 04:00Z → next Mon 04:00Z). */
const HELD_WINDOW = { startUtc: "2026-10-12T04:00:00.000Z", endUtc: "2026-10-19T04:00:00.000Z" };
/** The 3 unattributed paid held sessions expected to REMAIN after the writes. */
const REMAIN_EXPECTED = new Set(["sarah chaplin", "cheyenne duquette", "scott lawson"]);

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

// ---- FETCH: all appointments since Fri 2026-10-09 04:00Z (covers the held window) ----
const appts = (await store.getAppointmentsWithClientsSince(new Date(Date.parse("2026-10-09T04:00:00.000Z")).toISOString())) as any[];
const apptById = new Map<string, any>();
for (const a of appts) apptById.set(String(a.id ?? a.appointment_id), a);

// ---- PRE-FLIGHT VALIDATION (no writes until every target checks out) ----
const attributions = (await store.getAttributions()) as any[];
const attrByAppt = new Map<string, any>();
for (const a of attributions) attrByAppt.set(a.appointment_id, a);

const failures: string[] = [];
const ready: { apptId: string; note: string; skip: boolean }[] = [];
for (const t of TARGETS) {
  const a = apptById.get(t.apptId);
  if (!a) { failures.push(`${t.name}: appointment ${t.apptId} not found in window`); continue; }
  const aName = String(a.client_name ?? "").trim();
  const aType = String(a.appointment_type ?? "").trim();
  const aWin = a.booking_win_business_date ? String(a.booking_win_business_date).slice(0, 10) : "";
  const dt = a.appointment_datetime ? new Date(a.appointment_datetime).toISOString() : "";
  if (aName.toLowerCase() !== t.name.toLowerCase()) { failures.push(`${t.apptId}: client_name mismatch — expected "${t.name}", stored "${aName}"`); continue; }
  if (!aType.startsWith(t.typePrefix)) { failures.push(`${t.name}: appointment_type mismatch — expected prefix "${t.typePrefix}", stored "${aType}"`); continue; }
  if (dt !== t.datetimeUtc) { failures.push(`${t.name}: appointment_datetime mismatch — expected ${t.datetimeUtc}, stored ${dt}`); continue; }
  if (aWin !== t.winDate) { failures.push(`${t.name}: booking_win_business_date mismatch — expected ${t.winDate}, stored ${aWin}`); continue; }
  if (a.payment_state !== "paid") { failures.push(`${t.name}: payment_state=${a.payment_state}, expected paid`); continue; }
  if (a.cancelled_at) { failures.push(`${t.name}: cancelled_at=${a.cancelled_at} — refusing to attribute a cancelled session`); continue; }
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
console.log(`Pre-flight OK: ${TARGETS.length} targets verified (name + type + datetime + win date + paid + not cancelled).`);

// ---- HELD-SESSION-WEEK BASELINE: unattributed paid sessions 2026-10-12..2026-10-18 ----
const inHeldWindow = (a: any): boolean => {
  const dt = a.appointment_datetime ? new Date(a.appointment_datetime).toISOString() : "";
  return dt >= HELD_WINDOW.startUtc && dt < HELD_WINDOW.endUtc;
};
const isPaidUncancelled = (a: any): boolean => a.payment_state === "paid" && !a.cancelled_at;
const unattributedHeldBefore = appts.filter(
  (a) => inHeldWindow(a) && isPaidUncancelled(a) && !attrByAppt.get(String(a.id ?? a.appointment_id))?.rep_id,
);
console.log(`held-week 10/12–10/18 unattributed paid sessions BEFORE: ${unattributedHeldBefore.length} (expected 6)`);
for (const a of unattributedHeldBefore) console.log(`  before: ${new Date(a.appointment_datetime).toISOString()} ${a.client_name}`);
if (unattributedHeldBefore.length !== 6) {
  console.error("ABORT: held-week unattributed baseline is not 6 — state drifted since the probe, nothing written.");
  process.exit(1);
}

// ---- SNAPSHOT commission_weekly (FREEZE CHECK — abort if anything moves) ----
const cwSnapshot = async (): Promise<string> =>
  JSON.stringify(
    ((await store.getCommissionWeeklyRecords()) as any[])
      .map((r) => [r.user_id, r.week_start, r.status, r.qualifying_bookings, r.base_commission, r.additional_commission, r.pool_bonus, r.hole_bonus, r.manual_adjustment, r.total, r.hole_audit])
      .sort(),
  );
const cwBefore = await cwSnapshot();

// ---- WRITES (the audited manual path ONLY) ----
let written = 0, skipped = 0;
for (const t of TARGETS) {
  const r = ready.find((x) => x.apptId === t.apptId)!;
  if (r.skip) { skipped++; console.log(`SKIP (already manual → Allison Wittner): ${t.name} ${t.winDate}`); continue; }
  await assignAttributionCore(store, { appointmentId: t.apptId, repId: allison.id, note: r.note });
  written++;
  console.log(`ASSIGNED ${t.name} ${t.winDate} → Allison Wittner (method=manual, manual_override=true, audited)`);
}
console.log(`\nwrites=${written} skipped=${skipped}`);

// ---- FREEZE CHECK: commission_weekly must be identical ----
const cwAfter = await cwSnapshot();
if (cwBefore !== cwAfter) {
  console.error("FATAL: commission_weekly CHANGED during the run — verify manually before proceeding.");
  process.exit(1);
}
console.log("commission_weekly freeze check: PASS (0 rows changed)");

// ---- READ-BACK VERIFICATION ----
const after = (await store.getAttributions()) as any[];
const afterByAppt = new Map<string, any>();
for (const a of after) afterByAppt.set(a.appointment_id, a);
let ok = 0;
for (const t of TARGETS) {
  const a = afterByAppt.get(t.apptId);
  const good = a && a.manual_override && a.method === "manual" && a.rep_id === allison.id;
  if (good) { ok++; console.log(`VERIFIED ${t.name}: method=manual manual_override=true rep_id=${allison.id} (Allison Wittner)`); }
  else console.error(`VERIFY FAIL: ${t.name} ${t.winDate} — ${a ? `method=${a.method} manual=${a.manual_override} rep=${a.rep_id}` : "no attribution row"}`);
}
console.log(`read-back: ${ok}/${TARGETS.length} now manual → Allison Wittner`);

// ---- HELD-SESSION-WEEK AFTER: unattributed paid sessions must drop 6 → 3 ----
const unattributedHeldAfter = appts.filter((a) => {
  if (!inHeldWindow(a) || !isPaidUncancelled(a)) return false;
  const row = afterByAppt.get(String(a.id ?? a.appointment_id));
  return !row || !row.rep_id;
});
const remainNames = new Set(unattributedHeldAfter.map((a) => String(a.client_name ?? "").trim().toLowerCase()));
console.log(`held-week 10/12–10/18 unattributed paid sessions AFTER: ${unattributedHeldAfter.length} (expected 3)`);
for (const a of unattributedHeldAfter) console.log(`  after: ${new Date(a.appointment_datetime).toISOString()} ${a.client_name}`);
const remainOk = unattributedHeldAfter.length === 3 && [...REMAIN_EXPECTED].every((n) => remainNames.has(n)) && remainNames.size === 3;
if (!remainOk) console.error(`VERIFY FAIL: remaining set mismatch — expected exactly {sarah chaplin, Cheyenne Duquette, Scott Lawson}, got {${[...remainNames].join(", ")}}`);
else console.log("remaining unattributed held sessions: PASS (sarah chaplin, Cheyenne Duquette, Scott Lawson — left untouched)");
process.exit(ok === TARGETS.length && remainOk ? 0 : 1);
