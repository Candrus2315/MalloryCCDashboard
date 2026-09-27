/** Dump full contacts-backfill checkpoint (reconciliation evidence). Read-only. */
import { getStore } from "../src/server/store";
const store = await getStore();
const raw = await store.getSyncCheckpoint("hl_contacts_backfill_v1");
console.log(raw);
process.exit(0);
