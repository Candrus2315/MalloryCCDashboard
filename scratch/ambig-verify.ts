import { getStore } from "../src/server/store";
import { addDays, etDayStartUtc, etToday } from "../src/server/date-logic";
import { bookingAttributionSplit } from "../src/server/metrics/compute";
import { appointmentInScope } from "../src/server/metrics/availability";
const store = await getStore() as any;
const settings = await store.getSettings();
const today = etToday();
const [apptsWindow, attributions, overrides] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -170))),
  store.getAttributions(),
  store.getManualOverrides(200),
]);
const scoped = (apptsWindow as any[]).filter((a) => appointmentInScope(a, settings.acuity));
const split = bookingAttributionSplit(scoped, attributions);
console.log("SPLIT", JSON.stringify(split));
const repOverrides = (overrides as any[]).filter((o) => o.entity_type === "booking_attribution" && o.field === "rep");
console.log("audit rep-changes total:", repOverrides.length, "| last 3:", repOverrides.slice(-3).map((o) => `${o.entity_id.slice(0,8)}:${o.previous_value}->${o.new_value}`).join(" | "));
const allison = (await store.getUsers()).find((u: any) => u.name === "Allison Wittner");
const allisonRows = (attributions as any[]).filter((a) => a.rep_id === allison.id && a.manual_override);
console.log("Allison manual-override bookings:", allisonRows.length);
process.exit(0);
