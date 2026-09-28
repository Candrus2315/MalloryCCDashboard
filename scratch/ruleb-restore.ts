/**
 * RULE B RECOVERY (deliberate force recompute): the first live gate run
 * flipped 2 ambiguous rows (null-owner email resolutions) before the guard-b
 * null-owner gap was understood. Run with the PRE-Rule-B engine checked out,
 * this restores booking_attributions to the owner-pinned baseline
 * (410 = 139/3/268, 3× "ambiguous") using the exact pre-Rule-B semantics.
 * force bypasses the writer-version guard (checkpoint was stamped 4 by the
 * failed gate run) and the degradation guard — a deliberate recovery write.
 */
import { getStore } from "../src/server/store";
import { computeAndPersistAttributions } from "../src/server/sync/attribution-tick";

const store = await getStore();
const settings = await store.getSettings();
const res = await computeAndPersistAttributions(store, settings, { force: true });
const after = await store.getAttributions();
const attributed = after.filter((r) => r.rep_id != null).length;
const ambiguous = after.filter((r) => r.rep_id == null && (r.note ?? "").startsWith("ambiguous")).length;
const breakdown = after
  .filter((r) => r.rep_id == null)
  .reduce<Record<string, number>>((acc, r) => {
    const code = r.reason_code ?? "MISSING";
    acc[code] = (acc[code] ?? 0) + 1;
    return acc;
  }, {});
console.log("===RESTORE===");
console.log(JSON.stringify({ tick: res, split: { total: after.length, attributed, ambiguous, unattributed: after.length - attributed - ambiguous }, breakdown }, null, 2));
process.exit(0);
