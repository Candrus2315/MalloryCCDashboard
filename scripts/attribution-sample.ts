/**
 * ATTRIBUTION LIVE SAMPLE (manual run only — NEVER from tests, READ-ONLY).
 *
 *   bun scripts/attribution-sample.ts
 *
 * Runs the pure attribution engine against the LIVE synced data already in the
 * store (the scheduler's Acuity appointments + harvested HighLevel calls +
 * contacts) and prints an honest breakdown. NOTHING is written: no
 * booking_attributions rows, no connection updates, no API calls — the engine
 * is pure and every store method used is a read.
 */
import { getStore } from "../src/server/store";
import { matchAppointmentsToCalls } from "../src/server/metrics/attribution";
import { etToday, addDays } from "../src/server/date-logic";

async function main() {
  if (process.env.NODE_ENV === "test") {
    console.log("ABORTED — running under the test runner");
    process.exit(1);
  }
  const store = await getStore();
  console.log(`store mode: ${store.mode}`);

  const settings = await store.getSettings();
  const today = etToday();
  // The live Acuity window (yesterday → +14d) — same span the availability sync uses.
  const apptFrom = `${addDays(today, -1)}T00:00:00.000Z`;
  const apptTo = `${addDays(today, 15)}T00:00:00.000Z`;

  const appts = await store.getAppointmentsOverlapping(apptFrom, apptTo) as (typeof appts)[number] & {
    client_phone?: string | null;
    client_email?: string | null;
  }[];
  const calls = await store.getAllCallsSince(`${addDays(today, -30)}T00:00:00.000Z`);
  const contacts = await store.getContacts();
  const users = await store.getAllUsers();

  const withPhone = appts.filter((a) => (a.client_phone ?? "").length > 0).length;
  const withEmail = appts.filter((a) => (a.client_email ?? "").length > 0).length;
  const withContactId = appts.filter((a) => (a.contact_id ?? "").length > 0).length;
  console.log(
    `sample: ${appts.length} live appointments (${apptFrom.slice(0, 10)} → ${apptTo.slice(0, 10)}), ` +
      `${calls.length} calls (30d), ${contacts.length} contacts, ${users.filter((u) => u.is_active).length} active reps`,
  );
  console.log(
    `identity coverage: contact_id ${withContactId}/${appts.length}, phone ${withPhone}/${appts.length}, email ${withEmail}/${appts.length}`,
  );

  const matches = matchAppointmentsToCalls(
    appts.map((a) => ({
      id: a.id,
      contact_id: a.contact_id,
      client_phone: a.client_phone ?? null,
      client_email: a.client_email ?? null,
      appointment_datetime: a.appointment_datetime,
      created_at: (a as { created_at?: string }).created_at,
    })),
    // CallRow has no external_call_id column exposed by this selector — for the
    // sample the internal id stands in (identity/reporting only; nothing stored).
    calls.map((c) => ({
      external_call_id: c.id,
      rep_id: c.rep_id,
      provider_rep_external_id: c.provider_rep_external_id ?? null,
      contact_id: c.contact_id,
      started_at: c.started_at,
      duration_seconds: c.duration_seconds,
    })),
    contacts.map((c) => ({ id: c.id, phone: c.phone, email: c.email })),
    {
      meeting_threshold_seconds: settings.meeting_threshold_seconds,
      attribution_window_hours: settings.attribution_window_hours,
      rep_mappings: settings.rep_mappings,
    },
    { today, users: users.map((u) => ({ id: u.id, is_active: u.is_active })) },
  );

  const attributed = matches.filter((m) => m.status === "attributed");
  const unattributed = matches.filter((m) => m.status === "unattributed");
  const byReason = new Map<string, number>();
  for (const u of unattributed) byReason.set(u.reason ?? "?", (byReason.get(u.reason ?? "?") ?? 0) + 1);
  const byMethod = new Map<string, number>();
  for (const a of attributed) byMethod.set(a.method ?? "?", (byMethod.get(a.method ?? "?") ?? 0) + 1);
  const withRep = attributed.filter((a) => a.repId != null).length;

  console.log(`RESULT: ${attributed.length} attributed (${[...byMethod].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}), ${withRep} with an eligible rep`);
  console.log(`        ${unattributed.length} unattributed (${[...byReason].map(([k, v]) => `${k}=${v}`).join(", ") || "none"})`);
  const samples = unattributed.filter((u) => u.reason === "ambiguous").slice(0, 5);
  for (const s of samples) console.log(`        ambiguous e.g. ${s.appointmentId}: ${s.detail ?? "(no detail)"}`);
  process.exit(0);
}
main();
