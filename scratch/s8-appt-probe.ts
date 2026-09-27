import { getStore } from "../src/server/store";
import { etDayStartUtc, etDayEndUtc } from "../src/server/date-logic";
const store = await getStore();
const settings = await store.getSettings();
console.log("scope:", JSON.stringify(settings.acuity));
for (const date of ["2026-09-27", "2026-09-28", "2026-10-01"]) {
  const rows = await store.getAppointmentsOverlapping(etDayStartUtc(date), etDayEndUtc(date));
  const active = rows.filter((a) => !a.cancelled && a.status !== "cancelled");
  console.log(`${date}: rows=${rows.length} active=${active.length}`);
  for (const a of active.slice(0, 12)) {
    console.log(`  ${a.appointment_datetime} dur=${a.duration_minutes} cal=${a.calendar_name}/${a.calendar_id} type=${a.appointment_type}`);
  }
}
process.exit(0);
