/**
 * SESSION 3 — attribution RERUN through the ONE invocation
 * (computeAndPersistAttributions) in THIS process, not the running server.
 * Replaces computed rows by design; no manual overrides exist.
 */
import { getStore } from "../src/server/store";
import { computeAndPersistAttributions } from "../src/server/sync/attribution-tick";
import { appointmentInScope } from "../src/server/metrics/availability";

const store = await getStore();
const settings = await store.getSettings();

const before = await store.getAttributions();
console.log(`pre-run: ${before.length} stored attribution rows · manual_override rows: ${before.filter((r) => r.manual_override).length}`);

const res = await computeAndPersistAttributions(store, settings);
console.log("computeAndPersistAttributions:", JSON.stringify(res, null, 2));

const after = await store.getAttributions();
const attributed = after.filter((r) => r.method !== "none");
const unattributed = after.filter((r) => r.method === "none");
const ambiguous = after.filter((r) => (r.note ?? "").startsWith("ambiguous"));
console.log(JSON.stringify({
  storedRows: after.length,
  attributed: attributed.length,
  unattributed: unattributed.length,
  ambiguousQueue: ambiguous.length,
  manualOverride: after.filter((r) => r.manual_override).length,
  invariant_totalEqAttributedPlusUnattributed: attributed.length + unattributed.length === after.length,
}, null, 2));

// Sanity: the engine's own scope rule should see the same total as the stored rows.
const today = new Date();
const appts = await store.getAppointmentsWithClientsSince("1970-01-01T00:00:00.000Z");
const inScope = appts.filter((a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled);
console.log(`appointments with clients (all time): ${appts.length} · in-scope non-cancelled (engine input): ${inScope.length}`);
process.exit(0);
