import { getStore } from "../src/server/store";
import { addDays, etDayStartUtc, etToday } from "../src/server/date-logic";
import { buildUnattributedQueue } from "../src/server/metrics/compute";
import { matchAppointmentsToCalls } from "../src/server/metrics/attribution";
import { appointmentInScope } from "../src/server/metrics/availability";

const store = await getStore() as any;
const settings = await store.getSettings();
const today = etToday();
const [apptsWindow, callsWindow, contacts, attributions, users, allUsers] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
  store.getAllCallsSince(etDayStartUtc(addDays(today, -30))),
  store.getContacts(),
  store.getAttributions(),
  store.getUsers(),
  store.getAllUsers(),
]);
const scopedAppts = apptsWindow.filter((a: any) => appointmentInScope(a, settings.acuity));
const engineMatches = matchAppointmentsToCalls(
  scopedAppts,
  callsWindow,
  contacts.map((c: any) => ({ id: c.id, phone: c.phone, email: c.email })),
  {
    meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
    attribution_window_hours: settings.attribution_window_hours,
    rep_mappings: settings.rep_mappings,
  },
  { today, users: allUsers.map((u: any) => ({ id: u.id, is_active: u.is_active })) },
);
const queue = buildUnattributedQueue({
  appointments: scopedAppts,
  attributions,
  calls: callsWindow,
  contacts: contacts.map((c: any) => ({ id: c.id, phone: c.phone, email: c.email, assigned_rep_id: c.assigned_rep_id })),
  thresholdSeconds: settings.meaningful_call_threshold_seconds,
  matches: engineMatches,
});
const nameOf = (id: any) => users.find((u: any) => u.id === id)?.name ?? "non-roster";
const amb = queue.filter((r: any) => r.reason === "ambiguous");
console.log("QUEUE_TOTAL", queue.length, "AMBIGUOUS", amb.length);
let i = 0;
for (const r of amb) {
  i++;
  const cands = (r.candidate_calls ?? []).map((c: any) =>
    `${new Date(c.started_at).toLocaleString("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})} ET · ${Math.round(c.duration_seconds/60)}m · ${nameOf(c.rep_id)}`);
  console.log(`#${i} [${r.appointment_id.slice(0,8)}] ${r.client_name ?? "Unknown"} <${r.client_email ?? "no-email"}> ${r.client_phone ?? ""}`);
  console.log(`    type=${r.appointment_type} cal=${r.calendar_name ?? "?"} session=${r.appointment_datetime} booked=${r.created_at}`);
  console.log(`    suggested=${r.suggested_rep_id ? nameOf(r.suggested_rep_id) : "—"} candidates:`);
  for (const c of cands) console.log(`      - ${c}`);
}
process.exit(0);
