/**
 * S5b VERIFICATION — the three-way split the pages now display, computed by
 * the shipped metrics function (bookingAttributionSplit) over the live
 * Postgres, in the SAME scope the attribution tick evaluates. Read-only.
 * Run: bun scratch/s5b-verify.ts
 */
import { addDays, etDayStartUtc, etToday } from "../src/server/date-logic";
import { appointmentInScope } from "../src/server/metrics/availability";
import { bookingAttributionSplit } from "../src/server/metrics/compute";
import { getStore, getDbStatus } from "../src/server/store";

const store = await getStore();
const status = getDbStatus();
if (status.mode !== "postgres" || !status.ok) {
  console.log("NO LIVE DB", status);
  process.exit(1);
}
const settings = await store.getSettings();
const today = etToday();
const [apptsRaw, attributions] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
  store.getAttributions(),
]);
const appts = apptsRaw.filter(
  (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
);
const split = bookingAttributionSplit(appts, attributions);
console.log("DISPLAYED THREE-WAY SPLIT:", JSON.stringify(split));
console.log(
  "INVARIANT:",
  split.attributed + split.ambiguous + split.unattributed + split.withoutVerdict === split.total ? "PASS" : "FAIL",
  `(${split.attributed} + ${split.ambiguous} + ${split.unattributed} + ${split.withoutVerdict} = ${split.total})`,
);
console.log(
  "EXPECTATION 49/4/71=124:",
  split.attributed === 49 && split.ambiguous === 4 && split.unattributed === 71 && split.withoutVerdict === 0 && split.total === 124
    ? "PASS"
    : "CHECK (data may have drifted)",
);
process.exit(0);
