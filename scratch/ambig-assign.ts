import { getStore } from "../src/server/store";
import { addDays, etDayStartUtc, etToday } from "../src/server/date-logic";
import { assignAttributionCore } from "../src/server/queries";
import { appointmentInScope } from "../src/server/metrics/availability";

const store = await getStore() as any;
const settings = await store.getSettings();
const today = etToday();
const [apptsWindow, contacts, users] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -170))),
  store.getContacts(),
  store.getUsers(),
]);
const allison = (users as any[]).find((u) => u.name === "Allison Wittner" && u.is_active);
if (!allison) { console.log("ALLISON NOT FOUND/INACTIVE — aborting"); process.exit(1); }
const nameOf = (id: any) => (users as any[]).find((u: any) => u.id === id)?.name ?? "non-roster";
const scopedAppts = (apptsWindow as any[]).filter((a) => appointmentInScope(a, settings.acuity));
const attributions = await store.getAttributions();
// ambiguous = has an attribution row with reason ambiguous, or no row but engine-queued? Use stored verdict.
const ambRows = (attributions as any[]).filter((a) => a.reason_code === "ambiguous" && !a.manual_override);
console.log("stored ambiguous (non-manual):", ambRows.length);
let done = 0, skipped = 0;
for (const a of ambRows) {
  const appt = (scopedAppts as any[]).find((x) => (x.id ?? x.appointment_id) === a.appointment_id);
  if (!appt) { skipped++; continue; }
  const email = appt.client_email ?? appt.clients?.[0]?.email ?? null;
  const emailContact = email ? (contacts as any[]).find((c) => (c.email ?? "").toLowerCase() === String(email).toLowerCase()) : null;
  if (!emailContact || emailContact.assigned_rep_id !== allison.id) { skipped++; continue; }
  await assignAttributionCore(store, {
    appointmentId: a.appointment_id,
    repId: allison.id,
    note: "Owner call 2026-09-28: ambiguous identity (email resolves a different contact than stored contact id); email-resolved contact record owned by Allison Wittner; no competing call evidence in window.",
  });
  done++;
  console.log(`assigned ${String(a.appointment_id).slice(0,8)} ${appt.client_name ?? "?"} -> Allison Wittner`);
}
console.log(`DONE assigned=${done} skipped=${skipped}`);
process.exit(0);
