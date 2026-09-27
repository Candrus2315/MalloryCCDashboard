/**
 * S4b probe — live classification reconnaissance (read-only).
 * Mirrors computeAndPersistAttributions' engine inputs, groups unattributed
 * reasons, and breaks "no-qualifying-call" down by the signals the engine has:
 *   A = candidate contact ids nonempty? (identity resolution result)
 *   B = in-window interactions of ANY kind for those contacts
 *       (calls any duration w/o resolvable rep, harvest messages any rep)
 *   C = in-window interactions WITH resolvable roster rep (s1) → would have
 *       attributed (sanity — must be empty here)
 * Writes JSON to scratch/s4b-probe.json (terminal mangles output).
 */
import { getStore } from "../src/server/store";
import { matchAppointmentsToCalls, bookingCreationDateEt, attributionWindowDates, callDateEt, type AttributionCall } from "../src/server/metrics/attribution";
import { appointmentInScope } from "../src/server/metrics/availability";
import { buildRosterEligibility, eligibleRepId } from "../src/server/roster";
import { addDays, etDateStrFromInstant, etDayStartUtc } from "../src/server/date-logic";

const store = await getStore();
const settings = await store.getSettings();
const now = new Date();
const today = etDateStrFromInstant(now.getTime());
const since = etDayStartUtc(addDays(today, -(30 + Math.max(2, Math.ceil(settings.attribution_window_hours / 24)))));

const [storedAppts, storedCalls, storedContacts, allUsers, existing, harvestCalls] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
  store.getAllCallsSince(since),
  store.getContacts(),
  store.getAllUsers(),
  store.getAttributions(),
  store.getHarvestCallsSince(since),
]);

