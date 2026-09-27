import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const st = await sql`select coalesce(status,'(null)') as status, count(*)::int as n from appointments where created_business_date between '2026-09-21' and '2026-09-27' group by 1 order by 2 desc`;
console.log("Sep21-27 by status:", JSON.stringify(st));
const cx = await sql`select acuity_appointment_id, created_business_date::text as cbd, appointment_datetime::text as adt, status, raw->>'dateCreated' as rawdc from appointments where created_business_date between '2026-09-21' and '2026-09-27' and (status ilike '%cancel%' or status ilike '%void%')`;
console.log("cancelled rows in week:", JSON.stringify(cx, null, 1));
const tot = await sql`select count(*)::int as n, sum(case when status ilike '%cancel%' then 1 else 0 end)::int as cancelled from appointments`;
console.log("ALL rows:", JSON.stringify(tot[0]));
await sql.end();
