/** S5 DIAGNOSTIC — what rewrote the stored attributions? READ-ONLY, direct SQL (no store DDL). */
import postgres from "postgres";
import { getSecret } from "../src/server/env";

const dbUrl = getSecret("DATABASE_URL")!;
const sql = postgres(dbUrl, { max: 2, ...(new URL(dbUrl).searchParams.get("sslmode") === null ? { ssl: "require" } : {}) });

const runs = await sql`SELECT id::text, provider, status, records_upserted, error, started_at, finished_at FROM sync_runs ORDER BY started_at DESC LIMIT 15`;
const attrStats = await sql`SELECT method, count(*)::int AS n, min(updated_at) AS first_write, max(updated_at) AS last_write FROM booking_attributions GROUP BY method ORDER BY n DESC`;
const noteStats = await sql`SELECT split_part(note, ';', 1) AS reason_head, count(*)::int AS n FROM booking_attributions WHERE method = 'none' GROUP BY reason_head ORDER BY n DESC`;
const recent = await sql`SELECT b.updated_at, a.acuity_appointment_id, b.note FROM booking_attributions b JOIN appointments a ON a.id = b.appointment_id WHERE b.method = 'none' ORDER BY b.updated_at DESC LIMIT 4`;
const attributed = await sql`SELECT a.acuity_appointment_id, b.method, b.confidence, b.updated_at, c.external_call_id, c.duration_seconds, u.name AS rep_name FROM booking_attributions b JOIN appointments a ON a.id = b.appointment_id LEFT JOIN calls c ON c.id = b.call_id LEFT JOIN users u ON u.id = b.rep_id WHERE b.method <> 'none'`;
await sql.end({ timeout: 1 });
console.log(JSON.stringify({ runs, attrStats, noteStats: noteStats.slice(0, 8), recentNoneRows: recent, attributedRows: attributed }, null, 2));
process.exit(0);
