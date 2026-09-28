import { getStore } from "../src/server/store";
import { addDays, etDayStartUtc, etToday } from "../src/server/date-logic";
import { matchAppointmentsToCalls } from "../src/server/metrics/attribution";
import { appointmentInScope } from "../src/server/metrics/availability";

const store = await getStore() as any;
const settings = await store.getSettings();
const today = etToday();
const [apptsWindow, callsWindow, contacts, users, allUsers] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -170))),
  store.getAllCallsSince(etDayStartUtc(addDays(today, -170))),
  store.getContacts(),
  store.getUsers(),
  store.getAllUsers(),
]);
const nameOf = (id: any) => users.find((u: any) => u.id === id)?.name ?? allUsers.find((u: any) => u.id === id)?.name ?? "non-roster";
const ambIds = ["5765fcff","21eba589","1ec8c996","b4640e50","6e185da5","c9032d4f","6dc830d1","57398d5c","fc26f27c","040ae015","923de95c","ea8a3d65"];
const scopedAppts = (apptsWindow as any[]).filter((a) => appointmentInScope(a, settings.acuity));
const matches = matchAppointmentsToCalls(scopedAppts, callsWindow, contacts.map((c: any) => ({ id: c.id, phone: c.phone, email: c.email })), {
  meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
  attribution_window_hours: settings.attribution_window_hours,
  rep_mappings: settings.rep_mappings,
}, { today, users: allUsers.map((u: any) => ({ id: u.id, is_active: u.is_active })) });
const matchByAppt = new Map<string, any>();
for (const m of matches as any[]) if (m.appointment_id) matchByAppt.set(m.appointment_id, m);
const callKeys = callsWindow.length ? Object.keys(callsWindow[0]) : [];
const et = (d: any) => new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
for (const appt of scopedAppts) {
  const aid = appt.id ?? appt.appointment_id;
  if (!ambIds.some((p) => String(aid).startsWith(p))) continue;
  const m = matchByAppt.get(aid);
  const stored = appt.contact_id ?? appt.clients?.[0]?.contact_id ?? null;
  const email = appt.client_email ?? appt.clients?.[0]?.email ?? null;
  const emailContact = email ? (contacts as any[]).find((c) => (c.email ?? "").toLowerCase() === String(email).toLowerCase()) : null;
  const wFrom = m?.window?.from ?? null, wTo = m?.window?.to ?? null;
  console.log(`\n### ${String(aid).slice(0,8)} — ${appt.client_name ?? "?"} | session ${et(appt.appointment_datetime)} ET | window ${wFrom}..${wTo}`);
  console.log(`    email: ${email ?? "none"} | stored contact: ${stored ? String(stored).slice(0,8) : "none"} | email-resolved contact: ${emailContact ? String(emailContact.id).slice(0,8) + " (rep " + nameOf(emailContact.assigned_rep_id) + ")" : "none"}`);
  for (const [label, cid] of [["stored", stored], ["email-resolved", emailContact?.id ?? null]] as const) {
    if (!cid) continue;
    const relevant = (callsWindow as any[]).filter((c) => (c.contact_id ?? c.contactId) === cid);
    const inWin = relevant.filter((c) => {
      if (!wFrom || !wTo) return true;
      const d = new Date(c.started_at).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
      return d >= wFrom && d <= wTo;
    });
    const show = inWin.length ? inWin : relevant.slice(-3);
    console.log(`    ${label} contact calls${inWin.length ? " IN WINDOW" : " (recent, none in window)"}:`);
    for (const c of show.slice(0, 6)) console.log(`      · ${et(c.started_at)} ET · ${Math.round((c.duration_seconds ?? 0) / 60)}m · ${nameOf(c.rep_id ?? c.user_id)}`);
    if (!show.length) console.log("      · (no calls on record)");
  }
}
process.exit(0);
