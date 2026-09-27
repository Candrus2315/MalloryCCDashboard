import { getStore } from "../src/server/store";
const store = await getStore() as any;
const rows = await store.getLeadsByWorkDates(["2026-09-22","2026-09-23","2026-09-24","2026-09-25","2026-09-26","2026-09-27","2026-09-28","2026-09-29"]);
const m: Record<string, Record<string, number>> = {};
for (const r of rows) {
  m[r.source_date] ??= {};
  m[r.source_date][r.work_date] = (m[r.source_date][r.work_date] ?? 0) + 1;
}
console.log("MAP", JSON.stringify(m));
process.exit(0);
