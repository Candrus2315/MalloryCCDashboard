/**
 * S7 BACKFILL (one-shot) — pull Acuity with the WIDENED window
 * (today−35 → today+180, date-chunked) and upsert into the live store.
 * Duplicate-safe: upsert by acuity_appointment_id; existing rows update in
 * place; cancellations arrive with canceled:true and UPDATE (never duplicate).
 * Then verifies the landed counts against Acuity ground truth.
 * Run: bun run scratch/s7-backfill.ts  (NOT under bun test — live creds + DB)
 */
import { getStore } from "../src/server/store";
import {
  readAcuityCreds,
  AcuityLiveAdapter,
  upsertAcuityAppointments,
  writeAcuityConnection,
} from "../src/server/sync/acuity-live";
import { etDateStrFromInstant } from "../src/server/date-logic";

const store = await getStore();

const before = await store.getAllAppointmentsSince("2000-01-01T00:00:00Z");
console.log("appointments BEFORE:", before.length);

const creds = readAcuityCreds();
if (!creds) throw new Error("Acuity credentials missing — cannot backfill");
const adapter = new AcuityLiveAdapter(creds);
const appts = await adapter.fetchAppointments();
console.log(
  "fetched:", appts.length,
  "| requests:", adapter.lastRun?.requests,
  "| window:", JSON.stringify(adapter.lastRun?.window),
  "| truncated:", adapter.lastRun?.truncated,
  "| warnings:", JSON.stringify(adapter.lastRun?.warnings),
);

const purged = await store.deleteDemoAcuityRows();
const count = await upsertAcuityAppointments(store, appts);
console.log("upserted:", count, "| demo rows purged:", JSON.stringify(purged));

await writeAcuityConnection(store, {
  live: true,
  note: `S7 backfill · window ${adapter.lastRun?.window.minDate} → ${adapter.lastRun?.window.maxDate} · ${count} appointments · ${adapter.lastRun?.requests} chunked requests`,
  nowIso: new Date().toISOString(),
});

// ---------- verification against Acuity ground truth ----------
const after = await store.getAllAppointmentsSince("2000-01-01T00:00:00Z");
const etDate = (iso: string) => etDateStrFromInstant(Date.parse(iso));
const sessionsSep25Jan31 = after.filter((a) => {
  const d = etDate(a.appointment_datetime);
  return d >= "2026-09-25" && d <= "2027-01-31";
}).length;
const sessionsBeforeSep25 = after.filter((a) => etDate(a.appointment_datetime) < "2026-09-25").length;
const createdSep2125 = after.filter((a) => {
  const d = etDate(a.created_at);
  return d >= "2026-09-21" && d <= "2026-09-25";
});
const createdSep2124 = createdSep2125.filter((a) => etDate(a.created_at) <= "2026-09-24");
const times = after.map((a) => a.appointment_datetime).sort();
const perDay: Record<string, number> = {};
for (const a of createdSep2125) perDay[etDate(a.created_at)] = (perDay[etDate(a.created_at)] ?? 0) + 1;

console.log("---- VERIFY ----");
console.log("appointments AFTER:", after.length);
console.log("session datetime span:", times[0], "->", times[times.length - 1]);
console.log("sessions Sep25->Jan31:", sessionsSep25Jan31, "(Acuity truth: 212)");
console.log("sessions before Sep25 (held history):", sessionsBeforeSep25);
console.log("created Sep21-25:", createdSep2125.length, "(Acuity truth: 63)", JSON.stringify(perDay));
console.log("created Sep21-24:", createdSep2124.length, "(owner held history: 54)");
console.log("cancelled rows:", after.filter((a) => a.cancelled).length);
process.exit(0);
