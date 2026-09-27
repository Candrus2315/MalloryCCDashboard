import { getStore } from "../src/server/store";
const store = await getStore() as any;
const rows = await store.getAttributions();
const ids = (await Bun.file("/tmp/failing-ids.txt").text()).trim().split("\n");
for (const id of ids) {
  const r = rows.find((x: any) => x.appointment_id === id);
  console.log(JSON.stringify(r ? { appointment_id: id, rep_id: r.rep_id, manual_override: r.manual_override, note: (r.note ?? "").slice(0, 70) } : { id, missing: true }));
}
process.exit(0);
