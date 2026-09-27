import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const cal = await sql`select calendar_name, count(*)::int as n from appointments group by 1 order by 2 desc limit 10`;
console.log("by calendar:", JSON.stringify(cal));
const wk = await sql`select acuity_appointment_id, calendar_name, created_business_date::text as cbd, status from appointments where created_business_date between '2026-09-21' and '2026-09-27' order by created_business_date`;
console.log("week rows:", JSON.stringify(wk, null, 0));
const demo = await sql`select count(*)::int as n from appointments where acuity_appointment_id !~ '^[0-9]+$'`;
console.log("non-numeric ids (demo):", JSON.stringify(demo[0]));
await sql.end();
