/**
 * S7 VERIFY (read-only) — the brief's acceptance checks on the backfilled DB:
 *  1. sessions with ET session date Sep 21–24 exist (owner's held-sessions history)
 *  2. rows whose stored created_at UTC date is Sep 21–25 = 63 (raw dateCreated truth;
 *     date-only dateCreated stores as midnight UTC so its UTC date == the raw string date)
 *  3. per-day breakdown for the report
 */
import { getStore } from "../src/server/store";
import { etDateStrFromInstant } from "../src/server/date-logic";

const store = await getStore();
const rows = await store.getAllAppointmentsSince("2000-01-01T00:00:00Z");
const etDate = (iso: string) => etDateStrFromInstant(Date.parse(iso));
const utcDate = (iso: string) => iso.slice(0, 10);

const sess = (a: (typeof rows)[number]) => etDate(a.appointment_datetime);
const sessionsSep2124 = rows.filter((a) => { const d = sess(a); return d >= "2026-09-21" && d <= "2026-09-24"; });
const perSessDay: Record<string, number> = {};
for (const a of sessionsSep2124) perSessDay[sess(a)] = (perSessDay[sess(a)] ?? 0) + 1;

const createdSep2125Utc = rows.filter((a) => { const d = utcDate(a.created_at); return d >= "2026-09-21" && d <= "2026-09-25"; });
const perCreatedUtc: Record<string, number> = {};
for (const a of createdSep2125Utc) perCreatedUtc[utcDate(a.created_at)] = (perCreatedUtc[utcDate(a.created_at)] ?? 0) + 1;

// sample rows: what does a stored date-only dateCreated look like?
const sample = rows.filter((a) => utcDate(a.created_at) === "2026-09-21").slice(0, 3).map((a) => ({ id: a.acuity_appointment_id, created_at: a.created_at, session: a.appointment_datetime }));

console.log(JSON.stringify({
  totalRows: rows.length,
  sessionsEtSep21_24: { count: sessionsSep2124.length, perDay: perSessDay },
  createdAtUtcSep21_25: { count: createdSep2125Utc.length, perDay: perCreatedUtc, note: "raw dateCreated truth = 63 (15/13/12/14/9)" },
  sampleCreatedAt: sample,
}, null, 2));
process.exit(0);
