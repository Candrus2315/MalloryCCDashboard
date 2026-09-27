import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const s = await sql`select count(*)::int total, sum(case when rep_id is not null then 1 else 0 end)::int attr, sum(case when rep_id is null and note like 'ambiguous%' then 1 else 0 end)::int amb, sum(case when rep_id is null and note not like 'ambiguous%' then 1 else 0 end)::int unattr from booking_attributions`;
console.log("STORED SPLIT NOW:", JSON.stringify(s[0]));
const w = await sql`select count(*)::int n from sync_runs where provider='attribution' and started_at > now() - interval '90 minutes'`;
console.log("attribution runs last 90min:", JSON.stringify(w[0]));
await sql.end();
