import { getStore } from "../src/server/store";
const store = await getStore() as any;
const users = await store.getUsers();
for (const u of users) console.log(JSON.stringify({ name: u.name, call_start_date: u.call_start_date ?? null }));
process.exit(0);
