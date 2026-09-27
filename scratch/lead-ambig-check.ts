import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const s = await sql`select count(*)::int total, sum(case when rep_id is not null then 1 else 0 end)::int attr, sum(case when rep_id is null and note like 'ambiguous%' then 1 else 0 end)::int amb, sum(case when rep_id is null and note not like 'ambiguous%' then 1 else 0 end)::int unattr from booking_attributions`;
console.log("SPLIT NOW:", JSON.stringify(s[0]));
const m = await sql`select acuity_appointment_id, rep_id, substring(note,1,60) as note, updated_at from booking_attributions where updated_at > now() - interval '2 hours' and rep_id is not null order by updated_at desc limit 8`;
console.log("recently assigned:", JSON.stringify(m, null, 1));
await sql.end();
