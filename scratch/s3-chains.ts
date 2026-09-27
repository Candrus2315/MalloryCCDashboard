/**
 * SESSION 3 — AUDIT CHAINS: 3 attributed + 2 unattributed bookings,
 * end-to-end: Acuity identity → HL contact → winning call (HL message id,
 * ledger evidence, rep) → stored attribution row (method + window dates).
 * Read-only.
 */
import { getStore } from "../src/server/store";
import { etDateStrFromInstant } from "../src/server/date-logic";

const store = await getStore();
const users = await store.getAllUsers();
const userById = new Map(users.map((u) => [u.id, u]));
const attributions = await store.getAttributions();
const calls = (await store.getAllCallsSince("1970-01-01T00:00:00.000Z")) as Array<Record<string, unknown>>;
const callById = new Map(calls.map((c) => [c.id as string, c]));

const attributed = attributions.filter((r) => r.method !== "none");
const unattributed = attributions.filter((r) => r.method === "none");

// Prefer distinct methods among the attributed picks.
const byMethod = new Map<string, typeof attributed[number]>();
for (const r of attributed) if (!byMethod.has(r.method)) byMethod.set(r.method, r);
const attributedPicks = [...byMethod.values()].slice(0, 3);
while (attributedPicks.length < 3 && attributedPicks.length < attributed.length) {
  const next = attributed.find((r) => !attributedPicks.includes(r));
  if (!next) break;
  attributedPicks.push(next);
}
const ambiguousPick = unattributed.find((r) => (r.note ?? "").startsWith("ambiguous")) ?? unattributed[0];
const secondUnattributed =
  unattributed.find((r) => r !== ambiguousPick && (r.note ?? "").startsWith("no-qualifying-call")) ??
  unattributed.find((r) => r !== ambiguousPick);
const unattributedPicks = [ambiguousPick, secondUnattributed].filter((x): x is NonNullable<typeof x> => !!x);

function chain(r: (typeof attributions)[number]): Record<string, unknown> {
  const appt = apptById.get(r.appointment_id);
  const call = r.call_id ? callById.get(r.call_id) : undefined;
  const callContact = call?.contact_id ? contactById.get(call.contact_id as string) : undefined;
  const rep = r.rep_id ? userById.get(r.rep_id) : null;
  const callRep = call?.rep_id ? userById.get(call.rep_id as string) : null;
  return {
    appointment: appt && {
      internal_id: appt.id,
      acuity_appointment_id: (appt as Record<string, unknown>).acuity_appointment_id ?? null,
      type: appt.appointment_type,
      created_at: appt.created_at,
      session_datetime: appt.appointment_datetime,
      client_phone: (appt as Record<string, unknown>).client_phone ?? null,
      client_email: (appt as Record<string, unknown>).client_email ?? null,
      stored_contact_id: appt.contact_id,
    },
    storedAttributionRow: {
      id: r.id,
      method: r.method,
      confidence: r.confidence,
      rep_id: r.rep_id,
      rep_name: rep?.name ?? null,
      call_id: r.call_id,
      manual_override: r.manual_override,
      note: r.note ?? null,
    },
    winningCall: call && {
      internal_id: call.id,
      hl_message_id: call.external_call_id,
      started_at_utc: call.started_at,
      started_at_et_date: etDateStrFromInstant(Date.parse(call.started_at as string)),
      duration_seconds: call.duration_seconds,
      over_two_minutes: call.over_two_minutes ?? null,
      resolved_contact_id: call.contact_id,
      resolved_via: call.contact_resolution_method ?? null,
      call_rep_id: call.rep_id,
      call_rep_name: callRep?.name ?? null,
    },
    ledgerHarvestCall: call?.external_call_id ? harvestByMessage.get(call.external_call_id as string) ?? null : null,
    resolvedContact: callContact && {
      internal_id: callContact.id,
      hl_external_id: callContact.external_id,
      phone_normalized: callContact.phone_normalized ?? null,
      email_normalized: callContact.email_normalized ?? null,
      assigned_rep_id: callContact.assigned_rep_id,
      assigned_rep_name: callContact.assigned_rep_id ? userById.get(callContact.assigned_rep_id)?.name ?? null : null,
    },
  };
}

const apptsAll = await store.getAppointmentsWithClientsSince("1970-01-01T00:00:00.000Z");
const apptById = new Map(apptsAll.map((a) => [a.id, a]));
const contacts = await store.getContacts();
const contactById = new Map(contacts.map((c) => [c.id, c]));
const harvestRows = await store.getHarvestCallsByMessageIds(
  calls.map((c) => c.external_call_id as string).filter((x): x is string => !!x),
);
const harvestByMessage = new Map(harvestRows.map((h) => [h.message_id, { message_id: h.message_id, contact_external_id: h.contact_external_id ?? null }]));

console.log(JSON.stringify({
  attributedChains: attributedPicks.map(chain),
  unattributedChains: unattributedPicks.map(chain),
}, null, 2));
process.exit(0);
