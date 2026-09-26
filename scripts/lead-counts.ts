import postgres from "postgres";
import { getSecret } from "../src/server/env";
const sql = postgres(getSecret("DATABASE_URL")!, { ssl: "require", max: 1 });
const rows = await sql`select source_sheet, count(*)::int as n, min(source_date) as min_src, max(source_date) as max_src, min(work_date) as min_w, max(work_date) as max_w from leads group by source_sheet order by source_sheet`;
console.log(JSON.stringify(rows, null, 1));
const dupes = await sql`select source_id, count(*)::int from leads group by source_id having count(*) > 1 limit 5`;
console.log("dupe source_ids:", dupes.length);
await sql.end({ timeout: 5 });
process.exit(0);
