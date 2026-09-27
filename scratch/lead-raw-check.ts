import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const r = await sql`select acuity_appointment_id, created_at, raw from appointments where raw->>'dateCreated' like 'September 2%' order by created_at desc limit 2`;
for (const row of r) {
  console.log("id:", row.acuity_appointment_id, "| stored created_at:", row.created_at);
  console.log("raw keys:", Object.keys(row.raw).join(","));
  console.log("dateCreated:", JSON.stringify(row.raw.dateCreated), "| date_created:", JSON.stringify(row.raw.date_created), "| datetime:", JSON.stringify(row.raw.datetime), "| date:", JSON.stringify(row.raw.date), "| time:", JSON.stringify(row.raw.time));
  console.log("---");
}
await sql.end();
