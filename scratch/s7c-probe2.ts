import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const attr = await sql`select a.appointment_id::text as appt, a.rep_id::text as rep, a.method, a.note, ap.acuity_appointment_id, ap.created_at::text as created from booking_attributions a join appointments ap on ap.id = a.appointment_id where ap.created_at >= '2026-09-20' and ap.created_at < '2026-09-27' and a.rep_id is not null limit 4`;
for (const row of attr) console.log("attr:", row.appt.slice(0,8), "acuity", row.acuity, "| method", row.method, "| created", row.created, "| note:", (row.note ?? "").slice(0, 200));
const midnight = await sql`select count(*)::int as n from appointments where created_at = date_trunc('day', created_at)`;
console.log("rows with midnight-UTC created_at:", midnight[0].n);
await sql.end();
