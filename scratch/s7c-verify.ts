/**
 * S7c-FINISH read-only verification v2 (NO persistence — snapshot of CURRENT stored state).
 *  A. stored split   B. old-124 enumeration vs baseline artifacts (S6-gate logic: 71 outcomes
 *     by c1Reps + 46 _allDiff + 4 ambiguous; kept-3 via gate history + rerun before/after)
 *  C. Sep21-27 by-day: stated-offset local date vs created_business_date (non-cancelled only,
 *     the metrics definition)   D. weekly 63   E. >2min   F. -0600 rows
 *  G. ET-vs-stated-date flips   H. precision/source/raw health
 */
import { getStore } from "../src/server/store";
import { bookingsFromOverThresholdCalls } from "../src/server/metrics/compute";
import { appointmentInScope } from "../src/server/metrics/availability";
import { etDayStartUtc, addDays, etDateStrFromInstant } from "../src/server/date-logic";

const scenarios = JSON.parse(await Bun.file("scratch/s5-scenarios.json").text());
const engineGate = JSON.parse(await Bun.file("scratch/s5-engine-gate.json").text());
const attribResults = JSON.parse(await Bun.file("scratch/s5-attrib-results.json").text());
const outcomes = scenarios._outcomes as Array<Record<string, unknown>>; // 71
const diffRows = (engineGate._allDiff ?? []) as Array<{ appointmentId: string; engine: { callExternalId: string | null; repId: string | null } }>; // 46
const amb4 = attribResults.fourCurrentlyAmbiguousBecome as Array<{ acuityId: string }>;

const store = await getStore();
const settings = await store.getSettings();
const [attrs, allCalls, apptsAll] = await Promise.all([
  store.getAttributions(),
  store.getAllCallsSince("2000-01-01"),
  store.getAppointmentsWithClientsSince(etDayStartUtc("2026-08-01")),
]);
const byAppt = new Map(attrs.map((r) => [r.appointment_id, r]));
const apptIdByAcuity = new Map(apptsAll.map((a) => [a.acuity_appointment_id ?? "", a.id]));
const amb4ApptIds = new Set(amb4.map((a) => apptIdByAcuity.get(a.acuityId)).filter((x): x is string => !!x));
const internalByExternal = new Map(allCalls.filter((c) => c.external_call_id).map((c) => [c.external_call_id as string, c.id]));

const verdictOf = (r: { rep_id: string | null; note: string | null } | undefined) =>
  !r ? "MISSING" : r.rep_id != null ? "attributed" : (r.note ?? "").startsWith("ambiguous") ? "ambiguous" : "unattributed";

// ---- B. enumeration: S6-gate logic (owner-verified) ----
const enumRows: Array<{ apptId: string; group: string; expected: string; stored: string; diff: string | null }> = [];
for (const o of outcomes) {
  const apptId = o.apptId as string;
  const c1Reps = (o.c1Reps as string[]) ?? [];
  const c1 = o.c1 as { id: string; rep: string } | null;
  const expected = c1Reps.length === 1 ? "attributed" : c1Reps.length > 1 ? "ambiguous" : "unattributed";
  const row = byAppt.get(apptId);
  const stored = verdictOf(row);
  let diff: string | null = null;
  if (expected === "attributed") {
    if (row?.rep_id !== (c1?.rep ?? null) || row?.method !== "window_interaction" || !(row?.note ?? "").includes(`evidence=${c1?.id}`))
      diff = `want rep=${c1?.rep} evidence=${c1?.id} got rep=${row?.rep_id} method=${row?.method} note=${(row?.note ?? "").slice(0, 80)}`;
  } else if (expected === "ambiguous" && stored !== "ambiguous") diff = `want ambiguous got ${stored} rep=${row?.rep_id}`;
  else if (expected === "unattributed" && stored !== "unattributed") diff = `want unattributed got ${stored} rep=${row?.rep_id}`;
  enumRows.push({ apptId, group: "outcome71", expected, stored, diff });
}
for (const d of diffRows) {
  if (d.engine.callExternalId == null) continue;
  const row = byAppt.get(d.appointmentId);
  const wantCall = internalByExternal.get(d.engine.callExternalId) ?? d.engine.callExternalId;
  const diff = !row || row.rep_id !== d.engine.repId || row.call_id !== wantCall
    ? `want rep=${d.engine.repId} call=${wantCall} got rep=${row?.rep_id} call=${row?.call_id}` : null;
  enumRows.push({ apptId: d.appointmentId, group: "engine46", expected: "attributed", stored: verdictOf(row), diff });
}
for (const apptId of amb4ApptIds) {
  const row = byAppt.get(apptId);
  const diff = !row || row.rep_id != null || !(row.note ?? "").startsWith("ambiguous") ? `want ambiguous got ${verdictOf(row)}` : null;
  enumRows.push({ apptId, group: "kept4", expected: "ambiguous", stored: verdictOf(row), diff });
}
const distinct = new Set(enumRows.map((e) => e.apptId));
const diffs = enumRows.filter((e) => e.diff);
// kept-3 (3 pre-S5 stored window rows outside _allResults): verified row-for-row at the
// S6 and S7 gates (kept3 check, failures=0 both times) and covered by this session's
// full-table before/after rerun diff — not independently enumerable from S5 artifacts.

