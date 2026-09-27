/** S7c LIVE BACKFILL: re-pull the window (3 paced requests) through the REAL
 * S7c ingestion so every row gets the authoritative instant + business date +
 * raw object. Idempotent re-upsert by acuity id; cancellations update in place. */
import { availabilityTick } from "../src/server/sync/acuity-live";
import postgres from "postgres";
const res = await availabilityTick({ trigger: "manual" });
console.log("TICK:", JSON.stringify(res));
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const [{ n: total }] = await sql`select count(*)::int as n from appointments`;
const [{ n: nullCbd }] = await sql`select count(*)::int as n from appointments where created_business_date is null`;
const [{ n: nullCreated }] = await sql`select count(*)::int as n from appointments where created_at = date_trunc('day', created_at)`;
const prec = await sql`select created_time_precision, count(*)::int as n from appointments group by 1 order by 2 desc`;
console.log(JSON.stringify({ total, nullCbd, midnightUtcStill: nullCreated, precision: prec }, null, 1));
const offs = await sql`select substring(created_time_source from '[+-][0-9]{4}$') as off, count(*)::int as n from appointments group by 1 order by 2 desc`;
console.log("offsets:", JSON.stringify(offs));
const [{ n: rawNull }] = await sql`select count(*)::int as n from appointments where raw is null or raw::text in ('{}','null')`;
console.log("rows with empty/null raw:", rawNull);

const [{ n: wk }] = await sql`select count(*)::int as n from appointments where created_business_date between '2026-09-21' and '2026-09-27'`;
console.log('weekly created_business_date 2026-09-21..27:', wk);
const edges = await sql`select acuity_appointment_id, created_time_source, created_business_date::text as cbd, calendar_name from appointments where created_time_source is not null and substring(created_time_source,1,10) <> created_business_date::text order by created_time_source`;
console.log('EDGE rows (ET cbd differs from stated-offset local date):');
for (const e of edges) console.log(JSON.stringify(e));
const six = await sql`select acuity_appointment_id, created_time_source, created_business_date::text as cbd, calendar_name from appointments where created_time_source like '%-0600'`;
console.log('rows with -0600 offset:');
for (const e of six) console.log(JSON.stringify(e));
await sql.end();
