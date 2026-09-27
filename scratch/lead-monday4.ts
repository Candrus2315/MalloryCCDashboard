import { getStore } from "../src/server/store";
const store = await getStore() as any;
const rows = await store.getLeadsByWorkDates(["2026-09-25","2026-09-26","2026-09-27","2026-09-28"]);
const byDate: Record<string, { family: number; animalia: number; assigned: number }> = {};
for (const r of rows) {
  const d = r.work_date;
  byDate[d] ??= { family: 0, animalia: 0, assigned: 0 };
  if (r.lead_type === "animalia") byDate[d].animalia += 1; else byDate[d].family += 1;
  if (r.assigned_rep_id) byDate[d].assigned += 1;
}
console.log(JSON.stringify(byDate, null, 0));
process.exit(0);
