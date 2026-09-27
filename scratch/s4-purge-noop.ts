/**
 * S4 purge closure: run the REAL purge methods against the live store.
 * Live census (scratch/s4-live-verify.ts) showed ZERO demo-% rows, so both
 * purges must be no-ops (0 removed) and provider counts unchanged.
 */
import { getStore } from "../src/server/store";
const store = await getStore();
const before = (await store.getAppointmentsWithClientsSince("2000-01-01T00:00:00Z")).length;
const acuity = await store.deleteDemoAcuityRows();
const highlevel = await store.deleteDemoHighLevelRows();
const after = (await store.getAppointmentsWithClientsSince("2000-01-01T00:00:00Z")).length;
console.log(JSON.stringify({ before, acuityPurge: acuity, highlevelPurge: highlevel, after }, null, 1));
