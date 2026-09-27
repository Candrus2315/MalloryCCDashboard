/**
 * S8 live-verify: run the REAL availabilityPageData() loader (no deps → live
 * Postgres + real settings + real Acuity rows) and print the next-7-days
 * payload exactly as the Availability page consumes it.
 */
import { availabilityPageData } from "../src/server/page-data";

const data = await availabilityPageData();
console.log("today:", data.today, "| connection:", JSON.stringify(data.connection));
console.log("filters:", JSON.stringify(data.filters));
for (const d of data.days) {
  console.log(
    `${d.date} wd=${new Date(d.date + "T12:00:00Z").getUTCDay()} cap=${d.totalCapacity} booked=${d.booked} blocked=${d.blockedCount} open=${d.openSlotTimes.length} inv=${d.booked + d.blockedCount + d.openSlotTimes.length === d.totalCapacity}`,
  );
  console.log("   slots:", JSON.stringify(d.openSlotTimes));
}
const todayRow = data.days[0];
const expected9 = ["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:30 PM", "2:30 PM", "3:30 PM", "4:30 PM", "5:30 PM"];
// per-day: booked+blocked+open === capacity must hold; every day with capacity
// > 0 must show slots from the 9-start grid (intersections may be booked)
let gridOk = true;
for (const d of data.days) {
  if (d.totalCapacity > 0) {
    const all9 = ["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:30 PM", "2:30 PM", "3:30 PM", "4:30 PM", "5:30 PM"];
    const open = d.openSlotTimes;
    if (open.length + d.booked + d.blockedCount !== d.totalCapacity || d.totalCapacity !== 9) gridOk = false;
    if (!open.every((s) => all9.includes(s))) gridOk = false;
  }
}
console.log("GRID_OK (cap=9/day, slots ⊂ 9-start grid, invariant holds):", gridOk);
console.log("today open times:", JSON.stringify(todayRow.openSlotTimes));
process.exit(0);
