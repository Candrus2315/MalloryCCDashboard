/** S4 follow-up census: error sync runs (proper ts compare) + future-day calendar breakdown. */
import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1, onnotice: () => {} });

const runs = await sql`
  select provider, status, records_upserted, started_at, finished_at, error
  from sync_runs
  where started_at::timestamptz > now() - interval '45 minutes'
  order by started_at desc limit 30`;

const byCal = await sql`
  select (appointment_datetime at time zone 'America/New_York')::date as day,
         calendar_id, calendar_name, count(*) as n
  from appointments
  where (appointment_datetime at time zone 'America/New_York')::date >= (now() at time zone 'America/New_York')::date
    and (appointment_datetime at time zone 'America/New_York')::date < (now() at time zone 'America/New_York')::date + 8
  group by 1,2,3 order by 1 asc, 3 desc`;

const errors30d = await sql`
  select count(*) as n from sync_runs
  where status = 'error' and started_at::timestamptz > now() - interval '7 days'`;

const calTotals = await sql`
  select calendar_id, calendar_name, count(*) as n from appointments group by 1,2 order by 3 desc`;
await sql.end();
console.log(JSON.stringify({ runs, byCal, errorsLast7d: errors30d[0], calTotals }, null, 1));
