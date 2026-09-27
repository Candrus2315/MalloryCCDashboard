import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const ids = (await Bun.file("/tmp/failing-ids.txt").text()).trim().split("\n");
for (const id of ids) {
  const rows = await sql`select acuity_appointment_id, rep_id, substring(note,1,80) as note, updated_at::text from booking_attributions where acuity_appointment_id = ${id}`;
  console.log(JSON.stringify(rows[0] ?? { id, missing: true }));
}
await sql.end();
