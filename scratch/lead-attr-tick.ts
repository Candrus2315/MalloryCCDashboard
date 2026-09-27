/**
 * LEAD ONE-SHOT: rewrite booking_attributions with the CURRENT production
 * engine (same path the attribution tick uses). Run once after republishing
 * main to repair the table a stale deployed process had degraded to 3/121.
 */
import { getStore } from "../src/server/store";
import { recomputeAttributions } from "../src/server/sync/run";

const store = await getStore();
console.log("store mode:", store.constructor.name);
const settings = await store.getSettings();
const n = await recomputeAttributions(store, settings);
console.log("ATTRIBUTION UPSERTED:", n);
process.exit(0);
