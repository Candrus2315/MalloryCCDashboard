import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1, onnotice: () => {} });
const r = await sql`select provider, status, started_at, finished_at, left(coalesce(error, ''), 90) as err from sync_runs where status = 'error' and started_at::timestamptz > now() - interval '7 days' order by started_at desc`;
console.log(JSON.stringify(r, null, 1));
await sql.end();
