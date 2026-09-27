import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const J = async (label: string, q: any) => { console.log(label, JSON.stringify([...await q])); };
const A = "2026-09-21T04:00:00Z", B = "2026-09-28T04:00:00Z";
await J("FRESHNESS", sql`select max(created_at) mx, count(*)::int total from appointments`);
await J("BY_CREATED", sql`select (created_at at time zone 'America/New_York')::date d, count(*)::int n, sum(case when cancelled then 1 else 0 end)::int canc from appointments where created_at >= ${A} and created_at < ${B} group by 1 order by 1`);
await J("BY_APPT_DATE", sql`select (appointment_datetime at time zone 'America/New_York')::date d, count(*)::int n, sum(case when cancelled then 1 else 0 end)::int canc from appointments where appointment_datetime >= ${A} and appointment_datetime < ${B} group by 1 order by 1`);
await J("IN_SCOPE_124_CHECK", sql`select count(*)::int n from booking_attributions ba join appointments a on a.id=ba.appointment_id where a.created_at >= ${A} and a.created_at < ${B}`);
await sql.end();
