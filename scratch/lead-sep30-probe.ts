import { getStore } from "../src/server/store";
import { etDayStartUtc, etDayEndUtc } from "../src/server/date-logic";
const store = await getStore();
const date = "2026-09-30";
const rows = await store.getAppointmentsOverlapping(etDayStartUtc(date), etDayEndUtc(date));
const active = rows.filter((a) => !a.cancelled && a.status !== "cancelled");
console.log(`Sep30: total=${rows.length} active=${active.length}`);
for (const a of active) {
  const d = new Date(a.appointment_datetime);
  const et = d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
  console.log(`  ${et} ET | dur=${a.duration_minutes} | cal=${a.calendar_name}/${a.calendar_id} | type=${a.appointment_type} | ${a.client_name ?? "?"}`);
}
process.exit(0);
