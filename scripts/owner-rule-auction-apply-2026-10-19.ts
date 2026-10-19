/**
 * OWNER RULE RETROACTIVE APPLICATION — owner directive 2026-10-19 (verbatim):
 * "if there is ever any auction bookings it came from Allison, always
 * contribute those to her".
 *
 * Applies the standing auction→Allison rule to ALL-TIME non-cancelled,
 * in-scope auction-genre appointments not already attributed to Allison
 * Wittner — via the ENGINE'S OWN audited persist path (store.upsertAttributions,
 * advisory-locked, degradation-guarded, force for the one-shot reassignment) +
 * manual_overrides audit rows recording each previous owner. NO raw UPDATEs.
 *
 * The standing rule itself lives in the engine (src/server/metrics/
 * attribution.ts OWNER RULE + sync/attribution-tick.ts wiring, writer v5):
 * after this script, every FUTURE auction booking is attributed at sync time
 * with no manual action.
 *
 * Safety:
 *  - Pre-flight: Allison must resolve to EXACTLY ONE active roster user by
 *    name, else the whole run aborts before any write.
 *  - Idempotent: appointments already attributed to Allison are skipped
 *    (any method — manual provenance stays verbatim).
 *  - commission_weekly snapshot before/after: ANY difference is reported as
 *    a hard failure (stored commission rows must never move).
 *  - Out-of-scope / cancelled auction appointments are counted and LEFT
 *    untouched (the engine's population never includes them either).
 *  - Read-back verification after the writes.
 *  - Stamps the attribution writer checkpoint to v5 so the pre-merge v4
 *    writer cannot churn the rule rows back until the new build deploys.
 *
 * Run: bun scripts/owner-rule-auction-apply-2026-10-19.ts
 */
import { readFileSync } from "node:fs";
import { getStore } from "../src/server/store";
import {
  isAuctionSession,
  OWNER_RULE_AUCTION_METHOD,
  OWNER_RULE_AUCTION_NOTE,
  OWNER_RULE_AUCTION_REASON,
  OWNER_RULE_AUCTION_REP_NAME,
} from "../src/server/metrics/attribution";
import { appointmentInScope } from "../src/server/metrics/availability";
import { ATTRIBUTION_WRITER_VERSION, ATTRIBUTION_WRITER_VERSION_KEY } from "../src/server/sync/attribution-tick";
import type { AppointmentRow } from "../src/server/metrics/compute";
import { isBookingWin } from "../src/server/metrics/compute";

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

const isCancelled = (a: AppointmentRow) => Boolean(a.cancelled) || a.status === "cancelled";

const store = await getStore();

// ---- PRE-FLIGHT: resolve the rule rep (exactly one active roster user) ----
const allUsers = await store.getAllUsers();
const matches = allUsers.filter(
  (u) => u.is_active && (u.name ?? "").trim().toLowerCase() === OWNER_RULE_AUCTION_REP_NAME.toLowerCase(),
);
if (matches.length !== 1) {
  console.error(`ABORT: expected exactly 1 active roster user named "${OWNER_RULE_AUCTION_REP_NAME}", found ${matches.length}`);
  process.exit(1);
}
const allison = matches[0]!;
console.log(`PRE-FLIGHT OK: rule rep = ${allison.name} (${allison.id})`);

const settings = await store.getSettings();
const appts = await store.getAllAppointmentsSince("1970-01-01T00:00:00Z");
const attributions = await store.getAttributions();
const attrByAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
const usersById = new Map(allUsers.map((u) => [u.id, u]));

const auction = appts.filter((a) => isAuctionSession(a.appointment_type));
const inScope = auction.filter((a) => appointmentInScope(a, settings.acuity) && !isCancelled(a));
const outOfScope = auction.filter((a) => !appointmentInScope(a, settings.acuity));
const cancelled = auction.filter((a) => isCancelled(a) && appointmentInScope(a, settings.acuity));

// Targets: non-cancelled, in-scope, current attribution NOT already Allison.
const targets: { appt: AppointmentRow; prevRep: string | null; prevManual: boolean; prevMethod: string | null }[] = [];
let alreadyAllison = 0;
for (const a of inScope) {
  const attr = attrByAppt.get(a.id);
  if (attr?.rep_id === allison.id) {
    alreadyAllison += 1;
    continue;
  }
  targets.push({
    appt: a,
    prevRep: attr?.rep_id ? usersById.get(attr.rep_id)?.name ?? attr.rep_id : null,
    prevManual: attr?.manual_override ?? false,
    prevMethod: attr?.method ?? null,
  });
}

console.log(`INVENTORY: auction appts all-time=${auction.length} inScopeActive=${inScope.length} outOfScope=${outOfScope.length} cancelled=${cancelled.length}`);
console.log(`  already Allison=${alreadyAllison}  targets for the rule=${targets.length}`);
for (const t of targets) {
  console.log(`  TARGET ${t.appt.id} | ${t.appt.client_name} | ${t.appt.appointment_type} | win=${t.appt.booking_win_business_date ?? "-"} | prev=${t.prevRep ?? "unattributed"} (${t.prevMethod ?? "no row"}, manual=${t.prevManual})`);
}

