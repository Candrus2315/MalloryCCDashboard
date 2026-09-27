import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const J = async (label: string, q: any) => { console.log(label, JSON.stringify([...await q])); };
await J("SYNC_RUNS_RECENT", sql`select provider, status, started_at, finished_at, records_upserted, left(coalesce(error,''),160) err from sync_runs order by started_at desc limit 16`);
await J("WATERMARKS", sql`select provider, watermark, updated_at from sync_watermarks order by provider`);
await J("CHECKPOINTS", sql`select key, left(value::text,120) v, updated_at from sync_checkpoints order by key`);
await sql.end();
