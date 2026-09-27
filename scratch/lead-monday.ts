import { getStore } from "../src/server/store";
const store = await getStore() as any;
const rows = await store.getLeadsByWorkDates(["2026-09-25","2026-09-26","2026-09-27","2026-09-28"]);
for (const r of rows) console.log(JSON.stringify(r));
process.exit(0);
