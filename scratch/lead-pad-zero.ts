import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const before = await sql`select value->'studio'->>'padding_min' as p from app_settings where key='app'`;
await sql`update app_settings set value = jsonb_set(value, '{studio,padding_min}', '0'::jsonb, true) where key='app'`;
const after = await sql`select value->'studio'->>'padding_min' as p, value->'studio'->>'slot_interval_min' as i, value->'studio'->>'appointment_duration_min' as d from app_settings where key='app'`;
console.log("padding before:", before[0]?.p, "→ after:", after[0]?.p, "| interval:", after[0]?.i, "| duration:", after[0]?.d);
await sql.end();
