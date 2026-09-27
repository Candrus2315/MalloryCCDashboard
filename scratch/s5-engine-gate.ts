/**
 * S5 STEP-1 GATE — run the PRODUCTION engine (matchAppointmentsToCalls) with
 * EXACTLY the tick's wiring (computeAndPersistAttributions inputs) over the
 * stored data, tally verdicts, and diff against the stored booking_attributions
 * rows. READ-ONLY: no upserts, no writes of any kind.
 */
import { getStore } from "../src/server/store";
import { appointmentInScope } from "../src/server/metrics/availability";
import { matchAppointmentsToCalls } from "../src/server/metrics/attribution";
import { addDays, etDateStrFromInstant, etDayStartUtc, etToday } from "../src/server/date-logic";

const store = await getStore();
const settings = await store.getSettings();
const today = etToday();
const since = etDayStartUtc(addDays(today, -(30 + Math.max(2, Math.ceil(settings.attribution_window_hours / 24)))));

const [storedAppts, storedCalls, storedContacts, allUsers, existing] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
  store.getAllCallsSince(since),
  store.getContacts(),
  store.getAllUsers(),
  store.getAttributions(),
]);

const appts = storedAppts.filter(
  (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
);

const matches = matchAppointmentsToCalls(
  appts,
  storedCalls,
  storedContacts.map((c) => ({ id: c.id, phone: c.phone, email: c.email })),
  {
    meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
    attribution_window_hours: settings.attribution_window_hours,
    rep_mappings: settings.rep_mappings,
  },
  { today, users: allUsers.map((u) => ({ id: u.id, is_active: u.is_active })) },
);

// tallies
const byStatus: Record<string, number> = {};
const unByReason: Record<string, number> = {};
const attrByMethod: Record<string, number> = {};
for (const m of matches) {
  byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
  if (m.status === "unattributed") {
    const r = m.reason ?? "NO-REASON";
    unByReason[r] = (unByReason[r] ?? 0) + 1;
  } else {
    const mm = m.method ?? "NO-METHOD";
    attrByMethod[mm] = (attrByMethod[mm] ?? 0) + 1;
  }
}

// diff vs stored rows
const storedByAppt = new Map(existing.map((r) => [r.appointment_id, r]));
const engineById = new Map(matches.map((m) => [m.appointmentId, m]));
const diff: Array<Record<string, unknown>> = [];
for (const m of matches) {
  const s = storedByAppt.get(m.appointmentId);
  const storedAttr = s && s.method !== "none";
  const engineAttr = m.status === "attributed";
  if (storedAttr !== engineAttr) {
    diff.push({
      appointmentId: m.appointmentId,
      engine: { status: m.status, method: m.method, reason: m.reason, repId: m.repId ?? null, callExternalId: m.callExternalId ?? null },
      stored: s ? { method: s.method, rep_id: s.rep_id, note: (s.note ?? "").slice(0, 120) } : null,
    });
  }
}

const out = {
  today,
  scopeCounts: { storedAppts: storedAppts.length, inScopeNonCancelled: appts.length, storedCalls: storedCalls.length, storedAttrRows: existing.length },
  settingsUsed: {
    meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
    attribution_window_hours: settings.attribution_window_hours,
    rep_mappings: settings.rep_mappings,
    activeRoster: allUsers.filter((u) => u.is_active).map((u) => `${u.name}:${u.external_id}`),
  },
  engineVerdicts: { byStatus, unattributedByReason: unByReason, attributedByMethod: attrByMethod },
  storedTable: {
    methodAttributed: existing.filter((r) => r.method !== "none").length,
    repSet: existing.filter((r) => r.rep_id != null).length,
  },
  diffCount: diff.length,
  diffSample: diff.slice(0, 6),
  _allDiff: diff,
};
await Bun.write("scratch/s5-engine-gate.json", JSON.stringify(out, null, 2));
const { _allDiff, ...report } = out;
console.log(JSON.stringify(report, null, 2));
process.exit(0);
