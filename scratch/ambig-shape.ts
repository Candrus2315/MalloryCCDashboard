import { getStore } from "../src/server/store";
const store = await getStore() as any;
const attributions = await store.getAttributions();
console.log("keys:", Object.keys(attributions[0] ?? {}).join(","));
const ids = ["5765fcff","21eba589","1ec8c996","b4640e50","6e185da5","c9032d4f","6dc830d1","57398d5c","fc26f27c","040ae015","923de95c","ea8a3d65"];
for (const a of attributions as any[]) {
  if (ids.some(p => String(a.appointment_id).startsWith(p))) console.log(JSON.stringify(a, (k,v) => typeof v === "string" && v.length > 40 ? v.slice(0,40)+"…" : v));
}
process.exit(0);
