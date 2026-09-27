import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const J = async (label: string, q: any) => { console.log(label, JSON.stringify([...await q])); };
await J("APPT_SPAN", sql`select min(appointment_datetime) mn, max(appointment_datetime) mx, min(created_at) mnc, max(created_at) mxc, count(*)::int n from appointments`);
await J("WEEKLY_CREATED", sql`select (created_at at time zone 'America/New_York')::date d, count(*)::int n from appointments where created_at at time zone 'America/New_York' >= date '2026-09-01' group by 1 order by 1`);
await J("SYNC_RUNS_RECENT", sql`select provider, kind, status, started_at, finished_at, left(coalesce(error,''),120) err from sync_runs order by started_at desc limit 14`);
await J("WATERMARKS", sql`select provider, key, value from sync_watermarks order by provider,key`);
await sql.end();
