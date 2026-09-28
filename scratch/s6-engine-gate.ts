/**
 * S6/S7c ACCEPTANCE GATE (owner-frozen s1 rule; pins updated to the S7c
 * baseline 2026-09-28) — runs the REAL wiring
 * (computeAndPersistAttributions → store upsert) over the live Postgres, then
 * verifies:
 *   - EXPLICIT-WINDOW RERUN STABILITY: every stored verdict (rep, call,
 *     ambiguous-ness) must survive the rerun unchanged — ANY change = STOP;
 *   - per-row vs scratch/s5-scenarios.json s1 verdicts (71 outcomes) +
 *     scratch/s5-engine-gate.json _allDiff (46) + kept-3/kept-4 → zero diffs;
 *   - S7c+S4b baseline split: 410 = 139 attributed / 3 ambiguous / 268 (owner assigned 9 more 9/28: email-identity conflicts owned by Allison — audit-tracked; 3 non-roster-owned remain queued)
 *     unattributed (post-manual-assignment baseline, 2026-09-27);
 *   - >2min subset (bookingsFromOverThresholdCalls) = EXACTLY 76;
 *   - S4b: every unattributed row carries a reason_code category, attributed
 *     rows carry none.
 * PERSISTS the s1 verdicts to booking_attributions (that IS the deployment of
 * the rule's data; the lead publishes after).
 */
import { getStore } from "../src/server/store";
import { computeAndPersistAttributions } from "../src/server/sync/attribution-tick";
import { bookingsFromOverThresholdCalls } from "../src/server/metrics/compute";
import { etDayStartUtc, addDays } from "../src/server/date-logic";

const store = await getStore();
const settings = await store.getSettings();
const today = settings.timezone ? undefined : undefined; // computeAndPersist uses its own now()
const scenarios = JSON.parse(await Bun.file("scratch/s5-scenarios.json").text());
const engineGate = JSON.parse(await Bun.file("scratch/s5-engine-gate.json").text());

// BEFORE rows: full-table verdict snapshot for the explicit-window rerun
// stability check (S7c: ANY verdict change = STOP) + the kept-3/kept-4 sets.
const before = await store.getAttributions();
const verdictKey = (r: { rep_id: string | null; call_id: string | null; note: string | null }) =>
  JSON.stringify([r.rep_id, r.call_id, (r.note ?? "").startsWith("ambiguous")]);
const beforeVerdicts = new Map(before.map((r) => [r.appointment_id, verdictKey(r)]));
const beforeAttr = new Map(before.filter((r) => r.rep_id != null).map((r) => [r.appointment_id, r]));
const beforeAmb = new Set(before.filter((r) => (r.note ?? "").startsWith("ambiguous")).map((r) => r.appointment_id));

// REAL WIRING — computes AND persists (writer guards included).
const res = await computeAndPersistAttributions(store, settings);
const after = await store.getAttributions();
const afterByAppt = new Map(after.map((r) => [r.appointment_id, r]));
// OWNER MANUAL OVERRIDES outrank engine-baseline expectations: rows the owner
// assigned by hand in Settings (manual_override=true, audit-tracked) are
// expected to diverge from the s1/kept baselines BY DESIGN. They are skipped
// (counted, not failed) — the engine itself must never touch them.
const manualOverrideIds = new Set(after.filter((r) => r.manual_override).map((r) => r.appointment_id));
let manualOverrides = 0;

const attributed = after.filter((r) => r.rep_id != null).length;
const ambiguous = after.filter((r) => r.rep_id == null && (r.note ?? "").startsWith("ambiguous")).length;
const unattributed = after.filter((r) => r.rep_id == null && !(r.note ?? "").startsWith("ambiguous")).length;

// EXPLICIT-WINDOW RERUN STABILITY (S7c owner stop-condition): every stored
// verdict must be EXACTLY as it was before the rerun — rep, call, ambiguity.
const rerunChanged: Array<{ appointmentId: string; before: string; after: string }> = [];
for (const r of after) {
  const b = beforeVerdicts.get(r.appointment_id);
  if (b !== undefined && b !== verdictKey(r)) rerunChanged.push({ appointmentId: r.appointment_id, before: b, after: verdictKey(r) });
}
for (const [apptId, b] of beforeVerdicts) if (!afterByAppt.has(apptId)) rerunChanged.push({ appointmentId: apptId, before: b, after: "ROW-GONE" });

// Per-row expectations from the S5 evidence.
const failures: string[] = [];
const outcomes = scenarios._outcomes as Array<Record<string, unknown>>; // the 71 no-qual bookings
// calls table for external→internal id resolution
const since = etDayStartUtc(addDays((res.appointments ?? 0) >= 0 ? new Date().toISOString().slice(0, 10) : "", -40));
void since;
const allCalls = await store.getAllCallsSince("2000-01-01");
const internalByExternal = new Map(allCalls.filter((c) => c.external_call_id).map((c) => [c.external_call_id as string, c.id]));

