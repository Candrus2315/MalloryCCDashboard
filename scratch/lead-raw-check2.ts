import postgres from "postgres";
const sql = postgres(process.env.Database_URL!, { ssl: { rejectUnauthorized: false }, max: 1 });
const r = await sql`select acuity_appointment_id, created_at, raw from appointments order by created_at desc limit 1`;
const row = r[0];
console.log("id:", row.acuity_appointment_id, "| stored created_at:", row.created_at);
console.log("raw type:", typeof row.raw, "| keys:", Object.keys(row.raw ?? {}).slice(0, 40).join(","));
for (const k of Object.keys(row.raw ?? {})) {
  const v = (row.raw as any)[k];
  if (typeof v === "string" && /september/i.test(v)) console.log("KEY WITH 'september':", k, "=", JSON.stringify(v));
}
console.log("dateCreated:", JSON.stringify((row.raw as any)?.dateCreated));
console.log("date_created:", JSON.stringify((row.raw as any)?.date_created));
console.log("createdAt:", JSON.stringify((row.raw as any)?.createdAt));
await sql.end();
