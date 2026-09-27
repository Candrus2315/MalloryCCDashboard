import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const before = await sql`select value->'studio'->>'slot_interval_min' as v from app_settings where key='app'`;
console.log("before:", before[0]?.v);
await sql`update app_settings set value = jsonb_set(value, '{studio,slot_interval_min}', '50'::jsonb, true) where key='app'`;
const after = await sql`select value->'studio'->>'slot_interval_min' as v, value->'studio'->>'appointment_duration_min' as d, value->'studio'->'hours' as h from app_settings where key='app'`;
console.log("after:", after[0]?.v, "| duration:", after[0]?.d, "| hours[0..1]:", JSON.stringify((after[0]?.h ?? []).slice(0,2)));
await sql.end();
