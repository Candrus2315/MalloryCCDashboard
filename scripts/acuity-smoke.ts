/**
 * ACUITY LIVE SMOKE (manual run only — NEVER from tests).
 *
 *   bun scripts/acuity-smoke.ts
 *
 * Reads ACUITY_USER_ID + ACUITY_API_KEY from the environment (case-insensitive),
 * performs the exact read calls the availability sync makes — a rolling
 * yesterday → +14 days appointment window + the appointment-type catalog — and
 * prints honest counts. READ-ONLY: nothing is written to the database. Exit
 * code 0 on a clean smoke, 1 on any failure (bad creds, rate limit, HTTP).
 */
import { readAcuityCreds, createAcuityLiveAdapter, type AcuityLiveAdapter } from "../src/server/sync/acuity-live";

async function main() {
  if (process.env.NODE_ENV === "test") {
    console.log("SMOKE ABORTED — running under the test runner (live Acuity is forbidden from tests)");
    process.exit(1);
  }
  const creds = readAcuityCreds();
  const source = creds ? "resolved" : "MISSING";
  console.log(`credentials: ${source} (ACUITY_USER_ID / ACUITY_API_KEY via case-insensitive env lookup)`);
  if (!creds) {
    console.log("RESULT: FAIL — no credentials in the environment");
    process.exit(1);
  }

  const adapter: AcuityLiveAdapter = createAcuityLiveAdapter()!;
  const t0 = Date.now();
  try {
    const appts = await adapter.fetchAppointments();
    const types = await adapter.fetchAppointmentTypes();
    const ms = Date.now() - t0;
    const canceled = appts.filter((a) => a.cancelled).length;
    const byCalendar = new Map<string, number>();
    const byType = new Map<string, number>();
    for (const a of appts) {
      byCalendar.set(a.calendarName || a.calendarId, (byCalendar.get(a.calendarName || a.calendarId) ?? 0) + 1);
      byType.set(a.appointmentType || "(no type)", (byType.get(a.appointmentType || "(no type)") ?? 0) + 1);
    }
    const datetimes = appts.map((a) => a.appointmentDatetime).sort();
    console.log(`appointments fetched: ${appts.length} (canceled: ${canceled}) in ${ms}ms, ${adapter.lastRun?.requests ?? 0} paced requests`);
    console.log(`window: ${adapter.lastRun?.window.minDate} → ${adapter.lastRun?.window.maxDate} (ET)`);
    if (datetimes.length) {
      console.log(`session range: ${datetimes[0]} → ${datetimes[datetimes.length - 1]} (UTC instants)`);
    }
    console.log(`appointment types in catalog: ${types.length}${types.length ? ` (${types.map((t) => `${t.name}[${t.duration ?? "?"}m]`).join(", ")})` : ""}`);
    console.log(`calendars seen: ${[...byCalendar.entries()].map(([n, c]) => `${n}: ${c}`).join(" · ") || "(none)"}`);
    console.log(`types seen: ${[...byType.entries()].map(([n, c]) => `${n}: ${c}`).join(" · ") || "(none)"}`);
    for (const w of adapter.lastRun?.warnings ?? []) console.log(`warning: ${w}`);
    console.log(`RESULT: ${adapter.lastRun?.truncated ? "PARTIAL (window truncated at cap)" : "OK"}`);
    process.exit(adapter.lastRun?.truncated ? 1 : 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`RESULT: FAIL — ${msg}`);
    process.exit(1);
  }
}

await main();
