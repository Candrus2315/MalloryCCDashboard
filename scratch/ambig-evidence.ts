import { getStore } from "../src/server/store";
import { addDays, etDayStartUtc, etToday } from "../src/server/date-logic";
import { matchAppointmentsToCalls } from "../src/server/metrics/attribution";
import { appointmentInScope } from "../src/server/metrics/availability";

const store = await getStore() as any;
const settings = await store.getSettings();
const today = etToday();
const [apptsWindow, callsWindow, contacts, users, allUsers] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
  store.getAllCallsSince(etDayStartUtc(addDays(today, -30))),
  store.getContacts(),
  store.getUsers(),
  store.getAllUsers(),
]);
const nameOf = (id: any) => users.find((u: any) => u.id === id)?.name ?? allUsers.find((u: any) => u.id === id)?.name ?? `non-roster(${String(id).slice(0,8)})`;
const scopedAppts = apptsWindow.filter((a: any) => appointmentInScope(a, settings.acuity));
const matches = matchAppointmentsToCalls(
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
// map: appointment_id -> match; we want the ones the stored queue flags ambiguous
const ambIds = ["5765fcff","21eba589","1ec8c996","b4640e50","6e185da5","c9032d4f","6dc830d1","57398d5c","fc26f27c","040ae015","923de95c","ea8a3d65"];
const byId = new Map<string, any>();
for (const m of matches as any[]) {
  const aid = m.appointment_id ?? m.appointmentId ?? m.appt_id;
  if (aid) byId.set(aid, m);
}
for (const row of scopedAppts as any[]) {
  const aid = row.id ?? row.appointment_id;
  if (!ambIds.some(p => String(aid).startsWith(p))) continue;
  const m = byId.get(aid);
  const client = row.client_name ?? row.clients?.[0]?.name ?? "?";
  console.log(`\n=== ${String(aid).slice(0,8)} ${client} ===`);
  console.log(JSON.stringify(m, (k, v) => k.endsWith("_id") && typeof v === "string" && v.length > 20 ? v.slice(0,8) : v, 1));
}
process.exit(0);
