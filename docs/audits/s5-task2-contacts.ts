/**
 * S5 TASK 2 — 116,168 (HL source at walk time) vs 116,155 (DB rows). READ-ONLY.
 * ONE HL API call (page 1 meta.total — current source total, NO backfill),
 * DB counts, checkpoint failedPages, and contact-linkage integrity for the
 * in-scope bookings + unresolved calls.
 */
import { getStore } from "../src/server/store";
import { readHighLevelCreds } from "../src/server/sync/highlevel-live";
import { appointmentInScope } from "../src/server/metrics/availability";
import postgres from "postgres";
import { getSecret } from "../src/server/env";

const creds = readHighLevelCreds();
if (!creds) throw new Error("HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID required");

// 1) CURRENT source total (single API call)
const headers = { authorization: `Bearer ${creds.apiKey}`, version: "2021-07-28", accept: "application/json" };
const url = `https://services.leadconnectorhq.com/contacts/?locationId=${creds.locationId}&limit=100`;
const res = await fetch(url, { headers });
const body = (await res.json()) as { meta?: { total?: number } };
const apiTotal = body.meta?.total ?? null;

// 2) DB counts
const dbUrl = getSecret("DATABASE_URL")!;
const sql = postgres(dbUrl, { max: 2, ssl: "require" });
const counts = await sql`
  SELECT count(*)::int AS rows, count(DISTINCT external_id)::int AS distinct_ext,
         count(*) FILTER (WHERE external_id IS NULL)::int AS null_ext
  FROM contacts`;
// 3) checkpoint (failedPages recorded by the backfill walk)
const cp = await sql`SELECT value FROM sync_checkpoints WHERE key = 'hl_contacts_backfill_v1' LIMIT 1`;
let checkpoint: unknown = null;
if (cp.length) { const v = cp[0].value as unknown; try { checkpoint = typeof v === "string" ? JSON.parse(v) : v; } catch { checkpoint = String(v).slice(0, 400); } }

// 4) contact-linkage integrity for the in-scope bookings + calls the metrics read
const store = await getStore();
const settings = await store.getSettings();
const apptsWin = await store.getAppointmentsWithClientsSince("1970-01-01T00:00:00.000Z");
const inScope = apptsWin.filter((a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled);
const calls = await store.getAllCallsSince("1970-01-01T00:00:00.000Z") as unknown as Array<Record<string, unknown>>;
const contactIds = new Set((await sql`SELECT id::text FROM contacts`).map((r) => r.id as string));
const apptContactRefs = inScope.map((a) => (a as unknown as Record<string, unknown>).contact_id as string | null).filter((x): x is string => !!x);
const apptMissing = apptContactRefs.filter((id) => !contactIds.has(id));
const callContactRefs = calls.map((c) => c.contact_id as string | null).filter((x): x is string => !!x);
const callMissing = callContactRefs.filter((id) => !contactIds.has(id));
const unresolvedCalls = calls.filter((c) => (c.rep_id as string | null) == null);
const unresolvedWithContact = unresolvedCalls.filter((c) => (c.contact_id as string | null) != null).length;
const unresolvedContactMissing = unresolvedCalls.filter((c) => { const id = c.contact_id as string | null; return id != null && !contactIds.has(id); }).length;
await sql.end({ timeout: 1 });

console.log(JSON.stringify({
  apiStatus: res.status,
  apiMetaTotalNow: apiTotal,
  walkTimeSourceTotal: 116168,
  db: counts[0],
  deltaNow: apiTotal != null ? apiTotal - counts[0].rows : null,
  deltaAtWalk: 116168 - 116155,
  checkpoint: checkpoint ?? "(no checkpoint row)",
  integrity: {
    inScopeAppts: inScope.length,
    apptContactRefs: apptContactRefs.length,
    apptContactRefsMissingFromDB: apptMissing.length,
    callContactRefs: callContactRefs.length,
    callContactRefsMissingFromDB: callMissing.length,
    unresolvedCallsNoRep: unresolvedCalls.length,
    unresolvedWithContact,
    unresolvedContactMissingFromDB: unresolvedContactMissing,
  },
}, null, 2));
process.exit(0);