const appts = storedAppts.filter(
  (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
);

const activeHlUserByExt = new Map(
  allUsers.filter((u) => u.provider === "highlevel" && u.external_id && u.is_active).map((u) => [u.external_id as string, u.id]),
);
const harvestElig = buildRosterEligibility(
  allUsers.map((u) => ({ id: u.id, is_active: u.is_active })),
  settings.rep_mappings ?? [],
);
const s1Interactions = harvestCalls.map((h) => ({
  id: h.message_id,
  contact_external_id: h.contact_external_id,
  rep_id:
    (h.user_external_id ? activeHlUserByExt.get(h.user_external_id) : undefined) ??
    (h.user_external_id ? harvestElig.mapping.get(h.user_external_id) ?? null : null),
  started_at: h.started_at,
  duration_seconds: h.duration_seconds,
}));

const matches = matchAppointmentsToCalls(
  appts,
  storedCalls,
  storedContacts.map((c) => ({ id: c.id, phone: c.phone, email: c.email, external_id: c.external_id })),
  {
    meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
    attribution_window_hours: settings.attribution_window_hours,
    rep_mappings: settings.rep_mappings,
  },
  { today, users: allUsers.map((u) => ({ id: u.id, is_active: u.is_active })), s1Interactions },
);

// ---- classification signals per unattributed match ----
const users = allUsers.map((u) => ({ id: u.id, is_active: u.is_active }));
const elig = buildRosterEligibility(users, settings.rep_mappings ?? []);
const callsByContact = new Map<string, AttributionCall[]>();
for (const c of storedCalls) {
  if (!c.contact_id) continue;
  const l = callsByContact.get(c.contact_id) ?? [];
  l.push(c);
  callsByContact.set(c.contact_id, l);
}
const harvestAnyByExt = new Map<string, typeof s1Interactions>();
for (const h of s1Interactions) {
  if (!h.contact_external_id) continue;
  const l = harvestAnyByExt.get(h.contact_external_id) ?? [];
  l.push(h);
  harvestAnyByExt.set(h.contact_external_id, l);
}
const contactExtById = new Map(storedContacts.map((c) => [c.id, c.external_id ?? null]));
const storedByAppt = new Map(existing.map((r) => [r.appointment_id, r]));

function classifySignal(match: (typeof matches)[number]) {
  const appt = appts.find((a) => a.id === match.appointmentId)!;
  const anchor = bookingCreationDateEt(appt);
  if (!anchor) return { signal: "no-anchor", windowCallsNoRep: 0, windowHarvest: 0, candidateIds: 0 };
  const w = attributionWindowDates(anchor.date);
  // candidate ids: recompute the union the engine would use (contact id + resolved phone/email)
  const ids = new Set<string>();
  if ((appt.contact_id ?? "").trim()) ids.add((appt.contact_id ?? "").trim());
  // replicate phone/email resolution via contacts table
  void match;
  const candidateIds = [...ids];
  let windowCallsNoRep = 0;
  let windowCallsAnyRep = 0;
  for (const cid of candidateIds) {
    for (const c of callsByContact.get(cid) ?? []) {
      const day = callDateEt(c.started_at);
      if (!day || day < w.from || day > w.to) continue;
      const rep = eligibleRepId({ rep_id: c.rep_id, provider_rep_external_id: c.provider_rep_external_id ?? null }, elig);
      if (rep) windowCallsAnyRep += 1;
      else windowCallsNoRep += 1;
    }
  }
  let windowHarvest = 0;
  for (const cid of candidateIds) {
    const ext = contactExtById.get(cid);
    for (const h of (ext ? harvestAnyByExt.get(ext) : undefined) ?? []) {
      const day = callDateEt(h.started_at);
      if (!day || day < w.from || day > w.to) continue;
      windowHarvest += 1;
    }
  }
  return { signal: "ok", windowCallsNoRep, windowCallsAnyRep, windowHarvest, candidateIds: candidateIds.length };
}

const unattributed = matches.filter((m) => m.status === "unattributed");
const byReason: Record<string, number> = {};
for (const m of unattributed) byReason[m.reason ?? "none"] = (byReason[m.reason ?? "none"] ?? 0) + 1;

const breakdown: Record<string, number> = {};
const detailSamples: Array<Record<string, unknown>> = [];
for (const m of unattributed) {
  if (m.reason !== "no-qualifying-call") continue;
  const s = classifySignal(m);
  let cat: string;
  if (s.candidateIds === 0) cat = "A-no-candidate-contact";
  else if (s.windowCallsNoRep + s.windowHarvest > 0) cat = "B-interaction-without-roster-rep";
  else cat = "C-no-window-interaction";
  if (s.windowCallsAnyRep > 0) cat += "+SANITY-rep-call-in-window";
  breakdown[cat] = (breakdown[cat] ?? 0) + 1;
  if (detailSamples.length < 8) detailSamples.push({ appt: m.appointmentId, ...s, cat });
}

// stored rows: how many unattributed rows exist, and do live matches agree on count?
const storedUn = existing.filter((r) => r.rep_id == null && !(r.note ?? "").startsWith("ambiguous")).length;
const storedAmb = existing.filter((r) => r.rep_id == null && (r.note ?? "").startsWith("ambiguous")).length;
const storedAttr = existing.filter((r) => r.rep_id != null).length;

const out = {
  liveSplit: { total: matches.length, attributed: matches.filter((m) => m.status === "attributed").length, ambiguous: matches.filter((m) => m.status === "unattributed" && m.reason === "ambiguous").length, unattributed: unattributed.length },
  storedSplit: { total: existing.length, attributed: storedAttr, ambiguous: storedAmb, unattributed: storedUn },
  unattributedByReason: byReason,
  noQualifyingCallBreakdown: breakdown,
  detailSamples,
  counts: { appts: appts.length, calls: storedCalls.length, contacts: storedContacts.length, harvest: harvestCalls.length },
};
await Bun.write("scratch/s4b-probe.json", JSON.stringify(out, null, 2));
console.log("WROTE scratch/s4b-probe.json");