// ---- A. split ----
const attributed = attrs.filter((r) => r.rep_id != null).length;
const ambiguous = attrs.filter((r) => r.rep_id == null && (r.note ?? "").startsWith("ambiguous")).length;
const unattributed = attrs.filter((r) => r.rep_id == null && !(r.note ?? "").startsWith("ambiguous")).length;

// ---- C/D/F/G/H — metrics definition: non-cancelled only (isBooking), NO calendar scope ----
const localDateOfSource = (src: string | null | undefined): string | null => {
  if (!src) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(src);
  if (iso) return iso[1];
  const cal = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(src.trim());
  if (cal) {
    const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    const m = months[cal[1].toLowerCase()];
    return m ? `${cal[3]}-${String(m).padStart(2, "0")}-${String(Number(cal[2])).padStart(2, "0")}` : null;
  }
  return null;
};
const live = apptsAll.filter((a) => a.status !== "cancelled" && !a.cancelled);
const byDayRaw: Record<string, number> = {};
const byDayCbd: Record<string, number> = {};
for (const a of live) {
  const r = a as unknown as Record<string, unknown>;
  const local = localDateOfSource(r.created_time_source as string | null);
  const cbd = r.created_business_date as string | null;
  if (local && local >= "2026-09-21" && local <= "2026-09-27") byDayRaw[local] = (byDayRaw[local] ?? 0) + 1;
  if (cbd && cbd >= "2026-09-21" && cbd <= "2026-09-27") byDayCbd[cbd] = (byDayCbd[cbd] ?? 0) + 1;
}
const flips: string[] = [];
const offsetCounts: Record<string, number> = {};
const neg6: string[] = [];
const precisionCounts: Record<string, number> = {};
let rawMissing = 0, srcMissing = 0;
for (const a of apptsAll) {
  const r = a as unknown as Record<string, unknown>;
  const src = r.created_time_source as string | null;
  const cbd = r.created_business_date as string | null;
  const prec = (r.created_time_precision as string) ?? "MISSING";
  precisionCounts[prec] = (precisionCounts[prec] ?? 0) + 1;
  if (!r.raw) rawMissing += 1;
  if (!src) srcMissing += 1;
  const local = localDateOfSource(src);
  if (local && cbd && local !== cbd) flips.push(`${a.acuity_appointment_id}: stated ${local} vs ET ${cbd}`);
  const om = /([+-]\d{2}):?(\d{2})$/.exec(src ?? "");
  if (om) {
    const off = `${om[1]}:${om[2]}`;
    offsetCounts[off] = (offsetCounts[off] ?? 0) + 1;
    if (off === "-06:00") neg6.push(`${a.acuity_appointment_id} src="${src}" stated-local=${local} ET=${cbd}`);
  }
}

// ---- E. >2min (gate formula) ----
const today = etDateStrFromInstant(Date.now());
const inScope40 = apptsAll.filter((a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled);
const over2 = bookingsFromOverThresholdCalls(inScope40, attrs, allCalls, settings.meaningful_call_threshold_seconds);

const out = {
  storedSplit: { total: attrs.length, attributed, ambiguous, unattributed },
  enumeration: {
    outcome71: outcomes.length,
    engine46: diffRows.filter((d) => d.engine.callExternalId != null).length,
    kept4: amb4ApptIds.size,
    distinctApptIds: distinct.size,
    expectedAttributed: enumRows.filter((e) => e.expected === "attributed").length,
    expectedAmbiguous: enumRows.filter((e) => e.expected === "ambiguous").length,
    expectedUnattributed: enumRows.filter((e) => e.expected === "unattributed").length,
    changed: diffs.length,
    changedList: diffs.slice(0, 20),
    kept3Note: "3 pre-S5 stored rows: S6+S7 gate kept3 checks row-for-row (failures=0) + this session's rerun before/after full-table diff",
  },
  byDaySep21_27: { rawStatedOffsetLocalDate: byDayRaw, createdBusinessDate: byDayCbd, weeklyTotal: Object.values(byDayCbd).reduce((a, b) => a + b, 0) },
  flips: { count: flips.length, list: flips.slice(0, 10) },
  offsets: offsetCounts,
  neg6Rows: neg6,
  precision: precisionCounts,
  rawMissing,
  srcMissing,
  over2min: over2.length,
  scope: { live: live.length, today },
};
await Bun.write("scratch/s7c-verify.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
process.exit(0);
