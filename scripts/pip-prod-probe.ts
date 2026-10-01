/**
 * PROD PIP DATA PROBE (Part 5 pre-list, 100% READ-ONLY) — enumerates every
 * pips row + template row with its identifiers, rep, provenance and content
 * markers, so the test-row deletion list can be drawn up BEFORE anything is
 * deleted. Deletes nothing; prints a table to stdout.
 *
 * Run: bun /home/team/shared/site/scripts/pip-prod-probe.ts
 */
import postgres from "postgres";
import { getSecret } from "../src/server/env";

const url = getSecret("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL not resolvable — aborted, nothing read.");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

const pips = await sql`
  SELECT p.id::text AS id, p.title, p.status, p.rep_id::text AS rep_id, u.name AS rep_name,
         u.external_id AS rep_external, p.weekly_goal_min, p.created_by, p.created_at::text AS created_at,
         p.issued_at::text AS issued_at, p.template_id::text AS template_id
  FROM pips p LEFT JOIN users u ON u.id = p.rep_id
  ORDER BY p.created_at`;
const users = await sql`SELECT id::text AS id, name, external_id, is_active FROM users ORDER BY name`;
const templates = await sql`SELECT id::text AS id, name, version, created_by, created_at::text AS created_at FROM pip_templates ORDER BY created_at`;
const events = await sql`SELECT event_type, count(*)::int AS n FROM pip_event_log GROUP BY event_type ORDER BY event_type`;

console.log("=== USERS (id, name, external_id, active) ===");
for (const u of users as unknown as Record<string, unknown>[]) {
  console.log(`${u.id} | ${u.name} | ${u.external_id} | active=${u.is_active}`);
}
console.log(`\n=== PIPS (${(pips as unknown[]).length}) ===`);
for (const p of pips as unknown as Record<string, unknown>[]) {
  console.log(
    `${p.id} | ${p.status} | rep=${p.rep_name ?? "NULL"}(${p.rep_id ?? "-"};ext=${p.rep_external ?? "-"}) | ` +
      `goal=${p.weekly_goal_min} | by=${p.created_by} | created=${String(p.created_at).slice(0, 10)} | ` +
      `issued=${p.issued_at ? String(p.issued_at).slice(0, 10) : "-"} | tpl=${p.template_id ?? "-"} | "${p.title}"`,
  );
}
console.log(`\n=== TEMPLATES (${(templates as unknown[]).length}) ===`);
for (const t of templates as unknown as Record<string, unknown>[]) {
  console.log(`${t.id} | v${t.version} | by=${t.created_by} | created=${String(t.created_at).slice(0, 10)} | "${t.name}"`);
}
console.log("\n=== EVENT COUNTS ===");
for (const e of events as unknown as Record<string, unknown>[]) console.log(`${e.event_type}: ${e.n}`);
await sql.end();
process.exit(0);
