import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const rows = await sql`select key, value from app_settings where key ilike '%studio%' or key ilike '%avail%' or key ilike '%slot%' limit 5`;
console.log(JSON.stringify(rows, null, 1));
await sql.end();
