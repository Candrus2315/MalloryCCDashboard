import { getStore } from "../src/server/store";
const store = await getStore() as any;
const rows = await store.getLeadsByWorkDates(["2026-09-25","2026-09-26","2026-09-27","2026-09-28"]);
const out = rows.length ? JSON.stringify(rows, null, 1) : "NO ROWS";
await Bun.write("/tmp/leads-monday.txt", out);
console.log("rows:", rows.length, "| keys:", rows[0] ? Object.keys(rows[0]).join(",") : "-");
process.exit(0);