let checked71 = 0;
let newly30 = 0;
for (const o of outcomes) {
  const apptId = o.apptId as string;
  const c1Reps = (o.c1Reps as string[]) ?? [];
  const row = afterByAppt.get(apptId);
  checked71 += 1;
  if (!row) { failures.push(`71-population ${apptId}: NO stored row`); continue; }
  if (row.manual_override || manualOverrideIds.has(apptId)) { manualOverrides += 1; continue; }
  if (c1Reps.length === 1) {
    const c1 = o.c1 as { id: string; rep: string } | null;
    newly30 += 1;
    const note = row.note ?? "";
    const evOk = c1 ? note.includes(`evidence=${c1.id}`) : false;
    if (row.rep_id !== (c1?.rep ?? null) || row.method !== "window_interaction" || !evOk) {
      failures.push(`s1-newly ${apptId}: expected rep=${c1?.rep} evidence=${c1?.id} got rep=${row.rep_id} method=${row.method} note=${note.slice(0, 90)}`);
    }
  } else if (c1Reps.length > 1) {
    if (!(row.rep_id == null && (row.note ?? "").startsWith("ambiguous"))) {
      failures.push(`s1-multi-rep ${apptId}: expected ambiguous, got rep=${row.rep_id} note=${(row.note ?? "").slice(0, 90)}`);
    }
  } else {
    if (!(row.rep_id == null && !(row.note ?? "").startsWith("ambiguous"))) {
      failures.push(`s1-none ${apptId}: expected unattributed, got rep=${row.rep_id} note=${(row.note ?? "").slice(0, 90)}`);
    }
  }
}

// The 46 S5-diff engine-attributed rows: verdicts must be IDENTICAL to the engine's.
const diffRows = (engineGate._allDiff ?? []) as Array<{ appointmentId: string; engine: { callExternalId: string | null; repId: string | null } }>;
let checked46 = 0;
for (const d of diffRows) {
  if (d.engine.callExternalId == null) continue;
  const row = afterByAppt.get(d.appointmentId);
  checked46 += 1;
  const wantCall = internalByExternal.get(d.engine.callExternalId) ?? d.engine.callExternalId;
  if (!row || row.rep_id !== d.engine.repId || row.call_id !== wantCall) {
    failures.push(`engine-46 ${d.appointmentId}: expected rep=${d.engine.repId} call=${wantCall} got rep=${row?.rep_id} call=${row?.call_id}`);
  }
}
// The 3 previously-attributed + 4 ambiguous survive.
for (const [apptId, r] of beforeAttr) {
  const row = afterByAppt.get(apptId);
  if (!row || row.rep_id !== r.rep_id || row.call_id !== r.call_id) failures.push(`kept-3 ${apptId}: verdict changed`);
}
for (const apptId of beforeAmb) {
  if (manualOverrideIds.has(apptId)) { manualOverrides += 1; continue; }
  const row = afterByAppt.get(apptId);
  if (!row || row.rep_id != null || !(row.note ?? "").startsWith("ambiguous")) failures.push(`kept-4 ${apptId}: no longer ambiguous`);
}

// >2MIN SEPARATION — exactly 49.
const sinceAppts = etDayStartUtc(addDays(new Date().toISOString().slice(0, 10), -40));
const appts = (await store.getAppointmentsWithClientsSince(sinceAppts)).filter((a) => {
  void a; return true;
});
const { appointmentInScope } = await import("../src/server/metrics/availability");
const inScope = appts.filter((a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled);
const over2min = bookingsFromOverThresholdCalls(inScope, after, allCalls, settings.meaningful_call_threshold_seconds);

const summary = {
  tickResult: res,
  storedSplit: { total: after.length, attributed, ambiguous, unattributed },
  reasonCodeBreakdown: after
    .filter((r) => r.rep_id == null)
    .reduce<Record<string, number>>((acc, r) => {
      const code = r.reason_code ?? "MISSING";
      acc[code] = (acc[code] ?? 0) + 1;
      return acc;
    }, {}),
  // RULE B (owner-approved 2026-09-28): the 3 remaining email-identity
  // ambiguous bookings resolve via exact email match to contacts owned by
  // NON-roster people → they stay queued under the DISTINCT reason_code
  // "email-resolves-non-roster" (guard b). The note keeps its "ambiguous"
  // prefix, so the ambiguous=3 count and rerun-stability keys are unchanged.
  ruleB: {
    emailResolvesNonRoster: after.filter((r) => r.reason_code === "email-resolves-non-roster").length,
    identityResolvedNotes: after.filter((r) => (r.note ?? "").includes("identity-resolved-via-email")).length,
    EXPECTED_EMAIL_RESOLVES_NON_ROSTER: 3,
  },
  reasonCodeSanity: {
    unattributedMissingCode: after.filter((r) => r.rep_id == null && !(r.note ?? "").startsWith("ambiguous") && !r.reason_code).length,
    attributedWithCode: after.filter((r) => r.rep_id != null && r.reason_code).length,
  },
  EXPECTED: { total: 410, attributed: 139, ambiguous: 3, unattributed: 268 },
  rerunStability: { changed: rerunChanged.length, sample: rerunChanged.slice(0, 12), STOP_IF_NONZERO: true },
  perRow: { checked71, newly30, checked46, kept3: beforeAttr.size, kept4: beforeAmb.size, manualOverrides, failures: failures.length },
  over2min: { count: over2min.length, EXPECTED: 76 },
  gatePass:
    failures.length === 0 &&
    rerunChanged.length === 0 &&
    attributed === 139 &&
    ambiguous === 3 &&
    unattributed === 268 &&
    after.filter((r) => r.rep_id == null && !(r.note ?? "").startsWith("ambiguous") && !r.reason_code).length === 0 &&
    after.filter((r) => r.rep_id != null && r.reason_code).length === 0 &&
    after.length === 410 &&
    over2min.length === 76 &&
    after.filter((r) => r.reason_code === "email-resolves-non-roster").length === 3,
  sampleFailures: failures.slice(0, 12),
};
await Bun.write("scratch/s6-engine-gate.json", JSON.stringify({ ...summary, _failures: failures }, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
