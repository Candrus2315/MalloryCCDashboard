/** S5 STEP-1 GATE PROBE — what do the 46 window-note 'none' rows actually carry? READ-ONLY. */
import postgres from "postgres";
import { getSecret } from "../src/server/env";

const dbUrl = getSecret("DATABASE_URL")!;
const sql = postgres(dbUrl, { max: 2, ...(new URL(dbUrl).searchParams.get("sslmode") === "null" ? {} : { ssl: "require" }) });

const fortySix = await sql`
  SELECT b.method, (b.rep_id IS NOT NULL) AS has_rep, (b.call_id IS NOT NULL) AS has_call, b.manual_override, count(*)::int AS n
  FROM booking_attributions b
  WHERE b.method = 'none' AND b.note LIKE 'date_granularity_window%'
  GROUP BY 1,2,3,4 ORDER BY 5 DESC`;
const repSplit = await sql`
  SELECT (b.rep_id IS NOT NULL) AS has_rep, count(*)::int AS n
  FROM booking_attributions b GROUP BY 1`;
const noneRepRows = await sql`
  SELECT b.appointment_id::text, b.rep_id::text AS rep_id, u.name AS rep_name, b.call_id::text AS call_id,
         c.external_call_id, c.duration_seconds, c.rep_id AS call_rep_id, c.provider_rep_external_id,
         b.note
  FROM booking_attributions b
  LEFT JOIN users u ON u.id = b.rep_id
  LEFT JOIN calls c ON c.id = b.call_id
  WHERE b.method = 'none' AND b.note LIKE 'date_granularity_window%'
  LIMIT 8`;
const totals = await sql`
  SELECT count(*)::int AS total_rows,
         count(*) FILTER (WHERE rep_id IS NOT NULL)::int AS rep_set,
         count(*) FILTER (WHERE method <> 'none')::int AS method_attributed,
         count(*) FILTER (WHERE method = 'none' AND rep_id IS NOT NULL)::int AS none_with_rep,
         count(*) FILTER (WHERE method = 'none' AND rep_id IS NULL AND note LIKE 'ambiguous%')::int AS ambiguous_notes,
         count(*) FILTER (WHERE method = 'none' AND rep_id IS NULL AND note LIKE 'no-qualifying-call%')::int AS noqual_notes,
         count(*) FILTER (WHERE method = 'none' AND rep_id IS NULL AND note NOT LIKE 'ambiguous%' AND note NOT LIKE 'no-qualifying-call%')::int AS none_repnull_other_note
  FROM booking_attributions`;
await sql.end({ timeout: 1 });
console.log(JSON.stringify({ fortySix, repSplit, noneRepRows, totals }, null, 2));
process.exit(0);