// ---- SNAPSHOT: stored commission rows (must NOT move) + live win ownership ----
const commissionBefore = await store.getCommissionWeeklyRecords();
const winsBefore = countWinsByRep(appts, attrByAppt, usersById, allison.id);
console.log("\nWINS-BEFORE (paid wins by current ownership):");
printWinCounts(winsBefore);

// ---- APPLY via the engine's audited persist path ----
const ruleRows = targets.map((t) => ({
  id: `attr:${t.appt.id}`,
  appointment_id: t.appt.id,
  call_id: null,
  rep_id: allison.id,
  method: OWNER_RULE_AUCTION_METHOD,
  confidence: 1,
  manual_override: false,
  note: OWNER_RULE_AUCTION_NOTE,
  reason_code: OWNER_RULE_AUCTION_REASON,
}));
if (ruleRows.length > 0) {
  const written = await store.upsertAttributions(ruleRows, { force: true });
  console.log(`\nAPPLIED: ${written} owner-rule row(s) written via store.upsertAttributions(force)`);
  // Audit trail (manual_overrides) for every change — EXCEPT manual-override
  // flips, which the persist layer already audited in-transaction (avoid dupes).
  let audited = 0;
  for (const t of targets) {
    if (t.prevManual) continue;
    await store.insertManualOverride({
      entity_type: "booking_attribution",
      entity_id: t.appt.id,
      field: "rep",
      previous_value: t.prevRep ?? "unattributed",
      new_value: allison.name,
      changed_by: "owner-rule-auction-2026-10-19",
    });
    audited += 1;
  }
  console.log(`AUDIT: ${audited} manual_overrides row(s) recorded (changed_by=owner-rule-auction-2026-10-19)`);
} else {
  console.log("\nAPPLIED: 0 targets — nothing to write (idempotent no-op)");
}

// Stamp the writer checkpoint: the rows now on disk carry v5 semantics; the
// pre-merge v4 writer must refuse (fail-honest error sync_runs) until the new
// build deploys, instead of churning the rule rows back to evidence verdicts.
await store.setSyncCheckpoint(ATTRIBUTION_WRITER_VERSION_KEY, String(ATTRIBUTION_WRITER_VERSION));
console.log(`WRITER CHECKPOINT stamped: ${ATTRIBUTION_WRITER_VERSION_KEY}=${ATTRIBUTION_WRITER_VERSION}`);

// ---- VERIFY: read-back ----
const attributionsAfter = await store.getAttributions();
const attrAfterByAppt = new Map(attributionsAfter.map((a) => [a.appointment_id, a]));
let stillNotAllison = 0;
for (const a of inScope) {
  const attr = attrAfterByAppt.get(a.id);
  if (attr?.rep_id !== allison.id) {
    stillNotAllison += 1;
    console.error(`  VERIFY-FAIL ${a.id} ${a.client_name}: rep=${attr?.rep_id ?? "none"} method=${attr?.method ?? "none"}`);
  }
}
const commissionAfter = await store.getCommissionWeeklyRecords();
const commissionDelta = JSON.stringify(commissionBefore) !== JSON.stringify(commissionAfter);
const winsAfter = countWinsByRep(appts, attrAfterByAppt, usersById, allison.id);

console.log("\n=== VERIFICATION ===");
console.log(`  non-cancelled in-scope auction appts: ${inScope.length}`);
console.log(`  still not Allison: ${stillNotAllison}  ${stillNotAllison === 0 ? "— PASS" : "— FAIL"}`);
console.log(`  commission_weekly rows before=${commissionBefore.length} after=${commissionAfter.length} delta=${commissionDelta} ${commissionDelta ? "— FAIL" : "— PASS (untouched)"}`);
console.log("\nWINS-AFTER (paid wins by ownership):");
printWinCounts(winsAfter);
const ruleRowsOnDisk = attributionsAfter.filter((a) => a.method === OWNER_RULE_AUCTION_METHOD).length;
console.log(`  owner-rule rows on disk: ${ruleRowsOnDisk}`);

if (stillNotAllison > 0 || commissionDelta) {
  console.error("RESULT: FAIL — see VERIFY-FAIL lines above");
  process.exit(1);
}
console.log("RESULT: PASS — owner directive applied, stored commission rows untouched");

// ---- helpers ----
function countWinsByRep(
  appts: AppointmentRow[],
  attrByAppt: Map<string, { rep_id: string | null }>,
  usersById: Map<string, { name: string }>,
  allisonId: string,
): { allison: number; other: number; unattributed: number; total: number } {
  // A booking win = the engine's canonical isBookingWin predicate
  // (paid-deposit booking) — exactly what the live per-rep views count.
  void usersById;
  let allison = 0;
  let other = 0;
  let unattributed = 0;
  let total = 0;
  for (const a of appts) {
    if (!isAuctionSession(a.appointment_type)) continue;
    if (isCancelled(a) || !isBookingWin(a)) continue;
    total += 1;
    const rep = attrByAppt.get(a.id)?.rep_id ?? null;
    if (rep === allisonId) allison += 1;
    else if (rep) other += 1;
    else unattributed += 1;
  }
  return { allison, other, unattributed, total };
}

function printWinCounts(c: { allison: number; other: number; unattributed: number; total: number }): void {
  console.log(`  allison=${c.allison} otherRep=${c.other} unattributed=${c.unattributed} totalAuctionWins=${c.total}`);
}
